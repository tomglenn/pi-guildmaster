/**
 * TUI review viewer: a scrollable, editable view of a review-artifact file.
 *
 * `/review <id>` opens this component (TUI only). It shows:
 *   - a fixed header with the request title, PR info, parsed verdict/flag or parse error,
 *     and a content fingerprint that matches the /approve compact prompt
 *   - a scrollable body with the FULL file content (every line reachable by scrolling)
 *   - an always-visible footer with key hints and scroll position
 *
 * `e` opens ctx.ui.editor on the current file; on submit the file is written, re-parsed,
 * the new verdict/flag or error is notified, and the viewer reopens. Cancel writes nothing.
 * `q`/Esc closes the viewer without posting.
 *
 * Non-TUI fallback: a card with the full file body plus path/instructions.
 *
 * Overlay mode: the viewer is mounted as an overlay (not in editorContainer), so the row
 * budget is exactly `tui.terminal.rows - 2` (1-row top + 1-row bottom margin). The
 * component is sized to that budget; the overlay's maxHeight matches it.
 *
 * Tiny terminals (rows 1–5): footer always renders last; when rows are scarce the verdict +
 * fingerprint line is shown before the title (priority ordering).
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { type ReviewVerdict, reviewFlag } from "./execution/gh-tool.ts";
import { extractPostableReview } from "./orchestration/review-post.ts";
import { type CardLine, showCard } from "./ui.ts";
import type { UserRequest } from "./orchestration/approvals.ts";
import { hasUnsafeChars, sanitizeForDisplay, sanitizeForLabel } from "./sanitize.ts";

// Re-export sanitizers from the shared module for backward compatibility.
export { hasUnsafeChars, sanitizeForDisplay, sanitizeForLabel } from "./sanitize.ts";

export type ReviewViewerResult = "close" | "edit";

/** Compute the FULL sha256 hex digest of the body (stored in the viewed-fingerprint store for secure comparison). */
export function reviewBodyFingerprintFull(body: string): string {
	return createHash("sha256").update(body).digest("hex");
}

/** Compute the short (first-8-hex) fingerprint shown in the viewer header and the /approve confirm. */
export function reviewBodyFingerprint(body: string): string {
	return reviewBodyFingerprintFull(body).slice(0, 8);
}


// ---------------------------------------------------------------------------
// Per-session viewed-fingerprint store
// ---------------------------------------------------------------------------

/**
 * Per-session map: requestId -> { hash: full sha256, hasUnsafeChars }.
 * The full hash is stored so /approve can compare EXACT hashes, not truncated 8-char versions.
 */
const viewedFingerprints = new Map<string, { hash: string; hasUnsafeChars: boolean }>();

/**
 * Record that the /review viewer displayed this body for request `id`.
 * Stores the FULL sha256 hash for secure comparison in /approve.
 * `hasUnsafe` is true when the displayed file contained unsafe control/bidi/tag characters.
 */
export function recordViewedFingerprint(id: string, body: string, hasUnsafe = false): void {
	viewedFingerprints.set(id, { hash: reviewBodyFingerprintFull(body), hasUnsafeChars: hasUnsafe });
}

/** Return the stored entry for `id`, or undefined if never viewed. */
export function getViewedFingerprint(id: string): { hash: string; hasUnsafeChars: boolean } | undefined {
	return viewedFingerprints.get(id);
}

/** Reset the viewed-fingerprint store. Used in tests only. */
export function clearViewedFingerprints(): void {
	viewedFingerprints.clear();
}

// ---------------------------------------------------------------------------
// ReviewViewerComponent
// ---------------------------------------------------------------------------

