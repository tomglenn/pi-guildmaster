/**
 * Guild status board (§12, §20) — ambient, push-based visibility.
 *
 * A single always-on widget (plus a compact footer and transition toasts) so the
 * user never has to poll for state. It subscribes to the Quest and Approval
 * managers and repaints on every change:
 *   - active parties with live member glyphs;
 *   - pending approvals (with ids, so /approve works inline);
 *   - "ready" items: completed write-Quests with an un-raised draft PR.
 *
 * Toasts fire only on the moments that need the user or are done (needs-approval,
 * completed, failed) — live churn stays in the widget, never as toast spam.
 *
 * PERFORMANCE FIX: This module previously re-read the entire quest store from
 * disk on every member status change via repaint() → QuestStore.list(). Now it
 * renders from the QuestManager's in-memory recordCache, and coalesces bursts
 * of repaints via scheduleRepaint() to avoid synchronous disk I/O storms.
 */

import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getApprovalManager, getQuestManager } from "./orchestration/manager.ts";
import type { QuestMemberStatus, QuestRecord } from "./persistence/quest-store.ts";

const WIDGET = "guildmaster-board";
const QUEST_CARD = "guildmaster-quest";

const MEMBER_GLYPH: Record<QuestMemberStatus, string> = { pending: "○", running: "●", done: "✓", failed: "✗" };

/** Per-status colour for a party member's glyph + name. */
const MEMBER_COLOR: Record<QuestMemberStatus, ThemeColor> = { pending: "muted", running: "accent", done: "success", failed: "error" };

/**
 * Calculate the visible display width of a string, stripping ANSI escape codes.
 * Approximate for CJK/emoji; accurate for typical ASCII member names.
 */
function visibleWidth(s: string): number {
	// Strip ANSI escape codes (SGR sequences used by theme.fg/bold)
	const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
	// Simple char count - sufficient for ASCII names/glyphs used in member chips
	// Note: For full CJK/emoji support, would need get-east-asian-width library
	return stripped.length;
}

/**
 * Build a compact summary of party member statuses: · 3 members · ✓2 ●1
 * Shows non-zero status counts with glyphs; omits zero-count statuses.
 */
function memberSummary(
	members: QuestRecord["members"],
	theme: { fg: (c: ThemeColor, t: string) => string }
): string {
	const counts: Record<QuestMemberStatus, number> = { done: 0, running: 0, pending: 0, failed: 0 };
	for (const m of members) counts[m.status]++;

	const parts: string[] = [];
	// Order: done, running, pending, failed
	if (counts.done > 0) parts.push(theme.fg(MEMBER_COLOR.done, `${MEMBER_GLYPH.done}${counts.done}`));
	if (counts.running > 0) parts.push(theme.fg(MEMBER_COLOR.running, `${MEMBER_GLYPH.running}${counts.running}`));
	if (counts.pending > 0) parts.push(theme.fg(MEMBER_COLOR.pending, `${MEMBER_GLYPH.pending}${counts.pending}`));
	if (counts.failed > 0) parts.push(theme.fg(MEMBER_COLOR.failed, `${MEMBER_GLYPH.failed}${counts.failed}`));

	const total = members.length;
	const noun = total === 1 ? "member" : "members";
	// Format: · 13 members · ✓11 ●2
	return `· ${total} ${noun} · ${parts.join(" ")}`;
}

/**
 * Collapse ONLY completed members into a single `✓N` count, while keeping every
 * still-relevant member (running / pending / failed) as a full named chip.
 *
 * This is the middle tier between full chips and the counts-only summary: on a
 * large party the finished members are noise, but the user needs to see WHICH
 * members are still outstanding — collapsing everything (the old behaviour) hid
 * exactly that. Format: `✓21  ● runner  ○ scribe`.
 */
function collapseDoneChips(
	members: QuestRecord["members"],
	theme: { fg: (c: ThemeColor, t: string) => string }
): string {
	const doneCount = members.filter((m) => m.status === "done").length;
	const active = members.filter((m) => m.status !== "done");
	const parts: string[] = [];
	if (doneCount > 0) parts.push(theme.fg(MEMBER_COLOR.done, `${MEMBER_GLYPH.done}${doneCount}`));
	for (const m of active) parts.push(theme.fg(MEMBER_COLOR[m.status], `${MEMBER_GLYPH[m.status]} ${m.name}`));
	return parts.join("  ");
}

