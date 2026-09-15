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

import {
	newQuestId,
	type QuestMember,
	type QuestRecord,
	QuestStore,
} from "../persistence/quest-store.ts";

export interface QuestRunApi {
	readonly record: Readonly<QuestRecord>;
	readonly signal: AbortSignal;
	/** Replace the party member list and persist. Drives the live TUI panel. */
	setMembers(members: QuestMember[]): void;
}

export interface QuestOutcome {
	report: string;
	usage?: { cost: number; turns: number };
}

export type QuestExecutor = (api: QuestRunApi) => Promise<QuestOutcome>;

interface ActiveQuest {
	controller: AbortController;
	cancelled: boolean;
}

export class QuestManager {
	readonly store: QuestStore;
	private readonly active = new Map<string, ActiveQuest>();
	private readonly listeners = new Set<(record: QuestRecord) => void>();

	constructor(store: QuestStore = new QuestStore()) {
		this.store = store;
	}

	/** Subscribe to any quest change (create + every persisted transition). */
	onChange(listener: (record: QuestRecord) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(record: QuestRecord): void {
		for (const l of this.listeners) l(record);
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

	getActive(): QuestRecord[] {
		return [...this.active.keys()].map((id) => this.store.load(id)).filter((r): r is QuestRecord => Boolean(r));
	}

	cancel(id: string): boolean {
		const entry = this.active.get(id);
		if (!entry) return false;
		entry.cancelled = true;
		entry.controller.abort();
		return true;
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
		const entry: ActiveQuest = { controller, cancelled: false };
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
			this.store.save(record);
			options.onChange?.(record);
			this.emit(record);
		};

		record.state = "running";
		persist();

		const api: QuestRunApi = {
			get record() {
				return record;
			},
			signal: controller.signal,
			setMembers: (members) => {
				record.members = members;
				persist();
			},
		};

		try {
			const outcome = await executor(api);
			if (entry.cancelled || controller.signal.aborted) {
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
			record.state = entry.cancelled ? "cancelled" : "failed";
			if (record.state === "failed") record.error = err instanceof Error ? err.message : String(err);
		} finally {
			options.signal?.removeEventListener("abort", linkAbort);
			this.active.delete(record.id);
			persist();
		}

		return record;
	}
}
