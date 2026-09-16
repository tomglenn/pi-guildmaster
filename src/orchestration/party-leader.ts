/**
 * Party Leader — dynamic Party construction (§3, §6).
 *
 * The Party Leader is "a function, not a personality." It is an orchestrator-tier
 * agent whose ONLY tool is `dispatch`: it has no file tools of its own, so it must
 * delegate. Given the brief and the available Guildmates (with roles + models), it
 * decides which specialists to run, in what order, and what runs in parallel, then
 * passes findings between them and writes one coherent final report.
 *
 * Scope for M6: the Party dispatches READ-ONLY Guildmates only. Write (Smith) and
 * exec (Runner) dispatch requires the isolation (M8) and approval (M9) machinery
 * and is deliberately withheld until then, so a Party cannot touch the working tree.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type GuildmasterConfig, resolveModelSpec } from "../config.ts";
import { collectUsage, lastAssistantText, runChildAgent, runSession } from "../execution/child-agent.ts";
import { createEnvoyShellTool } from "../execution/gh-tool.ts";
import { findGuildmate, type Guildmate, loadPartyLeaderPrompt } from "../roster.ts";
import type { QuestMember } from "../persistence/quest-store.ts";
import type { RepoContext } from "../persistence/project-store.ts";
import type { ApprovalManager } from "./approvals.ts";

const READONLY_MAX_TURNS = 6;
const READONLY_HARD_TIMEOUT_MS = 120_000;
// Write/exec members (Smith implementing, Runner building/testing) need more room.
const WORK_MAX_TURNS = 12;
const WORK_HARD_TIMEOUT_MS = 240_000;
const LEADER_MAX_TURNS = 20;
const LEADER_GRACE_TURNS = 2;
const LEADER_HARD_TIMEOUT_MS = 420_000;

const DISPATCHABLE_READONLY: ReadonlySet<string> = new Set(["read-only"]);
const DISPATCHABLE_WRITE: ReadonlySet<string> = new Set(["read-only", "write", "exec"]);
// Review: read-only specialists judge, scribe (write) composes, envoy talks to GitHub.
const DISPATCHABLE_REVIEW: ReadonlySet<string> = new Set(["read-only", "write", "envoy"]);

export interface PartyResult {
	report: string;
	members: QuestMember[];
	usage: { cost: number; turns: number };
	stopReason?: string;
	error?: string;
}

/**
 * Extract the clean report from the Party Leader's final message. The leader is
 * asked to wrap it in explicit markers; we take what follows the last <<<REPORT>>>
 * (up to <<<END>>>), which strips any preamble/thinking structurally rather than
 * relying on the model to omit it. Falls back to the full text if unmarked.
 */
export function extractReport(text: string): string {
	const startTag = "<<<REPORT>>>";
	const start = text.lastIndexOf(startTag);
	if (start === -1) return text.trim();
	let body = text.slice(start + startTag.length);
	const end = body.indexOf("<<<END>>>");
	if (end !== -1) body = body.slice(0, end);
	return body.trim();
}

const DEFAULT_LEADER_PROMPT =
	"You are the Party Leader for one Quest. You are a function, not a personality. " +
	"You determine which Guildmates are needed, sequence or parallelize their work, pass useful " +
	"results between them, and ensure the Quest reaches one coherent conclusion.";

function buildRepoBlock(contexts: RepoContext[]): string[] {
	if (contexts.length === 1 && contexts[0].name === "cwd") return [];
	return [
		"## Project repositories",
		"Dispatch Guildmates against these repos by passing `repo`. Read-only members may target any repo;",
		"write/exec members (smith/runner) may target only a writable repo.",
		"",
		...contexts.map((c) => `- ${c.name} [${c.writable ? "writable" : "read-only"}]`),
		"",
	];
}

