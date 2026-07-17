import { createHash, createHmac } from "node:crypto";

export const REQUEST_SIGNATURE_HEADER = "x-request-signature";
export const REQUEST_TIMESTAMP_HEADER = "x-request-timestamp";
export const REQUEST_SIGNING_SECRET_ENV = "IBM_BOB_REQUEST_SIGNING_SECRET";
export const REQUIRE_REQUEST_SIGNING_ENV = "IBM_BOB_REQUIRE_REQUEST_SIGNING";

const MINIMUM_SECRET_BYTES = 32;
const HTTP_METHOD = /^[A-Z]+$/;

export interface RequestSigningInput {
	method: string;
	url: string | URL;
	body?: string;
	secret: string;
	timestamp?: string;
}

export interface RequestSigningHeaders {
	[REQUEST_TIMESTAMP_HEADER]: string;
	[REQUEST_SIGNATURE_HEADER]: string;
}

function parseRequired(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
	throw new Error(`${REQUIRE_REQUEST_SIGNING_ENV} must be a boolean value.`);
}

export function resolveRequestSigningSecret(
	environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const value = environment[REQUEST_SIGNING_SECRET_ENV];
	const required = parseRequired(environment[REQUIRE_REQUEST_SIGNING_ENV]);
	if (!value) {
		if (required) {
			throw new Error(
				`${REQUEST_SIGNING_SECRET_ENV} is required when ${REQUIRE_REQUEST_SIGNING_ENV} is enabled.`,
			);
		}
		return undefined;
	}
	if (value !== value.trim()) {
		throw new Error(`${REQUEST_SIGNING_SECRET_ENV} must not contain leading or trailing whitespace.`);
	}
	if (Buffer.byteLength(value, "utf8") < MINIMUM_SECRET_BYTES) {
		throw new Error(`${REQUEST_SIGNING_SECRET_ENV} must contain at least ${MINIMUM_SECRET_BYTES} bytes.`);
	}
	return value;
}

function canonicalMethod(method: string): string {
	const normalized = method.trim().toUpperCase();
	if (!HTTP_METHOD.test(normalized)) throw new Error(`Invalid HTTP method for request signing: ${method}`);
	return normalized;
}

function canonicalPath(url: string | URL): string {
	const parsed = url instanceof URL ? url : new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`Unsupported request-signing URL protocol: ${parsed.protocol}`);
	}
	return `${parsed.pathname}${parsed.search}`;
}

function canonicalTimestamp(timestamp: string): string {
	const parsed = new Date(timestamp);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
		throw new Error("Request-signing timestamp must be a canonical ISO-8601 UTC timestamp.");
	}
	return timestamp;
}

export function createRequestSignature(input: RequestSigningInput): string {
	const method = canonicalMethod(input.method);
	const path = canonicalPath(input.url);
	const timestamp = canonicalTimestamp(input.timestamp ?? new Date().toISOString());
	const bodyHash = createHash("sha256").update(input.body ?? "", "utf8").digest("hex");
	const canonicalRequest = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
	return createHmac("sha256", input.secret).update(canonicalRequest, "utf8").digest("hex");
}

export function createRequestSigningHeaders(input: RequestSigningInput): RequestSigningHeaders {
	const timestamp = canonicalTimestamp(input.timestamp ?? new Date().toISOString());
	return {
		[REQUEST_TIMESTAMP_HEADER]: timestamp,
		[REQUEST_SIGNATURE_HEADER]: createRequestSignature({ ...input, timestamp }),
	};
}

export function withRequestSigningHeaders(
	headers: Record<string, string>,
	input: RequestSigningInput,
): Record<string, string> {
	const sanitized = Object.fromEntries(
		Object.entries(headers).filter(([name]) => {
			const normalized = name.toLowerCase();
			return normalized !== REQUEST_SIGNATURE_HEADER && normalized !== REQUEST_TIMESTAMP_HEADER;
		}),
	);
	return { ...sanitized, ...createRequestSigningHeaders(input) };
}
