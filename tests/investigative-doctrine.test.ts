import assert from "node:assert/strict";
import { test } from "node:test";
import { INVESTIGATIVE_DOCTRINE } from "../src/execution/child-agent.ts";

// These tests are a REGRESSION TRIPWIRE for the global anti-anchoring doctrine.
// It exists because a review once examined a slice of a PR (the part a sibling
// artifact described) and reported confidently, missing blocking issues in the
// files it never opened. The doctrine is injected into every Guildmate in code so
// it cannot drift per-persona or be dropped by a narrow brief. If you are changing
// this, make sure the intent below still holds.

test("investigative doctrine treats the brief's framing as a claim to verify", () => {
	assert.match(INVESTIGATIVE_DOCTRINE, /CLAIM to verify/);
	assert.match(INVESTIGATIVE_DOCTRINE, /primary sources/);
});

test("investigative doctrine requires enumerating the full surface before analysing", () => {
	assert.match(INVESTIGATIVE_DOCTRINE, /FULL surface/);
	assert.match(INVESTIGATIVE_DOCTRINE, /every changed file/);
});

test("investigative doctrine requires declaring partial examinations and lowering confidence", () => {
	assert.match(INVESTIGATIVE_DOCTRINE, /partial/i);
	assert.match(INVESTIGATIVE_DOCTRINE, /confidence/i);
});

test("investigative doctrine forbids asserting checkable facts without checking", () => {
	assert.match(INVESTIGATIVE_DOCTRINE, /without checking/i);
});
