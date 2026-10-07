import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { briefConflict, reviewSensitiveDiff } from "../src/orchestration/write-review.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Guildmate } from "../src/roster.ts";

const warden: Guildmate = { name: "warden", tier: "read-only", description: "security", model: "capable", filePath: "fixture", systemPrompt: "review" };

test("actual changed and untracked files trigger an independent review before commit", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "guild-review-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
	try {
		git("init", "-q", "-b", "main");
		git("config", "user.email", "test@localhost");
		git("config", "user.name", "Test");
		fs.writeFileSync(path.join(cwd, "app.js"), "export const flag = false;\n");
		git("add", ".");
		git("commit", "-qm", "base");
		const baseRef = git("rev-parse", "HEAD");
		fs.writeFileSync(path.join(cwd, "app.js"), "export const token = 'new';\n");
		fs.writeFileSync(path.join(cwd, "notes.js"), "export const note = 'changed';\n");
		const isolation = { repo: "fixture", worktreePath: cwd, repoRoot: cwd, baseRef, branch: "main" };
		let task = "";
		const runReviewer = async (options: Parameters<typeof import("../src/execution/child-agent.ts").runChildAgent>[0]) => {
			task = options.task;
			return { guildmate: "warden", tier: "read-only", task, finalText: "No material issues.\nVERDICT: PASS", toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } };
		};
		const result = await reviewSensitiveDiff({ isolation, brief: "Update app", roster: [warden], config: DEFAULT_CONFIG, runReviewer });
		assert.equal(result.member?.status, "done");
		assert.match(task, /export const token/);
		assert.match(task, /notes\.js \(untracked\)/);
		assert.equal(result.verdict, "pass");
		// A BLOCK is a finding to iterate on, returned in full, not a thrown Quest failure.
		const blocked = await reviewSensitiveDiff({ isolation, brief: "Update app", roster: [warden], config: DEFAULT_CONFIG,
			runReviewer: async (options) => ({ ...(await runReviewer(options)), finalText: `VERDICT: BLOCK\nUnsafe.${"x".repeat(3000)}` }),
		});
		assert.equal(blocked.verdict, "block");
		assert.ok(blocked.verdict === "block" && blocked.findings.length > 3000, "findings are not cut to a fragment");
		// The reviewer sees the harness-observed checks, and can flag a brief conflict.
		await reviewSensitiveDiff({ isolation, brief: "Update app", roster: [warden], config: DEFAULT_CONFIG, runReviewer, checks: [{ command: "npm test", exitCode: 0 }] });
		assert.match(task, /npm test → exit 0/);
		assert.match(task, /BRIEF-CONFLICT:/);
		const conflicted = await reviewSensitiveDiff({ isolation, brief: "Update app", roster: [warden], config: DEFAULT_CONFIG,
			runReviewer: async (options) => ({ ...(await runReviewer(options)), finalText: "Bad.\nBRIEF-CONFLICT: the brief forbids the fix\nVERDICT: BLOCK" }),
		});
		assert.ok(conflicted.verdict === "block" && conflicted.briefConflict === "the brief forbids the fix");
		assert.equal(briefConflict("no marker\nVERDICT: BLOCK"), undefined);
		// A reviewer that could not run is still fail-closed.
		await assert.rejects(() => reviewSensitiveDiff({ isolation, brief: "Update app", roster: [warden], config: DEFAULT_CONFIG,
			runReviewer: async (options) => ({ ...(await runReviewer(options)), error: "model down" }),
		}), /could not run/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
