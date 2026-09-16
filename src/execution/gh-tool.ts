/**
 * The envoy's gated shell (§8, §9, §10).
 *
 * This is the ONLY door between a review party and GitHub. The envoy never gets
 * the raw `bash` tool; it gets this instead. Every command is classified by the
 * policy classifier (policy.ts) before it can run:
 *
 *   - read      (gh pr view/diff, git status)     → runs immediately
 *   - mutate    (gh pr review/comment, api POST)  → parks a human approval first
 *   - forbidden (gh pr merge)                      → refused outright
 *
 * A suspected security fix is blocked from auto-publish and must be confirmed out
 * of band, honouring the org security policy. Nothing hits GitHub without either a
 * read classification or the user's explicit /approve.
 */

import { execSync } from "node:child_process";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ApprovalManager } from "../orchestration/approvals.ts";
import { gateReviewCommand } from "./policy.ts";

export function createEnvoyShellTool(opts: {
	cwd: string;
	reviewMode: boolean;
	prText?: string;
	approvals: ApprovalManager;
	questId?: string;
}): ToolDefinition {
	return defineTool({
		name: "shell",
		label: "Shell (gated)",
		description:
			"Run a shell command as the party's GitHub envoy. Read-only commands (gh pr view/diff, git status) " +
			"run immediately. Mutations (gh pr review/comment) require the user's approval before running. " +
			"`gh pr merge` is forbidden. Use this to fetch the PR and to post the review the party agreed.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run, e.g. `gh pr diff 1905`." }),
		}),
		execute: async (_toolCallId, params) => {
			const gate = gateReviewCommand(params.command, { reviewMode: opts.reviewMode, prText: opts.prText });
			if (gate.blocked) {
				return {
					content: [{ type: "text", text: `BLOCKED (${gate.operation}): ${gate.reason}. Command not run.` }],
					details: { blocked: true, operation: gate.operation },
				};
			}
			if (gate.needsApproval) {
				const approved = await opts.approvals.request({
					title: `Envoy wants to ${gate.operation}`,
					description: `The review party is requesting to run:\n\n\`${params.command}\``,
					operation: gate.operation,
					questId: opts.questId,
				});
				if (!approved) {
					return {
						content: [{ type: "text", text: `DENIED by user: ${gate.operation}. Left as a draft; not posted.` }],
						details: { denied: true, operation: gate.operation },
					};
				}
			}
			try {
				const out = execSync(params.command, {
					cwd: opts.cwd,
					encoding: "utf-8",
					timeout: 60_000,
					stdio: ["ignore", "pipe", "pipe"],
				});
				return { content: [{ type: "text", text: out.slice(0, 20_000) || "(no output)" }], details: {} };
			} catch (err) {
				const e = err as { stderr?: string; message?: string };
				return { content: [{ type: "text", text: `Command failed: ${e.stderr || e.message || String(err)}` }], details: { failed: true } };
			}
		},
	});
}
