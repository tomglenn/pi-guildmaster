/**
 * The envoy's gated shell (§8, §9, §10).
 *
 * This is the ONLY door between a review party and GitHub. The envoy never gets
 * the raw `bash` tool; it gets this instead. Every command is classified by the
 * policy classifier (policy.ts) before it can run:
 *
 *   - read      (gh pr view/diff, git status)     → runs immediately
 *   - mutate    (gh api POST, …)                  → parks a human approval first
 *   - forbidden (gh pr merge; shell operators; the envoy posting a review/comment)
 *                                                  → refused outright
 *
 * The command runs as the exact argv the gate classified (execFileSync, no shell).
 * In a review Quest the review itself is posted only by postReview, from the
 * confirmed /approve snapshot of review.md — never by the envoy.
 *
 * Nothing hits GitHub without either a read classification or the user's explicit /approve.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ApprovalManager } from "../orchestration/approvals.ts";
import { gateReviewCommand, shellWords } from "./policy.ts";

export type ReviewVerdict = "approve" | "request-changes" | "comment";

/** The `gh pr review` flag for a verdict — the event GitHub records (APPROVE / REQUEST_CHANGES / COMMENT). */
export function reviewFlag(v: ReviewVerdict): "--approve" | "--request-changes" | "--comment" {
	return v === "approve" ? "--approve" : v === "request-changes" ? "--request-changes" : "--comment";
}

/** A PR number: digits only. */
export const PR_NUMBER_RE = /^\d+$/;
/** An `owner/repo` slug: word chars, dots and dashes only. */
export const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

/** Throw unless `number` / `slug` are a plain PR number and `owner/repo` slug. */
export function assertPrTarget(number: string, slug?: string): void {
	if (!PR_NUMBER_RE.test(number)) throw new Error(`Invalid PR number "${number}": expected digits only.`);
	if (slug !== undefined && !REPO_SLUG_RE.test(slug)) {
		throw new Error(`Invalid repo slug "${slug}": expected owner/repo (letters, digits, _ . - only).`);
	}
}

/** The `gh` argv that posts a review. Validates the target; never goes through a shell. */
export function buildReviewArgs(opts: { number: string; slug?: string; verdict: ReviewVerdict; bodyFile: string }): string[] {
	assertPrTarget(opts.number, opts.slug);
	return [
		"pr",
		"review",
		opts.number,
		...(opts.slug ? ["--repo", opts.slug] : []),
		reviewFlag(opts.verdict),
		"--body-file",
		opts.bodyFile,
	];
}

/** Runs a binary with an argv (no shell). Injectable so tests can capture the argv. */
export type ExecFile = (
	file: string,
	args: string[],
	opts: { cwd: string; encoding: "utf-8"; timeout: number; stdio: ["ignore", "pipe", "pipe"] },
) => string;

const defaultExecFile: ExecFile = (file, args, opts) => execFileSync(file, args, opts);

/**
 * Post a PR review via `gh pr review` (the envoy's action, run by the extension
 * once the user has approved). Re-runs the policy gate as a final safety check:
 * merge is never reachable here.
 */
export function postReview(opts: {
	cwd: string;
	number: string;
	slug?: string;
	verdict: ReviewVerdict;
	body: string;
	prText?: string;
	exec?: ExecFile;
}): { url?: string; error?: string } {
	const exec = opts.exec ?? defaultExecFile;
	try {
		assertPrTarget(opts.number, opts.slug);
	} catch (err) {
		return { error: (err as Error).message };
	}
	const repoArgs = opts.slug ? ["--repo", opts.slug] : [];
	const gate = gateReviewCommand(["gh", "pr", "review", opts.number, ...repoArgs, reviewFlag(opts.verdict)].join(" "), {
		reviewMode: true,
	});
	if (gate.blocked) return { error: gate.reason };
	// A private, freshly created directory + an exclusive 0600 file: nothing else can pre-create or read it.
	let dir: string | undefined;
	try {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-review-"));
		const bodyFile = path.join(dir, "body.md");
		fs.writeFileSync(bodyFile, opts.body, { encoding: "utf-8", flag: "wx", mode: 0o600 });
		exec("gh", buildReviewArgs({ number: opts.number, slug: opts.slug, verdict: opts.verdict, bodyFile }), {
			cwd: opts.cwd,
			encoding: "utf-8",
			timeout: 60_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let url: string | undefined;
		try {
			url =
				exec("gh", ["pr", "view", opts.number, ...repoArgs, "--json", "reviews", "-q", ".reviews[-1].url"], {
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
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
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
			"Run ONE gh or read-only git command as the party's GitHub envoy (no shell: pipes, ;, &&, redirects " +
			"and $(\u2026) are refused). Read-only commands (gh pr view/diff/checks, gh api GET, git status) run " +
			"immediately. The envoy never posts reviews or comments: a review Quest's review is posted from the " +
			"review.md comment block when the user runs /approve. Other mutations require the user's approval. " +
			"`gh pr merge` is forbidden. Use this to fetch the PR.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run, e.g. `gh pr diff 1905`." }),
		}),
		execute: async (_toolCallId, params) => {
			const gate = gateReviewCommand(params.command, { reviewMode: opts.reviewMode, envoy: true });
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
			// Run the exact argv the gate classified, with no shell in between.
			const argv = shellWords(params.command.trim());
			if (argv.length === 0) {
				return { content: [{ type: "text", text: "Command failed: empty command." }], details: {} };
			}
			try {
				const out = execFileSync(argv[0], argv.slice(1), {
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
