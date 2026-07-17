import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
import { calculateCost, clampThinkingLevel, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { withRequestSigningHeaders } from "./request-signing.ts";

type OpenAICompletionsModel = Model<"openai-completions">;
type StreamDelegate = (
	model: OpenAICompletionsModel,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

type ExtendedSimpleStreamOptions = SimpleStreamOptions & {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
};

interface OpenAICompatibleTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: unknown;
		strict?: false;
	};
}

function hasToolHistory(context: Context): boolean {
	return context.messages.some(
		(message) =>
			message.role === "toolResult" ||
			(message.role === "assistant" && message.content.some((block) => block.type === "toolCall")),
	);
}

function convertTools(context: Context, supportsStrictMode: boolean): OpenAICompatibleTool[] | undefined {
	if (!context.tools || context.tools.length === 0) return hasToolHistory(context) ? [] : undefined;
	return context.tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(supportsStrictMode ? { strict: false as const } : {}),
		},
	}));
}

function cacheRetention(options?: SimpleStreamOptions): "none" | "short" | "long" {
	if (options?.cacheRetention) return options.cacheRetention;
	const configured = options?.env?.PI_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION;
	return configured === "long" || configured === "none" ? configured : "short";
}

function resolvedCompat(model: OpenAICompletionsModel) {
	const compat = model.compat ?? {};
	return {
		supportsStore: compat.supportsStore ?? true,
		supportsDeveloperRole: compat.supportsDeveloperRole ?? false,
		supportsReasoningEffort: compat.supportsReasoningEffort ?? false,
		supportsUsageInStreaming: compat.supportsUsageInStreaming ?? true,
		maxTokensField: compat.maxTokensField ?? "max_tokens",
		requiresToolResultName: compat.requiresToolResultName ?? false,
		requiresAssistantAfterToolResult: compat.requiresAssistantAfterToolResult ?? false,
		requiresThinkingAsText: compat.requiresThinkingAsText ?? false,
		requiresReasoningContentOnAssistantMessages: compat.requiresReasoningContentOnAssistantMessages ?? false,
		thinkingFormat: compat.thinkingFormat ?? "openai",
		openRouterRouting: compat.openRouterRouting ?? {},
		vercelGatewayRouting: compat.vercelGatewayRouting ?? {},
		chatTemplateKwargs: compat.chatTemplateKwargs ?? {},
		zaiToolStream: compat.zaiToolStream ?? false,
		supportsStrictMode: compat.supportsStrictMode ?? false,
		cacheControlFormat: compat.cacheControlFormat,
		sendSessionAffinityHeaders: compat.sendSessionAffinityHeaders ?? false,
		sessionAffinityFormat: compat.sessionAffinityFormat ?? "openai",
		supportsLongCacheRetention: compat.supportsLongCacheRetention ?? true,
	};
}

function reasoningEffort(model: OpenAICompletionsModel, level: ThinkingLevel | undefined): string | undefined {
	if (!level) return undefined;
	const clamped = clampThinkingLevel(model, level);
	if (clamped === "off") return undefined;
	return model.thinkingLevelMap?.[clamped] ?? clamped;
}

export function buildOpenAICompletionsPayload(
	model: OpenAICompletionsModel,
	context: Context,
	options?: SimpleStreamOptions,
): Record<string, unknown> {
	const compat = resolvedCompat(model);
	const retention = cacheRetention(options);
	const payload: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(model, context, compat),
		stream: true,
	};

	if (retention === "long" && compat.supportsLongCacheRetention) {
		payload.prompt_cache_key = clampOpenAIPromptCacheKey(options?.sessionId);
		payload.prompt_cache_retention = "24h";
	}
	if (compat.supportsUsageInStreaming) payload.stream_options = { include_usage: true };
	if (compat.supportsStore) payload.store = false;

	const maxTokens = clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens);
	payload[compat.maxTokensField] = maxTokens;
	if (options?.temperature !== undefined) payload.temperature = options.temperature;

	const tools = convertTools(context, compat.supportsStrictMode);
	if (tools !== undefined) payload.tools = tools;
	const toolChoice = (options as ExtendedSimpleStreamOptions | undefined)?.toolChoice;
	if (toolChoice) payload.tool_choice = toolChoice;

	const effort = reasoningEffort(model, options?.reasoning);
	if (effort && model.reasoning && compat.supportsReasoningEffort) payload.reasoning_effort = effort;
	return payload;
}

function chatCompletionsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function errorStream(model: Model<Api>, error: unknown): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
	calculateCost(model, message.usage);
	stream.push({ type: "error", reason: "error", error: message });
	stream.end();
	return stream;
}

export function streamSignedOpenAICompletions(
	model: OpenAICompletionsModel,
	context: Context,
	options: SimpleStreamOptions,
	secret: string,
	delegate: StreamDelegate,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			const basePayload = buildOpenAICompletionsPayload(model, context, options);
			const replacedPayload = await options.onPayload?.(basePayload, model);
			const payload = replacedPayload === undefined ? basePayload : replacedPayload;
			const body = JSON.stringify(payload);
			const headers = withRequestSigningHeaders(
				Object.fromEntries(
					Object.entries(options.headers ?? {}).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				),
				{
					method: "POST",
					url: chatCompletionsUrl(model.baseUrl),
					body,
					secret,
				},
			);
			const inner = delegate(model, context, {
				...options,
				headers,
				onPayload: () => payload,
			});
			for await (const event of inner) output.push(event);
			output.end();
		} catch (error) {
			for await (const event of errorStream(model, error)) output.push(event);
			output.end();
		}
	})();
	return output;
}
