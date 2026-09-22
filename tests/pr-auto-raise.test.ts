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
			confirmSecurity: undefined,
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
			confirmSecurity: undefined,
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

		let callCount = 0;
		const mockGit = mock.fn(async () => {
			callCount++;
			if (callCount > 1) throw new Error("Push failed for repo-b");
			return "";
		});
		const mockGh = mock.fn(async () => "https://github.com/test/a/pull/1\n");

		const result = await raisePr(record, {
			runGit: mockGit as any,
			runGh: mockGh as any,
			confirmSecurity: undefined,
		});

		assert.equal(result.raised, 1);
		assert.equal(result.results[0].raised, true);
		assert.equal(result.results[0].url, "https://github.com/test/a/pull/1");
		assert.equal(result.results[1].raised, false);
		assert.ok(result.results[1].reason.includes("Push failed"));
		// First PR URL should be preserved
		assert.equal(record.prs![0].url, "https://github.com/test/a/pull/1");
		assert.equal(record.prs![1].url, undefined);
	});

	test("refuses security-looking PR when confirmSecurity is undefined", async () => {
		const record = makeRecord(
			[{ repo: "test-repo", title: "Fix SQL injection vulnerability", url: undefined }],
			[{ repo: "test-repo", worktreePath: "/tmp/test" }]
		);

		const mockGit = mock.fn(async (args: string[]) => {
			if (args[0] === "remote") return "https://github.com/other/repo.git";
			return "";
		});

		const result = await raisePr(record, {
			runGit: mockGit as any,
			runGh: mock.fn() as any,
			confirmSecurity: undefined, // defaults to refuse
		});

		assert.equal(result.raised, 0);
		assert.equal(result.results[0].raised, false);
		assert.equal(result.results[0].refused, true);
		assert.ok(result.results[0].reason.includes("Security-fix"));
	});

	test("blocks grafana/grafana first-party security fix (org policy)", async () => {
		const record = makeRecord(
			[{ repo: "grafana", title: "Fix authentication bypass", url: undefined }],
			[{ repo: "grafana", worktreePath: "/tmp/grafana" }]
		);

		const mockGit = mock.fn(async (args: string[]) => {
			if (args[0] === "remote") return "https://github.com/grafana/grafana.git";
			return "";
		});

		const result = await raisePr(record, {
			runGit: mockGit as any,
			runGh: mock.fn() as any,
			confirmSecurity: async () => true, // even with confirm, should be blocked
		});

		assert.equal(result.raised, 0);
		assert.equal(result.results[0].raised, false);
		assert.equal(result.results[0].refused, true);
		assert.ok(result.results[0].reason.includes("grafana/grafana"));
		assert.ok(result.results[0].reason.includes("org policy"));
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
