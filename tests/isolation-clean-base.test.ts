/**
 * Regression test for clean-base isolation.
 *
 * A write-Quest worktree must branch from the repo's canonical default branch
 * (origin/HEAD → origin/main …), NOT from whatever the user currently has checked
 * out. This pins the fix for the incident where a Quest branched off an unmerged
 * WIP branch and that WIP silently looked like the Quest's own output.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveCleanBase } from "../src/execution/isolation.ts";

let tmp: string;
let work: string;

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	}).toString();
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gm-isolation-"));
	const origin = path.join(tmp, "origin.git");
	work = path.join(tmp, "work");

	git(["init", "--bare", "-b", "main", origin], tmp);
	git(["init", "-b", "main", work], tmp);
	git(["config", "commit.gpgsign", "false"], work);
	fs.writeFileSync(path.join(work, "README.md"), "base\n");
	git(["add", "-A"], work);
	git(["commit", "-m", "initial on main"], work);
	git(["remote", "add", "origin", origin], work);
	git(["push", "-u", "origin", "main"], work);
	// Establish refs/remotes/origin/HEAD -> refs/remotes/origin/main.
	git(["remote", "set-head", "origin", "main"], work);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveCleanBase picks origin/main, not the checked-out WIP branch", () => {
	const mainSha = git(["rev-parse", "HEAD"], work).trim();

	// Simulate the user's in-progress work: a WIP branch with an extra commit, checked out.
	git(["checkout", "-b", "fm/wip"], work);
	fs.writeFileSync(path.join(work, "wip.txt"), "in progress\n");
	git(["add", "-A"], work);
	git(["commit", "-m", "wip commit"], work);
	const wipSha = git(["rev-parse", "HEAD"], work).trim();
	assert.notEqual(wipSha, mainSha);

	const base = resolveCleanBase(work);
	assert.equal(base.ref, "origin/main");
	assert.equal(base.sha, mainSha, "must branch off origin/main, never the checked-out WIP tip");
});

test("resolveCleanBase falls back to HEAD when there is no remote base", () => {
	const noRemote = fs.mkdtempSync(path.join(os.tmpdir(), "gm-noremote-"));
	try {
		git(["init", "-b", "trunk", noRemote], tmp); // non-standard branch, no origin
		git(["config", "commit.gpgsign", "false"], noRemote);
		fs.writeFileSync(path.join(noRemote, "f.txt"), "x\n");
		git(["add", "-A"], noRemote);
		git(["commit", "-m", "only commit"], noRemote);
		const head = git(["rev-parse", "HEAD"], noRemote).trim();

		const base = resolveCleanBase(noRemote);
		assert.equal(base.ref, "HEAD");
		assert.equal(base.sha, head);
	} finally {
		fs.rmSync(noRemote, { recursive: true, force: true });
	}
});
