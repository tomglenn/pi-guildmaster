import { runChildAgent } from "../execution/child-agent.ts";
import { createRunnerShellTool } from "../execution/runner-shell.ts";
import { resolveModelSpec, type GuildmasterConfig } from "../config.ts";
import type { Guildmate } from "../roster.ts";
import type { QuestMember } from "../persistence/quest-store.ts";
import type { RepoContext } from "../persistence/project-store.ts";
import type { PartyResult } from "./party-leader.ts";

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
}): Promise<PartyResult> {
	const { context } = opts;
	if (!context.writable) throw new Error("Builder requires a writable isolated repository.");
	const member: QuestMember = { name: "builder", task: opts.brief, repo: context.name, status: "running", startedAt: Date.now() };
	const progress = () => opts.onProgress?.([{ ...member }]);
	progress();
	const guildmate: Guildmate = {
		name: "builder", tier: "builder", description: "Implement, test, and iterate in one session",
		model: "reasoning", filePath: "(built-in)",
		systemPrompt: [
			"You implement the user's brief in this isolated git worktree. You can edit files and run bounded shell commands.",
			"Work in ONE session: inspect relevant code, make the smallest correct change, run targeted tests, fix failures, and check the final diff against EVERY requirement.",
			"Use the shell for bounded build/test/git inspection only; do not push or open a PR. Never write planning or scratch files into the repo.",
			"If blocked or tests fail and you cannot fix them, begin your final answer with FAILED: and explain why. Do not claim a test passed unless you observed its exit code.",
			"End with a PR-ready report: first line '# <short title>', then Summary, Changes (file references), Testing (commands and observed results), and Risks / Unresolved.",
		].join("\n"),
	};
	const task = [opts.brief, opts.globalInstructions && `Guild-wide instructions:\n${opts.globalInstructions}`, opts.instructions && `Project instructions:\n${opts.instructions}`].filter(Boolean).join("\n\n");
	let seenTools = 0;
	try {
		const result = await runChildAgent({
			guildmate, task, modelSpec: resolveModelSpec(opts.config, "reasoning"), cwd: context.path,
			signal: opts.signal,
			customTools: [createRunnerShellTool({ cwd: context.path, ...opts.config.shell })], extraTools: ["shell"],
			onUpdate: (partial) => {
				opts.onActivity?.();
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
	}
}