/**
 * Format member chips, preferring the most detail that fits:
 *   1. full named chips for everyone;
 *   2. else completed collapsed to `✓N` with active members still shown in full;
 *   3. else the counts-only summary as a last resort.
 * Single member always shows a full chip. When budget is undefined, tiers are
 * chosen by member-count heuristics (terminal width unavailable).
 */
function formatMemberChips(
	record: QuestRecord,
	theme: { fg: (c: ThemeColor, t: string) => string },
	budget: number | undefined
): string {
	const members = record.members;
	if (members.length === 0) return "";

	// Single member: always show full chip
	if (members.length === 1) {
		const m = members[0];
		return theme.fg(MEMBER_COLOR[m.status], `${MEMBER_GLYPH[m.status]} ${m.name}`);
	}

	// Build full chips string
	const fullChips = members
		.map((m) => theme.fg(MEMBER_COLOR[m.status], `${MEMBER_GLYPH[m.status]} ${m.name}`))
		.join("  ");

	// Decide: full chips → collapse-completed → counts-only summary
	if (budget === undefined) {
		// Fallback when terminal width unavailable (piped output, etc.)
		// Heuristic: 6+ members won't fit in typical 80-col terminal after prefix overhead.
		// Still keep active members visible by collapsing only the completed ones.
		return members.length >= 6 ? collapseDoneChips(members, theme) : fullChips;
	}

	if (budget > 0 && visibleWidth(fullChips) <= budget) return fullChips;

	// Full chips overflow: collapse completed but keep active members in full if that fits.
	const collapsed = collapseDoneChips(members, theme);
	if (budget > 0 && visibleWidth(collapsed) <= budget) return collapsed;

	// Even the active chips overflow: counts-only summary as a last resort.
	return memberSummary(members, theme);
}



/** Overall party status colour: failed → awaiting-approval → all-done → in-flight. */
function partyColor(record: QuestRecord): ThemeColor {
	if (record.members.some((m) => m.status === "failed")) return "error";
	if (record.state === "awaiting-approval") return "warning";
	if (record.members.length > 0 && record.members.every((m) => m.status === "done")) return "success";
	return "accent";
}

export class StatusSurface {
	private pi: ExtensionAPI | undefined;
	private ctx: ExtensionContext | undefined;
	private readonly questStates = new Map<string, string>();
	private knownApprovals = new Set<string>();
	private initialized = false;
	private repaintScheduled = false;
	private repaintTimer: ReturnType<typeof setTimeout> | undefined;

	/** Wire subscriptions once. The quest card renderer is registered here too. */
	init(pi: ExtensionAPI): void {
		this.pi = pi;
		if (this.initialized) return;
		this.initialized = true;

		pi.registerEntryRenderer(QUEST_CARD, (entry, { expanded }, theme) => {
			// Rendered lazily to avoid an import cycle with the quest tool.
			const record = entry.data as QuestRecord;
			return renderQuestCard(record, theme, expanded);
		});

		getQuestManager().onChange((record) => this.onQuestChange(record));
		getApprovalManager().onChange(() => this.onApprovalChange());
	}

