/**
 * Asynchronous human interaction (§9) — the parked-request primitive.
 *
 * This is the primitive the old prototype got wrong. A request is a PARKED promise,
 * not a blocking gate that kills a session: `ask()` returns a promise that resolves
 * only when a human decides. Because each Party member (and the Party Leader) is its
 * own concurrent child session, one parked request never blocks its siblings — they
 * keep working, and a pending request can never silently destroy unrelated work.
 *
 * Historically this only handled boolean approve/deny. It is now a TYPED inbox: a
 * request has a `kind` (approve / choose / answer / review-artifact) so a running
 * party can gate a side-effect, ask the user to pick an option, ask a free-text
 * question, or surface a draft artifact for the user to read/edit before it is used.
 * The boolean `request()` API is preserved as a thin wrapper so existing callers
 * (the envoy shell, the review post-gate) are unaffected.
 *
 * Pending requests are persisted (outside Pi) so they are inspectable and
 * survivable, and removed on resolution.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { approvalsDir } from "../paths.ts";

/**
 * What a parked request is asking the human to do.
 * - approve/choose/answer/review-artifact are answered from the terminal inbox.
 * - `huddle` is different: it hands a multi-round DISCUSSION to the foreground
 *   Guildmaster, who edits the artifact WITH the user and then resumes the party.
 */
export type RequestKind = "approve" | "choose" | "answer" | "review-artifact" | "huddle";

export type RequestStatus = "pending" | "resolved";

export interface UserRequest {
	id: string;
	questId?: string;
	kind: RequestKind;
	title: string;
	description: string;
	/** kind "approve": the operation being gated (e.g. `gh pr review --approve`). */
	operation?: string;
	/** kind "choose": the options the user picks from. */
	options?: string[];
	/** kind "choose": options that also take OPTIONAL free text in the same step (option → input prompt).
	 * The text comes back as {@link UserAnswer.text}, so picking e.g. "send it back" never needs a second request. */
	optionNotes?: Record<string, string>;
	/** kind "review-artifact": absolute path to a file the user reads/edits before deciding. */
	artifactPath?: string;
	/** kind "review-artifact": approving POSTS a PR review parsed from the artifact, so `/approve`
	 * must show the exact event + body and return them as {@link UserAnswer.review}. */
	postsReview?: boolean;
	createdAt: number;
	status: RequestStatus;
}

/** Backwards-compatible alias — a request used to be called an "approval". */
export type ApprovalRequest = UserRequest;
export type ApprovalStatus = RequestStatus;

/** The structured result of a resolved request. */
export interface UserAnswer {
	/** What the user did. `approved` is the boolean projection every kind carries. */
	action: "approve" | "deny" | "choose" | "answer" | "send-back";
	approved: boolean;
	/** kind "choose": the selected option. */
	choice?: string;
	/** kind "answer": the free text; kind "choose": the optional note for an {@link UserRequest.optionNotes} option; kind "review-artifact"/send-back: the user's notes. */
	text?: string;
	/** postsReview requests: the exact verdict + body the user confirmed at /approve. The post uses this snapshot. */
	review?: { verdict: "approve" | "request-changes" | "comment"; body: string };
}

interface Parked {
	request: UserRequest;
	resolve: (answer: UserAnswer) => void;
	/** Abort listener cleanup, when the caller passed a signal. */
	cleanup?: () => void;
}

let counter = 0;

export class ApprovalManager {
	private readonly parked = new Map<string, Parked>();
	private readonly listeners = new Set<() => void>();
	private readonly dir: string;

	constructor(dir: string = approvalsDir()) {
		this.dir = dir;
	}

	/** Subscribe to pending-set changes (for the TUI widget). Returns an unsubscribe fn. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const l of this.listeners) l();
	}

	private persist(request: UserRequest): void {
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			fs.writeFileSync(path.join(this.dir, `${request.id}.json`), JSON.stringify(request, null, 2), { mode: 0o600 });
		} catch {
			/* persistence is best-effort */
		}
	}

	private unpersist(id: string): void {
		try {
			fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
		} catch {
			/* ignore */
		}
	}

	/**
	 * Park a typed request. Resolves with a structured {@link UserAnswer} when a human
	 * decides (or with a `deny` answer if the optional signal aborts). Never blocks siblings.
	 */
	ask(input: {
		kind: RequestKind;
		title: string;
		description?: string;
		operation?: string;
		options?: string[];
		optionNotes?: Record<string, string>;
		artifactPath?: string;
		postsReview?: boolean;
		questId?: string;
		signal?: AbortSignal;
	}): Promise<UserAnswer> {
		const id = `rq-${Date.now().toString(36)}-${(counter++).toString(36)}`;
		const request: UserRequest = {
			id,
			questId: input.questId,
			kind: input.kind,
			title: input.title,
			description: input.description ?? "",
			operation: input.operation,
			options: input.options,
			optionNotes: input.optionNotes,
			artifactPath: input.artifactPath,
			postsReview: input.postsReview,
			createdAt: Date.now(),
			status: "pending",
		};
		this.persist(request);
		const promise = new Promise<UserAnswer>((resolve) => {
			let cleanup: (() => void) | undefined;
			if (input.signal) {
				const onAbort = () => this.answer(id, { action: "deny", approved: false });
				if (input.signal.aborted) queueMicrotask(onAbort);
				else input.signal.addEventListener("abort", onAbort, { once: true });
				cleanup = () => input.signal?.removeEventListener("abort", onAbort);
			}
			this.parked.set(id, { request, resolve, cleanup });
		});
		this.notify();
		return promise;
	}

	/**
	 * Boolean approve/deny — a thin wrapper over {@link ask} for gated side-effects.
	 * Preserved so existing callers (the envoy shell, review post-gate) are unchanged.
	 */
	request(input: { title: string; description: string; operation: string; questId?: string; signal?: AbortSignal }): Promise<boolean> {
		return this.ask({
			kind: "approve",
			title: input.title,
			description: input.description,
			operation: input.operation,
			questId: input.questId,
			signal: input.signal,
		}).then((a) => a.approved);
	}

	list(): UserRequest[] {
		return [...this.parked.values()].map((p) => p.request).sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): UserRequest | undefined {
		return this.parked.get(id)?.request;
	}

	has(id: string): boolean {
		return this.parked.has(id);
	}

	/** Resolve one request with a structured answer. Other parked requests are unaffected. */
	answer(id: string, ans: UserAnswer): boolean {
		const entry = this.parked.get(id);
		if (!entry) return false;
		entry.request.status = "resolved";
		this.parked.delete(id);
		this.unpersist(id);
		entry.cleanup?.();
		entry.resolve(ans);
		this.notify();
		return true;
	}

	/** Resolve an approve-kind request by boolean. Kept for `/approve` · `/deny`. */
	resolve(id: string, approved: boolean): boolean {
		return this.answer(id, { action: approved ? "approve" : "deny", approved });
	}

	/** Deny everything (e.g. on shutdown) so no promise dangles. */
	denyAll(): void {
		for (const id of [...this.parked.keys()]) this.answer(id, { action: "deny", approved: false });
	}
}
