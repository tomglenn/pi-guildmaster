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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ApprovalManager } from "../orchestration/approvals.ts";
import { gateReviewCommand } from "./policy.ts";

export type ReviewVerdict = "approve" | "request-changes" | "comment";

/**
 * Post a PR review via `gh pr review` (the envoy's action, run by the extension
 * once the user has approved). Re-runs the policy gate as a final safety check:
 * a suspected security fix stays blocked, and merge is never reachable here.
 */
export function postReview(opts: {
	cwd: string;
	number: string;
	slug?: string;
	verdict: ReviewVerdict;
	body: string;
	prText?: string;
}): { url?: string; error?: string } {
	const flag = opts.verdict === "approve" ? "--approve" : opts.verdict === "request-changes" ? "--request-changes" : "--comment";
	const repoFlag = opts.slug ? ` --repo ${opts.slug}` : "";
	const gate = gateReviewCommand(`gh pr review ${opts.number}${repoFlag} ${flag}`, { reviewMode: true, prText: opts.prText });
	if (gate.blocked) return { error: gate.reason };
	const tmp = path.join(os.tmpdir(), `gm-review-${Date.now()}.md`);
	try {
		fs.writeFileSync(tmp, opts.body, "utf-8");
		execSync(`gh pr review ${opts.number}${repoFlag} ${flag} --body-file ${tmp}`, {
			cwd: opts.cwd,
			encoding: "utf-8",
			timeout: 60_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let url: string | undefined;
		try {
			url =
				execSync(`gh pr view ${opts.number}${repoFlag} --json reviews -q ".reviews[-1].url"`, {
					cwd: opts.cwd,
					encoding: "utf-8",
					timeout: 20_000,
					stdio: ["ignore", "pipe", "pipe"],
				}).trim() || undefined;
		} catch {
			/* url is best-effort */
		}
		return { url };
	} catch (err) {
		const e = err as { stderr?: string; message?: string };
		return { error: e.stderr || e.message || String(err) };
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

export function createEnvoyShellTool(opts: {
	cwd: string;
	reviewMode: boolean;
	prText?: string;
	/** Required only in review mode (to gate a post). In read-only acquire mode no
	 * mutation is ever reachable, so approvals may be omitted. */
	approvals?: ApprovalManager;
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
					details: {},
				};
			}
			if (gate.needsApproval) {
				if (!opts.approvals) {
					return {
						content: [{ type: "text", text: `BLOCKED (${gate.operation}): this envoy is read-only and cannot mutate. Command not run.` }],
						details: {},
					};
				}
				const approved = await opts.approvals.request({
					title: `Envoy wants to ${gate.operation}`,
					description: `The review party is requesting to run:\n\n\`${params.command}\``,
					operation: gate.operation,
					questId: opts.questId,
				});
				if (!approved) {
					return {
						content: [{ type: "text", text: `DENIED by user: ${gate.operation}. Left as a draft; not posted.` }],
						details: {},
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
				return { content: [{ type: "text", text: `Command failed: ${e.stderr || e.message || String(err)}` }], details: {} };
			}
		},
	});
}
