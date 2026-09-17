/**
 * Tests for raisePr's UPDATE path: when a Quest carries `sourcePr`, raising must
 * fast-forward push to the existing PR's branch (updating it) rather than opening
 * a new PR — and must refuse (never force-push) if the push is rejected.
 * git/gh are injected; no network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { raisePr, type CommandRunner } from "../src/orchestration/pr.ts";
import type { ApprovalManager } from "../src/orchestration/approvals.ts";
import type { QuestRecord } from "../src/persistence/quest-store.ts";

const approveAll = { request: async () => true } as unknown as ApprovalManager;
const denyAll = { request: async () => false } as unknown as ApprovalManager;

function baseRecord(overrides: Partial<QuestRecord> = {}): QuestRecord {
	return {
		id: "2026-01-01_00-00-00_test",
		title: "Address review feedback",
		brief: "b",
		cwd: "/tmp/repo",
		state: "completed",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		members: [],
		report: "done",
		isolations: [{ repo: "app", branch: "guildmaster/pr-1942-test", worktreePath: "/tmp/wt", baseRef: "abc", repoRoot: "/tmp/repo" }],
		prs: [{ repo: "app", branch: "guildmaster/pr-1942-test", title: "Fix feedback", body: "addresses review", draft: false }],
		...overrides,
	};
}

test("update path fast-forward pushes to the existing PR and opens no new PR", async () => {
	const gitCalls: string[][] = [];
	const ghCalls: string[][] = [];
	const runGit: CommandRunner = async (args) => {
		gitCalls.push(args);
		return "";
	};
	const runGh: CommandRunner = async (args) => {
		ghCalls.push(args);
		return "";
	};
	const record = baseRecord({
		sourcePr: { number: 1942, url: "https://github.com/grafana/grafana-pathfinder-app/pull/1942", headBranch: "guildmaster/fix-x", slug: "grafana/grafana-pathfinder-app", repo: "app" },
	});

	const result = await raisePr(record, { approvals: approveAll, runGit, runGh });

	assert.equal(result.raised, 1);
	assert.match(result.results[0].reason, /Updated existing PR #1942/);
	assert.equal(result.results[0].url, "https://github.com/grafana/grafana-pathfinder-app/pull/1942");
	// A plain `git push` (fast-forward), never a force push.
	assert.ok(gitCalls.some((a) => a.join(" ") === "push"), "expected a plain `git push`");
	assert.ok(!gitCalls.some((a) => a.includes("--force") || a.includes("-f")), "must never force-push");
	// No new PR created.
	assert.ok(!ghCalls.some((a) => a.includes("create")), "must not run gh pr create on update");
	// The draft PR entry now points at the existing PR.
	assert.equal(record.prs?.[0].url, "https://github.com/grafana/grafana-pathfinder-app/pull/1942");
	assert.equal(record.prs?.[0].number, 1942);
});

test("update path refuses (does not force) when push is rejected as non-fast-forward", async () => {
	const runGit: CommandRunner = async (args) => {
		if (args.join(" ") === "push") throw new Error("! [rejected] (non-fast-forward)");
		return "";
	};
	const runGh: CommandRunner = async () => "";
	const record = baseRecord({
		sourcePr: { number: 1942, url: "https://github.com/grafana/grafana-pathfinder-app/pull/1942", headBranch: "guildmaster/fix-x", slug: "grafana/grafana-pathfinder-app", repo: "app" },
	});

	const result = await raisePr(record, { approvals: approveAll, runGit, runGh });

	assert.equal(result.raised, 0);
	assert.match(result.results[0].reason, /diverged|non-fast-forward|rebase/i);
	assert.equal(record.prs?.[0].url, undefined); // not marked as raised
});

test("update path respects denial without pushing", async () => {
	const gitCalls: string[][] = [];
	const runGit: CommandRunner = async (args) => {
		gitCalls.push(args);
		return "";
	};
	const record = baseRecord({
		sourcePr: { number: 1942, url: "u", headBranch: "guildmaster/fix-x", repo: "app" },
	});

	const result = await raisePr(record, { approvals: denyAll, runGit, runGh: async () => "" });
	assert.equal(result.raised, 0);
	assert.ok(!gitCalls.some((a) => a.join(" ") === "push"), "must not push when denied");
});

test("create path still opens a new PR when there is no sourcePr", async () => {
	const ghCalls: string[][] = [];
	const runGit: CommandRunner = async () => "";
	const runGh: CommandRunner = async (args) => {
		ghCalls.push(args);
		return "https://github.com/grafana/grafana-pathfinder-app/pull/2000\n";
	};
	const record = baseRecord(); // no sourcePr

	const result = await raisePr(record, { approvals: approveAll, runGit, runGh });
	assert.equal(result.raised, 1);
	assert.match(result.results[0].reason, /Raised as a draft PR/);
	assert.ok(ghCalls.some((a) => a.includes("create")), "expected gh pr create on the create path");
	assert.equal(record.prs?.[0].url, "https://github.com/grafana/grafana-pathfinder-app/pull/2000");
});