function buildSystemPrompt(basePrompt: string, available: Guildmate[], config: GuildmasterConfig, write: boolean, contexts: RepoContext[], instructions?: string, reviewMode = false): string {
	const roster = available
		.map((m) => `- ${m.name} [${m.tier}] (model: ${resolveModelSpec(config, m.model) ?? "default"}): ${m.tagline ?? m.description}`)
		.join("\n");

	const projectBlock = instructions?.trim() ? ["## Project context", instructions.trim(), ""] : [];

	const common = [
		...projectBlock,
		...buildRepoBlock(contexts),
		basePrompt,
		"",
		`## Available Guildmates${reviewMode ? " (PR review)" : write ? "" : " (read-only specialists)"}`,
		reviewMode
			? "Dispatch via the `dispatch` tool; you have NO tools of your own. `envoy` is the party's ONLY contact with GitHub (a gated shell): it fetches the PR and, with the user's approval, posts the review. All other members work read-only on the fetched PR."
			: write
				? "You are running in an ISOLATED git worktree on a dedicated branch. Writes by `smith` and commands by `runner` happen ONLY in this worktree and never touch the user's checkout. Dispatch via the `dispatch` tool; you have NO tools of your own."
				: "Dispatch these via the `dispatch` tool. You have NO file tools yourself — you MUST delegate all investigation.",
		"",
		roster,
		"",
		"## Running this Quest",
		"- Choose only the Guildmates the task needs. There is no fixed pipeline.",
		"- Emit multiple `dispatch` calls in one turn to run independent work in parallel.",
		"- Feed useful findings from one Guildmate into the next one's task.",
		"- ADVERSARIAL REVIEW: for any review, correctness, security, or decision, once you have a",
		"  substantive conclusion or plan, dispatch `inquisitor` to attack it. Inquisitor runs on a DIFFERENT",
		"  model family by design: take its objections seriously and resolve them before finalizing.",
	];

	const reviewWorkflow = [
		"- PR REVIEW WORKFLOW: first dispatch `envoy` to ACQUIRE the PR (it runs `gh pr view` / `gh pr diff`,",
		"  and `gh pr checkout <n>` when a repo worktree is the cwd). If the envoy cannot acquire the PR,",
		"  do not fabricate a review — emit the FAILED signal (see finalize).",
		"- Dispatch reviewers in PARALLEL against the acquired PR: scout/delver for correctness, warden for",
		"  security, inquisitor to attack the conclusions. Use architect for large or structural changes.",
		"- Then dispatch `scribe` to write the final human-facing review from their findings: a short summary,",
		"  findings grouped by theme with file:line, and a verdict (comment / approve / request-changes).",
		"- To POST it, dispatch `envoy` with the EXACT review text to run `gh pr review`. That needs the user's",
		"  approval and may be blocked; if denied or blocked, leave the review as a draft and say so. NEVER merge.",
		"- The final report IS the review Scribe wrote (note it if posting was denied/blocked).",
	];

	const workflow = reviewMode
		? reviewWorkflow
		: write
		? [
				"- IMPLEMENTATION WORKFLOW: first understand the code (scout/delver) and get a plan (architect).",
				"  Have inquisitor review the plan. THEN dispatch `smith` to implement it, and `runner` to build",
				"  and test. Only dispatch smith after a plan exists; if smith reports the plan is wrong, stop and",
				"  re-plan rather than improvising. Runner must not start non-terminating processes.",
				"- The final report is a PULL REQUEST DESCRIPTION. First line: a concise PR title as an H1",
				"  (`# ...`). Then sections: Summary, Changes (with file references), Testing (what runner ran and",
				"  observed), and Risks / Unresolved (including anything inquisitor flagged). Do not claim tests",
				"  passed unless runner actually reported it.",
			]
		: [
				"- When you have enough, STOP dispatching and produce the FINAL REPORT: clean human-facing markdown",
				"  that preserves file:line evidence and omits internal chatter.",
			];

	const finalize = [
		"- Produce the final report as your last message, wrapped EXACTLY between the markers",
		"  `<<<REPORT>>>` and `<<<END>>>`, with nothing after `<<<END>>>`. Any thinking/preamble must come",
		"  BEFORE `<<<REPORT>>>`. Note any point Inquisitor left unresolved.",
		"- HONEST FAILURE: if you could not actually complete the task (e.g. the PR could not be acquired),",
		"  do NOT write a normal report. Instead make the content between the markers begin with `FAILED:`",
		"  followed by the reason. This records the Quest as failed rather than a false success.",
	];

	return [...common, ...workflow, ...finalize].join("\n");
}

