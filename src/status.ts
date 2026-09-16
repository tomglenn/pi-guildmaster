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
 */

import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getApprovalManager, getQuestManager } from "./orchestration/manager.ts";
import type { QuestMemberStatus, QuestRecord } from "./persistence/quest-store.ts";

const WIDGET = "guildmaster-board";
const QUEST_CARD = "guildmaster-quest";

const MEMBER_GLYPH: Record<QuestMemberStatus, string> = { pending: "○", running: "●", done: "✓", failed: "✗" };
/** Per-status colour for a party member's glyph + name. */
const MEMBER_COLOR: Record<QuestMemberStatus, string> = { pending: "muted", running: "accent", done: "success", failed: "error" };

/** Colour-coded member glyphs with a space between icon and name, e.g. "✓ scout". */
function memberGlyphs(record: QuestRecord, theme: { fg: (c: string, t: string) => string }): string {
	return record.members.map((m) => theme.fg(MEMBER_COLOR[m.status], `${MEMBER_GLYPH[m.status]} ${m.name}`)).join("  ");
}

/** Overall party status colour: failed → awaiting-approval → all-done → in-flight. */
function partyColor(record: QuestRecord): string {
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

	private onQuestChange(record: QuestRecord): void {
		const prev = this.questStates.get(record.id);
		if (prev !== record.state) {
			this.questStates.set(record.id, record.state);
			if (record.state === "completed") {
				this.notify(`Quest "${record.title}" completed${record.prs?.length ? ` — ${record.prs.length} draft PR(s) ready` : ""}.`, "info");
				this.showQuestCard(record);
			} else if (record.state === "failed") {
				this.notify(`Quest "${record.title}" failed: ${record.error ?? "unknown"}.`, "error");
				this.showQuestCard(record);
			} else if (record.state === "awaiting-approval") {
				this.notify(`Quest "${record.title}" is awaiting approval.`, "warning");
			}
		}
		this.repaint();
	}

	private onApprovalChange(): void {
		const current = getApprovalManager().list();
		for (const a of current) {
			if (!this.knownApprovals.has(a.id)) this.notify(`Approval needed — /approve ${a.id}  (${a.title})`, "warning");
		}
		this.knownApprovals = new Set(current.map((a) => a.id));
		this.repaint();
	}

	private notify(text: string, level: "info" | "warning" | "error"): void {
		this.ctx?.ui.notify(text, level);
	}

	private showQuestCard(record: QuestRecord): void {
		this.pi?.appendEntry(QUEST_CARD, record);
	}

	/** Recompute and repaint the board + footer. Safe to call anytime. */
	repaint(): void {
		if (!this.ctx) return;
		const quests = getQuestManager();
		const active = quests.getActive();
		const pending = getApprovalManager().list();
		// Finished Quests persist on the board until the user turns them in (§ turn-in),
		// so a completion is never missed while multitasking with a scrolling transcript.
		const done = quests.store.list().filter((q) => (q.state === "completed" || q.state === "failed") && !q.acknowledgedAt);

		if (active.length === 0 && pending.length === 0 && done.length === 0) {
			this.ctx.ui.setWidget(WIDGET, undefined);
			return;
		}

		// Snapshot for the render closure.
		// Resolve parent titles for any chained (fromQuest) Quests, for lineage display.
		const lineage: Record<string, string> = {};
		for (const q of [...active, ...done]) {
			if (q.parentId) {
				const p = quests.store.load(q.parentId);
				if (p) lineage[q.id] = p.title;
			}
		}
		const snapshot = { active: [...active], pending: [...pending], done: [...done], lineage };
		this.ctx.ui.setWidget(WIDGET, (_tui, theme) => {
			const fg = (c: string, t: string) => theme.fg(c, t);
			const box = new Container();
			box.addChild(new Spacer(1));
			box.addChild(new Text(fg("toolTitle", theme.bold("◆ Guild")), 0, 0));
			for (const q of snapshot.active) {
				const label = q.project ? fg("muted", `[${q.project}] `) : "";
				box.addChild(new Text(`  ${fg(partyColor(q), "●")} ${label}${fg("toolTitle", q.title)}  ${memberGlyphs(q, theme)}`, 0, 0));
				if (snapshot.lineage[q.id]) box.addChild(new Text(`      ${fg("muted", `↳ from ${snapshot.lineage[q.id]}`)}`, 0, 0));
			}
			for (const a of snapshot.pending) {
				box.addChild(new Text(`  ${fg("warning", "⚑")} ${fg("dim", a.id)}  ${a.title}  ${fg("muted", "/approve")}`, 0, 0));
			}
			for (const q of snapshot.done) {
				const failed = q.state === "failed";
				const label = q.project ? fg("muted", `[${q.project}] `) : "";
				const hint = q.prs?.some((p) => !p.url)
					? "draft PR ready → raise_pr"
					: failed
						? "failed — turn in to clear"
						: "done — turn in to clear";
				box.addChild(
					new Text(`  ${fg(failed ? "error" : "success", failed ? "✗" : "✔")} ${label}${fg("toolTitle", q.title)}  ${fg("muted", hint)}`, 0, 0),
				);
				if (snapshot.lineage[q.id]) box.addChild(new Text(`      ${fg("muted", `↳ from ${snapshot.lineage[q.id]}`)}`, 0, 0));
			}
			return box;
		}, { placement: "belowEditor" });
	}
}

// Lightweight quest card renderer, kept here to avoid an import cycle.
function renderQuestCard(record: QuestRecord, theme: { fg: (c: string, t: string) => string; bold: (t: string) => string }, expanded: boolean): Container {
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
