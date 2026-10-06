/**
 * The runner (exec tier) does LOCAL work only. This is the policy gate that stops
 * a write-Quest party from pushing a branch or opening/merging a PR out of band,
 * bypassing the gated raise path. Local git and reads must still pass through.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { gateRunnerCommand } from "../src/execution/policy.ts";
import { createRunnerShellTool } from "../src/execution/runner-shell.ts";

const mockCtx: any = { cwd: process.cwd() };

const BLOCKED = [
	"git push",
	"git push -u origin my-branch",
	"gh pr create --draft --title x",
	"gh pr merge 123",
	"gh api --method POST repos/o/r/pulls",
	"gh api -X DELETE repos/o/r/git/refs/heads/x",
	// A mutation cannot ride in behind an innocent first segment.
	"npm test && git push",
	"npm run build; gh pr create",
];

const ALLOWED = [
	"git add -A",
	"git commit -m 'wip'",
	"git checkout -b feature",
	"git status",
	"git log --oneline",
	"npm test",
	"npm run lint && npm run typecheck",
	"gh pr view 12",
	"gh pr list --state open",
	"gh api repos/o/r/pulls", // read (no write method)
];

test("gateRunnerCommand blocks every remote mutation and merge", () => {
	for (const cmd of BLOCKED) {
		const g = gateRunnerCommand(cmd);
		assert.ok(g.blocked, `expected BLOCKED: ${cmd}`);
		assert.ok(g.reason && g.reason.length > 0, `expected a reason for: ${cmd}`);
	}
});

test("gateRunnerCommand allows local git, builds/tests, and gh reads", () => {
	for (const cmd of ALLOWED) {
		const g = gateRunnerCommand(cmd);
		assert.ok(!g.blocked, `expected ALLOWED: ${cmd} (got: ${g.reason})`);
	}
});

test("git push points the runner at the raise path", () => {
	const g = gateRunnerCommand("git push");
	assert.match(g.reason ?? "", /raise_pr/);
});

test("runner shell refuses a push before spawning anything", async () => {
	const tool = createRunnerShellTool({ cwd: mockCtx.cwd });
	const result = await tool.execute("t", { command: "git push -u origin x" }, undefined, undefined, mockCtx);
	assert.equal((result.details as any).blocked, true);
	assert.equal((result.details as any).refused, true);
	assert.match((result.content[0] as any).text, /REFUSED/);
});

test("runner shell still runs an ordinary local command", async () => {
	const tool = createRunnerShellTool({ cwd: mockCtx.cwd });
	const result = await tool.execute("t", { command: 'node -e "console.log(42)"' }, undefined, undefined, mockCtx);
	assert.ok(!(result.details as any).blocked, "local command must not be blocked");
	assert.ok((result.content[0] as any).text.includes("42"));
});

// Nested-exec git commands export GIT_DIR, which sends test fixtures' git writes to the
// user's real repo (regression: a quest set core.bare=true on the user's checkout).
for (const c of [
	"git rebase --exec 'npm test' main",
	"git rebase -x 'npm test' 9851d0a",
	"git rebase --exec='npm run typecheck' main",
	"git rebase -ix 'npm test' main",
	"npm run build && git rebase -x 'npm test' main",
	"git bisect run npm test",
]) {
	test(`runner refuses nested-exec git: ${c}`, () => {
		const g = gateRunnerCommand(c);
		assert.equal(g.blocked, true);
		assert.match(g.reason ?? "", /GIT_DIR/);
	});
}

for (const c of ["git rebase main", "git rebase -i main", "git rebase --continue", "git bisect start", "git log --exec-path"]) {
	test(`runner still allows ordinary git: ${c}`, () => {
		assert.equal(gateRunnerCommand(c).blocked, false);
	});
}

test("scrubGitRepoEnv removes repo-pinning git vars and keeps the rest", async () => {
	const { scrubGitRepoEnv } = await import("../src/execution/runner-shell.ts");
	const out = scrubGitRepoEnv({ GIT_DIR: "/x/.git", GIT_WORK_TREE: "/x", GIT_AUTHOR_NAME: "a", PATH: "/bin" });
	assert.equal(out.GIT_DIR, undefined);
	assert.equal(out.GIT_WORK_TREE, undefined);
	assert.equal(out.GIT_AUTHOR_NAME, "a");
	assert.equal(out.PATH, "/bin");
});
