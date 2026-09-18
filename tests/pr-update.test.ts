/**
 * Tests for raisePr's UPDATE path: when a Quest carries `sourcePr`, raising must
 * fast-forward push to the existing PR's branch (updating it) rather than opening
 * a new PR — and must refuse (never force-push) if the push is rejected.
 * git/gh are injected; no network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { raisePr, type CommandRunner } from "../src/orchestration/pr.ts";
import type { QuestRecord } from "../src/persistence/quest-store.ts";

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

	const result = await raisePr(record, { runGit, runGh });

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

test("update path replies to and resolves addressed threads, best-effort", async () => {
	const ghCalls: string[][] = [];
	const runGit: CommandRunner = async () => "";
	const runGh: CommandRunner = async (args) => {
		ghCalls.push(args);
		return "";
	};
	const record = baseRecord({
		sourcePr: {
			number: 1942,
			url: "https://github.com/grafana/grafana-pathfinder-app/pull/1942",
			headBranch: "guildmaster/fix-x",
			slug: "grafana/grafana-pathfinder-app",
			repo: "app",
			threads: [
				{ threadId: "T_human", commentId: 111, author: "Jayclifford345" },
				{ threadId: "T_bot", commentId: 333, author: "cursor[bot]" },
			],
		},
	});

	const result = await raisePr(record, { runGit, runGh });
	assert.equal(result.raised, 1);
	assert.match(result.results[0].reason, /Replied to\/resolved 2\/2 thread/);
	// A reply POST + a resolve mutation per thread.
	assert.ok(ghCalls.some((a) => a.join(" ").includes("pulls/1942/comments/111/replies")), "expected reply to human comment");
	assert.ok(ghCalls.some((a) => a.join(" ").includes("resolveReviewThread")), "expected a resolveReviewThread mutation");
});

test("a failing reply/resolve never fails the push", async () => {
	const runGit: CommandRunner = async () => "";
	const runGh: CommandRunner = async (args) => {
		if (args.includes("graphql") || args.join(" ").includes("replies")) throw new Error("boom");
		return "";
	};
	const record = baseRecord({
		sourcePr: {
			number: 1942,
			url: "u",
			headBranch: "guildmaster/fix-x",
			slug: "grafana/grafana-pathfinder-app",
			repo: "app",
			threads: [{ threadId: "T_human", commentId: 111, author: "Jayclifford345" }],
		},
	});
	const result = await raisePr(record, { runGit, runGh });
	assert.equal(result.raised, 1); // push still succeeded
	assert.match(result.results[0].reason, /Updated existing PR #1942/);
	assert.match(result.results[0].reason, /0\/1 thread/);
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

	const result = await raisePr(record, { runGit, runGh });

	assert.equal(result.raised, 0);
	assert.match(result.results[0].reason, /diverged|non-fast-forward|rebase/i);
	assert.equal(record.prs?.[0].url, undefined); // not marked as raised
});

test("update path (address-feedback) pushes WITHOUT asking for approval", async () => {
	const gitCalls: string[][] = [];
	const runGit: CommandRunner = async (args) => {
		gitCalls.push(args);
		return "";
	};
	const record = baseRecord({
		sourcePr: { number: 1942, url: "https://github.com/grafana/grafana-pathfinder-app/pull/1942", headBranch: "guildmaster/fix-x", slug: "grafana/grafana-pathfinder-app", repo: "app" },
	});

	// No approvals dep exists any more; the update must push on its own.
	const result = await raisePr(record, { runGit, runGh: async () => "" });
	assert.equal(result.raised, 1);
	assert.ok(gitCalls.some((a) => a.join(" ") === "push"), "address-feedback must push without a gate");
});

test("create path still opens a new PR when there is no sourcePr", async () => {
	const ghCalls: string[][] = [];
	const runGit: CommandRunner = async () => "";
	const runGh: CommandRunner = async (args) => {
		ghCalls.push(args);
		// No existing PR for the branch → reconciliation finds nothing, create runs.
		if (args[0] === "pr" && args[1] === "list") return "[]";
		return "https://github.com/grafana/grafana-pathfinder-app/pull/2000\n";
	};
	const record = baseRecord(); // no sourcePr

	const result = await raisePr(record, { runGit, runGh });
	assert.equal(result.raised, 1);
	assert.match(result.results[0].reason, /Raised as a draft PR/);
	assert.ok(ghCalls.some((a) => a.includes("create")), "expected gh pr create on the create path");
	assert.equal(record.prs?.[0].url, "https://github.com/grafana/grafana-pathfinder-app/pull/2000");
});

test("create path opens a draft WITHOUT asking for approval", async () => {
	const ghCalls: string[][] = [];
	const runGit: CommandRunner = async () => "";
	const runGh: CommandRunner = async (args) => {
		ghCalls.push(args);
		if (args[0] === "pr" && args[1] === "list") return "[]";
		return "https://github.com/grafana/grafana-pathfinder-app/pull/3001\n";
	};
	const record = baseRecord(); // no sourcePr

	// There is no approvals dependency at all: a draft is for the human to review.
	const result = await raisePr(record, { runGit, runGh });
	assert.equal(result.raised, 1, "a draft PR is opened with no approval gate");
	assert.ok(ghCalls.some((a) => a.includes("create")), "expected gh pr create");
	assert.equal(record.prs?.[0].url, "https://github.com/grafana/grafana-pathfinder-app/pull/3001");
});

test("create path adopts an existing open PR instead of creating a duplicate", async () => {
	const gitCalls: string[][] = [];
	const ghCalls: string[][] = [];
	const runGit: CommandRunner = async (args) => {
		gitCalls.push(args);
		return "";
	};
	const runGh: CommandRunner = async (args) => {
		ghCalls.push(args);
		if (args[0] === "pr" && args[1] === "list") {
			return JSON.stringify([{ url: "https://github.com/grafana/grafana-pathfinder-app/pull/1950", number: 1950 }]);
		}
		return "";
	};
	const record = baseRecord(); // no sourcePr

	const result = await raisePr(record, { runGit, runGh });
	assert.equal(result.raised, 1);
	assert.match(result.results[0].reason, /adopted PR #1950/i);
	assert.ok(gitCalls.some((a) => a.join(" ").startsWith("push")), "still pushes the latest commits");
	assert.ok(!ghCalls.some((a) => a.includes("create")), "must NOT create a duplicate PR");
	assert.equal(record.prs?.[0].url, "https://github.com/grafana/grafana-pathfinder-app/pull/1950");
	assert.equal(record.prs?.[0].number, 1950);
});