	/** Capture the current session's UI. Call on session_start (and reload). */
	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.repaint();
	}

	/**
	 * Schedule a debounced repaint. Collapses bursts of changes (e.g. multiple
	 * party members finishing in quick succession) into a single repaint to avoid
	 * synchronous I/O storms on the event loop.
	 */
	private scheduleRepaint(): void {
		if (this.repaintScheduled) return;
		this.repaintScheduled = true;
		this.repaintTimer = setTimeout(() => {
			this.repaintScheduled = false;
			this.repaintTimer = undefined;
			this.doRepaint();
		}, 16);
	}

	private onQuestChange(record: QuestRecord): void {
		const prev = this.questStates.get(record.id);
		if (prev !== record.state) {
			this.questStates.set(record.id, record.state);
			if (record.state === "completed") {
				const raisedCount = (record.prs ?? []).filter((p) => p.url).length;
				const totalPrs = (record.prs ?? []).length;
				const prStatus = raisedCount === totalPrs
					? `${raisedCount} draft PR(s) opened`
					: raisedCount > 0
						? `${raisedCount}/${totalPrs} PR(s) opened (${totalPrs - raisedCount} not raised — use raise_pr)`
						: `${totalPrs} draft PR(s) ready to raise`;
				const prUrls = (record.prs ?? []).filter((p) => p.url).map((p) => p.url).join(", ");
				const completionMsg = `Quest "${record.title}" completed${totalPrs > 0 ? ` — ${prStatus}` : ""}.`;
				this.notify(completionMsg + (prUrls ? ` ${prUrls}` : ""), "info");
				this.showQuestCard(record);
			} else if (record.state === "failed") {
				this.notify(`Quest "${record.title}" failed: ${record.error ?? "unknown"}.`, "error");
				this.showQuestCard(record);
			} else if (record.state === "awaiting-approval") {
				this.notify(`Quest "${record.title}" is awaiting approval.`, "warning");
			}
		}
		this.scheduleRepaint();
	}

	private onApprovalChange(): void {
		const current = getApprovalManager().list();
		for (const a of current) {
			if (!this.knownApprovals.has(a.id)) this.notify(`Approval needed — /approve ${a.id}  (${a.title})`, "warning");
		}
		this.knownApprovals = new Set(current.map((a) => a.id));
		this.scheduleRepaint();
	}

	private notify(text: string, level: "info" | "warning" | "error"): void {
		this.ctx?.ui.notify(text, level);
	}

	private showQuestCard(record: QuestRecord): void {
		this.pi?.appendEntry(QUEST_CARD, record);
	}

	/** Recompute and repaint the board + footer. Safe to call anytime. */
	repaint(): void {
		if (this.repaintTimer) {
			clearTimeout(this.repaintTimer);
			this.repaintTimer = undefined;
			this.repaintScheduled = false;
		}
		this.doRepaint();
	}

	/**
	 * Perform the actual repaint. Uses QuestManager's in-memory recordCache
	 * instead of reading from disk to avoid synchronous I/O on the event loop.
	 */
	private doRepaint(): void {
		if (!this.ctx) return;
		const quests = getQuestManager();
		const active = quests.getActive();
		const pending = getApprovalManager().list();
		// Finished Quests persist on the board until the user turns them in (§ turn-in),
		// so a completion (or a cancellation from a reload) is never missed while multitasking.
		// Use getBoardRecords() which reads from the manager's in-memory cache, not disk.
		const boardRecords = quests.getBoardRecords();
		const done = boardRecords.filter(
			(q) => (q.state === "completed" || q.state === "failed" || q.state === "cancelled") && !q.acknowledgedAt
		);

		if (active.length === 0 && pending.length === 0 && done.length === 0) {
			this.ctx.ui.setWidget(WIDGET, undefined);
			return;
		}

		// Snapshot for the render closure.
		// Resolve parent titles for any chained (fromQuest) Quests, for lineage display.
		const lineage: Record<string, string> = {};
		for (const q of [...active, ...done]) {
			if (q.parentId) {
				const p = boardRecords.find((r) => r.id === q.parentId);
				if (p) lineage[q.id] = p.title;
			}
		}
		const snapshot = { active: [...active], pending: [...pending], done: [...done], lineage };
		this.ctx.ui.setWidget(WIDGET, (_tui, theme) => {
			const fg = (c: ThemeColor, t: string) => theme.fg(c, t);
			const box = new Container();
			box.addChild(new Spacer(1));
			box.addChild(new Text(fg("toolTitle", theme.bold("◆ Guildmaster Quest Log")), 0, 0));
			for (const q of snapshot.active) {
				const label = q.project ? fg("muted", `[${q.project}] `) : "";
				const end = q.state === "awaiting-approval" ? `  ${fg("warning", "⏸ awaiting approval")}` : "";
				
				// Calculate width budget for member chips
				// Use process.stdout.columns as terminal width (may differ from widget width, but acceptable approximation)
				const termWidth = process.stdout.columns;
				let chips: string;
				if (termWidth !== undefined) {
					// Build prefix/suffix to measure overhead
					const prefix = `  ● ${q.project ? `[${q.project}] ` : ""}${q.title}  `;
					const suffix = q.state === "awaiting-approval" ? "  ⏸ awaiting approval" : "";
					const budget = termWidth - visibleWidth(prefix) - visibleWidth(suffix);
					chips = formatMemberChips(q, theme, budget);
				} else {
					chips = formatMemberChips(q, theme, undefined);
				}
				
				box.addChild(new Text(`  ${fg(partyColor(q), "●")} ${label}${fg("toolTitle", q.title)}  ${chips}${end}`, 0, 0));
				if (snapshot.lineage[q.id]) box.addChild(new Text(`      ${fg("muted", `↳ from ${snapshot.lineage[q.id]}`)}`, 0, 0));
			}
			for (const a of snapshot.pending) {
				box.addChild(new Text(`  ${fg("warning", "⚑")} ${fg("dim", a.id)}  ${a.title}  ${fg("muted", "/approve")}`, 0, 0));
			}
			for (const q of snapshot.done) {
				const label = q.project ? fg("muted", `[${q.project}] `) : "";
				let color: ThemeColor = "success";
				let glyph = "✔";
				let hint = "completed";
				if (q.state === "failed") {
					color = "error";
					glyph = "✗";
					hint = "failed";
				} else if (q.state === "cancelled") {
					color = "muted";
					glyph = "⊘";
					hint = "cancelled";
				}
				if (q.prs && q.prs.length > 0) {
					const raisedCount = q.prs.filter((p) => p.url).length;
					if (raisedCount === 0) {
						hint = "draft PR ready → raise_pr";
					} else if (raisedCount < q.prs.length) {
						hint = `${raisedCount}/${q.prs.length} raised → raise_pr for rest`;
					} else {
						hint = `${raisedCount} PR(s) opened`;
					}
				}
				const titleColor = q.state === "cancelled" ? "muted" : "toolTitle";
				box.addChild(new Text(`  ${fg(color, glyph)} ${label}${fg(titleColor, q.title)}  ${fg("muted", hint)}`, 0, 0));
				if (snapshot.lineage[q.id]) box.addChild(new Text(`      ${fg("muted", `↳ from ${snapshot.lineage[q.id]}`)}`, 0, 0));
			}
			return box;
		}, { placement: "belowEditor" });
	}
}

