import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { reviewSensitiveDiff } from "../src/orchestration/write-review.ts";
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
		await assert.rejects(() => reviewSensitiveDiff({ isolation, brief: "Update app", roster: [warden], config: DEFAULT_CONFIG,
			runReviewer: async (options) => ({ ...(await runReviewer(options)), finalText: "VERDICT: BLOCK\nUnsafe." }),
		}), /did not pass/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
