/**
 * Approval UX (§9, §12): pending-approvals widget, /approvals · /approve · /deny
 * commands (used by review quests), and the `raise_pr` tool that turns a write-Quest's
 * draft into a pushed draft PR — no approval; a draft is for the human to review.
 *
 * Non-blocking by design: the widget + commands let the human resolve an approval
 * on their own time. Extension commands run even while a tool call is streaming,
 * so `/approve` can resolve the `raise_pr` tool while it waits.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getApprovalManager, getQuestManager } from "./orchestration/manager.ts";
import { type ReviewVerdict, reviewFlag } from "./execution/gh-tool.ts";
import type { UserRequest } from "./orchestration/approvals.ts";
import { commitsAhead } from "./execution/isolation.ts";
import { explainUnraisable, raisePr } from "./orchestration/pr.ts";
import { extractPostableReview } from "./orchestration/review-post.ts";
import type { QuestRecord } from "./persistence/quest-store.ts";
import { type CardLine, showCard } from "./ui.ts";
import { matchOption, numberedOptions, parseRequestArgs, requestCompletions, resolveRequestId } from "./request-input.ts";

/** A short glyph + label for each request kind, for the inbox. */
const KIND_LABEL: Record<UserRequest["kind"], string> = {
	approve: "approve",
	choose: "choose",
	answer: "answer",
	"review-artifact": "review",
	huddle: "huddle",
};

// The Guild status board (status.ts) owns the widget; it auto-repaints from the
// ApprovalManager's change events, so these commands just resolve/list.

type Kind = UserRequest["kind"];
/** Which request kinds each command acts on. */
const COMMAND_KINDS: Record<"approve" | "deny" | "choose" | "answer" | "review", readonly Kind[]> = {
	approve: ["approve", "review-artifact"],
	deny: ["approve", "choose", "answer", "review-artifact"],
	choose: ["choose"],
	answer: ["answer", "review-artifact"],
	review: ["review-artifact"],
};

function requestTitle(questTitle: string | undefined, r: UserRequest): string {
	return questTitle ? `[${questTitle}] ${r.title}` : r.title;
}

/** The GitHub review event each verdict records. */
const REVIEW_EVENT: Record<ReviewVerdict, string> = {
	approve: "APPROVE",
	"request-changes": "REQUEST_CHANGES",
	comment: "COMMENT",
};

/**
 * The /approve confirm prompt for posting a PR review. It is self-sufficient: it has
 * the exact event (GitHub event + gh flag + full command line) and the FULL,
 * untruncated body that will be posted, so the user never has to trust a separate
 * card. pi renders confirm as a wrapping text block with no length cap.
 */
export function buildReviewConfirm(
	operation: string | undefined,
	verdict: ReviewVerdict,
	body: string,
): { title: string; message: string } {
	const flag = reviewFlag(verdict);
	const command = `${operation ?? "gh pr review"} ${flag}`;
	return {
		title: `Post this review as ${REVIEW_EVENT[verdict]} (${flag})?`,
		message: [
			`Event: ${REVIEW_EVENT[verdict]}`,
			`Command: ${command}`,
			"Inline comments are not supported; only the body below is posted.",
			"",
			"----- exact body (posted verbatim) -----",
			body,
			"----- end of body -----",
		].join("\n"),
	};
}

/** Read a postsReview artifact FRESH and parse what would post (never a cached or whole-file body). */
function readPostable(artifactPath: string | undefined): ReturnType<typeof extractPostableReview> {
	if (!artifactPath) return { error: "the request has no review file" };
	try {
		return extractPostableReview(fs.readFileSync(artifactPath, "utf-8"));
	} catch (err) {
		return { error: `could not read ${artifactPath} (${err instanceof Error ? err.message : String(err)})` };
	}
}

