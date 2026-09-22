/**
 * Quest persistence — boring JSON, one file per Quest (§19).
 *
 * State lives at ~/.pi/agent/guildmaster/quests/<id>.json, independent of Pi's
 * session storage, so Quests survive restarts and can be read by external tools.
 *
 * The store enforces the one invariant that matters: state must reflect reality.
 * A Quest cannot be persisted as `completed` unless it actually has a report.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { questsDir } from "../paths.ts";

/** The six lifecycle states (§5). Do not add states without a demonstrated need. */
export type QuestState = "created" | "running" | "awaiting-approval" | "completed" | "failed" | "cancelled";

export type QuestMemberStatus = "pending" | "running" | "done" | "failed";

export interface QuestMember {
	name: string;
	task: string;
	model?: string;
	status: QuestMemberStatus;
	summary?: string;
	/** Which project repo this member worked in (multi-repo projects). */
	repo?: string;
}

/** Git worktree isolation for one repo of a write-Quest (§11). One per writable repo. */
export interface QuestIsolation {
	repo: string;
	branch: string;
	worktreePath: string;
	baseRef: string;
	/** Human-readable label of the clean base this branch was cut from (e.g. "origin/main"). */
	baseLabel?: string;
	repoRoot: string;
}

/** A PR review a review-Quest produced, awaiting or having completed its approved post. */
export interface QuestReview {
	number: string;
	slug?: string;
	repoName?: string;
	verdict: "approve" | "request-changes" | "comment";
	posted?: boolean;
	url?: string;
}

/** Drafted (M8) or opened (M9) pull request for one repo. Guildmaster never merges. */
export interface QuestPr {
	repo: string;
	branch: string;
	title: string;
	body: string;
	draft: boolean;
	diffStat?: string;
	url?: string;
	number?: number;
}

export interface QuestRecord {
	id: string;
	title: string;
	brief: string;
	cwd: string;
	/** Registered project id this Quest belongs to (undefined = ad-hoc / cwd-scoped). */
	project?: string;
	state: QuestState;
	createdAt: number;
	updatedAt: number;
	members: QuestMember[];
	/** Present only when state === "completed". */
	report?: string;
	error?: string;
	/** How the party's run ended (e.g. "endTurn", "aborted", "error"). Forensics for post-mortems. */
	stopReason?: string;
	usage?: { cost: number; turns: number };
	/** Write-Quest fields: one isolation + one drafted PR per writable repo (§ Projects P3). */
	isolations?: QuestIsolation[];
	prs?: QuestPr[];
	/** Review-Quest: the review produced and its post status (approval-gated). */
	review?: QuestReview;
	/**
	 * Set for an "address-feedback" write-Quest: the existing PR this Quest is
	 * iterating on. When present, raising pushes commits to `headBranch` to UPDATE
	 * this PR (fast-forward only) instead of opening a new one.
	 */
	sourcePr?: {
		number: number;
		url: string;
		headBranch: string;
		slug?: string;
		repo?: string;
		isCrossRepository?: boolean;
		/** Unresolved review threads this Quest set out to address, so raising can reply + resolve them. */
		threads?: { threadId?: string; commentId?: number; author: string }[];
	};
	/** Set when the user "turns in" a finished Quest: it leaves the board but stays in history. */
	acknowledgedAt?: number;
	/** The Quest this one was chained from (fromQuest) — multi-step lineage. */
	parentId?: string;
	/** Error from auto-raise attempt; user can retry with raise_pr */
	raiseError?: string;
}

const TERMINAL: ReadonlySet<QuestState> = new Set(["completed", "failed", "cancelled"]);

export function isTerminal(state: QuestState): boolean {
	return TERMINAL.has(state);
}

/** Throw if a record would misrepresent reality. Enforced on every write. */
function assertValid(record: QuestRecord): void {
	if (record.state === "completed" && !record.report?.trim()) {
		throw new Error(`Quest ${record.id} cannot be "completed" without a report.`);
	}
}

export class QuestStore {
	private readonly dir: string;
	private readonly saveListeners = new Set<(record: QuestRecord) => void>();

	constructor(dir: string = questsDir()) {
		this.dir = dir;
	}

	/** Register a listener that fires after each successful save. Returns an unsubscribe function. */
	onSave(listener: (record: QuestRecord) => void): () => void {
		this.saveListeners.add(listener);
		return () => {
			this.saveListeners.delete(listener);
		};
	}

	private filePath(id: string): string {
		return path.join(this.dir, `${id}.json`);
	}

	/** Persist a record. Atomic (temp + rename). Bumps updatedAt. Enforces invariant. */
	save(record: QuestRecord): QuestRecord {
		assertValid(record);
		record.updatedAt = Date.now();
		fs.mkdirSync(this.dir, { recursive: true });
		const tmp = this.filePath(`.${record.id}.tmp`);
		fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, this.filePath(record.id));
		for (const listener of this.saveListeners) {
			listener(record);
		}
		return record;
	}

	/** Delete a quest's record file. Returns true if a file was actually removed. */
	delete(id: string): boolean {
		try {
			fs.unlinkSync(this.filePath(id));
			return true;
		} catch {
			return false;
		}
	}

	load(id: string): QuestRecord | undefined {
		try {
			return JSON.parse(fs.readFileSync(this.filePath(id), "utf-8")) as QuestRecord;
		} catch {
			return undefined;
		}
	}

	/** All persisted Quests, newest first. */
	list(): QuestRecord[] {
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return [];
		}
		const records: QuestRecord[] = [];
		for (const name of names) {
			if (!name.endsWith(".json") || name.startsWith(".")) continue;
			const rec = this.load(name.slice(0, -".json".length));
			if (rec) records.push(rec);
		}
		return records.sort((a, b) => b.createdAt - a.createdAt);
	}
}

/** Short, sortable, filesystem-safe id. */
export function newQuestId(): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
	const rand = Math.random().toString(36).slice(2, 6);
	return `${ts}_${rand}`;
}
