/**
 * Regression tests for unsigned party commits (Bug 3).
 *
 * Root cause: neither commit path signed. The harness's commit in commitAndDiff
 * ran a bare `git commit` and the runner's shell spawned with
 * {...process.env, CI:"true"}, so with user.signingkey set but commit.gpgsign
 * unset git never signed, and a "Signed Commits" ruleset rejected the push (GH013).
 *
 * Fix: signingMode decides whether party commits are signed (explicit-on, or a key
 * with commit.gpgsign unset). The harness signs its own commit with a per-command
 * `-c commit.gpgsign=true`; commitAndDiff then re-signs any unsigned MEMBER commit in
 * base..HEAD with `git rebase --force-rebase --gpg-sign <base>` (aborting + throwing a
 * clear error on failure). Nothing is injected via GIT_CONFIG_* env, which would leak
 * into every repo a runner touches (e.g. a project's own test-fixture repos). An
 * explicit commit.gpgsign=false is respected. A push rejected by a signed-commits rule
 * gets an actionable message on both raise paths; a non-signature GH013 does not.
 *
 * Assumption: party commits in base..HEAD are unpublished, so rewriting them is safe.
 *
 * Uses real temp repos + a real `git worktree`, with the user's git config
 * isolated (GIT_CONFIG_GLOBAL → empty temp file, GIT_CONFIG_NOSYSTEM=1).
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { commitAndDiff, commitsAhead, signingMode, unsignedCommits, type Isolation } from "../src/execution/isolation.ts";
import { createRunnerShellTool } from "../src/execution/runner-shell.ts";
import { isSignatureRejection, raisePr, type CommandRunner } from "../src/orchestration/pr.ts";
import type { QuestRecord } from "../src/persistence/quest-store.ts";

const mockCtx: any = { cwd: process.cwd() };
const hasSshKeygen = spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error === undefined;

let configDir: string;
const savedEnv: Record<string, string | undefined> = {};

// commitAndDiff's git() and the runner shell inherit process.env, so isolation is set there.
before(() => {
	configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-signing-cfg-"));
	const globalConfig = path.join(configDir, "gitconfig");
	fs.writeFileSync(globalConfig, "");
	const env: Record<string, string | undefined> = {
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		// No agent: signing must work from the private key path alone.
		SSH_AUTH_SOCK: undefined,
		GIT_CONFIG_COUNT: undefined,
	};
	for (const [k, v] of Object.entries(env)) {
		savedEnv[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

after(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(configDir, { recursive: true, force: true });
});

let tmp: string;
let iso: Isolation;

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function isSigned(cwd: string, rev = "HEAD"): boolean {
	return git(["cat-file", "commit", rev], cwd)
		.split("\n\n")[0]
		.split("\n")
		.some((l) => l.startsWith("gpgsig"));
}

/** Every commit in base..HEAD, newest first. */
function branchCommits(): string[] {
	return git(["rev-list", `${iso.baseRef}..HEAD`], iso.worktreePath).split("\n").filter(Boolean);
}

/** A member's plain `git commit` in the worktree (no signing flags, like a runner's). */
function memberCommit(file: string, msg: string): string {
	fs.writeFileSync(path.join(iso.worktreePath, file), `// ${msg}\n`);
	git(["add", "-A"], iso.worktreePath);
	git(["commit", "-q", "-m", msg], iso.worktreePath);
	return git(["rev-parse", "HEAD"], iso.worktreePath).trim();
}

/** gpg.format=ssh + user.signingkey=<fresh ed25519 private key>, as in the user's global config. */
function configureSshSigning(): void {
	const key = path.join(tmp, "k");
	execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key, "-q"], { stdio: "ignore" });
	git(["config", "gpg.format", "ssh"], iso.repoRoot);
	git(["config", "user.signingkey", key], iso.repoRoot);
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gm-signing-"));
	const repoRoot = path.join(tmp, "repo");
	git(["init", "-b", "main", repoRoot], tmp);
	fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n");
	git(["add", "-A"], repoRoot);
	git(["commit", "-m", "initial"], repoRoot);
	const baseRef = git(["rev-parse", "HEAD"], repoRoot).trim();
	const branch = "guildmaster/test-sign";
	const worktreePath = path.join(tmp, "wt");
	git(["worktree", "add", "-b", branch, worktreePath, baseRef], repoRoot);
	iso = { repo: "repo", branch, worktreePath, baseRef, baseLabel: "origin/main", repoRoot };
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

