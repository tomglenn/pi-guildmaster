/**
 * Consult — lightweight, bounded, synchronous specialist work (§5).
 *
 *   Guildmaster → Consult → one read-only Guildmate → concise result → Guildmaster
 *
 * A Consult uses exactly one Guildmate, is read-only, creates no Party and no
 * Party Leader, does not persist a Quest, and returns during the current turn.
 * The specialist's full investigation stays in its own isolated session; only the
 * concise result crosses back (§7).
 *
 * M2 scope: the Guildmaster can invoke a single read-only Guildmate (Scout and the
 * other read-only specialists) as an isolated child agent. Consult budgets/timeboxing
 * and the Quest path for write work arrive in later milestones.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { effectiveConfig, loadConfig, resolveModelSpec } from "./config.ts";
import { type ChildAgentResult, runChildAgent } from "./execution/child-agent.ts";
import { pickRepo, resolveProjectQuery } from "./orchestration/resolve.ts";
import { ProjectStore } from "./persistence/project-store.ts";
import { findGuildmate, loadRoster } from "./roster.ts";

// A Consult is predictably bounded (§5). The PRIMARY bound is a step budget the
// specialist can self-limit against and that is enforced structurally (graceful
// wrap-up at the cap). The wall-clock limit is only a generous hang backstop.
const CONSULT_MAX_TURNS = 6;
const CONSULT_GRACE_TURNS = 1;
const CONSULT_HARD_TIMEOUT_MS = 120_000;

const ConsultParams = Type.Object({
	agent: Type.String({ description: "Name of the read-only Guildmate to consult (e.g. scout, delver, warden)" }),
	task: Type.String({ description: "The single, bounded investigation to delegate. Be specific." }),
	project: Type.Optional(Type.String({ description: "Registered project id/name to run against. Omit to use the current directory." })),
	repo: Type.Optional(Type.String({ description: "Which project repo to investigate (for multi-repo projects)." })),
});

// Real failures only. Budget endings ("budget"/"timeout") are bounded, not failed.
function isFailed(r: ChildAgentResult): boolean {
	return Boolean(r.error) || r.stopReason === "error" || r.stopReason === "aborted";
}

function formatToolCall(name: string, args: Record<string, unknown>, fg: (c: string, t: string) => string): string {
	const path = (args.path as string) ?? "";
	switch (name) {
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${(args.pattern as string) ?? ""}/`) + (path ? fg("dim", ` in ${path}`) : "");
		case "find":
			return fg("muted", "find ") + fg("accent", (args.pattern as string) ?? "*") + (path ? fg("dim", ` in ${path}`) : "");
		case "read":
			return fg("muted", "read ") + fg("accent", path);
		case "ls":
			return fg("muted", "ls ") + fg("accent", path || ".");
		default: {
			const s = JSON.stringify(args);
			return fg("accent", name) + fg("dim", ` ${s.length > 50 ? `${s.slice(0, 50)}…` : s}`);
		}
	}
}

function formatUsage(r: ChildAgentResult): string {
	const u = r.usage;
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${u.input}`);
	if (u.output) parts.push(`↓${u.output}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (r.model) parts.push(r.model);
	return parts.join(" ");
}

export function registerConsultTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "consult",
		label: "Consult",
		description: [
			"Consult a single read-only specialist Guildmate for one bounded investigation.",
			"The specialist runs in an isolated context and returns only a concise, evidence-backed result.",
			"Read-only specialists: scout (fast recon), delver (deep trace), architect (planning),",
			"warden (security), inquisitor (adversarial review).",
		].join(" "),
		promptSnippet: "Delegate one bounded, read-only investigation to a specialist Guildmate; returns a concise result",
		promptGuidelines: [
			"Use consult to delegate a single bounded, read-only investigation (e.g. scout for fast recon) when doing it yourself would consume significant context. The specialist has isolated context and returns only a concise result. Do not use consult for trivial questions you can answer directly.",
		],
		parameters: ConsultParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const roster = loadRoster();
			let config = loadConfig();
			const mate = findGuildmate(roster, params.agent);

			if (!mate) {
				const available = roster.filter((m) => m.tier === "read-only").map((m) => m.name).join(", ") || "none";
				throw new Error(`Unknown Guildmate "${params.agent}". Read-only specialists: ${available}.`);
			}
			if (mate.tier !== "read-only") {
				throw new Error(
					`Consult is read-only, but "${mate.name}" is tier "${mate.tier}". ` +
						`Write/exec work belongs in a Quest (not yet available).`,
				);
			}

			// Resolve where to run: a named project's repo, or the current directory.
			// A resolved project also supplies its config overrides + standing instructions.
			let cwd = ctx.cwd;
			let task = params.task;
			if (params.project) {
				const resolution = resolveProjectQuery(new ProjectStore(), params.project);
				if (resolution.error) throw new Error(resolution.error);
				const project = resolution.project!;
				const pick = pickRepo(project, params.repo);
				if (pick.error) throw new Error(pick.error);
				cwd = pick.repo!.path;
				config = effectiveConfig(config, project.config);
				if (project.instructions?.trim()) task = `${params.task}\n\nProject context: ${project.instructions.trim()}`;
			}

			const modelSpec = resolveModelSpec(config, mate.model);
			const result = await runChildAgent({
				guildmate: mate,
				task,
				modelSpec,
				cwd,
				signal,
				maxTurns: CONSULT_MAX_TURNS,
				graceTurns: CONSULT_GRACE_TURNS,
				hardTimeoutMs: CONSULT_HARD_TIMEOUT_MS,
				onUpdate: (partial) => {
					onUpdate?.({
						content: [{ type: "text", text: partial.finalText || `Consulting ${mate.name}…` }],
						details: partial,
					});
				},
			});

			if (isFailed(result)) {
				return {
					content: [
						{
							type: "text",
							text: `Consult of ${mate.name} ${result.stopReason ?? "failed"}: ${result.error ?? "(no detail)"}`,
						},
					],
					details: result,
					isError: true,
				};
			}

			// Wall-clock backstop fired: a genuine hang. Result may be partial or empty.
			if (result.stopReason === "timeout") {
				const text = result.finalText
					? `${result.finalText}\n\n[timeboxed backstop hit; result may be partial]`
					: `Consult of ${mate.name} hit the wall-clock backstop before answering ` +
						`(tool activity: ${result.toolCalls.map((c) => c.name).join(", ") || "none"}). ` +
						`Consider a narrower question or a Quest.`;
				return { content: [{ type: "text", text }], details: result };
			}

			// Step budget reached: a clean, bounded result (possibly scoped).
			const budgetNote = result.budget === "steps" ? "\n\n_(reached step budget; result is scoped)_" : "";
			return {
				content: [{ type: "text", text: (result.finalText || "(no result)") + budgetNote }],
				details: result,
			};
		},

		renderCall(args, theme) {
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}…` : args.task) : "…";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("consult "))}${theme.fg("accent", args.agent ?? "…")}\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const r = result.details as ChildAgentResult | undefined;
			if (!r) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}
			const fg = theme.fg.bind(theme);
			const failed = isFailed(r);
			const icon = failed ? fg("error", "✗") : r.budget ? fg("warning", "◐") : fg("success", "✓");
			const container = new Container();
			container.addChild(new Text(`${icon} ${fg("toolTitle", theme.bold(`consult ${r.guildmate}`))}`, 0, 0));

			if (failed) container.addChild(new Text(fg("error", r.error ?? r.stopReason ?? "failed"), 0, 0));
			else if (r.budget === "time") container.addChild(new Text(fg("warning", "timeboxed (backstop) — partial"), 0, 0));
			else if (r.budget === "steps") container.addChild(new Text(fg("warning", "reached step budget — scoped result"), 0, 0));

			for (const call of r.toolCalls) {
				container.addChild(new Text(`  ${fg("muted", "→ ")}${formatToolCall(call.name, call.args, fg)}`, 0, 0));
			}

			if (r.finalText) {
				container.addChild(new Spacer(1));
				const text = expanded ? r.finalText.trim() : r.finalText.split("\n").slice(0, 6).join("\n");
				container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
				if (!expanded && r.finalText.split("\n").length > 6) {
					container.addChild(new Text(fg("muted", "(Ctrl+O to expand)"), 0, 0));
				}
			}

			const usage = formatUsage(r);
			if (usage) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(fg("dim", usage), 0, 0));
			}
			return container;
		},
	});
}
