/**
 * Quest lifecycle orchestration (§5, §6).
 *
 *   created → running → (awaiting-approval) → completed | failed | cancelled
 *
 * The manager owns state transitions and persistence; the actual work is a
 * pluggable executor (a single Guildmate in tests, the Party Leader in practice).
 * State always reflects reality: `completed` requires a report, enforced by the
 * store; a cancelled run is recorded as cancelled even if the executor returned.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { discardIsolation } from "../execution/isolation.ts";
import { questScratchDir, questsDir, reportsDir } from "../paths.ts";
import {
	isTerminal,
	newQuestId,
	type QuestMember,
	type QuestRecord,
	type QuestState,
	QuestStore,
} from "../persistence/quest-store.ts";

export interface QuestRunApi {
	readonly record: Readonly<QuestRecord>;
	readonly signal: AbortSignal;
	/** Replace the party member list and persist. Drives the live TUI panel. */
	setMembers(members: QuestMember[]): void;
	/** Record liveness (e.g. a leader session event) for the stall watchdog. Does not persist. */
	touch(): void;
	/** Remember the leader's latest partial text, kept as the report if the watchdog fails the run. */
	notePartial(text: string): void;
	/** Persist the executor's direct record changes. A no-op once run() has settled (fenced). */
	save(): void;
}

/**
 * How long a running Quest may go with no activity while no party member is running
 * before the stall watchdog fails it. Also the age after which a legacy (pid-less)
 * non-terminal record with no live run is treated as orphaned.
 */
export const LEADER_STALL_MS = 20 * 60_000;

export interface QuestManagerTimings {
	stallMs?: number;
	stallCheckMs?: number;
	stallGraceMs?: number;
}

export interface QuestOutcome {
	report: string;
	usage?: { cost: number; turns: number };
}

export type QuestExecutor = (api: QuestRunApi) => Promise<QuestOutcome>;

interface ActiveQuest {
	controller: AbortController;
	cancelled: boolean;
	/** Last observed sign of life (member progress, state transition, leader event). */
	lastActivity: number;
	stalled: boolean;
	stallReason?: string;
	/** The leader's latest text, recorded as partial output on a stall. */
	partial?: string;
	/** run() has reached a terminal state: a late executor must not change the record. */
	settled: boolean;
}

