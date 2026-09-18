import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyWorktreeJunk } from "../src/execution/isolation.ts";

describe("classifyWorktreeJunk", () => {
	describe("planning/summary docs at repo root", () => {
		test("classifies IMPLEMENTATION*.md variants", () => {
			const junk = classifyWorktreeJunk([
				"IMPLEMENTATION_PLAN.md",
				"IMPLEMENTATION.md",
				"IMPLEMENTATION_NOTES.md",
			]);
			assert.equal(junk.length, 3);
		});

		test("classifies other planning docs", () => {
			const junk = classifyWorktreeJunk([
				"PR_DESCRIPTION.md",
				"VERIFICATION_NOTES.md",
				"BUGFIX_SUMMARY.md",
				"CHANGES.md",
				"AGENT_NOTES.md",
				"MY_PLAN.md",
				"TODO.md",
				"CHECKLIST.md",
			]);
			assert.equal(junk.length, 8);
		});

		test("does NOT classify legitimate root docs", () => {
			const junk = classifyWorktreeJunk([
				"README.md",
				"CHANGELOG.md",
				"CONTRIBUTING.md",
				"SECURITY.md",
				"LICENSE.md",
				"ARCHITECTURE.md",
				"CODE_OF_CONDUCT.md",
			]);
			assert.deepEqual(junk, []);
		});

		test("does NOT classify nested planning docs", () => {
			const junk = classifyWorktreeJunk([
				"docs/IMPLEMENTATION.md",
				"src/SUMMARY.md",
				"design/VERIFICATION_PLAN.md",
			]);
			assert.deepEqual(junk, []);
		});
	});

	describe("ad-hoc scripts at repo root", () => {
		test("classifies verification scripts", () => {
			const junk = classifyWorktreeJunk([
				"run-tests.js",
				"verify-fix.ts",
				"test-implementation.sh",
				"check-output.js",
				"quick-test.ts",
				"repro-bug.js",
			]);
			assert.equal(junk.length, 6);
		});

		test("does NOT classify legitimate test files in subdirs", () => {
			const junk = classifyWorktreeJunk([
				"src/index.test.ts",
				"tests/isolation.test.ts",
				"test/unit/foo.test.js",
				"__tests__/bar.test.ts",
			]);
			assert.deepEqual(junk, []);
		});

		test("does NOT classify legitimate utility modules", () => {
			const junk = classifyWorktreeJunk([
				"src/test-utils.ts",
				"src/utils/verify.ts",
				"packages/core/run.ts",
				"scripts/build.js",
			]);
			assert.deepEqual(junk, []);
		});

		test("does NOT classify scripts without junk prefix", () => {
			const junk = classifyWorktreeJunk([
				"build.js",
				"index.ts",
				"main.sh",
				"cli.js",
			]);
			assert.deepEqual(junk, []);
		});
	});

	describe("existing scratch patterns (any depth)", () => {
		test("classifies temp commit scripts", () => {
			const junk = classifyWorktreeJunk([
				".temp_commit.sh",
				"temp-commit.sh",
				"nested/.temp_commit.sh",
			]);
			assert.equal(junk.length, 3);
		});

		test("classifies guildmaster scratch files", () => {
			const junk = classifyWorktreeJunk([
				".guildmaster-scratch",
				"guildmaster_temp",
				"deep/path/.guildmaster-notes",
			]);
			assert.equal(junk.length, 3);
		});
	});

	describe("edge cases", () => {
		test("handles empty array", () => {
			assert.deepEqual(classifyWorktreeJunk([]), []);
		});

		test("handles mixed junk and legitimate files", () => {
			const junk = classifyWorktreeJunk([
				"src/index.ts",
				"IMPLEMENTATION_PLAN.md",
				"tests/foo.test.ts",
				"verify-fix.js",
				"README.md",
			]);
			assert.deepEqual(junk.sort(), ["IMPLEMENTATION_PLAN.md", "verify-fix.js"]);
		});
	});
});
