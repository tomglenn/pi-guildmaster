/**
 * Guildmaster slash commands (§13).
 *
 * These are power-user / introspection commands. Normal natural-language
 * interaction remains the primary interface; commands never become required
 * ceremony (§20).
 *
 * Milestone 1 registers the read-only status commands and a `/consult` stub.
 * Live Party/Quest state is wired in later milestones.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type GuildmasterConfig, loadConfig, resolveModelSpec } from "./config.ts";
import { runChildAgent } from "./execution/child-agent.ts";
import { getQuestManager } from "./orchestration/manager.ts";
import type { QuestMemberStatus, QuestRecord } from "./persistence/quest-store.ts";
import { guildmasterHome } from "./paths.ts";
import { findGuildmate, type Guildmate, loadRoster } from "./roster.ts";
import { type CardLine, showCard } from "./ui.ts";

const TIER_COLOR: Record<string, ThemeColor> = {
	"read-only": "success",
	write: "warning",
	exec: "error",
	orchestrator: "accent",
};

function modelDisplay(config: GuildmasterConfig, model: string | undefined): string {
	if (!model) return "inherit";
	const resolved = resolveModelSpec(config, model);
	return resolved && resolved !== model ? `${model} → ${resolved}` : model;
}

function rosterLines(roster: Guildmate[], config: GuildmasterConfig): CardLine[] {
	if (roster.length === 0) {
		return [{ text: "No Guildmates found. Roster may not be seeded yet.", color: "error" }];
	}
	const lines: CardLine[] = [];
	for (const mate of roster) {
		lines.push({ text: mate.name, bold: true, indent: 2 });
		lines.push({ text: mate.tier, color: TIER_COLOR[mate.tier] ?? "muted", indent: 5 });
		lines.push({ text: modelDisplay(config, mate.model), color: "dim", indent: 5 });
		lines.push({ text: mate.tagline ?? mate.description, color: "muted", indent: 5 });
	}
	return lines;
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("guild", {
		description: "Show the Guild roster and configured models",
		handler: async (_args, _ctx) => {
			const config = loadConfig();
			const roster = loadRoster();
			const aliasLines: CardLine[] = Object.entries(config.models).map(([alias, spec]) => ({
				text: `${alias.padEnd(12)} ${spec}`,
				color: "dim",
				indent: 2,
			}));
			showCard(pi, {
				title: `Guild roster (${roster.length} Guildmates)`,
				lines: [
					{ text: "Model aliases", bold: true },
					...aliasLines,
					{ text: "", color: "muted" },
					{ text: "Guildmates", bold: true },
					...rosterLines(roster, config),
				],
			});
		},
	});

	pi.registerCommand("guildmaster", {
		description: "Show Guildmaster configuration and status",
		handler: async (_args, _ctx) => {
			const config = loadConfig();
			const roster = loadRoster();
			showCard(pi, {
				title: "Guildmaster",
				lines: [
					{ text: `home        ${guildmasterHome()}`, color: "dim" },
					{ text: `guildmaster ${modelDisplay(config, config.guildmasterModel)}`, color: "dim" },
					{ text: `party-leader ${modelDisplay(config, config.partyLeaderModel)}`, color: "dim" },
					{ text: `roster      ${roster.length} Guildmates`, color: "dim" },
					{ text: "", color: "muted" },
					{ text: "Consult and Quest delegation arrive in later milestones.", color: "muted" },
				],
			});
		},
	});

	const MEMBER_ICON: Record<QuestMemberStatus, string> = { pending: "○", running: "●", done: "✓", failed: "✗" };
	const stateColor = (s: string) =>
		s === "completed" ? "success" : s === "failed" ? "error" : s === "cancelled" ? "warning" : "accent";

	pi.registerCommand("party", {
		description: "Show active Party / Quest state",
		handler: async (_args, _ctx) => {
			const active = getQuestManager().getActive();
			if (active.length === 0) {
				showCard(pi, { title: "Party", lines: [{ text: "No active Party.", color: "muted" }] });
				return;
			}
			const lines: CardLine[] = [];
			for (const q of active) {
				lines.push({ text: `${q.title} [${q.state}]`, bold: true });
				for (const m of q.members) {
					const color = m.status === "failed" ? "error" : m.status === "done" ? "success" : "accent";
					lines.push({ text: `${MEMBER_ICON[m.status]} ${m.name}  ${m.task.slice(0, 50)}`, color, indent: 2 });
				}
			}
			showCard(pi, { title: "Party", lines });
		},
	});

	pi.registerCommand("quests", {
		description: "Show current and recent Quests",
		handler: async (_args, _ctx) => {
			const quests: QuestRecord[] = getQuestManager().store.list().slice(0, 12);
			if (quests.length === 0) {
				showCard(pi, { title: "Quests", lines: [{ text: "No Quests yet.", color: "muted" }] });
				return;
			}
			const lines: CardLine[] = quests.map((q) => {
				const done = q.members.filter((m) => m.status === "done").length;
				return {
					text: `${q.state.padEnd(10)} ${q.title}  (${done}/${q.members.length} members)  ${q.id}`,
					color: stateColor(q.state),
				};
			});
			showCard(pi, { title: `Quests (${quests.length})`, lines });
		},
	});

	pi.registerCommand("quest-cancel", {
		description: "Cancel a running background Quest by id",
		getArgumentCompletions: (prefix) => {
			const items = getQuestManager()
				.getActive()
				.map((q) => ({ value: q.id, label: `${q.id} — ${q.title}` }));
			const f = items.filter((i) => i.value.startsWith(prefix.trim()));
			return f.length > 0 ? f : items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const id = args.trim();
			const ok = getQuestManager().cancel(id);
			ctx.ui.notify(ok ? `Cancelling Quest ${id}.` : `No active Quest ${id}.`, ok ? "info" : "warning");
		},
	});

	pi.registerCommand("consult", {
		description: "Consult a Guildmate directly (power user)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const first = prefix.split(/\s+/)[0] ?? "";
			const items = loadRoster()
				.filter((m) => m.tier === "read-only")
				.map((m) => ({ value: m.name, label: `${m.name} — ${m.tagline ?? m.description}` }))
				.filter((i) => i.value.startsWith(first));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIdx = trimmed.indexOf(" ");
			const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
			if (!name || !task) {
				ctx.ui.notify("Usage: /consult <guildmate> <question>", "warning");
				return;
			}
			const config = loadConfig();
			const mate = findGuildmate(loadRoster(), name);
			if (!mate) {
				ctx.ui.notify(`Unknown Guildmate "${name}".`, "error");
				return;
			}
			if (mate.tier !== "read-only") {
				ctx.ui.notify(`"${name}" is tier ${mate.tier}; Consult is read-only.`, "error");
				return;
			}
			ctx.ui.setStatus("guildmaster", `consulting ${mate.name}…`);
			try {
				const result = await runChildAgent({
					guildmate: mate,
					task,
					modelSpec: resolveModelSpec(config, mate.model),
					cwd: ctx.cwd,
					signal: ctx.signal,
				});
				const body = (result.error ? `Error: ${result.error}` : result.finalText || "(no result)").split("\n");
				showCard(pi, {
					title: `Consult: ${mate.name}`,
					lines: [
						{ text: `${result.model ?? mate.model ?? "?"} · ${result.usage.turns} turns · $${result.usage.cost.toFixed(4)}`, color: "dim" },
						{ text: "", color: "muted" },
						...body.map((line) => ({ text: line, color: result.error ? ("error" as ThemeColor) : undefined })),
					],
				});
			} finally {
				ctx.ui.setStatus("guildmaster", "");
			}
		},
	});
}