/** True unless signalling the pid reports ESRCH (no such process). EPERM means it exists. */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export class QuestManager {
	readonly store: QuestStore;
	private readonly active = new Map<string, ActiveQuest>();
	private readonly listeners = new Set<(record: QuestRecord) => void>();
	private readonly recordCache = new Map<string, QuestRecord>();
	private cacheHydrated = false;
	private readonly stallMs: number;
	private readonly stallCheckMs: number;
	private readonly stallGraceMs: number;

	constructor(store: QuestStore = new QuestStore(), timings: QuestManagerTimings = {}) {
		this.store = store;
		this.stallMs = timings.stallMs ?? LEADER_STALL_MS;
		this.stallCheckMs = timings.stallCheckMs ?? 60_000;
		this.stallGraceMs = timings.stallGraceMs ?? 60_000;
		this.store.onSave((record) => this.updateCache(record));
	}

	/** Subscribe to any quest change (create + every persisted transition). */
	onChange(listener: (record: QuestRecord) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(record: QuestRecord): void {
		for (const l of this.listeners) l(record);
	}

	private updateCache(record: QuestRecord): void {
		if (record.acknowledgedAt) {
			this.recordCache.delete(record.id);
		} else {
			this.recordCache.set(record.id, record);
		}
	}

	/**
	 * Fail non-terminal records that no live process is running, so a Quest left `running`
	 * by a crashed/killed process does not show as running forever. A record is orphaned when
	 * its owner pid is another process that is dead, or (legacy, no pid) when it has not been
	 * updated for {@link LEADER_STALL_MS}. A record owned by THIS pid but absent from this
	 * manager's active map is left alone: a previous module generation in this process (e.g.
	 * before /reload) is still settling it. Reads `store.list()` once and returns that list
	 * (newest first) with any orphans updated in place, so callers need not re-read.
	 */
	reconcileOrphans(now: number = Date.now()): QuestRecord[] {
		const records = this.store.list();
		for (const rec of records) {
			if (isTerminal(rec.state) || this.active.has(rec.id)) continue;
			const pid = Number.isInteger(rec.ownerPid) && (rec.ownerPid as number) > 0 ? (rec.ownerPid as number) : undefined;
			if (pid === process.pid) continue;
			const orphaned = pid !== undefined ? !isProcessAlive(pid) : now - rec.updatedAt > LEADER_STALL_MS;
			if (!orphaned) continue;
			const was = rec.state;
			const leaderFile = this.store.leaderOutputPath(rec.id);
			rec.state = "failed";
			rec.error =
				`Quest orphaned: no live process is running it (was ${was}, owner pid ${pid ?? "unknown"}). ` +
				`Any commits on its branch are preserved; partial leader output, if any, is in ${leaderFile}.`;
			// Keep the leader's last completed message as the report, so dismiss preserves it.
			if (!rec.report?.trim()) {
				try {
					const partial = fs.readFileSync(leaderFile, "utf-8");
					if (partial.trim()) rec.report = `_Partial output: the quest was orphaned before finishing._\n\n${partial}`;
				} catch {
					/* best effort: no partial output on disk */
				}
			}
			this.store.save(rec);
			this.emit(rec);
		}
		return records;
	}

	private hydrateCache(): void {
		if (this.cacheHydrated) return;
		this.cacheHydrated = true;
		for (const rec of this.reconcileOrphans()) {
			if (this.active.has(rec.id) || (isTerminal(rec.state) && !rec.acknowledgedAt)) {
				this.recordCache.set(rec.id, rec);
			}
		}
	}

	/** Get all records that should appear on the Guild board (active + unacknowledged terminal). */
	getBoardRecords(): QuestRecord[] {
		this.hydrateCache();
		return [...this.recordCache.values()];
	}

	create(input: { cwd: string; title: string; brief: string; project?: string }): QuestRecord {
		const now = Date.now();
		const record: QuestRecord = {
			id: newQuestId(),
			title: input.title,
			brief: input.brief,
			cwd: input.cwd,
			project: input.project,
			state: "created",
			createdAt: now,
			updatedAt: now,
			members: [],
		};
		this.store.save(record);
		this.emit(record);
		return record;
	}

	/**
	 * Flip a still-running Quest's state (e.g. running ↔ awaiting-input around a
	 * `request_user` gate) and repaint. Persists + emits so the board reacts, but
	 * does NOT touch the active/terminal bookkeeping owned by `run`. Never use this
	 * to reach a terminal state — that is `run`'s job.
	 */
	transition(record: QuestRecord, state: QuestState): void {
		if (isTerminal(state)) throw new Error(`transition() cannot set terminal state "${state}"; that is run()'s job.`);
		// Fence: once run() has settled the record, a late executor cannot revive it.
		if (isTerminal(record.state)) return;
		record.state = state;
		const entry = this.active.get(record.id);
		if (entry) entry.lastActivity = Date.now();
		this.store.save(record);
		this.emit(record);
	}

	getActive(): QuestRecord[] {
		return [...this.active.keys()]
			.map((id) => this.recordCache.get(id))
			.filter((r): r is QuestRecord => Boolean(r));
	}

	cancel(id: string): boolean {
		const entry = this.active.get(id);
		if (!entry) return false;
		entry.cancelled = true;
		entry.controller.abort();
		return true;
	}

	/**
	 * Stand a Quest down and remove it. If it is still running, this cancels it and
	 * lets the run loop settle to `cancelled` (no record deleted, to avoid racing the
	 * executor's final persist). If it is terminal, this tears down any worktree
	 * isolations + branches, deletes the record and its diff artifacts, and emits a
	 * change so the Guild board repaints. In-place branches are left untouched.
	 */
	/**
	 * Preserve a Quest's report to the reports store so dismissing (which deletes the
	 * record) never silently loses the artifact. Best-effort; returns the file path
	 * when written. Only Quests that actually produced a report are saved.
	 */
	private persistReport(record: QuestRecord): string | undefined {
		if (!record.report?.trim()) return undefined;
		try {
			const dir = reportsDir();
			fs.mkdirSync(dir, { recursive: true });
			const slug =
				(record.title || "quest")
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 60) || "quest";
			const file = path.join(dir, `${record.id}-${slug}.md`);
			const header = `# ${record.title}\n\n_Quest ${record.id} · ${record.state}${record.project ? ` · ${record.project}` : ""} · saved ${new Date().toISOString()}_\n\n`;
			fs.writeFileSync(file, `${header}${record.report.trim()}\n`, { mode: 0o600 });
			return file;
		} catch {
			return undefined;
		}
	}

	dismiss(id: string): { record?: QuestRecord; cancelledRunning: boolean; tornDown: boolean; inPlaceKept: boolean; savedReport?: string } {
		const record = this.store.load(id);
		if (this.active.has(id)) {
			this.cancel(id);
			return { record, cancelledRunning: true, tornDown: false, inPlaceKept: false };
		}
		if (!record) return { cancelledRunning: false, tornDown: false, inPlaceKept: false };
		// Preserve the report BEFORE anything is torn down or deleted.
		const savedReport = this.persistReport(record);
		let tornDown = false;
		let inPlaceKept = false;
		for (const iso of record.isolations ?? []) {
			discardIsolation(iso);
			if (iso.worktreePath !== iso.repoRoot) tornDown = true;
			else inPlaceKept = true;
		}
		// Best-effort: remove any saved diff artifacts for this quest.
		try {
			for (const f of fs.readdirSync(questsDir())) {
				if (f.startsWith(`${id}.`) && f.endsWith(".diff")) fs.unlinkSync(path.join(questsDir(), f));
			}
		} catch {
			/* ignore */
		}
		// Clean up scratch directory
		const scratchDir = questScratchDir(record.id);
		if (fs.existsSync(scratchDir)) {
			try {
				fs.rmSync(scratchDir, { recursive: true, force: true });
			} catch {
				// Best effort
			}
		}
		this.store.delete(id);
		this.recordCache.delete(id); // Remove from cache since it's deleted
		record.state = "cancelled";
		this.emit(record); // listeners recompute from store (now empty of this id) and repaint
		return { record, cancelledRunning: false, tornDown, inPlaceKept, savedReport };
	}

	/**
	 * "Turn in" a finished Quest: mark it acknowledged so it leaves the Guild board
	 * but stays in history (report, branch and any draft PR are untouched). No-op
	 * unless the Quest is in a terminal state. Emits so the board repaints.
	 */
	acknowledge(id: string): QuestRecord | undefined {
		const record = this.store.load(id);
		if (!record || !isTerminal(record.state)) return record;
		record.acknowledgedAt = Date.now();
		this.store.save(record);
		this.emit(record);
		return record;
	}

	/**
	 * Transition a created Quest through running to a terminal state by executing
	 * `executor`. Persists on every change and calls `onChange` for UI updates.
	 */
	async run(
		record: QuestRecord,
		executor: QuestExecutor,
		options: { signal?: AbortSignal; onChange?: (record: QuestRecord) => void } = {},
	): Promise<QuestRecord> {
		const controller = new AbortController();
		const entry: ActiveQuest = { controller, cancelled: false, lastActivity: Date.now(), stalled: false, settled: false };
		this.active.set(record.id, entry);

		const linkAbort = () => {
			entry.cancelled = true;
			controller.abort();
		};
		if (options.signal) {
			if (options.signal.aborted) linkAbort();
			else options.signal.addEventListener("abort", linkAbort, { once: true });
		}

		const persist = () => {
			if (entry.settled) return;
			this.store.save(record);
			options.onChange?.(record);
			this.emit(record);
		};

		record.state = "running";
		record.ownerPid = process.pid;
		persist();

		const api: QuestRunApi = {
			get record() {
				return record;
			},
			signal: controller.signal,
			setMembers: (members) => {
				if (entry.settled) return;
				record.members = members;
				entry.lastActivity = Date.now();
				persist();
			},
			touch: () => {
				if (!entry.settled) entry.lastActivity = Date.now();
			},
			notePartial: (text) => {
				if (!entry.settled) entry.partial = text;
			},
			save: () => {
				if (!entry.settled) this.store.save(record);
			},
		};

		// Stall watchdog: a leader that goes silent while no member is running is aborted;
		// if it then ignores the abort for the grace period, run() settles without it.
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let rejectStall: (err: Error) => void = () => {};
		const stallSettled = new Promise<never>((_resolve, reject) => {
			rejectStall = reject;
		});
		const watchdog = setInterval(() => {
			if (entry.stalled || entry.settled || record.state !== "running") return;
			if (record.members.some((m) => m.status === "running")) return;
			const idle = Date.now() - entry.lastActivity;
			if (idle <= this.stallMs) return;
			entry.stalled = true;
			entry.stallReason = `Party leader stalled: no activity for ${Math.round(idle / 60_000)} min after all party members finished; aborted by the stall watchdog.`;
			controller.abort();
			graceTimer = setTimeout(() => rejectStall(new Error(entry.stallReason)), this.stallGraceMs);
		}, this.stallCheckMs);
		watchdog.unref?.();

		const failStalled = () => {
			record.state = "failed";
			record.error = entry.stallReason;
			if (entry.partial?.trim()) {
				record.report = `_Partial output: the party leader stalled before finishing._\n\n${entry.partial}`;
			}
		};

		try {
			const running = executor(api);
			// If the watchdog settles first, the executor may still reject later: never unhandled.
			running.catch(() => {});
			const outcome = await Promise.race([running, stallSettled]);
			if (entry.stalled) {
				failStalled();
			} else if (entry.cancelled || controller.signal.aborted) {
				record.state = "cancelled";
			} else if (!outcome.report?.trim()) {
				// Reality check: no result means this did not complete.
				record.state = "failed";
				record.error ??= "Executor returned no report.";
			} else {
				record.report = outcome.report;
				record.usage = outcome.usage;
				record.state = "completed";
			}
		} catch (err) {
			if (entry.stalled) {
				failStalled();
			} else {
				record.state = entry.cancelled ? "cancelled" : "failed";
				if (record.state === "failed") record.error = err instanceof Error ? err.message : String(err);
			}
		} finally {
			clearInterval(watchdog);
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", linkAbort);
			this.active.delete(record.id);
			persist();
			entry.settled = true;
		}

		return record;
	}
}
