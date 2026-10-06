/**
 * Regression tests for Bug 4: a Quest left `running` forever with no live leader.
 *
 * Two gaps let a dead or hung run read as running indefinitely:
 *  - hydrateCache (quest.ts) never reconciled a non-terminal record with no live run,
 *    so one left by a crashed/killed process stayed `running` on disk, in /quests and
 *    in quest_status. Now `reconcileOrphans` fails it using the recorded owner pid.
 *  - runSession awaits `session.prompt` with no budget, so a leader that went silent
 *    after its members finished could hold the Quest `running` with no activity. Now a
 *    stall watchdog in run() aborts it, and a grace timer settles run() even if the
 *    executor ignores the abort; late executor writes are fenced off.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { LEADER_STALL_MS, QuestManager, type QuestRunApi } from "../src/orchestration/quest.ts";
import { newQuestId, type QuestRecord, type QuestState, QuestStore } from "../src/persistence/quest-store.ts";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-orphan-"));
	dirs.push(dir);
	return dir;
}

/** Write a record straight to disk (store.save would bump updatedAt and enforce the report rule). */
function writeRecord(dir: string, fields: { state: QuestState; ownerPid?: number; updatedAt?: number; report?: string }): QuestRecord {
	const now = Date.now();
	const rec: QuestRecord = {
		id: newQuestId(),
		title: "Quest",
		brief: "b",
		cwd: "/tmp",
		createdAt: now,
		members: [],
		...fields,
		updatedAt: fields.updatedAt ?? now,
	};
	fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
	return rec;
}