// Lightweight quest card renderer, kept here to avoid an import cycle.
function renderQuestCard(record: QuestRecord, theme: { fg: (c: ThemeColor, t: string) => string; bold: (t: string) => string }, expanded: boolean): Container {
	const fg = theme.fg.bind(theme);
	const stateColor = record.state === "completed" ? "success" : record.state === "failed" ? "error" : "accent";
	const c = new Container();
	c.addChild(new Text(`${fg("toolTitle", theme.bold(`◇ Quest: ${record.title}`))} ${fg(stateColor, `[${record.state}]`)}`, 0, 0));
	for (const m of record.members) {
		const color = m.status === "failed" ? "error" : m.status === "done" ? "success" : "accent";
		c.addChild(new Text(`  ${fg(color, MEMBER_GLYPH[m.status])} ${fg("accent", m.name)}  ${fg("muted", (m.summary ?? m.task).split("\n")[0].slice(0, 60))}`, 0, 0));
	}
	for (const pr of record.prs ?? []) {
		if (pr.url) c.addChild(new Text(fg("success", `PR (${pr.repo}): ${pr.url}`), 0, 0));
		else c.addChild(new Text(fg("muted", `branch `) + fg("accent", `${pr.repo}→${pr.branch}`) + fg("muted", " (draft, not pushed)"), 0, 0));
	}
	if (record.error) c.addChild(new Text(fg("error", `error: ${record.error}`), 0, 0));
	if (record.report) {
		// Render the report as formatted markdown (headings, code, lists) rather than raw text.
		const full = record.report.trim();
		const allLines = full.split("\n");
		const shown = expanded ? full : allLines.slice(0, 20).join("\n");
		c.addChild(new Markdown(shown, 0, 0, getMarkdownTheme()));
		if (!expanded && allLines.length > 20) c.addChild(new Text(fg("muted", "(Ctrl+O to expand)"), 0, 0));
	}
	return c;
}

let surface: StatusSurface | undefined;
export function getStatusSurface(): StatusSurface {
	surface ??= new StatusSurface();
	return surface;
}

// Exported for testing
export { visibleWidth, memberSummary, formatMemberChips, collapseDoneChips };
