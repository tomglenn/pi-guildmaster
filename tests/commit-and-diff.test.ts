/**
 * Regression tests for the "Write Quest produced no changes" false failure.
 *
 * Root cause: commitAndDiff decided `committed` from the staged index after
 * `git add -A`, so a member (runner) that had already run `git commit` in the
 * worktree left nothing staged and the Quest was failed despite real commits on
 * the branch. `committed` now means "branch has commits ahead of baseRef".
 *
 * Uses real temp repos + a real `git worktree` (as production does), with the
 * user's git config isolated so signing/hooks/templates cannot leak in.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { GuildmasterConfig } from "../src/config.ts";
import { commitAndDiff, commitsAhead, type Isolation } from "../src/execution/isolation.ts";
import { buildSystemPrompt } from "../src/orchestration/party-leader.ts";
import { explainUnraisable } from "../src/orchestration/pr.ts";
import type { QuestRecord } from "../src/persistence/quest-store.ts";

// commitAndDiff's git() inherits process.env, so the isolation env is set there too.
const GIT_ENV: Record<string, string> = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};
const savedEnv: Record<string, string | undefined> = {};

before(() => {
	for (const [k, v] of Object.entries(GIT_ENV)) {
		savedEnv[k] = process.env[k];
		process.env[k] = v;
	}
});

after(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

let tmp: string;
let iso: Isolation;

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...GIT_ENV },
	}).toString();
}

/** A member committing in the worktree during the Quest (e.g. runner after `make generate`). */
function memberCommit(file: string, content: string): void {
	fs.writeFileSync(path.join(iso.worktreePath, file), content);
	git(["add", "-A"], iso.worktreePath);
	git(["commit", "-m", `member: ${file}`], iso.worktreePath);
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gm-commit-diff-"));
	const repoRoot = path.join(tmp, "repo");
	git(["init", "-b", "main", repoRoot], tmp);
	fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n");
	git(["add", "-A"], repoRoot);
	git(["commit", "-m", "initial"], repoRoot);
	const baseRef = git(["rev-parse", "HEAD"], repoRoot).trim(); // full SHA, as in production
	const branch = "guildmaster/test-abcd";
	const worktreePath = path.join(tmp, "wt");
	git(["worktree", "add", "-b", branch, worktreePath, baseRef], repoRoot);
	iso = { repo: "repo", branch, worktreePath, baseRef, baseLabel: "origin/main", repoRoot };
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("regression: a member's commit with a clean tree counts as committed", () => {
	memberCommit("feature.ts", "export const x = 1;\n");
	assert.equal(git(["status", "--porcelain"], iso.worktreePath).trim(), "", "tree is clean before finalize");

	const result = commitAndDiff(iso, "harness commit");
	assert.equal(result.committed, true);
	assert.match(result.stat, /feature\.ts/);
	assert.match(result.diff, /export const x = 1;/);
	assert.equal(commitsAhead(iso), 1, "no extra harness commit when nothing was left over");
});

test("a truly empty branch is not committed and has an empty diff", () => {
	const result = commitAndDiff(iso, "harness commit");
	assert.equal(result.committed, false);
	assert.equal(result.stat, "");
	assert.equal(result.diff, "");
	assert.equal(commitsAhead(iso), 0);
});

test("uncommitted changes only: the harness commits them", () => {
	fs.writeFileSync(path.join(iso.worktreePath, "new-file.ts"), "// new\n");

	const result = commitAndDiff(iso, "harness commit");
	assert.equal(result.committed, true);
	assert.match(result.stat, /new-file\.ts/);
	assert.equal(commitsAhead(iso), 1);
	assert.equal(git(["log", "-1", "--format=%s"], iso.worktreePath).trim(), "harness commit");
});

test("a member commit plus leftover changes: 2 commits ahead, both files in the stat", () => {
	memberCommit("alpha.ts", "export const a = 1;\n");
	fs.writeFileSync(path.join(iso.worktreePath, "beta.ts"), "export const b = 2;\n");

	const result = commitAndDiff(iso, "harness commit");
	assert.equal(result.committed, true);
	assert.equal(commitsAhead(iso), 2);
	assert.match(result.stat, /alpha\.ts/);
	assert.match(result.stat, /beta\.ts/);
});

test("a member commit plus junk-only leftovers: committed, junk not committed", () => {
	memberCommit("feature.ts", "export const x = 1;\n");
	fs.writeFileSync(path.join(iso.worktreePath, "IMPLEMENTATION_PLAN.md"), "# plan\n");

	const result = commitAndDiff(iso, "harness commit");
	assert.equal(result.committed, true);
	assert.equal(commitsAhead(iso), 1, "junk alone must not produce a harness commit");
	assert.match(result.stat, /feature\.ts/);
	assert.doesNotMatch(result.stat, /IMPLEMENTATION_PLAN\.md/);
	const tracked = git(["ls-tree", "-r", "--name-only", "HEAD"], iso.worktreePath);
	assert.doesNotMatch(tracked, /IMPLEMENTATION_PLAN\.md/);
});

test("commitsAhead propagates git errors instead of reporting 0", () => {
	assert.throws(() => commitsAhead({ ...iso, worktreePath: path.join(tmp, "missing") }));
});

// ── raise_pr's explanation for a Quest with no un-raised draft PR ──────────────

function failedRecord(): QuestRecord {
	return {
		id: "2026-10-06_10-59-25_dhkl",
		title: "backend change",
		brief: "b",
		cwd: "/tmp",
		state: "failed",
		error: "Write Quest produced no changes",
		createdAt: 0,
		updatedAt: 0,
		members: [],
		isolations: [
			{
				repo: "grafana-pathfinder-backend",
				branch: "guildmaster/backend-dhkl",
				worktreePath: "/wt/backend",
				baseRef: "1e4865767588422fd02a193e3dc937770e4a7570",
				baseLabel: "origin/main",
				repoRoot: "/repo",
			},
		],
		prs: [],
	};
}

test("explainUnraisable: commits ahead → names the branch and the manual push / draft-PR commands", () => {
	const msg = explainUnraisable(failedRecord(), () => 2);
	assert.match(msg, /failed: Write Quest produced no changes/);
	assert.match(msg, /grafana-pathfinder-backend/);
	assert.match(msg, /guildmaster\/backend-dhkl/);
	assert.match(msg, /\/wt\/backend/);
	assert.match(msg, /2 commit\(s\) ahead of origin\/main/);
	assert.ok(msg.includes("git -C /wt/backend push -u origin guildmaster/backend-dhkl"));
	assert.ok(msg.includes("gh pr create --draft --head guildmaster/backend-dhkl"));
	assert.match(msg, /no draft PR was recorded/);
});

test("explainUnraisable: nothing ahead → nothing to raise", () => {
	const msg = explainUnraisable(failedRecord(), () => 0);
	assert.match(msg, /no commits ahead of base/);
	assert.match(msg, /nothing to raise/);
	assert.doesNotMatch(msg, /push -u origin/);
});

test("explainUnraisable: unknown count (missing worktree) is handled", () => {
	const msg = explainUnraisable(failedRecord(), () => undefined);
	assert.match(msg, /nothing to raise/);
	assert.match(msg, /may be missing/);
	assert.doesNotMatch(msg, /push -u origin/);
});

test("write-mode leader prompt says the harness commits leftover changes", () => {
	const prompt = (write: boolean) =>
		buildSystemPrompt("base", [], {} as GuildmasterConfig, write, [], undefined, undefined, false, false, "<<<R>>>", "<<<E>>>", undefined, false);
	const text = prompt(true);
	assert.match(text, /harness commits any changes left in the worktree/);
	assert.match(text, /Commits a member makes are kept and count as changes/);
	assert.doesNotMatch(prompt(false), /harness commits any changes/);
});
