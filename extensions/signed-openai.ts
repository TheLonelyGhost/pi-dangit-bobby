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

function sanitizeSurrogates(value: string): string {
	return value.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function clampPromptCacheKey(value: string | undefined): string | undefined {
	if (!value) return value;
	return Array.from(value).slice(0, 64).join("");
}

function normalizedToolCallId(value: string): string {
	const callId = value.includes("|") ? value.split("|", 1)[0] : value;
	return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

function convertMessages(model: OpenAICompletionsModel, context: Context, compat: ReturnType<typeof resolvedCompat>) {
	const messages: Array<Record<string, unknown>> = [];
	if (context.systemPrompt) {
		messages.push({
			role: model.reasoning && compat.supportsDeveloperRole ? "developer" : "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	for (const message of context.messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				if (message.content.length > 0) messages.push({ role: "user", content: sanitizeSurrogates(message.content) });
			} else {
				const content = message.content.map((block) =>
					block.type === "text"
						? { type: "text", text: sanitizeSurrogates(block.text) }
						: { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
				);
				if (content.length > 0) messages.push({ role: "user", content });
			}
			continue;
		}

		if (message.role === "assistant") {
			const assistant: Record<string, unknown> = { role: "assistant", content: null };
			const text = message.content
				.filter((block) => block.type === "text" && block.text.trim().length > 0)
				.map((block) => (block.type === "text" ? sanitizeSurrogates(block.text) : ""))
				.join("");
			if (text) assistant.content = text;
			const thinking = message.content.filter(
				(block) => block.type === "thinking" && block.thinking.trim().length > 0,
			);
			if (thinking.length > 0 && compat.requiresThinkingAsText) {
				assistant.content = thinking
					.map((block) => (block.type === "thinking" ? sanitizeSurrogates(block.thinking) : ""))
					.concat(text ? [text] : [])
					.join("\n\n");
			} else if (thinking[0]?.type === "thinking" && thinking[0].thinkingSignature) {
				assistant[thinking[0].thinkingSignature] = thinking
					.map((block) => (block.type === "thinking" ? block.thinking : ""))
					.join("\n");
			}
			const calls = message.content.filter((block) => block.type === "toolCall");
			if (calls.length > 0) {
				assistant.tool_calls = calls.map((block) =>
					block.type === "toolCall"
						? {
								id: normalizedToolCallId(block.id),
								type: "function",
								function: { name: block.name, arguments: JSON.stringify(block.arguments) },
							}
						: undefined,
				);
			}
			if (
				compat.requiresReasoningContentOnAssistantMessages &&
				model.reasoning &&
				assistant.reasoning_content === undefined
			) {
				assistant.reasoning_content = "";
			}
			if (assistant.content !== null || assistant.tool_calls) messages.push(assistant);
			continue;
		}

		if (message.role === "toolResult") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n");
			const images = message.content.filter((block) => block.type === "image");
			const result: Record<string, unknown> = {
				role: "tool",
				content: sanitizeSurrogates(text || (images.length > 0 ? "(see attached image)" : "(no tool output)")),
				tool_call_id: normalizedToolCallId(message.toolCallId),
			};
			if (compat.requiresToolResultName && message.toolName) result.name = message.toolName;
			messages.push(result);
			if (images.length > 0 && model.input.includes("image")) {
				messages.push({
					role: "user",
					content: [
						{ type: "text", text: "Attached image(s) from tool result:" },
						...images.map((block) =>
							block.type === "image"
								? { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
								: undefined,
						),
					],
				});
			}
		}
	}
	return messages;
}

function clampMaxTokens(model: OpenAICompletionsModel, context: Context, requested: number): number {
	if (model.contextWindow <= 0) return Math.max(1, requested);
	const estimatedInput = Math.ceil(JSON.stringify({ context, tools: context.tools }).length / 4);
	const available = Math.max(1, model.contextWindow - estimatedInput - 4096);
	return Math.min(requested, model.maxTokens, available);
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
		payload.prompt_cache_key = clampPromptCacheKey(options?.sessionId);
		payload.prompt_cache_retention = "24h";
	}
	if (compat.supportsUsageInStreaming) payload.stream_options = { include_usage: true };
	if (compat.supportsStore) payload.store = false;

	const maxTokens = clampMaxTokens(model, context, options?.maxTokens ?? model.maxTokens);
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
