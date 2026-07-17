import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { createRequestSignature } from "../extensions/request-signing.ts";
import {
	buildOpenAICompletionsPayload,
	streamSignedOpenAICompletions,
} from "../extensions/signed-openai.ts";

// Public deterministic test vector; never use this value as a production credential.
const TEST_SIGNING_KEY = "0123456789abcdef0123456789abcdef";

const model: Model<"openai-completions"> = {
	id: "premium",
	name: "IBM Bob Premium",
	api: "openai-completions",
	provider: "ibm-bob",
	baseUrl: "https://api.us-east.bob.ibm.com/inference/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
	compat: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
	},
};

const context: Context = {
	systemPrompt: "System instructions",
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	],
};

test("builds the OpenAI Chat Completions payload that is signed", () => {
	assert.deepEqual(buildOpenAICompletionsPayload(model, context), {
		model: "premium",
		messages: [
			{ role: "system", content: "System instructions" },
			{ role: "user", content: "Hello" },
		],
		stream: true,
		stream_options: { include_usage: true },
		store: false,
		max_tokens: 8192,
		tools: [
			{
				type: "function",
				function: {
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			},
		],
	});
});

test("serializes assistant tool calls and tool results", () => {
	const payload = buildOpenAICompletionsPayload(model, {
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Checking" },
					{ type: "toolCall", id: "call+unsafe|ignored", name: "read", arguments: { path: "a.txt" } },
				],
				api: "openai-completions",
				provider: "ibm-bob",
				model: "premium",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call+unsafe|ignored",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: 2,
			},
		],
	});
	assert.deepEqual(payload.messages, [
		{
			role: "assistant",
			content: "Checking",
			tool_calls: [
				{
					id: "call_unsafe",
					type: "function",
					function: { name: "read", arguments: '{"path":"a.txt"}' },
				},
			],
		},
		{ role: "tool", content: "file contents", tool_call_id: "call_unsafe" },
	]);
});

test("signs the final payload and preserves authentication headers", async () => {
	let capturedOptions: SimpleStreamOptions | undefined;
	let capturedPayload: unknown;
	const options: SimpleStreamOptions = {
		headers: { Authorization: "Bearer redacted", "x-instance-id": "instance-1" },
		onPayload(payload) {
			return { ...(payload as Record<string, unknown>), request_marker: "final" };
		},
	};

	const delegate = (_model: Model<"openai-completions">, _context: Context, next?: SimpleStreamOptions) => {
		capturedOptions = next;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			capturedPayload = await next?.onPayload?.({ ignored: true }, model);
			stream.end();
		});
		return stream;
	};

	const stream = streamSignedOpenAICompletions(model, context, options, TEST_SIGNING_KEY, delegate);
	for await (const _event of stream) {
		// The fake delegate emits no model events.
	}

	assert.ok(capturedOptions);
	assert.equal(capturedOptions.headers?.Authorization, "Bearer redacted");
	assert.equal(capturedOptions.headers?.["x-instance-id"], "instance-1");
	assert.equal(typeof capturedOptions.headers?.["x-request-timestamp"], "string");
	assert.equal(typeof capturedOptions.headers?.["x-request-signature"], "string");
	assert.deepEqual(capturedPayload, {
		...buildOpenAICompletionsPayload(model, context, options),
		request_marker: "final",
	});

	const timestamp = capturedOptions.headers?.["x-request-timestamp"] as string;
	const expected = createRequestSignature({
		method: "POST",
		url: "https://api.us-east.bob.ibm.com/inference/v1/chat/completions",
		timestamp,
		body: JSON.stringify(capturedPayload),
		secret: TEST_SIGNING_KEY,
	});
	assert.equal(capturedOptions.headers?.["x-request-signature"], expected);
});

test("signature matches the exact body sent by the OpenAI adapter", async () => {
	let signatureValid = false;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const timestamp = request.headers["x-request-timestamp"];
			const signature = request.headers["x-request-signature"];
			if (typeof timestamp === "string" && typeof signature === "string") {
				const expected = createRequestSignature({
					method: request.method ?? "POST",
					url: `http://127.0.0.1${request.url}`,
					timestamp,
					body,
					secret: TEST_SIGNING_KEY,
				});
				signatureValid = signature === expected;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(
				`data: ${JSON.stringify({ id: "test", model: "premium", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({ id: "test", model: "premium", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const localModel = { ...model, baseUrl: `http://127.0.0.1:${address.port}/inference/v1` };
		const stream = streamSignedOpenAICompletions(
			localModel,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ headers: { Authorization: "Bearer redacted" } },
			TEST_SIGNING_KEY,
			openAICompletionsApi().streamSimple,
		);
		const events = [];
		for await (const event of stream) events.push(event);
		assert.equal(signatureValid, true);
		assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "ok"));
		assert.ok(events.some((event) => event.type === "done"));
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
