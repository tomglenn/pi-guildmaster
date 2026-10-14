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
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getApprovalManager, getQuestManager } from "./orchestration/manager.ts";
import { type ReviewVerdict, reviewFlag } from "./execution/gh-tool.ts";
import { ApprovalManager } from "./orchestration/approvals.ts";
import type { UserRequest } from "./orchestration/approvals.ts";
import { commitsAhead } from "./execution/isolation.ts";
import { explainUnraisable, raisePr } from "./orchestration/pr.ts";
import { extractPostableReview } from "./orchestration/review-post.ts";
import type { QuestRecord } from "./persistence/quest-store.ts";
import { type CardLine, showCard } from "./ui.ts";
import { matchOption, numberedOptions, parseRequestArgs, requestCompletions, resolveRequestId } from "./request-input.ts";
import { getViewedFingerprint, hasUnsafeChars, openReviewViewer, reviewBodyFingerprint, reviewBodyFingerprintFull, sanitizeForLabel, showReviewCard } from "./review-viewer.ts";

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
 * Parse a PR label (e.g. "owner/repo#123") from an operation string like
 * "gh pr review 123 --repo owner/repo". Returns undefined if not parseable.
 */
export function parsePrLabelFromOperation(operation: string | undefined): string | undefined {
	if (!operation) return undefined;
	const m = /^gh pr review (\d+)(?:\s+--repo\s+([\w.\-/]+))?/.exec(operation);
	if (!m) return undefined;
	const [, number, slug] = m;
	return slug ? `${slug}#${number}` : `#${number}`;
}

/**
 * Build the compact /approve prompt for posting a PR review.
 *
 * Returns a `title` (multi-line summary: PR, verdict, body size + fingerprint, hint)
 * and `options` ordered `["Cancel", "Post … review (…)"]` so index 0 = Cancel is
 * the safe default when the user presses Enter without reading.
 *
 * The fingerprint (first 8 hex of sha256 of the body) is also shown in the /review
 * viewer header so the user can match what they are approving.
 *
 * No body content appears in the title or options — the full body is in /review.
 */
export function buildCompactReviewSelect(opts: {
	id: string;
	operation: string | undefined;
	/** PR label like "owner/repo#123" or "#123". Derived from operation when not supplied. */
	label?: string;
	verdict: ReviewVerdict;
	body: string;
	/** Contextual warnings shown in the confirm title. */
	warnings?: {
		/** User never viewed this review in /review this session. */
		neverViewed?: boolean;
		/** Body changed since it was last viewed in /review. */
		viewedDiffers?: boolean;
		/** No --repo slug: repository inferred by gh from checkout. */
		noSlug?: boolean;
		/** The file contained unsafe control/bidi/tag characters when last viewed. */
		viewedUnsafe?: boolean;
	};
}): { title: string; options: string[]; titleLinesPriority: string[] } {
	const flag = reviewFlag(opts.verdict);
	const event = REVIEW_EVENT[opts.verdict];
	const label = opts.label ?? parsePrLabelFromOperation(opts.operation);
	const lines = opts.body.split("\n");
	const fingerprint = reviewBodyFingerprint(opts.body);
	const command = `${opts.operation ?? "gh pr review"} ${flag}`;

	// Title lines in PRIORITY ORDER (most important first for budget-aware rendering):
	// 1. verdict/event+flag  2. PR  3. warnings  4. size+fingerprint  5. /review hint
	const verdictLine = `Verdict: ${event} (${flag})`;
	const prLine = label ? `PR: ${label}` : undefined;
	const sizeAndFp = `Body: ${lines.length} lines / ${opts.body.length} chars · ${fingerprint}`;
	const hintLine = `Review/edit first: /review ${opts.id}`;

	const warningLines: string[] = [];
	if (opts.warnings?.neverViewed) warningLines.push("⚠ Not yet viewed in /review this session");
	if (opts.warnings?.viewedDiffers) warningLines.push("⚠ Body changed since last /review — review again");
	if (opts.warnings?.viewedUnsafe) warningLines.push("⚠ File contained unsafe characters when last viewed");
	if (opts.warnings?.noSlug) warningLines.push("⚠ No --repo: repository inferred by gh from checkout");

	// Priority-ordered (for TUI budget trimming): verdict first, then PR, warnings, size/fp, hint
	const titleLinesPriority: string[] = [
		verdictLine,
		...(prLine ? [prLine] : []),
		...warningLines,
		sizeAndFp,
		hintLine,
	];

	// Full title for non-TUI display (all lines in original order)
	const titleLines = titleLinesPriority;

	return {
		title: titleLines.join("\n"),
		options: ["Cancel", `Post ${event} review (${command})`],
		titleLinesPriority,
	};
}