// ── signingMode ───────────────────────────────────────────────────────────────

test("signingMode: nothing configured → none", () => {
	assert.equal(signingMode(iso.worktreePath), "none");
});

test("signingMode: commit.gpgsign=true / false → explicit-on / explicit-off", () => {
	git(["config", "commit.gpgsign", "true"], iso.repoRoot);
	assert.equal(signingMode(iso.worktreePath), "explicit-on");
	git(["config", "commit.gpgsign", "false"], iso.repoRoot);
	assert.equal(signingMode(iso.worktreePath), "explicit-off");
});

test("signingMode: git booleans yes / no are understood", () => {
	git(["config", "commit.gpgsign", "yes"], iso.repoRoot);
	assert.equal(signingMode(iso.worktreePath), "explicit-on");
	git(["config", "commit.gpgsign", "no"], iso.repoRoot);
	assert.equal(signingMode(iso.worktreePath), "explicit-off");
});

test("signingMode: explicit false wins over a configured key", () => {
	git(["config", "user.signingkey", "/nonexistent/key"], iso.repoRoot);
	git(["config", "commit.gpgsign", "false"], iso.repoRoot);
	assert.equal(signingMode(iso.worktreePath), "explicit-off");
});

test("signingMode: key set, commit.gpgsign unset → key-only; empty key → none", () => {
	git(["config", "user.signingkey", "/nonexistent/key"], iso.repoRoot);
	assert.equal(signingMode(iso.worktreePath), "key-only");
	git(["config", "user.signingkey", ""], iso.repoRoot);
	assert.equal(signingMode(iso.worktreePath), "none");
});

test("signingMode: an invalid commit.gpgsign value leaves the decision to git (explicit-on)", () => {
	git(["config", "commit.gpgsign", "maybe"], iso.repoRoot);
	assert.equal(signingMode(iso.worktreePath), "explicit-on");
});

// ── runner shell env ──────────────────────────────────────────────────────────

test("runner shell adds no GIT_CONFIG_* to the spawn env, even with a signing key", { timeout: 20_000 }, async () => {
	// key-only: the mode in which signing used to be injected via GIT_CONFIG_* env.
	git(["config", "user.signingkey", "/nonexistent/key"], iso.repoRoot);
	assert.equal(process.env.GIT_CONFIG_COUNT, undefined, "base env has no GIT_CONFIG_COUNT");
	const tool = createRunnerShellTool({ cwd: iso.worktreePath });
	const result = await tool.execute("env-1", { command: "env" }, undefined, undefined, mockCtx);
	const out = (result.content[0] as any).text as string;
	assert.equal((result.details as any).exitCode, 0, out);
	assert.match(out, /^CI=true$/m, "env output was captured");
	assert.doesNotMatch(out, /GIT_CONFIG_KEY/);
	assert.doesNotMatch(out, /GIT_CONFIG_COUNT/);
});

// ── real signing (ssh key, no agent) ──────────────────────────────────────────

const skip = hasSshKeygen ? false : "ssh-keygen not available";

test("commitAndDiff signs the harness commit when only a signing key is configured", { skip }, () => {
	configureSshSigning();
	fs.writeFileSync(path.join(iso.worktreePath, "feature.ts"), "export const x = 1;\n");

	const result = commitAndDiff(iso, "harness commit");
	assert.equal(result.committed, true);
	assert.ok(isSigned(iso.worktreePath), "harness commit must carry a gpgsig header");
});

test("an unsigned member commit is re-signed by commitAndDiff (key configured, gpgsign unset)", { skip }, () => {
	configureSshSigning();
	memberCommit("gen.ts", "member commit");
	assert.equal(isSigned(iso.worktreePath), false, "precondition: a plain member commit is unsigned");
	fs.writeFileSync(path.join(iso.worktreePath, "feature.ts"), "export const x = 1;\n");

	const result = commitAndDiff(iso, "harness commit");
	assert.equal(result.committed, true);
	const commits = branchCommits();
	assert.equal(commits.length, 2);
	for (const sha of commits) assert.ok(isSigned(iso.worktreePath, sha), `${sha} must carry a gpgsig header`);
	assert.deepEqual(unsignedCommits(iso), []);
	assert.deepEqual(git(["log", "--format=%s", `${iso.baseRef}..HEAD`], iso.worktreePath).trim().split("\n"), ["harness commit", "member commit"]);
	assert.match(result.stat, /gen\.ts/);
	assert.match(result.stat, /feature\.ts/);
});

