import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { questScratchDir } from "../src/paths.ts";

describe("questScratchDir", () => {
	test("returns valid path for normal questId", () => {
		const dir = questScratchDir("2026-09-18_16-23-47_a1b2");
		assert.ok(dir.includes("scratch"));
		assert.ok(dir.includes("2026-09-18_16-23-47_a1b2"));
	});

	test("rejects questId with forward slash", () => {
		assert.throws(() => questScratchDir("../../../etc"), /path traversal/i);
	});

	test("rejects questId with backslash", () => {
		assert.throws(() => questScratchDir("..\\..\\etc"), /path traversal/i);
	});

	test("rejects questId with dot-dot", () => {
		assert.throws(() => questScratchDir("legit..butnotreally"), /path traversal/i);
	});
});
