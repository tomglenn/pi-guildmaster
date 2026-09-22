/**
 * Host agent bash tool gate: ensures the Guildmaster own destructive shell
 * actions require explicit human approval. Child agents are structurally sandboxed
 * (no bash tool) and the envoy/runner shells are policy-gated separately; this
 * addresses the hole where the HOST itself had the raw bash tool ungated.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyHostCommand } from "../src/execution/policy.ts";
import { gateHostCommand } from "../src/execution/host-gate.ts";

const DESTRUCTIVE = [
	"gh pr edit 456 --add-label bug",
	"gh repo delete owner/repo",
	"git push --force",
	"git push -f",
	"git push origin main --force-with-lease",
	"git push --delete origin my-branch",
	"git push origin :my-branch",
	"git branch -D my-branch",
	"git branch -d old-feature",
	"git reset --hard",
	"git reset --hard HEAD~1",
	"git clean -fd",
	"git clean -df",
	"gh api -X DELETE repos/owner/repo/git/refs/heads/branch",
	"gh api --method DELETE /repos/owner/repo/pulls/123",
	"rm -rf node_modules",
	"rm -fr /tmp/build",
	"gh pr close 1953",
	"gh pr close 1953 --delete-branch",
	"gh pr delete 456",
];

const MUTATE = [
	"git push",
	"git push -u origin main",
	"gh pr create --draft --title WIP",
	"gh pr comment 123 --body LGTM",
	"gh pr review 456 --approve",
	"gh api -X POST repos/owner/repo/issues",
	"gh issue create --title Bug",
];

const FORBIDDEN = [
	"gh pr merge 123",
	"gh pr merge 456 --auto",
];

const READ = [
	"ls -la",
	"cat README.md",
	"grep -r TODO src/",
	"git status",
	"git log --oneline",
	"git diff",
	"git add -A",
	"git commit -m wip",
	"git checkout -b feature",
	"gh pr view 123",
	"gh pr list --state open",
	"gh repo view owner/repo",
	"npm test",
	"npm run build",
	"rm file.txt",
	"rm -f old.log",
];

test("classifyHostCommand recognizes destructive operations", () => {
	for (const cmd of DESTRUCTIVE) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "destructive", `expected DESTRUCTIVE: ${cmd} (got: ${c.klass})`);
		assert.ok(c.operation && c.operation.length > 0, `expected operation for: ${cmd}`);
		assert.ok(c.reason && c.reason.length > 0, `expected reason for: ${cmd}`);
	}
});

test("classifyHostCommand recognizes mutations", () => {
	for (const cmd of MUTATE) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "mutate", `expected MUTATE: ${cmd} (got: ${c.klass})`);
	}
});

test("classifyHostCommand recognizes forbidden operations", () => {
	for (const cmd of FORBIDDEN) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "forbidden", `expected FORBIDDEN: ${cmd} (got: ${c.klass})`);
	}
});

test("classifyHostCommand recognizes read operations", () => {
	for (const cmd of READ) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "read", `expected READ: ${cmd} (got: ${c.klass})`);
	}
});

test("gateHostCommand blocks forbidden operations", () => {
	for (const cmd of FORBIDDEN) {
		const g = gateHostCommand(cmd);
		assert.ok(g.blocked, `expected BLOCKED: ${cmd}`);
		assert.ok(!g.needsApproval, `forbidden should not need approval: ${cmd}`);
	}
});

test("gateHostCommand requires approval for destructive operations", () => {
	for (const cmd of DESTRUCTIVE) {
		const g = gateHostCommand(cmd);
		assert.ok(!g.blocked, `destructive should not be hard-blocked: ${cmd}`);
		assert.ok(g.needsApproval, `expected NEEDS_APPROVAL: ${cmd}`);
	}
});

test("gateHostCommand requires approval for mutations", () => {
	for (const cmd of MUTATE) {
		const g = gateHostCommand(cmd);
		assert.ok(!g.blocked, `mutation should not be hard-blocked: ${cmd}`);
		assert.ok(g.needsApproval, `expected NEEDS_APPROVAL: ${cmd}`);
	}
});

test("gateHostCommand allows read operations", () => {
	for (const cmd of READ) {
		const g = gateHostCommand(cmd);
		assert.ok(!g.blocked, `read should not be blocked: ${cmd}`);
		assert.ok(!g.needsApproval, `read should not need approval: ${cmd}`);
	}
});

test("regular git push (no force, no delete) is mutate, not destructive", () => {
	const c = classifyHostCommand("git push -u origin main");
	assert.equal(c.klass, "mutate", "regular push is mutate");
});

test("gh api DELETE is destructive", () => {
	const c = classifyHostCommand("gh api -X DELETE repos/o/r/git/refs/heads/x");
	assert.equal(c.klass, "destructive");
});

test("gh api POST/PUT/PATCH are mutate, not destructive", () => {
	const commands = [
		"gh api -X POST repos/o/r/issues",
		"gh api --method PUT /repos/o/r/pulls/1",
		"gh api -X PATCH repos/o/r/issues/2",
	];
	for (const cmd of commands) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "mutate", `${cmd} should be mutate`);
	}
});

test("rm -rf is destructive", () => {
	const c = classifyHostCommand("rm -rf node_modules");
	assert.equal(c.klass, "destructive");
});

// Shell wrapper bypass tests
test("shell wrapper with destructive inner command requires approval", () => {
	const destructiveWrappers = [
		'bash -c "gh pr close 123"',
		"sh -c 'git push --force'",
		'/bin/bash -c "rm -rf /tmp"',
		"eval 'gh pr delete 456'",
	];
	for (const cmd of destructiveWrappers) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "destructive", `shell wrapper should expose destructive: ${cmd}`);
		assert.ok(c.operation.includes("shell -c:"), `operation should indicate shell wrapper: ${c.operation}`);
	}
});

test("shell wrapper with read inner command is allowed", () => {
	const readWrappers = [
		'bash -c "ls -la"',
		"sh -c 'cat README.md'",
		"eval 'git status'",
	];
	for (const cmd of readWrappers) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "read", `shell wrapper with read inner should be read: ${cmd}`);
	}
});

// Command substitution tests
test("command substitution is blocked", () => {
	const substitutions = [
		"echo $(gh pr close 123)",
		"ls `rm -rf /tmp`",
		"git commit -m $(date)",
		"cat `find . -name '*.txt'`",
	];
	for (const cmd of substitutions) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "destructive", `command substitution should be blocked: ${cmd}`);
		assert.ok(c.reason.includes("substitution"), `reason should mention substitution: ${c.reason}`);
	}
});

// Flag variant tests
test("rm flag variants are all destructive", () => {
	const variants = [
		"rm -rf /tmp",
		"rm -fr /tmp",
		"rm -RF /tmp",
		"rm -Rf /tmp",
		"rm -rF /tmp",
		"rm -Fr /tmp",
		"rm -rfv /tmp",
	];
	for (const cmd of variants) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "destructive", `${cmd} should be destructive`);
	}
});

test("gh api method variants", () => {
	const deleteVariants = [
		"gh api -X DELETE /repos/o/r",
		"gh api --method DELETE /repos/o/r",
		"gh api --method=DELETE /repos/o/r",
	];
	for (const cmd of deleteVariants) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "destructive", `${cmd} should be destructive`);
	}
});

test("git push force-with-lease variants", () => {
	const variants = [
		"git push --force-with-lease",
		"git push --force-with-lease=origin/main",
		"git push origin main --force-with-lease=origin/main",
	];
	for (const cmd of variants) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "destructive", `${cmd} should be destructive`);
	}
});

// Chained command tests
test("chained commands with destructive segment are blocked", () => {
	const chained = [
		"ls && gh pr close 123",
		"cat README.md || rm -rf /tmp",
		"git status ; git push --force",
		"echo done | gh pr delete 456",
	];
	for (const cmd of chained) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "destructive", `chained destructive should be caught: ${cmd}`);
	}
});

test("chained read commands are allowed", () => {
	const chained = [
		"ls && cat README.md",
		"git status ; git log",
		"echo test | grep test",
	];
	for (const cmd of chained) {
		const c = classifyHostCommand(cmd);
		assert.equal(c.klass, "read", `chained reads should be allowed: ${cmd}`);
	}
});