export function registerApprovals(pi: ExtensionAPI): void {
	const approvals = getApprovalManager();
	// pi replaces the WHOLE argument text with a picked completion, so completions only ever
	// extend what was typed (never an unrelated id that would swallow the user's option text).
	const completionsFor = (verb: keyof typeof COMMAND_KINDS) => (prefix: string) => requestCompletions(approvals.list(), COMMAND_KINDS[verb], prefix);
	const questTitleOf = (r: UserRequest) => (r.questId ? getQuestManager().store.load(r.questId)?.title : undefined);

	/**
	 * Resolve which request a command targets. The id is optional when only one request of
	 * the command's kinds is waiting; with several, the interactive UI offers a picker.
	 */
	const pickRequest = async (
		ctx: ExtensionCommandContext,
		verb: keyof typeof COMMAND_KINDS,
		args: string,
	): Promise<{ req: UserRequest; rest: string; implicit: boolean } | undefined> => {
		const pending = approvals.list();
		const parsed = parseRequestArgs(pending, COMMAND_KINDS[verb], args);
		if (parsed.error) {
			ctx.ui.notify(parsed.error, "warning");
			return undefined;
		}
		if (parsed.id) {
			const req = approvals.get(parsed.id);
			if (!req) ctx.ui.notify(`Request ${parsed.id} is no longer pending.`, "warning");
			return req ? { req, rest: parsed.rest, implicit: Boolean(parsed.implicit) } : undefined;
		}
		const eligible = pending.filter((r) => COMMAND_KINDS[verb].includes(r.kind));
		if (!ctx.hasUI) {
			ctx.ui.notify(`${eligible.length} requests are waiting. Use /${verb} <id> (see /inbox).`, "warning");
			return undefined;
		}
		const labels = eligible.map((r) => `${r.id} — ${requestTitle(questTitleOf(r), r)}`);
		const pick = await ctx.ui.select(`/${verb}: which request?`, labels);
		const req = pick ? eligible[labels.indexOf(pick)] : undefined;
		return req ? { req, rest: parsed.rest, implicit: false } : undefined;
	};

	/** The inbox: every parked request across all Quests, with how to answer each. */
	const showInbox = (ctx: { ui: { notify: (t: string, l: "info" | "warning" | "error") => void } }) => {
		const pending = approvals.list();
		if (pending.length === 0) {
			ctx.ui.notify("Inbox empty — nothing is waiting on you.", "info");
			return;
		}
		const store = getQuestManager().store;
		const lines: CardLine[] = [];
		for (const r of pending) {
			const qTitle = r.questId ? store.load(r.questId)?.title : undefined;
			lines.push({ text: `${r.id}  ${KIND_LABEL[r.kind]}`, bold: true });
			lines.push({ text: requestTitle(qTitle, r), indent: 2 });
			if (r.kind === "choose" && r.options?.length)
				for (const line of numberedOptions(r.options)) lines.push({ text: line, color: "muted", indent: 4 });
			if (r.kind === "review-artifact" && r.artifactPath)
				lines.push({ text: `artifact: ${r.artifactPath}`, color: "dim", indent: 2 });
			const how =
				r.kind === "approve"
					? `/approve ${r.id}  ·  /deny ${r.id}`
					: r.kind === "choose"
						? `/choose ${r.id}  (opens a picker)  ·  /choose ${r.id} <number>`
						: r.kind === "answer"
							? `/answer ${r.id}  (opens an input)  ·  /answer ${r.id} <text>`
							: r.kind === "huddle"
								? `a collaborative decision — ask me to pick it up (quest_huddle)`
								: `/review ${r.id}  (read/edit)  ·  /approve ${r.id}  ·  /answer ${r.id} <notes to send back>`;
			lines.push({ text: how, color: "accent", indent: 2 });
			lines.push({ text: "", color: "muted" });
		}
		showCard(pi, { title: `Inbox (${pending.length} waiting)`, lines });
	};

	pi.registerCommand("inbox", { description: "Show everything waiting on you (approvals, questions, reviews)", handler: async (_a, ctx) => showInbox(ctx) });
	// Back-compat alias.
	pi.registerCommand("approvals", { description: "List pending requests (alias of /inbox)", handler: async (_a, ctx) => showInbox(ctx) });

	for (const verb of ["approve", "deny"] as const) {
		pi.registerCommand(verb, {
			description: `${verb === "approve" ? "Approve" : "Deny / decline"} a pending request by id`,
			getArgumentCompletions: completionsFor(verb),
			handler: async (args, ctx) => {
				const picked = await pickRequest(ctx, verb, args);
				if (!picked) return;
				const { req, implicit } = picked;
				const id = req.id;
				// No id typed: never resolve a gate the user has not seen. Confirm it by title.
				if (implicit && !(verb === "approve" && req.kind === "review-artifact" && req.postsReview)) {
					if (!ctx.hasUI) return ctx.ui.notify(`Use /${verb} ${id} to ${verb} "${req.title}".`, "warning");
					const ok = await ctx.ui.confirm(`${verb === "approve" ? "Approve" : "Decline"}: ${requestTitle(questTitleOf(req), req)}?`, req.description ?? "");
					if (!ok) return ctx.ui.notify(`${id} is still pending.`, "info");
				}
				if (verb === "approve" && req?.kind === "review-artifact" && req.postsReview) {
					// Posting a PR review: parse the CURRENT file, show the exact event + body, confirm,
					// and answer with that snapshot — it is exactly what gets posted.
					const parsed = readPostable(req.artifactPath);
					if ("error" in parsed) {
						ctx.ui.notify(`Not posted: ${parsed.error}. Edit ${req.artifactPath ?? "review.md"} and /approve ${id} again.`, "warning");
						return;
					}
					if (!ctx.hasUI) {
						ctx.ui.notify(`Not posted: ${id} posts a PR review and needs an interactive confirm of the exact body. Run /approve ${id} in the interactive terminal.`, "warning");
						return;
					}
					const flag = reviewFlag(parsed.verdict);
					const command = `${req.operation ?? "gh pr review"} ${flag}`;
					showCard(pi, {
						title: `About to post: ${req.title}`,
						lines: [
							{ text: command, color: "accent", bold: true },
							{ text: "Inline comments are not supported; only this text is posted.", color: "muted" },
							{ text: "", color: "muted" },
							...parsed.body.split("\n").map((line) => ({ text: line })),
						],
					});
					const prompt = buildReviewConfirm(req.operation, parsed.verdict, parsed.body);
					const ok = await ctx.ui.confirm(prompt.title, prompt.message);
					if (!ok) {
						ctx.ui.notify(`Not posted — ${id} is still pending. Edit ${req.artifactPath} and /approve ${id} again, or /deny ${id}.`, "info");
						return;
					}
					const done = approvals.answer(id, { action: "approve", approved: true, review: { verdict: parsed.verdict, body: parsed.body } });
					ctx.ui.notify(done ? `Request ${id} approved — posting as ${flag}.` : `Request ${id} is no longer pending; nothing posted.`, done ? "info" : "warning");
					return;
				}
				approvals.resolve(id, verb === "approve");
				ctx.ui.notify(`Request ${id} ${verb === "approve" ? "approved" : "declined"}.`, "info");
			},
		});
	}

	pi.registerCommand("choose", {
		description: "Answer a 'choose' request: /choose opens a picker; or /choose [id] <number|text>",
		getArgumentCompletions: completionsFor("choose"),
		handler: async (args, ctx) => {
			const picked = await pickRequest(ctx, "choose", args);
			if (!picked) return;
			const { req, rest } = picked;
			const options = req.options ?? [];
			let choice: string | undefined;
			if (options.length === 0) {
				choice = rest || (ctx.hasUI ? (await ctx.ui.input(req.title, "Your choice"))?.trim() : undefined);
				if (!choice) return ctx.ui.notify(`Nothing chosen — ${req.id} is still pending.`, "info");
			} else {
				const list = numberedOptions(options);
				if (rest) {
					const m = matchOption(options, rest);
					if ("choice" in m) choice = m.choice;
					else if (!ctx.hasUI) return ctx.ui.notify(`${m.error}\n${list.join("\n")}`, "warning");
					else ctx.ui.notify(`${m.error} Pick one from the list.`, "warning");
				}
				if (!choice) {
					if (!ctx.hasUI) return ctx.ui.notify(`Usage: /choose ${req.id} <number>\n${list.join("\n")}`, "warning");
					const pick = await ctx.ui.select(requestTitle(questTitleOf(req), req), list);
					if (!pick) return ctx.ui.notify(`Nothing chosen — ${req.id} is still pending.`, "info");
					choice = options[list.indexOf(pick)];
				}
			}
			const done = approvals.answer(req.id, { action: "choose", approved: true, choice });
			ctx.ui.notify(done ? `Chose "${choice}" for ${req.id}.` : `${req.id} is no longer pending; nothing sent.`, done ? "info" : "warning");
		},
	});

	pi.registerCommand("answer", {
		description: "Answer an 'answer' request, or send a review back with notes: /answer opens an input; or /answer [id] <text>",
		getArgumentCompletions: completionsFor("answer"),
		handler: async (args, ctx) => {
			const picked = await pickRequest(ctx, "answer", args);
			if (!picked) return;
			const { req } = picked;
			const id = req.id;
			let rest = picked.rest;
			if (!rest && ctx.hasUI) rest = (await ctx.ui.input(requestTitle(questTitleOf(req), req), req.kind === "review-artifact" ? "Notes to send back" : "Your answer"))?.trim() ?? "";
			if (!rest) return ctx.ui.notify(ctx.hasUI ? `Nothing sent — ${id} is still pending.` : `Usage: /answer ${id} <text>`, ctx.hasUI ? "info" : "warning");
			// For a review-artifact, free text means "send it back with notes" (do NOT proceed).
			// For an 'answer' question, it is the answer the party asked for.
			if (req?.kind === "review-artifact") {
				approvals.answer(id, { action: "send-back", approved: false, text: rest });
				ctx.ui.notify(`Sent ${id} back with notes.`, "info");
			} else {
				approvals.answer(id, { action: "answer", approved: true, text: rest });
				ctx.ui.notify(`Answered ${id}.`, "info");
			}
		},
	});

	pi.registerCommand("review", {
		description: "Open a review-artifact request to read/edit before approving: /review [id]",
		getArgumentCompletions: completionsFor("review"),
		handler: async (args, ctx) => {
			const picked = await pickRequest(ctx, "review", args);
			if (!picked) return;
			const { req } = picked;
			const id = req.id;
			if (req.kind !== "review-artifact" || !req.artifactPath)
				return ctx.ui.notify(`${id} is a '${req.kind}' request, not an editable artifact. Use /inbox to see how to answer it.`, "warning");
			let content = "";
			try {
				content = fs.readFileSync(req.artifactPath, "utf-8");
			} catch {
				content = "(could not read the artifact file)";
			}
			const preview = content.split("\n").slice(0, 60);
			// A review that posts: lead with exactly what /approve would send (or why it can't).
			const postable: CardLine[] = [];
			if (req.postsReview) {
				const parsed = readPostable(req.artifactPath);
				if ("error" in parsed) {
					postable.push({ text: `\u26a0 Cannot post: ${parsed.error}`, color: "warning", bold: true });
				} else {
					postable.push({ text: `Will post: ${reviewFlag(parsed.verdict)}`, color: "accent", bold: true });
					postable.push(...parsed.body.split("\n").map((line) => ({ text: line })));
				}
				postable.push({ text: "", color: "muted" });
			}
			showCard(pi, {
				title: `Review: ${req.title}`,
				lines: [
					...postable,
					{ text: `Edit this file, then /approve ${id} to use the edited version:`, color: "muted" },
					{ text: req.artifactPath, color: "accent" },
					{ text: `Or /answer ${id} <notes> to send it back for revision, or /deny ${id} to leave it as a draft.`, color: "muted" },
					{ text: "", color: "muted" },
					...preview.map((line) => ({ text: line, color: "dim" as ThemeColor })),
					...(content.split("\n").length > 60 ? [{ text: "… (truncated — open the file for the rest)", color: "muted" as ThemeColor }] : []),
				],
			});
		},
	});

	pi.registerTool({
		name: "answer_request",
		label: "Answer request",
		description: [
			"Relay the user's explicit answer to a Quest's pending 'choose' or 'answer' inbox request, so the user does not have",
			"to retype it as a slash command. It cannot approve or deny gates, review artifacts or huddles: those stay with the",
			"user (/approve, /deny, /review, quest_huddle).",
		].join(" "),
		promptSnippet: "Relay the user's explicit decision to a Quest's pending choose/answer request",
		promptGuidelines: [
			"Use answer_request only to relay a decision the user has explicitly stated for that request in this conversation (for example 'pick option 1' or 'tell it staging'). Never choose on your own judgement or to get a Quest past a safety concern; if the user's intent is unclear, show them the numbered options and ask.",
		],
		parameters: Type.Object({
			requestId: Type.Optional(Type.String({ description: "Request id (rq-\u2026). Optional when exactly one choose/answer request is pending." })),
			option: Type.Optional(Type.String({ description: "For a 'choose' request: the 1-based option number, or its text." })),
			text: Type.Optional(Type.String({ description: "For an 'answer' request: the user's answer." })),
		}),
		async execute(_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: { id: string; choice?: string } }> {
			const pending = approvals.list();
			const eligible = pending.filter((r) => r.kind === "choose" || r.kind === "answer");
			const describe = (r: UserRequest) => `${r.id} (${r.kind}): ${requestTitle(questTitleOf(r), r)}${r.options?.length ? `\n${numberedOptions(r.options).map((l) => `  ${l}`).join("\n")}` : ""}`;
			let req: UserRequest | undefined;
			if (params.requestId) {
				const id = resolveRequestId(pending, params.requestId);
				req = id ? approvals.get(id) : undefined;
				if (!req) throw new Error(`No pending request matches "${params.requestId}".`);
				if (req.kind !== "choose" && req.kind !== "answer")
					throw new Error(`${req.id} is a '${req.kind}' request. Only the user can resolve it (see /inbox).`);
			} else if (eligible.length === 1) {
				req = eligible[0];
			} else {
				throw new Error(eligible.length === 0 ? "No choose/answer request is pending." : `Several requests are pending; pass requestId:\n${eligible.map(describe).join("\n")}`);
			}
			if (req.kind === "choose") {
				const input = (params.option ?? params.text ?? "").trim();
				if (!input) throw new Error(`Pass option for ${describe(req)}`);
				const m = req.options?.length ? matchOption(req.options, input) : { choice: input };
				if ("error" in m) throw new Error(`${m.error}\n${describe(req)}`);
				if (!approvals.answer(req.id, { action: "choose", approved: true, choice: m.choice })) throw new Error(`${req.id} is no longer pending.`);
				return { content: [{ type: "text", text: `Chose "${m.choice}" for ${req.id}. The Quest resumes.` }], details: { id: req.id, choice: m.choice } };
			}
			const text = (params.text ?? params.option ?? "").trim();
			if (!text) throw new Error(`Pass text for ${describe(req)}`);
			if (!approvals.answer(req.id, { action: "answer", approved: true, text })) throw new Error(`${req.id} is no longer pending.`);
			return { content: [{ type: "text", text: `Answered ${req.id}. The Quest resumes.` }], details: { id: req.id } };
		},
	});

	pi.registerTool({
		name: "raise_pr",
		label: "Raise PR",
		description: [
			"Raise the draft PR for a completed write-Quest: pushes the branch and opens a DRAFT pull request.",
			"PRs are auto-raised on Quest completion; use this tool to retry when auto-raise failed (network/auth) or",
			"was blocked (security-fix detection). Opening a draft needs no approval (a draft is for the human to review",
			"and decide whether to mark ready); it never merges, and if a PR already exists for the branch it is adopted",
			"rather than duplicated. If no questId is given, the most recent completed write-Quest with an un-raised draft is used.",
		].join(" "),
		promptSnippet: "Raise (push + open draft PR) the branch a write-Quest produced; no approval needed for a draft",
		promptGuidelines: [
			"Use raise_pr after a write Quest has produced a draft PR and the user wants it raised. Opening a draft PR needs no approval and only ever opens a DRAFT; it never merges. (Updating an existing PR via the address-feedback flow still asks for approval.)",
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
				if (params.questId && !record) throw new Error(`No Quest found with id "${params.questId}".`);
				// Explain the specific Quest (or, when auto-searching, the newest write-Quest) rather
				// than a bare refusal: e.g. a failed Quest whose branch still has commits gets the
				// manual push / gh pr create commands. Never auto-raises it.
				const target = record ?? manager.store.list().find((q) => q.isolations?.length);
				if (!target) throw new Error("No completed write-Quest with an un-raised draft PR was found.");
				if (target.prs?.length && target.prs.every((p) => p.url)) {
					throw new Error(`Quest "${target.title}" (${target.id}) has no un-raised draft PR: all its PRs are already raised (${target.prs.map((p) => p.url).join(", ")}).`);
				}
				const ahead = (iso: Parameters<typeof commitsAhead>[0]) => {
					try {
						return commitsAhead(iso);
					} catch {
						return undefined; // e.g. the worktree was removed
					}
				};
				const prefix = record ? "" : "No completed write-Quest with an un-raised draft PR was found. Most recent write-Quest: ";
				throw new Error(prefix + explainUnraisable(target, ahead));
			}

			const repos = record.prs.filter((p) => !p.url).map((p) => p.repo).join(", ");
			onUpdate?.({
				content: [{ type: "text", text: `Raising draft PR(s) for "${record.title}" [${repos}]…` }],
				details: {},
			});

			const result = await raisePr(record, {
				confirmSecurity: (message) => ctx.ui.confirm("Possible security fix", message),
			});
			const failures = result.results.filter((r) => !r.raised);
			record.raiseError = failures.length ? failures.map((f) => `${f.repo}: ${f.reason}`).join("; ") : undefined;
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