// ---------------------------------------------------------------------------
// ReviewConfirmComponent — TUI-mode confirm for /approve (review-artifact)
// ---------------------------------------------------------------------------

/** Injectable clock for testing the grace period. */
export interface ReviewConfirmClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimeout(t: ReturnType<typeof setTimeout>): void;
}

const defaultClock: ReviewConfirmClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (t) => clearTimeout(t),
};

/**
 * A compact TUI overlay confirm component for posting a PR review.
 *
 * Safety properties:
 *  - defaults to Cancel (index 0)
 *  - ignores ALL input for a ~500 ms grace period after opening (shows "arming…" indicator)
 *  - after the grace period, moves ONLY with ↑/↓/Tab/←/→; letters (j/k etc.) are ignored
 *  - Enter activates the highlighted option
 *  - Esc/ctrl+c cancel regardless of state
 */
export class ReviewConfirmComponent implements Component {
	private selectedIndex = 0; // 0 = Cancel
	private arming = true;
	private armTimer: ReturnType<typeof setTimeout> | undefined;
	private firstRendered = false;
	private readonly clock: ReviewConfirmClock;
	private readonly tui: { terminal: { rows: number }; requestRender(): void };
	private readonly titleLines: string[];
	/** Priority-ordered title lines for budget-aware rendering (verdict first). */
	private readonly priorityTitleLines: string[];
	private readonly options: string[];
	private readonly done: (result: string | undefined) => void;
	private readonly getBudgetRows: () => number;

	/** Grace period in ms; override in tests via clock injection. */
	static GRACE_MS = 500;

	constructor(
		tui: { terminal: { rows: number }; requestRender(): void },
		title: string,
		options: string[],
		done: (result: string | undefined) => void,
		clock?: ReviewConfirmClock,
		getBudgetRows?: () => number,
		priorityTitleLines?: string[],
	) {
		this.tui = tui;
		this.titleLines = title.split("\n");
		this.priorityTitleLines = priorityTitleLines ?? this.titleLines;
		this.options = options;
		this.done = done;
		this.clock = clock ?? defaultClock;
		this.getBudgetRows = getBudgetRows ?? (() => Math.max(1, this.tui.terminal.rows - 2));
		// Timer is NOT started here — it starts on first render (Issue 5).
	}

	private startArmTimer(): void {
		if (this.armTimer !== undefined) this.clock.clearTimeout(this.armTimer);
		this.armTimer = this.clock.setTimeout(() => {
			this.arming = false;
			this.armTimer = undefined;
			this.tui.requestRender();
		}, ReviewConfirmComponent.GRACE_MS);
	}

	dispose(): void {
		if (this.armTimer !== undefined) {
			this.clock.clearTimeout(this.armTimer);
			this.armTimer = undefined;
		}
	}

	invalidate(): void {
		// Stateless re-render: nothing to invalidate.
	}

	render(width: number): string[] {
		// Start the grace timer on first render (not constructor), so typed-ahead keys
		// arriving before the first render are discarded (Issue 5).
		if (!this.firstRendered) {
			this.firstRendered = true;
			this.startArmTimer();
		}

		const w = Math.max(1, width);
		// Budget: matches the overlay's effective height (margin:1, maxHeight:"100%" → rows-2).
		const budget = this.getBudgetRows();
		// Fixed bottom section: options + footer. No blank lines in minimal layout.
		const fixedBottom = this.options.length + 1; // N options + 1 footer
		const titleBudget = budget - fixedBottom;

		// "Too small" state: cannot show even one priority title line + options + footer.
		if (titleBudget <= 0) {
			return [truncateToWidth("Terminal too small to confirm safely — Esc to cancel", w)].slice(0, budget);
		}

		// Select up to titleBudget lines from priority-ordered title lines.
		const selectedTitle = this.priorityTitleLines.slice(0, titleBudget);

		// Options with selection marker.
		const optionLines: string[] = [];
		for (let i = 0; i < this.options.length; i++) {
			const marker = i === this.selectedIndex ? "→ " : "  ";
			optionLines.push(truncateToWidth(`${marker}${this.options[i]}`, w));
		}

		// Footer: arming indicator or key hints.
		const footer = this.arming
			? "Arming (wait)  Esc: cancel"
			: "↑↓ Tab ←→ navigate  Enter: confirm  Esc: cancel";

		return [
			...selectedTitle.map((l) => truncateToWidth(l, w)),
			...optionLines,
			truncateToWidth(footer, w),
		];
	}