export async function runParty(opts: {
	brief: string;
	/** One or more repo contexts the Party can work in. */
	contexts: RepoContext[];
	roster: Guildmate[];
	config: GuildmasterConfig;
	signal?: AbortSignal;
	onProgress?: (members: QuestMember[]) => void;
	/** When true, the Party may dispatch write/exec members (into a writable context). */
	write?: boolean;
	/** Standing project context to fold into the Party Leader's prompt. */
	instructions?: string;
	/** When set, this is a PR-review party: envoy becomes dispatchable with a gated shell. */
	review?: { prText?: string; approvals: ApprovalManager; questId?: string };
}): Promise<PartyResult> {
	const write = opts.write ?? false;
	const reviewMode = Boolean(opts.review);
	const contexts = opts.contexts;
	const dispatchable = reviewMode ? DISPATCHABLE_REVIEW : write ? DISPATCHABLE_WRITE : DISPATCHABLE_READONLY;
	const available = opts.roster.filter((m) => dispatchable.has(m.tier));
	const members: QuestMember[] = [];
	let memberCost = 0;

	const dispatch: ToolDefinition = defineTool({
		name: "dispatch",
		label: "Dispatch",
		description:
			"Delegate one bounded task to a single read-only Guildmate. Returns that Guildmate's concise result. " +
			`Available: ${available.map((m) => m.name).join(", ")}.`,
		parameters: Type.Object({
			agent: Type.String({ description: "Guildmate to dispatch" }),
			task: Type.String({ description: "The specific, bounded task for this Guildmate" }),
			repo: Type.Optional(Type.String({ description: "Which project repo to run in (omit for single-repo projects)" })),
		}),
		execute: async (_toolCallId, params, signal) => {
			const mate = findGuildmate(available, params.agent);
			if (!mate) {
				throw new Error(
					`"${params.agent}" is not a dispatchable Guildmate. Available: ${available.map((m) => m.name).join(", ")}.`,
				);
			}
			const readOnly = mate.tier === "read-only";
			const context = params.repo
				? contexts.find((c) => c.name === params.repo)
				: readOnly
					? contexts[0]
					: (contexts.find((c) => c.writable) ?? contexts[0]);
			if (!context) {
				throw new Error(`Unknown repo "${params.repo}". Available: ${contexts.map((c) => c.name).join(", ")}.`);
			}
			if (!readOnly && !context.writable) {
				throw new Error(
					`${mate.name} needs a writable repo; "${context.name}" is read-only. Writable: ${contexts.filter((c) => c.writable).map((c) => c.name).join(", ") || "none"}.`,
				);
			}
			const modelSpec = resolveModelSpec(opts.config, mate.model);
			const index =
				members.push({ name: mate.name, task: params.task, model: modelSpec, status: "running", repo: context.name }) - 1;
			opts.onProgress?.(members.slice());

			// The envoy gets the gated GitHub shell (never raw bash) for review parties.
			const envoyTools =
				mate.tier === "envoy" && opts.review
					? [
							createEnvoyShellTool({
								cwd: context.path,
								reviewMode: true,
								prText: opts.review.prText,
								approvals: opts.review.approvals,
								questId: opts.review.questId,
							}),
						]
					: undefined;

			const res = await runChildAgent({
				guildmate: mate,
				task: params.task,
				modelSpec,
				cwd: context.path,
				signal,
				maxTurns: readOnly ? READONLY_MAX_TURNS : WORK_MAX_TURNS,
				hardTimeoutMs: readOnly ? READONLY_HARD_TIMEOUT_MS : WORK_HARD_TIMEOUT_MS,
				customTools: envoyTools,
				extraTools: envoyTools ? ["shell"] : undefined,
			});

			memberCost += res.usage.cost;
			const failed = Boolean(res.error) || res.stopReason === "error" || res.stopReason === "aborted";
			members[index].status = failed ? "failed" : "done";
			members[index].summary = res.finalText.slice(0, 400);
			opts.onProgress?.(members.slice());

			if (failed) {
				return {
					content: [{ type: "text", text: `${mate.name} failed: ${res.error ?? res.stopReason ?? "unknown"}` }],
					details: {},
				};
			}
			return { content: [{ type: "text", text: res.finalText || "(no result)" }], details: {} };
		},
	});

	const run = await runSession({
		// The leader has no file tools; it just needs a valid cwd for session setup.
		cwd: contexts[0]?.path ?? process.cwd(),
		systemPrompt: buildSystemPrompt(loadPartyLeaderPrompt() ?? DEFAULT_LEADER_PROMPT, available, opts.config, write, contexts, opts.instructions, reviewMode),
		modelSpec: resolveModelSpec(opts.config, opts.config.partyLeaderModel),
		tools: ["dispatch"],
		customTools: [dispatch],
		promptText: opts.brief,
		maxTurns: LEADER_MAX_TURNS,
		graceTurns: LEADER_GRACE_TURNS,
		hardTimeoutMs: LEADER_HARD_TIMEOUT_MS,
		signal: opts.signal,
	});

	const rawReport = extractReport(lastAssistantText(run.messages));
	const leaderUsage = collectUsage(run.messages);
	// Honest failure: a leader that could not complete emits `FAILED: <reason>` instead of a report.
	const failedSignal = /^FAILED:/i.test(rawReport.trim());
	const report = failedSignal ? "" : rawReport;
	const error = run.error ?? (failedSignal ? rawReport.trim().replace(/^FAILED:\s*/i, "") : report.trim() ? undefined : "Party produced no report.");

	return {
		report,
		members,
		usage: { cost: memberCost + leaderUsage.cost, turns: leaderUsage.turns },
		stopReason: run.stopReason,
		error,
	};
}
