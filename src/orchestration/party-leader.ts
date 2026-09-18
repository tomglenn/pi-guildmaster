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

import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type GuildmasterConfig, resolveModelSpec } from "../config.ts";
import { collectUsage, lastAssistantText, runChildAgent, runSession } from "../execution/child-agent.ts";
import { createEnvoyShellTool } from "../execution/gh-tool.ts";
import { createRunnerShellTool } from "../execution/runner-shell.ts";
import { findGuildmate, type Guildmate, loadPartyLeaderPrompt } from "../roster.ts";
import type { QuestMember } from "../persistence/quest-store.ts";
import type { RepoContext } from "../persistence/project-store.ts";
import type { ApprovalManager } from "./approvals.ts";

const DISPATCHABLE_READONLY: ReadonlySet<string> = new Set(["read-only"]);
// Read-only investigation that also needs GitHub context: the read-only specialists
// plus the envoy, whose shell is read-only (it can fetch a PR but cannot post/mutate).
const DISPATCHABLE_READONLY_GH: ReadonlySet<string> = new Set(["read-only", "envoy"]);
const DISPATCHABLE_WRITE: ReadonlySet<string> = new Set(["read-only", "write", "exec"]);
// Review: read-only specialists judge, scribe (write) composes, envoy talks to GitHub.
const DISPATCHABLE_REVIEW: ReadonlySet<string> = new Set(["read-only", "write", "envoy"]);

export interface PartyResult {
	report: string;
	/** The leader's RAW final message, before delimiter extraction. Persisted for
	 * forensics/recovery so a bad extraction is never lossy-without-recovery. */
	rawFinal: string;
	members: QuestMember[];
	usage: { cost: number; turns: number };
	stopReason?: string;
	error?: string;
}

const DEFAULT_OPEN_TAG = "<<<REPORT>>>";
const DEFAULT_END_TAG = "<<<END>>>";

export interface ExtractedReport {
	/** The report body: marker-delimited when the leader finalized, else the full text. */
	body: string;
	/** True ONLY when the leader emitted the explicit <<<REPORT>>> finalization marker. */
	finalized: boolean;
}

/**
 * Extract the clean report from the Party Leader's final message, wrapped between
 * `openTag`...`endTag`. Robust to a report whose CONTENT quotes the delimiter
 * tokens (a report about this very machinery once truncated itself): we pair the
 * FIRST open with the LAST close, so the outermost wrapper wins and any quoted
 * mention inside the body is preserved rather than mistaken for the boundary.
 * Callers pass a per-run unique tag (see runParty), making accidental collision
 * effectively impossible. Also reports WHETHER the open marker was present
 * (`finalized`), so a run that stopped before finalizing is never mistaken for a
 * real report.
 */
export function extractReport(text: string, openTag: string = DEFAULT_OPEN_TAG, endTag: string = DEFAULT_END_TAG): ExtractedReport {
	const start = text.indexOf(openTag);
	if (start === -1) return { body: text.trim(), finalized: false };
	let body = text.slice(start + openTag.length);
	const end = body.lastIndexOf(endTag);
	if (end !== -1) body = body.slice(0, end);
	return { body: body.trim(), finalized: true };
}

export interface PartyOutcomeInput {
	/** The leader's last assistant message text. */
	lastText: string;
	/** How the underlying session ended (e.g. "endTurn", "aborted", "error"). */
	stopReason?: string;
	/** A transport/model error from the session, if any. */
	error?: string;
	/** Per-run report delimiters (default to the plain tokens for tests). */
	openTag?: string;
	endTag?: string;
}

/**
 * Decide the trustworthy outcome of a Party run. A report is accepted ONLY when the
 * leader DELIBERATELY finalized it (emitted the <<<REPORT>>> marker) AND the run
 * ended normally. A run that was cancelled/errored, signalled `FAILED:`, or never
 * emitted the marker yields an error and NO report — so a truncated run can never be
 * promoted to a "completed" Quest (the failure mode this guards against).
 */