/**
 * The TUI component for the review viewer.
 * Exported so tests can exercise it without a live terminal.
 *
 * The mock TUI for tests only needs: `{ terminal: { rows: number }, requestRender(): void }`.
 *
 * @param getBudgetRows Override for the row budget (defaults to `tui.terminal.rows`).
 *   In overlay mode pass `() => Math.max(1, tui.terminal.rows - 2)` so the component's
 *   budget matches the overlay's maxHeight.
 * @param headerLinesPriority Priority-ordered header lines for tiny terminals (rows ≤ 4).
 *   Defaults to same as headerLines.
 * @param onFirstBodyRender Called once on the first render that shows ≥1 body row.
 *   Used by openReviewViewer to record the viewed fingerprint only after the body
 *   is actually visible (not before, which would always record even on rows 1–3).
 */
export class ReviewViewerComponent implements Component {
	private scrollOffset = 0;
	/** Cached wrapped lines; invalidated when width changes. */
	private wrappedBody: string[] = [];
	private lastWrappedWidth = -1;
	private firstBodyRendered = false;
	private readonly tui: { terminal: { rows: number }; requestRender(): void };
	private readonly headerLines: string[];
	private readonly headerLinesPriority: string[];
	private readonly rawBody: string;
	private readonly footerHint: string;
	private readonly done: (result: ReviewViewerResult) => void;
	private readonly getBudgetRows: () => number;
	private readonly onFirstBodyRender: (() => void) | undefined;

	constructor(
		tui: { terminal: { rows: number }; requestRender(): void },
		headerLines: string[],
		rawBody: string,
		footerHint: string,
		done: (result: ReviewViewerResult) => void,
		getBudgetRows?: () => number,
		headerLinesPriority?: string[],
		onFirstBodyRender?: () => void,
	) {
		this.tui = tui;
		this.headerLines = headerLines;
		this.rawBody = rawBody;
		this.footerHint = footerHint;
		this.done = done;
		this.getBudgetRows = getBudgetRows ?? (() => this.tui.terminal.rows);
		this.headerLinesPriority = headerLinesPriority ?? headerLines;
		this.onFirstBodyRender = onFirstBodyRender;
	}

	invalidate(): void {
		this.lastWrappedWidth = -1; // force re-wrap on next render
	}

	render(width: number): string[] {
		const rows = Math.max(1, this.getBudgetRows());
		const effectiveWidth = Math.max(1, width);

		// For tiny terminals (≤ 4 rows), use priority-ordered header lines
		// (verdict/fingerprint first, so the user sees what they'd be approving).
		const useHeader = rows <= 4 ? this.headerLinesPriority : this.headerLines;

		// Always reserve 1 row for the footer. With ≥ 3 rows also reserve 1 for body.
		const footerRows = 1;
		const minBodyRows = rows >= 3 ? 1 : 0;
		const headerRows = Math.min(useHeader.length, Math.max(0, rows - footerRows - minBodyRows));
		const bodyRows = Math.max(0, rows - headerRows - footerRows);

		// Re-wrap body when width changes.
		if (effectiveWidth !== this.lastWrappedWidth) {
			this.lastWrappedWidth = effectiveWidth;
			this.wrappedBody = this.rawBody.split("\n").flatMap((line) => {
				if (line === "") return [""];
				const wrapped = wrapTextWithAnsi(line, effectiveWidth);
				return wrapped.length > 0 ? wrapped : [""];
			});
		}

		const totalBodyLines = this.wrappedBody.length;
		const maxScroll = Math.max(0, totalBodyLines - bodyRows);
		// Clamp scroll position (may be stale from a resize or initial open).
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		if (this.scrollOffset < 0) this.scrollOffset = 0;

		const visibleEnd = Math.min(this.scrollOffset + bodyRows, totalBodyLines);
		const visibleBodySlice = this.wrappedBody.slice(this.scrollOffset, visibleEnd);

		// Scroll position indicator.
		const first = totalBodyLines === 0 ? 0 : this.scrollOffset + 1;
		const last = visibleEnd;
		const pct = totalBodyLines === 0 ? 100 : Math.round((last / totalBodyLines) * 100);
		const scrollInfo = `${first}–${last}/${totalBodyLines} ${pct}%`;
		// Put scroll position first so it is never truncated on narrow terminals.
		const footer = truncateToWidth(`${scrollInfo}  ${this.footerHint}`, effectiveWidth);

		// Issue 5: fire the callback on the first render where at least 1 body row is visible.
		// This prevents recording the fingerprint when the terminal is too small to show
		// any body content (rows 1–3 with overlay budget rows-2).
		if (!this.firstBodyRendered && bodyRows > 0 && visibleBodySlice.length > 0) {
			this.firstBodyRendered = true;
			this.onFirstBodyRender?.();
		}

		const out: string[] = [];
		for (let i = 0; i < headerRows; i++) {
			out.push(truncateToWidth(useHeader[i] ?? "", effectiveWidth));
		}
		for (const line of visibleBodySlice) {
			out.push(truncateToWidth(line, effectiveWidth));
		}
		out.push(footer);

		// Safety: never exceed budget (defensive; the math above should guarantee this).
		return out.slice(0, rows);
	}