test("a runner's shell commit is re-signed by commitAndDiff", { skip, timeout: 20_000 }, async () => {
	configureSshSigning();
	fs.writeFileSync(path.join(iso.worktreePath, "gen.ts"), "// generated\n");
	const tool = createRunnerShellTool({ cwd: iso.worktreePath });
	const result = await tool.execute("sign-1", { command: "git add -A && git commit -q -m runner" }, undefined, undefined, mockCtx);
	assert.equal((result.details as any).exitCode, 0, (result.content[0] as any).text);

	const changes = commitAndDiff(iso, "harness commit");
	assert.equal(changes.committed, true);
	assert.deepEqual(branchCommits().filter((sha) => !isSigned(iso.worktreePath, sha)), []);
});

test("commit.gpgsign=false with a key: the member commit stays unsigned and untouched", { skip }, () => {
	configureSshSigning();
	git(["config", "commit.gpgsign", "false"], iso.repoRoot);
	const sha = memberCommit("gen.ts", "member commit");

	const result = commitAndDiff(iso, "harness commit");
	assert.equal(result.committed, true);
	assert.equal(git(["rev-parse", "HEAD"], iso.worktreePath).trim(), sha, "not rewritten");
	assert.equal(isSigned(iso.worktreePath), false);
});

test("no signing key: the member commit is left untouched", () => {
	const sha = memberCommit("gen.ts", "member commit");

	const result = commitAndDiff(iso, "harness commit");
	assert.equal(result.committed, true);
	assert.equal(git(["rev-parse", "HEAD"], iso.worktreePath).trim(), sha, "not rewritten");
	assert.equal(isSigned(iso.worktreePath), false);
});

test("re-signing failure throws a clear error and leaves the branch tip unchanged", () => {
	// Member commits first (plain, unsigned), then point the key at a missing file.
	const sha = memberCommit("gen.ts", "member commit");
	git(["config", "gpg.format", "ssh"], iso.repoRoot);
	git(["config", "user.signingkey", path.join(tmp, "missing-key")], iso.repoRoot);

	assert.throws(() => commitAndDiff(iso, "harness commit"), (e: Error) => {
		assert.match(e.message, /re-sign/i);
		assert.match(e.message, /signing is configured/i);
		assert.match(e.message, /ssh-add/);
		assert.ok(e.message.includes(`git -C ${iso.worktreePath} rebase --force-rebase --gpg-sign ${iso.baseRef}`), e.message);
		assert.match(e.message, /commit\.gpgsign=false/);
		// The restore is checked, not assumed, and the original tip is named.
		assert.ok(e.message.includes(`branch was restored to its original tip ${sha}`), e.message);
		assert.doesNotMatch(e.message, /NOT restored/);
		return true;
	});
	assert.equal(git(["rev-parse", "HEAD"], iso.worktreePath).trim(), sha, "branch tip unchanged");
	assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], iso.worktreePath).trim(), iso.branch, "rebase aborted, still on the branch");
	assert.equal(git(["status", "--porcelain"], iso.worktreePath).trim(), "", "worktree clean");
});

/** Signing applies (key-only) but the key is missing, so any actual rebase would fail. */
function configureMissingKey(): void {
	git(["config", "gpg.format", "ssh"], iso.repoRoot);
	git(["config", "user.signingkey", path.join(tmp, "missing-key")], iso.repoRoot);
}