	handleInput(data: string): void {
		// Esc and ctrl+c always cancel, even during grace — use matchesKey for Kitty protocol support.
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}

		// "Too small" state: only Esc/ctrl+c work (handled above).
		const budget = this.getBudgetRows();
		if (budget - this.options.length - 1 <= 0) return;

		// During grace period: discard the input AND restart the quiet timer (Issue 5).
		if (this.arming) {
			this.startArmTimer();
			return;
		}

		// Navigation: ↑/↓/Tab/←/→ ONLY (not j/k or other letters).
		if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, Key.down) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, Key.enter)) {
			// Enter: activate highlighted option.
			this.done(this.options[this.selectedIndex]);
			return;
		}
		// All other keys (j, k, letters, etc.) are silently ignored.
		this.tui.requestRender();
	}
}

/** Read a postsReview artifact FRESH and parse what would post (never a cached or whole-file body). */
export function readPostable(artifactPath: string | undefined): ReturnType<typeof extractPostableReview> {
	if (!artifactPath) return { error: "the request has no review file" };
	try {
		return extractPostableReview(fs.readFileSync(artifactPath, "utf-8"));
	} catch (err) {
		return { error: `could not read ${artifactPath} (${err instanceof Error ? err.message : String(err)})` };
	}
}

export function registerApprovals(
	pi: ExtensionAPI,
	opts?: {
		/** Inject an ApprovalManager (tests). Defaults to the singleton. */
		approvals?: ApprovalManager;
		/** Inject a clock for the grace-period timer (tests). */
		reviewConfirmClock?: ReviewConfirmClock;
	},
): void {
	const approvals = opts?.approvals ?? getApprovalManager();
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
		const labels = eligible.map((r) => `${r.id} — ${sanitizeForLabel(requestTitle(questTitleOf(r), r))}`);
		const pick = await ctx.ui.select(`/${verb}: which request?`, labels);
		const req = pick ? eligible[labels.indexOf(pick)] : undefined;
		return req ? { req, rest: parsed.rest, implicit: false } : undefined;
	};

	/** Show WHY the user is being asked before a picker/input: a select only renders the title + options. */
	const showRequestContext = (req: UserRequest) => {
		if (!req.description?.trim()) return;
		// Descriptions are Markdown (reviewer findings, party questions): render, never print raw.
		showCard(pi, {
			title: requestTitle(questTitleOf(req), req),
			markdown: req.description,
			lines: req.options?.length ? numberedOptions(req.options).map((text) => ({ text, color: "accent" as ThemeColor })) : [],
		});
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
						? `/choose ${r.id}  (opens a picker)  ·  /choose ${r.id} <number>${r.optionNotes && Object.keys(r.optionNotes).length ? " [guidance]" : ""}`
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
					// Cancel-first select (exact-equality consent) — avoids a stray Enter approving.
					const safeTitle = sanitizeForLabel(requestTitle(questTitleOf(req), req));
					const confirmLabel = `${verb === "approve" ? "Approve" : "Decline"}: "${safeTitle}"`;
					const cancelLabel = "Cancel";
					const confirmPick = await ctx.ui.select(
						`${verb === "approve" ? "Approve" : "Decline"}: ${safeTitle}?`,
						[cancelLabel, confirmLabel],
					);
					if (confirmPick !== confirmLabel) return ctx.ui.notify(`${id} is still pending.`, "info");
				}
				if (verb === "approve" && req?.kind === "review-artifact" && req.postsReview) {
					// ---------------------------------------------------------------
					// Posting a PR review: compact TUI confirm with grace period,
					// Cancel-first, no j/k type-ahead; select() fallback for RPC.
					// ---------------------------------------------------------------
					if (!ctx.hasUI) {
						ctx.ui.notify(`Not posted: ${id} posts a PR review and needs an interactive confirm. Run /approve ${id} in the interactive terminal.`, "warning");
						return;
					}
					// Parse the current file fresh.
					const parsed = readPostable(req.artifactPath);
					if ("error" in parsed) {
						ctx.ui.notify(`Not posted: ${sanitizeForLabel(parsed.error)}. Edit ${req.artifactPath ?? "review.md"} and /approve ${id} again.`, "warning");
						return;
					}
					// Guard: refuse to post if body/verdict contains unsafe chars (injection risk).
					// Covers C0/C1 controls, bidi controls, Unicode tag chars, and ZW non-printing chars.
					if (hasUnsafeChars(parsed.body) || hasUnsafeChars(parsed.verdict)) {
						ctx.ui.notify(
							`Not posted: the review body or verdict contains control/bidi/tag characters that could indicate tampering. ` +
								`Edit ${req.artifactPath ?? "review.md"} to remove them, then /approve ${id} again.`,
							"warning",
						);
						return;
					}
					const flag = reviewFlag(parsed.verdict);
					const label = parsePrLabelFromOperation(req.operation);
					// Warn when the review was never viewed, or body changed since last /review.
					// Use FULL sha256 hash for comparison (not truncated 8-char display version).
					const viewedEntry = getViewedFingerprint(id);
					const fingerprintFull = reviewBodyFingerprintFull(parsed.body);
					const fingerprint = fingerprintFull.slice(0, 8); // display only
					const neverViewed = viewedEntry === undefined;
					const viewedDiffers = viewedEntry !== undefined && viewedEntry.hash !== fingerprintFull;
					const viewedUnsafe = viewedEntry?.hasUnsafeChars === true;
					// Warn if no --repo slug (gh infers from checkout).
					const noSlug = !label || label.startsWith("#");
					const prompt = buildCompactReviewSelect({
						id,
						operation: req.operation,
						label,
						verdict: parsed.verdict,
						body: parsed.body,
						warnings: { neverViewed, viewedDiffers, noSlug, viewedUnsafe },
					});
					let pick: string | undefined;
					if (ctx.mode === "tui") {
						// TUI: custom confirm with grace period and budget-aware rendering.
						// overlay margin:1, maxHeight:"100%" → budget = rows-2 (matches component).
						pick = await ctx.ui.custom<string | undefined>(
							(tui, _theme, _kb, done) => {
								const getRows = () => Math.max(1, tui.terminal.rows - 2);
								return new ReviewConfirmComponent(
									tui, prompt.title, prompt.options, done,
									opts?.reviewConfirmClock, getRows, prompt.titleLinesPriority,
								);
							},
							{
								overlay: true,
								overlayOptions: {
									margin: 1,
									maxHeight: "100%",
									width: "80%",
									minWidth: 40,
								},
							},
						);
					} else {
						// Non-TUI (RPC etc.): plain select fallback.
						pick = await ctx.ui.select(prompt.title, prompt.options);
					}
					// Only EXACT equality with the Post option counts as consent.
					if (pick !== prompt.options[1]) {
						ctx.ui.notify(`Not posted — ${id} is still pending. /review ${id} to read/edit, then /approve ${id} again.`, "info");
						return;
					}
					// TOCTOU: re-read after confirm; compare EXACT body AND verdict (not fingerprint hash).
					const reParsed = readPostable(req.artifactPath);
					if ("error" in reParsed) {
						ctx.ui.notify(`Not posted: file changed while confirming (${sanitizeForLabel(reParsed.error)}). /approve ${id} again.`, "warning");
						return;
					}
					if (reParsed.body !== parsed.body || reParsed.verdict !== parsed.verdict) {
						ctx.ui.notify(`Not posted: the review file changed while you were confirming. Run /approve ${id} again.`, "warning");
						return;
					}
					// Post the EXACT snapshot the user confirmed.
					const done = approvals.answer(id, { action: "approve", approved: true, review: { verdict: parsed.verdict, body: parsed.body } });
					ctx.ui.notify(done ? `Approved ${id} — posting ${REVIEW_EVENT[parsed.verdict]} (${flag}).` : `${id} is no longer pending; nothing posted.`, done ? "info" : "warning");
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
			let note: string | undefined;
			// `/choose 2 <note>`: a note-taking option can carry its text inline.
			const inline = /^#?(\d+)\.?\s+([\s\S]+)$/.exec(rest);
			if (inline && options.length) {
				const m = matchOption(options, inline[1]);
				if ("choice" in m && req.optionNotes?.[m.choice]) {
					choice = m.choice;
					note = inline[2].trim();
				}
			}
			if (options.length === 0) {
				choice = rest || (ctx.hasUI ? (await ctx.ui.input(req.title, "Your choice"))?.trim() : undefined);
				if (!choice) return ctx.ui.notify(`Nothing chosen — ${req.id} is still pending.`, "info");
			} else {
				const list = numberedOptions(options);
				if (rest && !choice) {
					const m = matchOption(options, rest);
					if ("choice" in m) choice = m.choice;
					else if (!ctx.hasUI) return ctx.ui.notify(`${m.error}\n${list.join("\n")}`, "warning");
					else ctx.ui.notify(`${m.error} Pick one from the list.`, "warning");
				}
				if (!choice) {
					if (!ctx.hasUI) return ctx.ui.notify(`Usage: /choose ${req.id} <number>\n${list.join("\n")}`, "warning");
					showRequestContext(req);
					const pick = await ctx.ui.select(sanitizeForLabel(requestTitle(questTitleOf(req), req)), list);
					if (!pick) return ctx.ui.notify(`Nothing chosen — ${req.id} is still pending.`, "info");
					choice = options[list.indexOf(pick)];
				}
			}
			// Same step, no second request: an option that takes a note asks for it right away.
			const notePrompt = choice ? req.optionNotes?.[choice] : undefined;
			if (notePrompt && note === undefined && ctx.hasUI) {
				const typed = await ctx.ui.input(notePrompt, "Enter to skip");
				if (typed === undefined) return ctx.ui.notify(`Nothing sent \u2014 ${req.id} is still pending.`, "info");
				note = typed.trim() || undefined;
			}
			const done = approvals.answer(req.id, { action: "choose", approved: true, choice, text: note });
			ctx.ui.notify(
				done ? `Chose "${choice}" for ${req.id}${notePrompt ? (note ? " with your guidance" : " (no extra guidance)") : ""}.` : `${req.id} is no longer pending; nothing sent.`,
				done ? "info" : "warning",
			);
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
			if (!rest && ctx.hasUI) showRequestContext(req);
			if (!rest && ctx.hasUI) rest = (await ctx.ui.input(sanitizeForLabel(requestTitle(questTitleOf(req), req)), req.kind === "review-artifact" ? "Notes to send back" : "Your answer"))?.trim() ?? "";
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
			const label = parsePrLabelFromOperation(req.operation);
			if (ctx.mode === "tui") {
				// TUI: scrollable, editable viewer. Never posts — use /approve <id>.
				await openReviewViewer(ctx, req as UserRequest & { kind: "review-artifact"; artifactPath: string }, pi, label ?? undefined);
			} else {
				// Non-TUI fallback: card with the FULL file (no truncation).
				showReviewCard(pi, req as UserRequest & { kind: "review-artifact"; artifactPath: string }, label ?? undefined);
			}
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
			text: Type.Optional(Type.String({ description: "For an 'answer' request: the user's answer. For a 'choose' option that takes a note (e.g. send-back guidance): the user's note." })),
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
				// With option given, text is the optional note for a note-taking option (e.g. retry guidance).
				const note = params.option && req.optionNotes?.[m.choice] ? params.text?.trim() || undefined : undefined;
				if (!approvals.answer(req.id, { action: "choose", approved: true, choice: m.choice, text: note })) throw new Error(`${req.id} is no longer pending.`);
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
			"Retry opening the draft PR for a completed write-Quest: pushes the branch and opens a DRAFT pull request.",
			"Quests open their draft PR automatically when done; use this only when that failed (push/auth error) or the",
			"publish scan refused it and the user has since removed the flagged content. Opening a draft needs no approval (a draft is for the human to review",
			"and decide whether to mark ready); it never merges, and if a PR already exists for the branch it is adopted",
			"rather than duplicated. If no questId is given, the most recent completed write-Quest with an un-raised draft is used.",
		].join(" "),
		promptSnippet: "Raise (push + open draft PR) the branch a write-Quest produced; no approval needed for a draft",
		promptGuidelines: [
			"Use raise_pr only to retry a write Quest's draft PR that failed to open (push/auth error, or the publish scan refused it and the content was removed). Opening a draft PR needs no approval and only ever opens a DRAFT; it never merges. (Updating an existing PR via the address-feedback flow still asks for approval.)",
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

			const result = await raisePr(record, {});
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
