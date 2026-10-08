import { runChildAgent } from "../execution/child-agent.ts";
import { createRunnerShellTool } from "../execution/runner-shell.ts";
import { resolveModelSpec, type GuildmasterConfig } from "../config.ts";
import type { Guildmate } from "../roster.ts";
import type { QuestMember } from "../persistence/quest-store.ts";
import type { RepoContext } from "../persistence/project-store.ts";
import type { PartyResult } from "./party-leader.ts";
import { CHECKS_LINE_HELP } from "./checks-line.ts";

/** Display only (the board's live "test" chip); never used to judge the work. */
const LOOKS_LIKE_CHECK = /\b(test|vitest|jest|pytest|typecheck|lint|tsc|build)\b/i;

export function createBuilderGuildmate(): Guildmate {
	return {
		name: "builder", tier: "builder", description: "Implement, test, and iterate in one session",
		model: "capable", filePath: "(built-in)",
		systemPrompt: [
			"Implement the brief in the isolated worktree. You can edit files and run bounded shell commands.",
			"In this one session: inspect relevant code, edit, run the checks, fix failures, and check the final diff against every requirement.",
			"You own the result: nobody re-checks your work. Keep fixing and re-running until every check passes. You are not done while a check fails.",
			"Use the shell for bounded build, test, and git inspection. Do not push or open a PR. Do not create planning files in the repo.",
			"Run each check as ONE plain command (e.g. `npm test`, `npx tsc --noEmit`) so its real exit code is visible. Report observed exit codes, not guesses.",
			"If a check can only pass by breaking an explicit requirement of the brief, do not break it: begin your final answer with FAILED: and name the conflict.",
			"Your report becomes a public draft PR body: keep secrets, credentials, internal comms (Slack quotes or links) and private or customer information out of it and out of the diff.",
			"End with a PR-ready report: '# <short title>', then Summary, Changes, Testing, and Risks / Unresolved.",
			CHECKS_LINE_HELP,
		].join("\n"),
	};
}

/** One background edit/test loop. The worker keeps its session throughout all fixes. */
export async function runFastWrite(opts: {
	brief: string;
	context: RepoContext;
	config: GuildmasterConfig;
	instructions?: string;
	globalInstructions?: string;
	signal?: AbortSignal;
	onProgress?: (members: QuestMember[]) => void;
	onActivity?: () => void;
	onLeaderText?: (text: string) => void;
	onLeaderMessage?: (text: string) => void;
	/** Test seam: exercise the worker lifecycle without calling a model. */
	runWorker?: typeof runChildAgent;
}): Promise<PartyResult> {
	const { context } = opts;
	if (!context.writable) throw new Error("Builder requires a writable isolated repository.");
	const member: QuestMember = { name: "builder", task: opts.brief, repo: context.name, status: "running", startedAt: Date.now() };
	const progress = () => opts.onProgress?.([{ ...member }]);
	progress();
	const guildmate = createBuilderGuildmate();
	const task = [opts.brief, opts.globalInstructions && `Guild-wide instructions:\n${opts.globalInstructions}`, opts.instructions && `Project instructions:\n${opts.instructions}`].filter(Boolean).join("\n\n");
	let seenTools = 0;
	let seenShellResult: string | undefined;
	// A soft budget only raises visibility; it never cancels legitimate long tests.
	const budget = setTimeout(() => {
		member.budgetExceededAt = Date.now();
		progress();
	}, 5 * 60_000);
	budget.unref?.();
	try {
		const result = await (opts.runWorker ?? runChildAgent)({
			guildmate, task, modelSpec: resolveModelSpec(opts.config, "capable"), cwd: context.path,
			signal: opts.signal,
			onActivity: opts.onActivity,
			customTools: [createRunnerShellTool({ cwd: context.path, ...opts.config.shell })], extraTools: ["shell"],
			onUpdate: (partial) => {
				const shell = partial.lastShellResult;
				if (shell && shell.id !== seenShellResult) {
					seenShellResult = shell.id;
					if (shell.command && LOOKS_LIKE_CHECK.test(shell.command)) {
						member.lastTest = `${shell.exitCode === 0 ? "pass" : `exit ${shell.exitCode ?? "?"}`}: ${(shell.command ?? "test").slice(0, 100)}`;
						progress();
					}
				}
				const last = partial.toolCalls.at(-1);
			if (last && partial.toolCalls.length > seenTools) {
				seenTools = partial.toolCalls.length;
				member.lastTool = last.name;
				member.step = last.name === "shell" ? `Running: ${String(last.args.command ?? "command").slice(0, 100)}` : `${last.name}: ${String(last.args.path ?? "files").slice(0, 100)}`;
				progress();
			}
			if (partial.finalText) opts.onLeaderText?.(partial.finalText);
			},
		});
		member.status = result.error || result.stopReason === "error" || result.stopReason === "aborted" ? "failed" : "done";
		member.finishedAt = Date.now();
		member.summary = result.finalText.slice(0, 400);
		member.step = member.status === "done" ? "Finished edit/test loop" : "Worker stopped";
		progress();
		opts.onLeaderMessage?.(result.finalText);
		const error = result.error ?? (member.status === "failed" ? `Builder stopped (${result.stopReason ?? "unknown"}).` : !result.finalText.trim() ? "Builder returned an empty report." : /^FAILED:/i.test(result.finalText.trim()) ? result.finalText.trim() : undefined);
		return { report: error ? "" : result.finalText, rawFinal: result.finalText, members: [{ ...member }], usage: { cost: result.usage.cost, turns: result.usage.turns }, stopReason: result.stopReason, error };
	} catch (err) {
		member.status = "failed";
		member.finishedAt = Date.now();
		progress();
		throw err;
	} finally {
		clearTimeout(budget);
	}
}