	handleInput(data: string): void {
		const rows = Math.max(1, this.getBudgetRows());
		const footerRows = 1;
		const minBodyRows = rows >= 3 ? 1 : 0;
		const useHeader = rows <= 4 ? this.headerLinesPriority : this.headerLines;
		const headerRows = Math.min(useHeader.length, Math.max(0, rows - footerRows - minBodyRows));
		const bodyRows = Math.max(0, rows - headerRows - footerRows);
		const maxScroll = Math.max(0, this.wrappedBody.length - bodyRows);

		const clamp = (n: number) => Math.max(0, Math.min(maxScroll, n));

		if (matchesKey(data, Key.up) || data === "k") {
			this.scrollOffset = clamp(this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.scrollOffset = clamp(this.scrollOffset + 1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = clamp(this.scrollOffset - bodyRows);
		} else if (matchesKey(data, Key.pageDown) || data === " ") {
			this.scrollOffset = clamp(this.scrollOffset + bodyRows);
		} else if (matchesKey(data, Key.home) || data === "g") {
			this.scrollOffset = 0;
		} else if (matchesKey(data, Key.end) || data === "G") {
			this.scrollOffset = maxScroll;
		} else if (data === "e") {
			this.done("edit");
			return;
		} else if (data === "q" || matchesKey(data, Key.escape)) {
			this.done("close");
			return;
		}
		this.tui.requestRender();
	}
}

// ---------------------------------------------------------------------------
// Header builders
// ---------------------------------------------------------------------------

/**
 * Build the fixed header lines for the review viewer in normal (top-to-bottom) order.
 * Also returns a `priorityLines` array where verdict/fingerprint comes first,
 * for use on tiny terminals where rows are scarce.
 */
export function buildViewerHeader(opts: {
	title: string;
	/** e.g. "owner/repo#123" */
	label?: string;
	/** Parse result for the current file. */
	parsed: ReturnType<typeof extractPostableReview>;
	/** Content fingerprint (first 8 hex of sha256 of the postable body, or "" on error). */
	fingerprint: string;
	id: string;
	/** When true, adds a prominent warning that the file contains unsafe characters. */
	unsafeWarning?: boolean;
}): { lines: string[]; priorityLines: string[] } {
	const verdictLine =
		"error" in opts.parsed
			? `⚠ Cannot post: ${sanitizeForLabel(opts.parsed.error)}`
			: `Verdict: ${opts.parsed.verdict} (${reviewFlag(opts.parsed.verdict as ReviewVerdict)})  ·  fp: ${opts.fingerprint}`;
	const hintLine = `e edit  q close  /approve ${opts.id}`;
	const sep = "─".repeat(20);
	const unsafeLine = opts.unsafeWarning
		? "⚠⚠ UNSAFE CHARS: file contains hidden control/bidi characters — review carefully"
		: undefined;

	const lines: string[] = [
		...(unsafeLine ? [unsafeLine] : []),
		`Review: ${sanitizeForLabel(opts.title)}`,
		...(opts.label ? [`PR: ${opts.label}`] : []),
		verdictLine,
		hintLine,
		sep,
	];

	// Priority order for tiny terminals: verdict first (most important for safety).
	const priorityLines: string[] = [
		verdictLine,
		...(unsafeLine ? [unsafeLine] : []),
		`Review: ${sanitizeForLabel(opts.title)}`,
		...(opts.label ? [`PR: ${opts.label}`] : []),
		hintLine,
		sep,
	];

	return { lines, priorityLines };
}

/** Footer hint string for the review viewer. */
export const VIEWER_FOOTER_HINT = "↑/↓ j/k scroll  Space/PgDn  PgUp  g/G Home/End  e edit  q close";

// ---------------------------------------------------------------------------
// openReviewViewer
// ---------------------------------------------------------------------------

/**
 * Open the review viewer in TUI mode as an overlay, looping through edit→reopen cycles.
 * Returns when the user closes the viewer.
 *
 * Uses overlay: true with maxHeight = terminal.rows - 2 (1-row margins) so the component
 * never overflows the real screen regardless of other UI elements in editorContainer.
 *
 * Records the viewed fingerprint in the session store so /approve can warn if the
 * body was never viewed or differs from what was last seen.
 */
export async function openReviewViewer(
	ctx: ExtensionCommandContext,
	req: UserRequest & { kind: "review-artifact"; artifactPath: string },
	pi: ExtensionAPI,
	label?: string,
): Promise<void> {
	for (;;) {
		// Read the file fresh on each open (including after an edit).
		let content = "";
		try {
			content = fs.readFileSync(req.artifactPath, "utf-8");
		} catch {
			content = "(could not read the artifact file)";
		}

		const parsed = extractPostableReview(content);
		const fingerprint = "error" in parsed ? "" : reviewBodyFingerprint(parsed.body);
		const unsafe = hasUnsafeChars(content);

		// Issue 5: Record the viewed fingerprint only after the component has rendered
		// at least 1 body row (i.e., the body was actually visible). On tiny terminals
		// (rows 1-3: overlay budget = rows-2 = 1, no body rows fit), we do not mark as
		// viewed — /approve will keep the "not viewed" warning.
		const recordViewed = () => {
			if (!("error" in parsed) && fingerprint) recordViewedFingerprint(req.id, parsed.body, unsafe);
		};

		const { lines: headerLines, priorityLines: headerLinesPriority } = buildViewerHeader({
			title: req.title,
			label,
			parsed,
			fingerprint,
			id: req.id,
			unsafeWarning: unsafe,
		});

		// Sanitize content before display: replace control bytes with visible placeholders.
		const sanitizedContent = sanitizeForDisplay(content);

		// Mount as overlay so the row budget is bounded by the real terminal height minus margins.
		// The component's getBudgetRows matches the overlay's effective maxHeight (both = rows - 2).
		const result = await ctx.ui.custom<ReviewViewerResult>(
			(tui, _theme, _kb, done) => {
				const getRows = () => Math.max(1, tui.terminal.rows - 2);
				return new ReviewViewerComponent(
					tui,
					headerLines,
					sanitizedContent,
					VIEWER_FOOTER_HINT,
					done,
					getRows,
					headerLinesPriority,
					recordViewed,
				);
			},
			{
				overlay: true,
				overlayOptions: {
					// margin: 1 → top/bottom margins of 1 row each; availHeight = rows - 2.
					// maxHeight: "100%" is clamped to availHeight = rows - 2, matching getRows().
					margin: 1,
					maxHeight: "100%",
					width: "90%",
					minWidth: 40,
				},
			},
		);

		if (result !== "edit") break; // "close" or undefined

		// User pressed 'e': re-read fresh right before opening the editor (no stale prefill).
		let freshContent = "";
		try {
			freshContent = fs.readFileSync(req.artifactPath, "utf-8");
		} catch {
			freshContent = content; // fallback to what we already have
		}

		// Issue 8: if the file has unsafe control/bidi/tag chars, do NOT open the inline
		// editor (that would silently corrupt the sanitized prefill). Tell the user to
		// edit the file at its path with an external editor instead.
		if (hasUnsafeChars(freshContent)) {
			ctx.ui.notify(
				`Cannot open inline editor: ${sanitizeForLabel(req.artifactPath)} contains unsafe control or bidi characters. ` +
				`Edit the file directly at: ${req.artifactPath}`,
				"warning",
			);
			continue;
		}

		const edited = await ctx.ui.editor(`Edit review: ${sanitizeForLabel(req.title)}`, freshContent);
		if (edited === undefined) {
			// Cancelled — nothing written; reopen viewer with same content.
			continue;
		}
		// Write the edited content to the artifact file (authoritative).
		try {
			fs.writeFileSync(req.artifactPath, edited, { encoding: "utf-8", mode: 0o600 });
		} catch (err) {
			ctx.ui.notify(
				`Could not write ${req.artifactPath}: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			continue;
		}
		// Re-parse and notify the new verdict/flag or error.
		const reParsed = extractPostableReview(edited);
		if ("error" in reParsed) {
			ctx.ui.notify(`Edit saved. Cannot post yet: ${sanitizeForLabel(reParsed.error)}`, "warning");
		} else {
			const flag = reviewFlag(reParsed.verdict as ReviewVerdict);
			ctx.ui.notify(
				`Edit saved. Verdict: ${reParsed.verdict} (${flag}). /approve ${req.id} to post.`,
				"info",
			);
		}
		// Reopen the viewer with the updated content.
	}
}

// ---------------------------------------------------------------------------
// Non-TUI fallback
// ---------------------------------------------------------------------------

/**
 * Non-TUI fallback for /review: show a card with the FULL file content
 * (no truncation) plus path and instructions. Content is sanitized for display.
 */
export function showReviewCard(
	pi: ExtensionAPI,
	req: UserRequest & { kind: "review-artifact"; artifactPath: string },
	label?: string,
): void {
	let content = "";
	try {
		content = fs.readFileSync(req.artifactPath, "utf-8");
	} catch {
		content = "(could not read the artifact file)";
	}
	const parsed = extractPostableReview(content);

	// Record viewed fingerprint even in non-TUI mode.
	const cardUnsafe = hasUnsafeChars(content);
	if (!("error" in parsed)) {
		recordViewedFingerprint(req.id, parsed.body, cardUnsafe);
	}

	const headerLines: CardLine[] = [];
	if (label) headerLines.push({ text: `PR: ${label}`, color: "muted" });
	if ("error" in parsed) {
		headerLines.push({ text: `⚠ Cannot post: ${sanitizeForLabel(parsed.error)}`, color: "warning", bold: true });
	} else {
		const flag = reviewFlag(parsed.verdict as ReviewVerdict);
		const fingerprint = reviewBodyFingerprint(parsed.body);
		headerLines.push({
			text: `Verdict: ${parsed.verdict} (${flag})  ·  fingerprint: ${fingerprint}`,
			color: "accent",
			bold: true,
		});
	}
	headerLines.push({ text: "", color: "muted" });
	headerLines.push({ text: req.artifactPath, color: "accent" });
	headerLines.push({
		text: `Edit ${req.artifactPath}, then /approve ${req.id} to post, or /answer ${req.id} <notes> to send back, or /deny ${req.id}.`,
		color: "muted",
	});
	headerLines.push({ text: "", color: "muted" });

	// Sanitize for display.
	const sanitizedContent = sanitizeForDisplay(content);
	const bodyLines: CardLine[] = sanitizedContent.split("\n").map((line) => ({ text: line, color: "dim" as const }));

	showCard(pi, {
		title: `Review: ${req.title}`,
		lines: [...headerLines, ...bodyLines],
	});
}