export function finalizePartyOutcome(input: PartyOutcomeInput): { report: string; error?: string } {
	const extracted = extractReport(input.lastText, input.openTag ?? DEFAULT_OPEN_TAG, input.endTag ?? DEFAULT_END_TAG);
	const failedSignal = /^FAILED:/i.test(extracted.body.trim());
	const abnormalStop = input.stopReason === "error" || input.stopReason === "aborted";
	if (input.error || abnormalStop) {
		return { report: "", error: input.error ?? `Party ended without finalizing (${input.stopReason ?? "unknown"}).` };
	}
	if (failedSignal) {
		return { report: "", error: extracted.body.trim().replace(/^FAILED:\s*/i, "") || "Party reported failure without a reason." };
	}
	if (!extracted.finalized) {
		return { report: "", error: "Party stopped before emitting a final report (no report delimiter)." };
	}
	if (!extracted.body.trim()) {
		return { report: "", error: "Party emitted an empty report." };
	}
	return { report: extracted.body };
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

function buildSystemPrompt(basePrompt: string, available: Guildmate[], config: GuildmasterConfig, write: boolean, contexts: RepoContext[], globalInstructions: string | undefined, instructions: string | undefined, reviewMode: boolean, acquire: boolean, openTag: string, endTag: string, partyHint?: string[]): string {
	const roster = available
		.map((m) => `- ${m.name} [${m.tier}] (model: ${resolveModelSpec(config, m.model) ?? "default"}): ${m.tagline ?? m.description}`)
		.join("\n");

	const globalBlock = globalInstructions?.trim()
		? ["## Guild-wide instructions", globalInstructions.trim(), ""]
		: [];
	const projectBlock = instructions?.trim() ? ["## Project context", instructions.trim(), ""] : [];

	const common = [
		...globalBlock,
		...projectBlock,
		...buildRepoBlock(contexts),
		basePrompt,
		"",
		`## Available Guildmates${reviewMode ? " (PR review)" : acquire ? " (investigation + GitHub)" : write ? "" : " (read-only specialists)"}`,
		reviewMode
			? "Dispatch via the `dispatch` tool; you have NO tools of your own. `envoy` is the party's ONLY contact with GitHub (a gated shell): it fetches the PR and, with the user's approval, posts the review. All other members work read-only on the fetched PR."
			: acquire
				? "Dispatch via the `dispatch` tool; you have NO tools of your own. `envoy` is the party's contact with GitHub but is READ-ONLY here: it can fetch (gh pr view/diff, gh api reads) but CANNOT post, comment or mutate — this Quest only produces a report. All other members work read-only."
				: write
					? "You are running in an ISOLATED git worktree on a dedicated branch. Writes by `smith` and commands by `runner` happen ONLY in this worktree and never touch the user's checkout. Dispatch via the `dispatch` tool; you have NO tools of your own."
					: "Dispatch these via the `dispatch` tool. You have NO file tools yourself — you MUST delegate all investigation.",
		"",
		roster,
		"",
		"## Running this Quest",
		...(partyHint?.length
			? [`- This recipe PREFERS these Guildmates: ${partyHint.join(", ")}. Favour them, but dispatch others (e.g. inquisitor, scribe) when the task needs them.`]
			: []),
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
		"- Do NOT post the review yourself. Your final report IS the review Scribe wrote. After you finish, a",
		"  separate human-approved step posts it via the envoy (or leaves it as a draft). Never merge.",
		"- End with an explicit verdict line, e.g. `Verdict: Request changes`, so the post step knows what to submit.",
	];

	const acquireWorkflow = [
		"- ACQUIRE-THEN-ANALYSE WORKFLOW: first dispatch `envoy` to FETCH the GitHub context the brief needs",
		"  (e.g. `gh pr view <n> --json ...`, `gh pr diff <n>`, and `gh api .../comments` for review threads).",
		"  If the envoy cannot fetch it, do not fabricate — emit the FAILED signal (see finalize).",
		"- Then dispatch read-only specialists (scout/delver for code, architect for planning) against the",
		"  fetched material and the codebase. Use inquisitor to attack any conclusion or plan.",
		"- The envoy here is READ-ONLY: never ask it to post, comment, review or merge. This Quest DELIVERS A",
		"  REPORT ONLY. When you have enough, STOP and produce the final report.",
	];

	const workflow = reviewMode
		? reviewWorkflow
		: acquire
		? acquireWorkflow
		: write
		? [
				"- IMPLEMENTATION WORKFLOW: understand the code (scout/delver), get a plan (architect), and have",
				"  inquisitor attack the PLAN. THEN dispatch `smith` to implement and `runner` to build/test. Only",
				"  dispatch smith after a plan exists; if smith says the plan is wrong, stop and re-plan rather than",
				"  improvising. (Runner can only run bounded commands; watch modes/servers are refused by its shell.)",
				"- REVIEW YOUR OWN DIFF BEFORE FINALIZING: once smith has implemented and runner's build/tests are",
				"  green, you MUST dispatch `inquisitor` (and `warden` when the change touches security/auth/input",
				"  handling) to review the ACTUAL CHANGES, not the plan. Give the reviewer the changed-file list and",
				"  the brief's acceptance criteria; it reads those files (and may ask runner for `git diff`) and checks",
				"  the implementation against EVERY requirement in the brief.",
				"- HAND BACK ON MATERIAL ISSUES: if the reviewer finds a correctness bug, a security hole, a broken or",
				"  missing test, or a brief requirement not met, dispatch `smith` to fix it and then re-review. Cap",
				"  this at TWO review→fix rounds. Do NOT loop on nits or style — record minor items under Unresolved",
				"  and move on. Finalize only when the review is clean or the two rounds are spent.",
				"- PR BODY SYNTHESIS: after review passes, dispatch `scribe` to write the pull request description.",
				"  Scribe writes plain, human-readable prose (its persona defines the style). Give Scribe: the brief,",
				"  what changed (files and why), what runner tested, and any caveats from inquisitor/warden.",
				"- The final report IS what Scribe wrote — paste it verbatim between the report markers, do not",
				"  rewrite it. First line must be a concise PR title as H1 (`# ...`). Then sections: Summary,",
				"  Changes (with file references), Testing (what was verified), and Risks / Unresolved (if any).",
				"  Do not claim tests passed unless runner actually reported it.",
			]
		: [
				"- When you have enough, STOP dispatching and produce the FINAL REPORT: clean human-facing markdown",
				"  that preserves file:line evidence and omits internal chatter.",
			];

	const finalize = [
		`- Produce the final report as your last message, wrapped EXACTLY between the markers \`${openTag}\``,
		`  and \`${endTag}\`, with nothing after \`${endTag}\`. Any thinking/preamble must come BEFORE`,
		`  \`${openTag}\`. These markers are UNIQUE to this run — reproduce them verbatim, exactly once each.`,
		`  If your report needs to show a report delimiter as an example, write a GENERIC form without the run`,
		`  id (e.g. <<<REPORT>>>), never these exact run-tagged tokens. Note any point Inquisitor left unresolved.`,
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
	/** Guild-wide standing instructions prepended to every Party Leader prompt. */
	globalInstructions?: string;
	/** When set, this is a PR-review party: envoy becomes dispatchable with a gated shell. */
	review?: { prText?: string; approvals: ApprovalManager; questId?: string };
	/** When true (and not a review), grant a READ-ONLY envoy so the party can fetch
	 * GitHub context (a PR, its diff and comments) without any ability to post/mutate. */
	acquire?: boolean;
	/** Advisory list of preferred Guildmates for this recipe (does not hard-restrict). */
	partyHint?: string[];
}): Promise<PartyResult> {
	const write = opts.write ?? false;
	const reviewMode = Boolean(opts.review);
	const acquire = Boolean(opts.acquire) && !reviewMode && !write;
	const contexts = opts.contexts;
	const dispatchable = reviewMode
		? DISPATCHABLE_REVIEW
		: write
			? DISPATCHABLE_WRITE
			: acquire
				? DISPATCHABLE_READONLY_GH
				: DISPATCHABLE_READONLY;
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

			// Shell access is always a bounded/gated CUSTOM tool, never raw bash: the envoy gets the
			// policy-gated GitHub shell for review parties; the runner (exec) gets the bounded shell
			// that refuses non-terminating commands and reaps a silently hung one.
			const shellTools =
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
					: mate.tier === "envoy" && acquire
						? // Read-only envoy: reviewMode:false makes policy REFUSE every mutation
							// outright (no approval path), so this shell can only fetch.
							[createEnvoyShellTool({ cwd: context.path, reviewMode: false })]
						: mate.tier === "exec"
							? [createRunnerShellTool({ cwd: context.path, ...opts.config.shell })]
							: undefined;

			// Requirement fidelity: write/exec members act on the code, so they must see the quest's
			// authoritative constraints, not just the leader's paraphrase of one bounded task. The brief
			// is appended so smith/runner satisfy EVERY requirement, not only the observable one.
			const memberTask =
				mate.tier === "write" || mate.tier === "exec"
					? `${params.task}\n\n## Quest brief (authoritative requirements — satisfy ALL of these, not just the task above)\n${opts.brief}`
					: params.task;

			const res = await runChildAgent({
				guildmate: mate,
				task: memberTask,
				modelSpec,
				cwd: context.path,
				signal,
				customTools: shellTools,
				extraTools: shellTools ? ["shell"] : undefined,
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

	// Per-run report delimiters: a random id makes the tokens unique to this run, so a
	// report that discusses the delimiter machinery cannot collide with its own wrapper.
	const nonce = randomUUID().slice(0, 8);
	const openTag = `<<<REPORT:${nonce}>>>`;
	const endTag = `<<<END:${nonce}>>>`;

	const run = await runSession({
		// The leader has no file tools; it just needs a valid cwd for session setup.
		cwd: contexts[0]?.path ?? process.cwd(),
		systemPrompt: buildSystemPrompt(loadPartyLeaderPrompt() ?? DEFAULT_LEADER_PROMPT, available, opts.config, write, contexts, opts.globalInstructions, opts.instructions, reviewMode, acquire, openTag, endTag, opts.partyHint),
		modelSpec: resolveModelSpec(opts.config, opts.config.partyLeaderModel),
		tools: ["dispatch"],
		customTools: [dispatch],
		promptText: opts.brief,
		signal: opts.signal,
	});

	const leaderUsage = collectUsage(run.messages);
	const usage = { cost: memberCost + leaderUsage.cost, turns: leaderUsage.turns };
	const rawFinal = lastAssistantText(run.messages);
	const { report, error } = finalizePartyOutcome({
		lastText: rawFinal,
		stopReason: run.stopReason,
		error: run.error,
		openTag,
		endTag,
	});
	return { report, rawFinal, members, usage, stopReason: run.stopReason, error };
}