/** The pid of a child that has already exited (and been reaped), so signalling it gives ESRCH. */
function deadPid(): number {
	const pid = spawnSync(process.execPath, ["-e", ""]).pid;
	assert.ok(pid, "spawnSync must report the child's pid");
	return pid;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keep the event loop alive while an executor only waits on an abort signal (the watchdog interval is unref'd). */
async function keepAlive<T>(fn: () => Promise<T>): Promise<T> {
	const handle = setInterval(() => {}, 1000);
	try {
		return await fn();
	} finally {
		clearInterval(handle);
	}
}

const waitForAbort = (api: QuestRunApi) =>
	new Promise<void>((resolve) => {
		if (api.signal.aborted) resolve();
		else api.signal.addEventListener("abort", () => resolve(), { once: true });
	});

// ── Orphan reconcile ────────────────────────────────────────────────────────

test("a running Quest whose owner process is dead is failed as orphaned and persisted (via hydration)", () => {
	const dir = tmpDir();
	const pid = deadPid();
	const rec = writeRecord(dir, { state: "running", ownerPid: pid });

	const board = new QuestManager(new QuestStore(dir)).getBoardRecords();
	const found = board.find((r) => r.id === rec.id);
	assert.ok(found, "the orphan must show on the board, as failed");
	assert.equal(found.state, "failed");
	assert.match(found.error ?? "", /orphaned/);
	assert.match(found.error ?? "", new RegExp(`was running, owner pid ${pid}`));

	const onDisk = new QuestStore(dir).load(rec.id);
	assert.equal(onDisk?.state, "failed", "the failed state is persisted, not just cached");
	assert.match(onDisk?.error ?? "", /orphaned/);
});

test("a Quest owned by a live other process is left untouched", () => {
	const dir = tmpDir();
	const rec = writeRecord(dir, { state: "running", ownerPid: process.ppid });
	const list = new QuestManager(new QuestStore(dir)).reconcileOrphans();
	assert.equal(list.find((r) => r.id === rec.id)?.state, "running");
	assert.equal(new QuestStore(dir).load(rec.id)?.state, "running");
});

test("a Quest owned by THIS pid but not in this manager's active map is left untouched", () => {
	const dir = tmpDir();
	const rec = writeRecord(dir, { state: "running", ownerPid: process.pid });
	new QuestManager(new QuestStore(dir)).reconcileOrphans(Date.now() + LEADER_STALL_MS * 10);
	assert.equal(new QuestStore(dir).load(rec.id)?.state, "running");
});

test("a legacy Quest with no owner pid is orphaned only once it has been idle longer than LEADER_STALL_MS", () => {
	const dir = tmpDir();
	const now = Date.now();
	const recent = writeRecord(dir, { state: "running", updatedAt: now - 60_000 });
	const old = writeRecord(dir, { state: "running", updatedAt: now - LEADER_STALL_MS - 60_000 });

	new QuestManager(new QuestStore(dir)).reconcileOrphans(now);
	const store = new QuestStore(dir);
	assert.equal(store.load(recent.id)?.state, "running");
	assert.equal(store.load(old.id)?.state, "failed");
	assert.match(store.load(old.id)?.error ?? "", /owner pid unknown/);
});

test("an awaiting-input Quest whose owner process is dead is failed as orphaned", () => {
	const dir = tmpDir();
	const rec = writeRecord(dir, { state: "awaiting-input", ownerPid: deadPid() });
	new QuestManager(new QuestStore(dir)).reconcileOrphans();
	const onDisk = new QuestStore(dir).load(rec.id);
	assert.equal(onDisk?.state, "failed");
	assert.match(onDisk?.error ?? "", /was awaiting-input/);
});

test("an orphan with no report keeps the on-disk leader.md as its partial report", () => {
	const dir = tmpDir();
	const rec = writeRecord(dir, { state: "running", ownerPid: deadPid() });
	const store = new QuestStore(dir);
	fs.writeFileSync(store.leaderOutputPath(rec.id), "Members done; drafting the summary");

	new QuestManager(store).reconcileOrphans();
	const onDisk = new QuestStore(dir).load(rec.id);
	assert.equal(onDisk?.state, "failed");
	assert.ok(onDisk?.report?.startsWith("_Partial output: the quest was orphaned before finishing._\n\n"), onDisk?.report);
	assert.match(onDisk?.report ?? "", /Members done; drafting the summary/);
	assert.ok(onDisk?.error?.includes(store.leaderOutputPath(rec.id)), "the error points at the real leader.md path");
});

test("an orphan with no leader.md gets no invented report, and an existing report is kept", () => {
	const dir = tmpDir();
	const bare = writeRecord(dir, { state: "running", ownerPid: deadPid() });
	const withReport = writeRecord(dir, { state: "awaiting-approval", ownerPid: deadPid(), report: "# Drafted review" });
	const store = new QuestStore(dir);
	fs.writeFileSync(store.leaderOutputPath(withReport.id), "older leader text");

	new QuestManager(store).reconcileOrphans();
	assert.equal(new QuestStore(dir).load(bare.id)?.report, undefined);
	assert.equal(new QuestStore(dir).load(withReport.id)?.report, "# Drafted review");
});

test("a completed Quest is never touched, even with a dead owner pid", () => {
	const dir = tmpDir();
	const rec = writeRecord(dir, { state: "completed", ownerPid: deadPid(), report: "# Done" });
	new QuestManager(new QuestStore(dir)).reconcileOrphans();
	const onDisk = new QuestStore(dir).load(rec.id);
	assert.equal(onDisk?.state, "completed");
	assert.equal(onDisk?.error, undefined);
});

// ── Stall watchdog ──────────────────────────────────────────────────────────

const timings = { stallMs: 80, stallCheckMs: 10, stallGraceMs: 50 };

function newManager(): { mgr: QuestManager; dir: string } {
	const dir = tmpDir();
	return { mgr: new QuestManager(new QuestStore(dir), timings), dir };
}

test("a silent leader that honours the abort is failed as stalled", async () => {
	const { mgr, dir } = newManager();
	const rec = mgr.create({ cwd: "/tmp", title: "Stall", brief: "b" });
	const out = await keepAlive(() =>
		mgr.run(rec, async (api) => {
			await waitForAbort(api);
			return { report: "too late" };
		}),
	);
	assert.equal(out.state, "failed");
	assert.match(out.error ?? "", /stalled/);
	assert.equal(out.report, undefined, "no partial text was noted, so no report is invented");
	assert.equal(new QuestStore(dir).load(rec.id)?.state, "failed");
});

test("a leader that never settles is failed within the grace period and cannot change the record afterwards", async () => {
	const { mgr, dir } = newManager();
	const rec = mgr.create({ cwd: "/tmp", title: "Hung", brief: "b" });
	const captured: { api?: QuestRunApi } = {};
	const started = Date.now();
	const out = await keepAlive(() =>
		mgr.run(rec, (api) => {
			captured.api = api;
			return new Promise(() => {});
		}),
	);
	const elapsed = Date.now() - started;
	assert.equal(out.state, "failed");
	assert.match(out.error ?? "", /stalled/);
	assert.ok(elapsed < 1000, `run() must settle within ~stallMs + grace, took ${elapsed} ms`);

	// The hung executor wakes up late: neither its member updates nor a state flip may land.
	assert.ok(captured.api);
	captured.api.setMembers([{ name: "scout", task: "t", status: "running" }]);
	mgr.transition(rec, "running");
	mgr.transition(rec, "awaiting-input");
	assert.equal(rec.state, "failed");
	const onDisk = new QuestStore(dir).load(rec.id);
	assert.equal(onDisk?.state, "failed");
	assert.deepEqual(onDisk?.members, []);
});

test("a long-running member never trips the watchdog", async () => {
	const { mgr } = newManager();
	const rec = mgr.create({ cwd: "/tmp", title: "Member", brief: "b" });
	const out = await mgr.run(rec, async (api) => {
		api.setMembers([{ name: "scout", task: "t", status: "running" }]);
		await sleep(200);
		api.setMembers([{ name: "scout", task: "t", status: "done" }]);
		return { report: "# Done" };
	});
	assert.equal(out.state, "completed", out.error);
});

test("a paused (awaiting-input) Quest never trips the watchdog, and resuming resets the idle clock", async () => {
	const { mgr } = newManager();
	const rec = mgr.create({ cwd: "/tmp", title: "Paused", brief: "b" });
	const out = await mgr.run(rec, async () => {
		mgr.transition(rec, "awaiting-input");
		await sleep(200);
		mgr.transition(rec, "running");
		await sleep(20);
		return { report: "# Done" };
	});
	assert.equal(out.state, "completed", out.error);
});

test("leader activity via api.touch() keeps the Quest alive", async () => {
	const { mgr } = newManager();
	const rec = mgr.create({ cwd: "/tmp", title: "Busy", brief: "b" });
	const out = await mgr.run(rec, async (api) => {
		for (let i = 0; i < 10; i++) {
			api.touch();
			await sleep(20);
		}
		return { report: "# Done" };
	});
	assert.equal(out.state, "completed", out.error);
});

test("api.save() persists the executor's direct record changes while the run is live", async () => {
	const { mgr, dir } = newManager();
	const rec = mgr.create({ cwd: "/tmp", title: "Save", brief: "b" });
	let midRun: QuestRecord | undefined;
	await mgr.run(rec, async (api) => {
		rec.raiseError = "push rejected";
		api.save();
		midRun = new QuestStore(dir).load(rec.id);
		return { report: "# Done" };
	});
	assert.equal(midRun?.raiseError, "push rejected");
});

test("a slow side effect that resolves after a stall cannot save over the failed record", async () => {
	const { mgr, dir } = newManager();
	const rec = mgr.create({ cwd: "/tmp", title: "Late raise", brief: "b" });
	let lateSaveAttempted = false;
	const lateDone = new Promise<void>((resolve) => {
		void mgr.run(rec, async (api) => {
			// Simulated raisePr that ignores the abort and resolves well after stall + grace.
			await sleep(300);
			// The executor wakes up late and, without checking the signal, tries its direct save.
			rec.state = "awaiting-approval";
			rec.prs = [{ repo: "r", branch: "b", title: "t", body: "x", draft: true, url: "https://example/pr/1" }];
			api.save();
			lateSaveAttempted = true;
			resolve();
			return { report: "# Done" };
		});
	});

	await lateDone;
	assert.ok(lateSaveAttempted);
	const onDisk = new QuestStore(dir).load(rec.id);
	assert.equal(onDisk?.state, "failed", "the stalled run stays failed on disk");
	assert.match(onDisk?.error ?? "", /stalled/);
	assert.equal(onDisk?.prs, undefined, "the late side effect was never persisted");
});

test("a slow side effect that resolves after a cancel, then saves, leaves the Quest cancelled", async () => {
	const { mgr, dir } = newManager();
	const rec = mgr.create({ cwd: "/tmp", title: "Cancelled raise", brief: "b" });
	const run = mgr.run(rec, async (api) => {
		api.setMembers([{ name: "runner", task: "t", status: "running" }]); // keep the watchdog out of it
		await sleep(60);
		rec.prs = [{ repo: "r", branch: "b", title: "t", body: "x", draft: true }];
		api.save();
		return { report: "# Done" };
	});
	mgr.cancel(rec.id);
	const out = await run;
	assert.equal(out.state, "cancelled");
	assert.equal(new QuestStore(dir).load(rec.id)?.state, "cancelled");
});

test("partial leader text noted before a stall is kept as the report", async () => {
	const { mgr, dir } = newManager();
	const rec = mgr.create({ cwd: "/tmp", title: "Partial", brief: "b" });
	const out = await keepAlive(() =>
		mgr.run(rec, async (api) => {
			api.notePartial("Half of a plan");
			await waitForAbort(api);
			throw new Error("Party aborted");
		}),
	);
	assert.equal(out.state, "failed");
	assert.match(out.error ?? "", /stalled/);
	assert.ok(out.report?.startsWith("_Partial output"), out.report);
	assert.match(out.report ?? "", /Half of a plan/);
	assert.ok(new QuestStore(dir).load(rec.id)?.report?.startsWith("_Partial output"));
});