test("re-sign refuses a range containing a merge commit and leaves the tip unchanged", () => {
	memberCommit("a.ts", "member a");
	git(["checkout", "-q", "-b", "side", iso.baseRef], iso.worktreePath);
	memberCommit("b.ts", "side b");
	git(["checkout", "-q", iso.branch], iso.worktreePath);
	git(["merge", "-q", "--no-ff", "-m", "merge side", "side"], iso.worktreePath);
	const tip = git(["rev-parse", "HEAD"], iso.worktreePath).trim();
	configureMissingKey();

	assert.throws(() => commitAndDiff(iso, "harness commit"), (e: Error) => {
		assert.match(e.message, /merge commit/);
		assert.match(e.message, /can't be safely re-signed automatically/);
		assert.match(e.message, /Nothing was rewritten/);
		assert.ok(e.message.includes(iso.worktreePath), e.message);
		return true;
	});
	assert.equal(git(["rev-parse", "HEAD"], iso.worktreePath).trim(), tip, "tip unchanged");
	assert.equal(git(["rev-list", "--merges", `${iso.baseRef}..HEAD`], iso.worktreePath).trim(), tip, "merge kept");
});

test("re-sign refuses when tracked changes remain uncommitted, without rewriting", () => {
	// NOTES.md is root junk: the harness unstages it, so its tracked edit stays uncommitted.
	const sha = memberCommit("NOTES.md", "member notes");
	fs.writeFileSync(path.join(iso.worktreePath, "NOTES.md"), "edited\n");
	configureMissingKey();

	assert.throws(() => commitAndDiff(iso, "harness commit"), (e: Error) => {
		assert.match(e.message, /uncommitted changes to tracked files/);
		assert.match(e.message, /not rewritten/);
		return true;
	});
	assert.equal(git(["rev-parse", "HEAD"], iso.worktreePath).trim(), sha, "tip unchanged");
	assert.equal(fs.readFileSync(path.join(iso.worktreePath, "NOTES.md"), "utf-8"), "edited\n", "the edit is left in place");
});

test("commit.gpgsign=false is respected by both the runner and the harness", { skip, timeout: 20_000 }, async () => {
	configureSshSigning();
	git(["config", "commit.gpgsign", "false"], iso.repoRoot);

	fs.writeFileSync(path.join(iso.worktreePath, "gen.ts"), "// generated\n");
	const tool = createRunnerShellTool({ cwd: iso.worktreePath });
	const result = await tool.execute("sign-2", { command: "git add -A && git commit -q -m runner" }, undefined, undefined, mockCtx);
	assert.equal((result.details as any).exitCode, 0, (result.content[0] as any).text);
	assert.equal(isSigned(iso.worktreePath), false, "runner commit must not be signed");

	fs.writeFileSync(path.join(iso.worktreePath, "feature.ts"), "export const x = 1;\n");
	commitAndDiff(iso, "harness commit");
	assert.equal(git(["log", "-1", "--format=%s"], iso.worktreePath).trim(), "harness commit");
	assert.equal(isSigned(iso.worktreePath), false, "harness commit must not be signed");
});

test("a signing failure throws a clear error and never falls back to an unsigned commit", () => {
	git(["config", "gpg.format", "ssh"], iso.repoRoot);
	git(["config", "user.signingkey", path.join(tmp, "missing-key")], iso.repoRoot);
	fs.writeFileSync(path.join(iso.worktreePath, "feature.ts"), "export const x = 1;\n");

	assert.throws(() => commitAndDiff(iso, "harness commit"), (e: Error) => {
		assert.match(e.message, /Signing the commit failed/);
		assert.ok(e.message.includes(iso.worktreePath), "names the worktree holding the changes");
		assert.match(e.message, /commit\.gpgsign=false/);
		return true;
	});
	assert.equal(commitsAhead(iso), 0, "no unsigned fallback commit");
	assert.match(git(["status", "--porcelain"], iso.worktreePath), /feature\.ts/, "the change is still uncommitted");
});

// ── raise_pr: a signed-commits rule rejecting the push ────────────────────────

function gh013(): Error {
	// execFile errors carry git's stderr separately from the message.
	return Object.assign(new Error("Command failed: git push"), {
		stderr:
			"remote: error: GH013: Repository rule violations found for refs/heads/guildmaster/x.\n" +
			"remote: - Commits must have verified signatures.\n",
	});
}

function prRecord(overrides: Partial<QuestRecord> = {}): QuestRecord {
	return {
		id: "2026-10-06_10-59-25_dhkl",
		title: "backend change",
		brief: "b",
		cwd: "/tmp/repo",
		state: "completed",
		createdAt: 0,
		updatedAt: 0,
		members: [],
		report: "done",
		isolations: [{ repo: "backend", branch: "guildmaster/x", worktreePath: "/wt/backend", baseRef: "1e48657", repoRoot: "/tmp/repo" }],
		prs: [{ repo: "backend", branch: "guildmaster/x", title: "Change", body: "body", draft: true }],
		...overrides,
	};
}

const sourcePr = { number: 1942, url: "https://github.com/grafana/app/pull/1942", headBranch: "feature", slug: "grafana/app", repo: "backend" };

test("new-PR path: a GH013 rejection explains signing and how to re-sign", async () => {
	const ghCalls: string[][] = [];
	const runGit: CommandRunner = async (args) => {
		if (args[0] === "push") throw gh013();
		return "";
	};
	const runGh: CommandRunner = async (args) => {
		ghCalls.push(args);
		return "";
	};
	const record = prRecord();
	const result = await raisePr(record, { runGit, runGh });

	assert.equal(result.raised, 0);
	const reason = result.results[0].reason;
	assert.match(reason, /verified/);
	assert.ok(reason.includes("git -C /wt/backend rebase --force-rebase --gpg-sign 1e48657"), reason);
	assert.match(reason, /raise_pr/);
	assert.match(reason, /GH013/, "keeps the GH013 header of the raw error");
	assert.ok(reason.includes("Commits must have verified signatures"), "keeps the raw violation line");
	assert.equal(ghCalls.length, 0, "no PR created after a rejected push");
	assert.equal(record.prs?.[0].url, undefined);
});

test("update path: a GH013 rejection re-signs on top of the PR head recorded at attach", async () => {
	const runGit: CommandRunner = async (args) => {
		if (args[0] === "push") throw gh013();
		return "";
	};
	const record = prRecord({ sourcePr });
	const result = await raisePr(record, { runGit, runGh: async () => "" });

	assert.equal(result.raised, 0);
	const reason = result.results[0].reason;
	assert.match(reason, /verified/);
	assert.ok(reason.includes("rebase --force-rebase --gpg-sign 1e48657"), reason);
	assert.match(reason, /raise_pr/);
	assert.doesNotMatch(reason, /diverged/);
	assert.equal(record.prs?.[0].url, undefined);
});

function nonSignatureGh013(): Error {
	return Object.assign(new Error("Command failed: git push"), {
		stderr:
			"remote: error: GH013: Repository rule violations found for refs/heads/guildmaster/x.\n" +
			"remote: - Changes must be made through a pull request.\n",
	});
}

test("isSignatureRejection: needs signature text, a bare GH013 does not count", () => {
	const raw = (e: Error) => `${(e as any).stderr}\n${e.message}`;
	assert.equal(isSignatureRejection(raw(gh013())), true);
	assert.equal(isSignatureRejection(raw(nonSignatureGh013())), false);
	assert.equal(isSignatureRejection("remote: GH013"), false);
	assert.equal(isSignatureRejection("remote: - Commits must be signed"), true);
});

test("new-PR path: a non-signature GH013 keeps the generic failure message", async () => {
	const runGit: CommandRunner = async (args) => {
		if (args[0] === "push") throw nonSignatureGh013();
		return "";
	};
	const result = await raisePr(prRecord(), { runGit, runGh: async () => "" });

	assert.equal(result.raised, 0);
	assert.match(result.results[0].reason, /^Push\/PR creation failed/);
	assert.doesNotMatch(result.results[0].reason, /verified|gpg-sign|signed/);
});

test("update path: a non-signature GH013 keeps the diverged message", async () => {
	const runGit: CommandRunner = async (args) => {
		if (args[0] === "push") throw nonSignatureGh013();
		return "";
	};
	const result = await raisePr(prRecord({ sourcePr }), { runGit, runGh: async () => "" });

	assert.equal(result.raised, 0);
	assert.match(result.results[0].reason, /Push to PR #1942 rejected \(branch likely diverged/);
	assert.doesNotMatch(result.results[0].reason, /verified|gpg-sign/);
});

test("update path: a non-fast-forward rejection still gives the diverged message", async () => {
	const runGit: CommandRunner = async (args) => {
		if (args[0] === "push") {
			throw Object.assign(new Error("Command failed: git push\n! [rejected] HEAD -> feature (non-fast-forward)"), {
				stderr: "! [rejected] HEAD -> feature (non-fast-forward)\n",
			});
		}
		return "";
	};
	const result = await raisePr(prRecord({ sourcePr }), { runGit, runGh: async () => "" });

	assert.equal(result.raised, 0);
	assert.match(result.results[0].reason, /Push to PR #1942 rejected \(branch likely diverged \/ non-fast-forward\)/);
	assert.doesNotMatch(result.results[0].reason, /verified|gpg-sign/);
});
