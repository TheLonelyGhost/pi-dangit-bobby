import assert from "node:assert/strict";
import { test } from "node:test";
import {
	REQUEST_SIGNATURE_HEADER,
	REQUEST_TIMESTAMP_HEADER,
	createRequestSignature,
	createRequestSigningHeaders,
	resolveRequestSigningSecret,
	withRequestSigningHeaders,
} from "../extensions/request-signing.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const TIMESTAMP = "2026-07-17T12:34:56.789Z";
const URL = "https://api.us-east.bob.ibm.com/inference/v1/chat/completions?x=1";
const BODY = '{"model":"premium","stream":true}';

test("creates the expected HMAC-SHA256 signature", () => {
	assert.equal(
		createRequestSignature({ method: "post", url: URL, timestamp: TIMESTAMP, body: BODY, secret: SECRET }),
		"65828c5bbb13aa5fbf3b67ead5d17520a7722334c323f3639133f8c2f0fc3e39",
	);
});

test("signs only the URL path and query, not the origin", () => {
	const first = createRequestSignature({ method: "GET", url: "https://one.example.test/path?q=1", timestamp: TIMESTAMP, secret: SECRET });
	const second = createRequestSignature({ method: "GET", url: "https://two.example.test/path?q=1", timestamp: TIMESTAMP, secret: SECRET });
	assert.equal(first, second);
});

test("returns the canonical timestamp and signature headers", () => {
	assert.deepEqual(
		createRequestSigningHeaders({ method: "POST", url: URL, timestamp: TIMESTAMP, body: BODY, secret: SECRET }),
		{
			[REQUEST_TIMESTAMP_HEADER]: TIMESTAMP,
			[REQUEST_SIGNATURE_HEADER]: "65828c5bbb13aa5fbf3b67ead5d17520a7722334c323f3639133f8c2f0fc3e39",
		},
	);
});

test("replaces preexisting signing headers case-insensitively", () => {
	const headers = withRequestSigningHeaders(
		{
			Accept: "application/json",
			"X-Request-Signature": "stale",
			"x-request-timestamp": "stale",
		},
		{ method: "POST", url: URL, timestamp: TIMESTAMP, body: BODY, secret: SECRET },
	);
	assert.equal(headers.Accept, "application/json");
	assert.equal(headers[REQUEST_TIMESTAMP_HEADER], TIMESTAMP);
	assert.notEqual(headers[REQUEST_SIGNATURE_HEADER], "stale");
	assert.equal(Object.keys(headers).filter((name) => name.toLowerCase() === REQUEST_SIGNATURE_HEADER).length, 1);
});

test("loads a sufficiently long secret from the environment", () => {
	assert.equal(resolveRequestSigningSecret({ IBM_BOB_REQUEST_SIGNING_SECRET: SECRET }), SECRET);
});

test("allows signing to remain optional when no secret is configured", () => {
	assert.equal(resolveRequestSigningSecret({}), undefined);
});

test("fails closed when signing is required without a secret", () => {
	assert.throws(
		() => resolveRequestSigningSecret({ IBM_BOB_REQUIRE_REQUEST_SIGNING: "true" }),
		/IBM_BOB_REQUEST_SIGNING_SECRET is required/,
	);
});

test("rejects weak or accidentally padded secrets", () => {
	assert.throws(
		() => resolveRequestSigningSecret({ IBM_BOB_REQUEST_SIGNING_SECRET: "too-short" }),
		/at least 32 bytes/,
	);
	assert.throws(
		() => resolveRequestSigningSecret({ IBM_BOB_REQUEST_SIGNING_SECRET: `${SECRET} ` }),
		/leading or trailing whitespace/,
	);
});

test("rejects ambiguous required-signing configuration", () => {
	assert.throws(
		() => resolveRequestSigningSecret({ IBM_BOB_REQUIRE_REQUEST_SIGNING: "sometimes" }),
		/must be a boolean value/,
	);
});

test("rejects malformed methods and non-canonical timestamps", () => {
	assert.throws(
		() => createRequestSignature({ method: "POST\nX", url: URL, timestamp: TIMESTAMP, body: BODY, secret: SECRET }),
		/Invalid HTTP method/,
	);
	assert.throws(
		() => createRequestSignature({ method: "POST", url: URL, timestamp: "2026-07-17", body: BODY, secret: SECRET }),
		/canonical ISO-8601/,
	);
});
