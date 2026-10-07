import { test } from "node:test";
import assert from "node:assert/strict";
import { activeProgress } from "../src/status.ts";
import { toolsForTier } from "../src/capabilities.ts";
import { runFastWrite } from "../src/orchestration/fast-write.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { QuestRecord } from "../src/persistence/quest-store.ts";

test("builder can edit and use only its separately gated shell", () => {
	assert.deepEqual(toolsForTier("builder"), ["read", "grep", "find", "ls", "edit", "write"]);
	assert.ok(!toolsForTier("builder").includes("bash"));
});

test("active progress reports action, elapsed time, test result, and soft budget", () => {
	const rec = {
		createdAt: 1000,
		members: [{ name: "builder", task: "Change schema", repo: "app", status: "running", startedAt: 1000, step: "Running: npm test", lastTest: "pass: npm test", budgetExceededAt: 302000 }],
	} as QuestRecord;
	assert.equal(activeProgress(rec, 361000), "builder · 6m · Running: npm test · test pass: npm test · over 5m soft budget");
	rec.members[0].status = "done";
	assert.equal(activeProgress(rec, 361000), undefined);
});

test("one worker keeps the edit and test in one dispatch and records the observed test", async () => {
	let calls = 0;
	const updates: string[] = [];
	const result = await runFastWrite({
		brief: "Change schema", context: { name: "repo", path: process.cwd(), writable: true }, config: DEFAULT_CONFIG,
		onProgress: (members) => updates.push(`${members[0].step ?? "started"} ${members[0].lastTest ?? ""}`),
		runWorker: async (options) => {
			calls++;
			assert.ok(options.extraTools?.includes("shell"));
			assert.ok(options.customTools?.some((tool) => tool.name === "shell"));
			options.onUpdate?.({ guildmate: "builder", tier: "builder", task: "Change schema", finalText: "", toolCalls: [{ name: "edit", args: { path: "schema.ts" } }, { name: "shell", args: { command: "npm test" } }], lastShellResult: { id: "test-1", command: "npm test", exitCode: 0 }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } });
			return { guildmate: "builder", tier: "builder", task: "Change schema", finalText: "# Schema change\n\nTesting: npm test passed", toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } };
		},
	});
	assert.equal(calls, 1);
	assert.match(result.report, /Schema change/);
	assert.equal(result.members[0].lastTest, "pass: npm test");
	assert.ok(updates.some((u) => u.includes("Running: npm test")));
	assert.equal(result.members[0].status, "done");
});
