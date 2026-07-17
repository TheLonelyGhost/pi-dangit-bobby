import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BOB_VERSION_ENV,
	DEFAULT_BOB_VERSION,
	createBobUserAgent,
	resolveBobVersion,
} from "../extensions/bob-version.ts";

test("environment version takes precedence over installed Bob", () => {
	let discoveryCalled = false;
	const version = resolveBobVersion(
		{ [BOB_VERSION_ENV]: "2.3.4-beta.1+build.5" },
		() => {
			discoveryCalled = true;
			return "9.9.9";
		},
	);
	assert.equal(version, "2.3.4-beta.1+build.5");
	assert.equal(discoveryCalled, false);
});

test("normalizes a leading v in the configured version", () => {
	assert.equal(resolveBobVersion({ [BOB_VERSION_ENV]: "v2.0.0" }), "2.0.0");
});

test("uses the installed Bob version when no override is present", () => {
	assert.equal(resolveBobVersion({}, () => "1.4.2"), "1.4.2");
});

test("falls back when Bob is absent or reports invalid output", () => {
	assert.equal(resolveBobVersion({}, () => undefined), DEFAULT_BOB_VERSION);
	assert.equal(resolveBobVersion({}, () => "not-a-version"), DEFAULT_BOB_VERSION);
});

test("rejects malformed overrides instead of allowing header injection", () => {
	assert.throws(
		() => resolveBobVersion({ [BOB_VERSION_ENV]: "1.0.6\r\nx-forged: true" }),
		/must be a semantic version/,
	);
	assert.throws(() => resolveBobVersion({ [BOB_VERSION_ENV]: "" }), /must be a semantic version/);
});

test("formats the user agent as bobshell/version", () => {
	assert.equal(createBobUserAgent({}, () => "1.0.6"), "bobshell/1.0.6");
	assert.equal(createBobUserAgent({ [BOB_VERSION_ENV]: "3.0.0" }), "bobshell/3.0.0");
});
