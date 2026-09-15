/**
 * Asynchronous human approval (§9).
 *
 * This is the primitive the old prototype got wrong. Approval is a PARKED request,
 * not a blocking gate that kills a session: `request()` returns a promise that
 * resolves only when a human decides. Because each Party member is its own
 * concurrent child session, one parked action never blocks its siblings — they
 * keep working, and a pending approval can never silently destroy unrelated work.
 *
 * Pending approvals are persisted (outside Pi) so they are inspectable and
 * survivable, and removed on resolution.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { approvalsDir } from "../paths.ts";

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface ApprovalRequest {
	id: string;
	questId?: string;
	title: string;
	description: string;
	operation: string;
	createdAt: number;
	status: ApprovalStatus;
}

interface Parked {
	request: ApprovalRequest;
	resolve: (approved: boolean) => void;
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

	private persist(request: ApprovalRequest): void {
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

	/** Park a restricted action. Resolves true (approved) / false (denied). Never blocks siblings. */
	request(input: { title: string; description: string; operation: string; questId?: string }): Promise<boolean> {
		const id = `ap-${Date.now().toString(36)}-${(counter++).toString(36)}`;
		const request: ApprovalRequest = {
			id,
			questId: input.questId,
			title: input.title,
			description: input.description,
			operation: input.operation,
			createdAt: Date.now(),
			status: "pending",
		};
		this.persist(request);
		const promise = new Promise<boolean>((resolve) => {
			this.parked.set(id, { request, resolve });
		});
		this.notify();
		return promise;
	}

	list(): ApprovalRequest[] {
		return [...this.parked.values()].map((p) => p.request).sort((a, b) => a.createdAt - b.createdAt);
	}

	has(id: string): boolean {
		return this.parked.has(id);
	}

	/** Resolve one approval. Other parked approvals are unaffected. */
	resolve(id: string, approved: boolean): boolean {
		const entry = this.parked.get(id);
		if (!entry) return false;
		entry.request.status = approved ? "approved" : "denied";
		this.parked.delete(id);
		this.unpersist(id);
		entry.resolve(approved);
		this.notify();
		return true;
	}

	/** Deny everything (e.g. on shutdown) so no promise dangles. */
	denyAll(): void {
		for (const id of [...this.parked.keys()]) this.resolve(id, false);
	}
}
