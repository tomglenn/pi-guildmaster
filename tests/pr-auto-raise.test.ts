import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { raisePr, type PrDeps, type RaiseResult } from "../src/orchestration/pr.ts";
import type { QuestRecord, QuestPr, QuestIsolation } from "../src/persistence/quest-store.ts";

function makeRecord(prs: Partial<QuestPr>[], isolations: Partial<QuestIsolation>[] = []): QuestRecord {
	return {
		id: "test-quest",
		title: "Test Quest",
		brief: "Test brief",
		state: "completed",
		cwd: "/tmp/test",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		members: [],
		prs: prs.map((p, i) => ({
			repo: p.repo ?? `repo${i}`,
			branch: p.branch ?? "guildmaster/test-branch",
			title: p.title ?? "Test PR",
			body: p.body ?? "Test body",
			draft: p.draft ?? true,
			...p,
		})),
		isolations: isolations.map((iso, i) => ({
			repo: iso.repo ?? `repo${i}`,
			branch: iso.branch ?? "guildmaster/test-branch",
			baseRef: iso.baseRef ?? "abc123",
			baseLabel: iso.baseLabel ?? "main",
			worktreePath: iso.worktreePath ?? `/tmp/worktree${i}`,
			repoRoot: iso.repoRoot ?? "/tmp/repo",
		})),
	};
}

describe("raisePr", () => {
	test("raises a draft PR with no approval needed", async () => {
		const record = makeRecord(
			[{ repo: "test-repo", url: undefined }],
			[{ repo: "test-repo", worktreePath: "/tmp/test" }]
		);
		
		const mockGit = mock.fn(async () => "");
		const mockGh = mock.fn(async () => "https://github.com/test/test/pull/1\n");

		const result = await raisePr(record, {
			runGit: mockGit as any,
			runGh: mockGh as any,
		});

		assert.equal(result.raised, 1);
		assert.equal(result.results[0].raised, true);
		assert.equal(result.results[0].url, "https://github.com/test/test/pull/1");
		assert.equal(record.prs![0].url, "https://github.com/test/test/pull/1");
	});

	test("handles network failure gracefully without throwing", async () => {
		const record = makeRecord(
			[{ repo: "test-repo", url: undefined }],
			[{ repo: "test-repo", worktreePath: "/tmp/test" }]
		);

		const mockGit = mock.fn(async () => { throw new Error("Network timeout"); });

		const result = await raisePr(record, {
			runGit: mockGit as any,
			runGh: mock.fn() as any,
		});

		assert.equal(result.raised, 0);
		assert.equal(result.results[0].raised, false);
		assert.ok(result.results[0].reason.includes("Network timeout"));
	});

	test("partial success in cross-repo Quest - first succeeds, second fails", async () => {
		const record = makeRecord(
			[
				{ repo: "repo-a", url: undefined },
				{ repo: "repo-b", url: undefined },
			],
			[
				{ repo: "repo-a", worktreePath: "/tmp/a" },
				{ repo: "repo-b", worktreePath: "/tmp/b" },
			]
		);

		const mockGit = mock.fn(async (args: string[], cwd: string) => {
			if (args[0] === "push" && cwd === "/tmp/b") throw new Error("Push failed for repo-b");
			return "";
		});
		const mockGh = mock.fn(async () => "https://github.com/test/a/pull/1\n");

		const result = await raisePr(record, {
			runGit: mockGit as any,
			runGh: mockGh as any,
		});

		assert.equal(result.raised, 1);
		assert.equal(result.results[0].raised, true);
		assert.equal(result.results[0].url, "https://github.com/test/a/pull/1");
		assert.equal(result.results[1].raised, false);
		assert.match(result.results[1].reason, /Couldn't open the draft PR: Push failed for repo-b\. The branch/);
		// First PR URL should be preserved
		assert.equal(record.prs![0].url, "https://github.com/test/a/pull/1");
		assert.equal(record.prs![1].url, undefined);
	});

	test("a security-looking change is raised like any other: the party owns security review", async () => {
		const record = makeRecord([{ repo: "test-repo", title: "Fix SQL injection vulnerability", url: undefined }], [{ repo: "test-repo", worktreePath: "/tmp/test" }]);
		const result = await raisePr(record, { runGit: mock.fn(async () => "") as any, runGh: mock.fn(async () => "https://github.com/o/r/pull/9\n") as any });
		assert.equal(result.raised, 1);
	});

	test("refuses to publish when the added diff contains a secret, naming the kind and place, never the value", async () => {
		const record = makeRecord([{ repo: "test-repo", url: undefined }], [{ repo: "test-repo", worktreePath: "/tmp/test" }]);
		const runGit = mock.fn(async (args: string[]) => (args[0] === "diff" ? "+++ b/src/x.js\n@@ -0,0 +1 @@\n+const t = 'xoxb-1234567890-abcdefghij';" : ""));
		const runGh = mock.fn(async () => "");
		const result = await raisePr(record, { runGit: runGit as any, runGh: runGh as any });
		assert.equal(result.raised, 0);
		assert.equal(result.results[0].refused, true);
		assert.match(result.results[0].reason, /Slack token at src\/x\.js:1/);
		assert.doesNotMatch(result.results[0].reason, /xoxb-/);
		assert.ok(!runGit.mock.calls.some((c) => (c.arguments[0] as string[])[0] === "push"), "nothing pushed");
		assert.equal(runGh.mock.callCount(), 0);
	});

	test("refuses to publish an internal chat link in the PR body", async () => {
		const record = makeRecord([{ repo: "test-repo", body: "Context: https://acme.slack.com/archives/C012AB3CD/p123", url: undefined }], [{ repo: "test-repo", worktreePath: "/tmp/test" }]);
		const result = await raisePr(record, { runGit: mock.fn(async () => "") as any, runGh: mock.fn(async () => "") as any });
		assert.match(result.results[0].reason, /Slack message link at PR body line 1/);
	});

	test("push failures read as one plain sentence, not raw git output", async () => {
		const { explainPushFailure } = await import("../src/orchestration/pr.ts");
		const raw = "Command failed: git push -u origin b\nfatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.";
		assert.equal(explainPushFailure(raw, "b"), "Couldn't push: this repo has no `origin` remote. The branch `b` is kept.");
		assert.match(explainPushFailure("fatal: Authentication failed for 'https://github.com/x'", "b"), /authentication failed/);
	});

	test("skips already-raised PRs", async () => {
		const record = makeRecord(
			[{ repo: "test-repo", url: "https://github.com/test/test/pull/1" }],
			[{ repo: "test-repo", worktreePath: "/tmp/test" }]
		);

		const result = await raisePr(record, {
			runGit: mock.fn() as any,
			runGh: mock.fn() as any,
		});

		assert.equal(result.raised, 0);
		assert.ok(result.results[0].reason.includes("no un-raised"));
	});
});
