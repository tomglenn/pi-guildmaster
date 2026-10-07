import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runChildAgent } from "../execution/child-agent.ts";
import { resolveModelSpec, type GuildmasterConfig } from "../config.ts";
import type { QuestIsolation, QuestMember } from "../persistence/quest-store.ts";
import { findGuildmate, type Guildmate } from "../roster.ts";
export function requiredReviewer(brief: string, files: string[], diff: string): "warden" | "inquisitor" | undefined {
	if (/\b(auth(?:entication|orization)?|oauth|permission|privilege|secret|credential|token|cryptograph\w*|encrypt\w*|security|vulnerab\w*|injection|xss|csrf|sanitize|untrusted|user[ -]?input)\b/i.test(brief) ||
		files.some((f) => /(?:auth|permission|policy|security|secret|credential|token|crypto|saniti|csrf|xss)/i.test(f)) ||
		/^\+[^+].*\b(auth(?:enticate|orize)?|permission|secret|credential|token|sanitize|csrf|xss)\b/im.test(diff) ||
		(/\(untracked\) ---/.test(diff) && /\b(auth(?:enticate|orize)?|permission|secret|credential|token|sanitize|csrf|xss)\b/i.test(diff))) return "warden";
	if (/\b(migrat\w*|backfill|database schema|dependency upgrade|dependencies|supply.chain)\b/i.test(brief) ||
		files.some((f) => /(?:migrat|lock\.json$|lock\.yaml$)/i.test(f))) return "inquisitor";
	return undefined;
}

/** Fail closed: a missing or ambiguous verdict is NOT a passing independent review. */
export function reviewPassed(text: string): boolean {
	const verdicts = [...text.matchAll(/^VERDICT:\s*(PASS|BLOCK)\s*$/gim)];
	return verdicts.length === 1 && verdicts[0][1].toUpperCase() === "PASS";
}

/**
 * `block` is a FINDING to act on (fix round, or the user decides), never a reason to kill
 * the Quest by itself. Infrastructure failures (reviewer errored/aborted, diff too large,
 * reviewer missing) still throw: there is no finding to iterate on.
 */
export type ReviewOutcome =
	| { verdict: "skipped"; cost: number; member?: undefined }
	| { verdict: "pass" | "block"; reviewer: "warden" | "inquisitor"; member: QuestMember; cost: number; findings: string };

export async function reviewSensitiveDiff(opts: {
	isolation: QuestIsolation;
	brief: string;
	roster: Guildmate[];
	config: GuildmasterConfig;
	signal?: AbortSignal;
	onProgress?: (member: QuestMember) => void;
	/** Test seam: independent review without a live model. */
	runReviewer?: typeof runChildAgent;
}): Promise<ReviewOutcome> {
	const { isolation: iso } = opts;
	const git = (args: string[]) => execFileSync("git", args, { cwd: iso.worktreePath, encoding: "utf-8", maxBuffer: 2_000_000 });
	const diff = git(["diff", iso.baseRef, "--"]);
	const tracked = git(["diff", "--name-only", iso.baseRef, "--"]).trim().split("\n").filter(Boolean);
	const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
	const files = [...new Set([...tracked, ...untracked])];
	const snapshots = untracked.map((file) => {
		const full = path.join(iso.worktreePath, file);
		const stat = fs.lstatSync(full);
		if (!stat.isFile() || stat.size > 100_000) return `--- ${file} (non-regular or too large to inspect) ---`;
		return `--- ${file} (untracked) ---\n${fs.readFileSync(full, "utf-8")}`;
	}).join("\n");
	const fullDiff = `${diff}\n${snapshots}`;
	const reviewerName = requiredReviewer(opts.brief, files, fullDiff);
	if (!reviewerName) return { verdict: "skipped", cost: 0 };
	if (Buffer.byteLength(fullDiff) > 100_000) throw new Error("Risk-sensitive diff exceeds independent review limit (100 KB). Worktree preserved for manual review.");
	const reviewer = findGuildmate(opts.roster, reviewerName);
	if (!reviewer) throw new Error(`Risk-sensitive change requires ${reviewerName}, but that reviewer is unavailable. Worktree preserved.`);
	const member: QuestMember = { name: reviewerName, repo: iso.repo, task: "Independently review the final risk-sensitive diff", status: "running", startedAt: Date.now(), step: "Reviewing final diff" };
	opts.onProgress?.({ ...member });
	try {
		const res = await (opts.runReviewer ?? runChildAgent)({
			guildmate: reviewer, modelSpec: resolveModelSpec(opts.config, reviewer.model), cwd: iso.worktreePath, signal: opts.signal,
			task: `Independently review the FINAL change against the full brief. Inspect every changed file (including untracked files). Check for security and correctness issues. End with exactly one standalone line VERDICT: PASS or VERDICT: BLOCK. BLOCK on material issues or incomplete examination. Explain findings with file:line.\n\nBrief:\n${opts.brief}\n\nChanged files:\n${files.join("\n")}\n\nDiff and untracked files:\n${fullDiff}`,
		});
		if (res.error || res.stopReason === "aborted" || res.stopReason === "error") {
			member.status = "failed";
			member.finishedAt = Date.now();
			member.summary = (res.error ?? `Reviewer stopped (${res.stopReason}).`).slice(0, 400);
			opts.onProgress?.({ ...member });
			throw new Error(`Independent ${reviewerName} review could not run for ${iso.repo}: ${res.error ?? res.stopReason}. Worktree preserved.`);
		}
		const passed = reviewPassed(res.finalText);
		member.status = "done";
		member.step = passed ? "Review passed" : "Review blocked: findings sent for a fix";
		member.summary = res.finalText.slice(0, 400);
		member.finishedAt = Date.now();
		opts.onProgress?.({ ...member });
		return { verdict: passed ? "pass" : "block", reviewer: reviewerName, member, cost: res.usage.cost, findings: res.finalText.trim() };
	} catch (error) {
		if (member.status === "running") {
			member.status = "failed";
			member.finishedAt = Date.now();
			opts.onProgress?.({ ...member });
		}
		throw error;
	}
}
