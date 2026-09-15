/**
 * Approval UX (§9, §12): pending-approvals widget, /approvals · /approve · /deny
 * commands, and the `raise_pr` tool that gates turning a write-Quest's draft into
 * a pushed draft PR.
 *
 * Non-blocking by design: the widget + commands let the human resolve an approval
 * on their own time. Extension commands run even while a tool call is streaming,
 * so `/approve` can resolve the `raise_pr` tool while it waits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getApprovalManager, getQuestManager } from "./orchestration/manager.ts";
import type { ApprovalManager } from "./orchestration/approvals.ts";
import { raisePr } from "./orchestration/pr.ts";
import type { QuestRecord } from "./persistence/quest-store.ts";

// The Guild status board (status.ts) owns the widget; it auto-repaints from the
// ApprovalManager's change events, so these commands just resolve/list.

/** Resolve by exact id or a unique suffix, for convenience. */
function resolveId(approvals: ApprovalManager, arg: string): string | undefined {
	const trimmed = arg.trim();
	if (!trimmed) return undefined;
	if (approvals.has(trimmed)) return trimmed;
	const matches = approvals.list().filter((a) => a.id.endsWith(trimmed));
	return matches.length === 1 ? matches[0].id : undefined;
}

export function registerApprovals(pi: ExtensionAPI): void {
	const approvals = getApprovalManager();

	pi.registerCommand("approvals", {
		description: "List pending approvals",
		handler: async (_args, ctx) => {
			const pending = approvals.list();
			if (pending.length === 0) {
				ctx.ui.notify("No pending approvals.", "info");
				return;
			}
			for (const a of pending) ctx.ui.notify(`${a.id}: ${a.title} — ${a.description}`, "info");
		},
	});

	for (const verb of ["approve", "deny"] as const) {
		pi.registerCommand(verb, {
			description: `${verb === "approve" ? "Approve" : "Deny"} a pending approval by id`,
			getArgumentCompletions: (prefix) => {
				const items = approvals.list().map((a) => ({ value: a.id, label: `${a.id} — ${a.title}` }));
				const f = items.filter((i) => i.value.startsWith(prefix.trim()));
				return f.length > 0 ? f : items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const id = resolveId(approvals, args);
				if (!id) {
					ctx.ui.notify(`No matching pending approval for "${args.trim()}".`, "warning");
					return;
				}
				approvals.resolve(id, verb === "approve");
				ctx.ui.notify(`Approval ${id} ${verb === "approve" ? "approved" : "denied"}.`, "info");
			},
		});
	}

	pi.registerTool({
		name: "raise_pr",
		label: "Raise PR",
		description: [
			"Raise the draft PR for a completed write-Quest: pushes the branch and opens a DRAFT pull request.",
			"Requires human approval (parked, not blocking other work) and never merges. If no questId is given,",
			"the most recent completed write-Quest with an un-raised draft is used.",
		].join(" "),
		promptSnippet: "Raise (push + open draft PR) the branch a write-Quest produced; requires human approval",
		promptGuidelines: [
			"Use raise_pr after a write Quest has produced a draft PR and the user wants it raised. It requires the user's approval and only ever opens a DRAFT PR; it never merges.",
		],
		parameters: Type.Object({
			questId: Type.Optional(Type.String({ description: "Quest id (defaults to most recent un-raised write-Quest)" })),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const manager = getQuestManager();
			const record: QuestRecord | undefined = params.questId
				? manager.store.load(params.questId)
				: manager.store
						.list()
						.find((q) => q.state === "completed" && q.isolations?.length && q.prs?.some((p) => !p.url));

			if (!record?.prs?.some((p) => !p.url) || !record.isolations?.length) {
				throw new Error("No completed write-Quest with an un-raised draft PR was found.");
			}

			const repos = record.prs.filter((p) => !p.url).map((p) => p.repo).join(", ");
			onUpdate?.({
				content: [{ type: "text", text: `Requesting approval to raise draft PR(s) for "${record.title}" [${repos}]… (/approve each)` }],
				details: {},
			});

			const result = await raisePr(record, {
				approvals,
				confirmSecurity: (message) => ctx.ui.confirm("Possible security fix", message),
			});
			manager.store.save(record);
			const summary = result.results
				.map((r) => (r.raised ? `${r.repo}: ${r.url ?? "raised"}` : `${r.repo || "?"}: ${r.reason}`))
				.join("\n");
			return {
				content: [{ type: "text", text: `Raised ${result.raised}/${result.results.length}:\n${summary}` }],
				details: result,
				isError: result.raised === 0,
			};
		},
	});
}
