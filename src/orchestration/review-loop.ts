/**
 * The independent-review loop for write Quests.
 *
 * A Warden/Inquisitor BLOCK is a finding to act on, not a verdict that ends the Quest:
 *   review → BLOCK → Builder fix round (findings + brief) → checks → review again …
 * bounded by `maxFixRounds`. The user decides only when iterating cannot settle it:
 * the fix budget is spent, the fix's checks do not pass, or the Builder reports that a
 * finding CONFLICTS with an explicit brief requirement (it must not silently override
 * the brief). The user can accept the risk, send it back with guidance, or stop.
 *
 * Pure orchestration with injected effects, so the control flow is unit-testable.
 */

import type { UserAnswer } from "./approvals.ts";
import type { ReviewOutcome } from "./write-review.ts";
import type { QuestMember } from "../persistence/quest-store.ts";

export const ACCEPT = "Accept the risk: keep the change, and record the findings in the PR body";
export const RETRY = "Send it back for another fix round with my guidance";
export const STOP = "Stop: keep the branch local and end the Quest";

/** Findings can be long; keep them whole up to a generous cap (never cut to a fragment). */
export function clipFindings(text: string, max = 8_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated; ${text.length - max} more characters)`;
}

export function fixPrompt(brief: string, reviewer: string, findings: string, guidance?: string): string {
	return [
		`An independent ${reviewer} review BLOCKED the current change in this worktree. Fix its material findings in the same worktree.`,
		"The original brief still applies. Rerun the relevant checks as plain commands, and check the final diff against the brief and the findings.",
		"If a finding can only be fixed by contradicting an EXPLICIT requirement of the brief, do not override the brief: leave that part unchanged and begin your final answer with CONFLICT: followed by which requirement and which finding conflict. The user decides.",
		"If you cannot fix a finding for another reason, begin your final answer with FAILED: and explain why.",
		guidance && `User guidance for this round (takes priority over the brief where they conflict):\n${guidance}`,
		`Original brief:\n${brief}`,
		`${reviewer} findings:\n${clipFindings(findings)}`,
	].filter(Boolean).join("\n\n");
}

export type FixResult = {
	member: QuestMember;
	cost: number;
	report: string;
	/** Why the fix cannot simply go back to review: CONFLICT/FAILED report, worker error, or checks not passing. */
	blocker?: string;
};

export type ReviewLoopResult = {
	outcome: "skipped" | "passed" | "accepted";
	reviewer?: string;
	fixRounds: number;
	members: QuestMember[];
	cost: number;
	/** The last blocking findings (accepted outcome) for the PR body. */
	findings?: string;
	/** A short Markdown section for the report / PR body. */
	note?: string;
	/** Each fix round's Builder report, so the PR body describes the code that ships. */
	fixReports: string[];
};

export async function runReviewLoop(opts: {
	repo: string;
	brief: string;
	maxFixRounds?: number;
	review: () => Promise<ReviewOutcome>;
	fix: (prompt: string, round: number) => Promise<FixResult>;
	/** Ask the user to decide (choose). Abort resolves as a deny, which stops. */
	choose: (title: string, description: string, options: string[]) => Promise<UserAnswer>;
	/** Ask the user for free-text guidance for a retry round. */
	answer: (title: string, description: string) => Promise<UserAnswer>;
	onMembers?: (members: QuestMember[]) => void;
}): Promise<ReviewLoopResult> {
	const members: QuestMember[] = [];
	const fixReports: string[] = [];
	let cost = 0;
	let rounds = 0;
	let budget = opts.maxFixRounds ?? 2;
	const push = (m: QuestMember) => {
		members.push(m);
		opts.onMembers?.(members.slice());
	};
	for (;;) {
		const review = await opts.review();
		cost += review.cost;
		if (review.verdict === "skipped") return { outcome: "skipped", fixRounds: rounds, members, cost, fixReports };
		push(review.member);
		if (review.verdict === "pass") {
			const note = rounds === 0
				? `## Independent review\n${review.reviewer} reviewed the final diff: PASS.`
				: `## Independent review\n${review.reviewer} blocked the first version. After ${rounds} fix round${rounds > 1 ? "s" : ""}, it passed.`;
			return { outcome: "passed", reviewer: review.reviewer, fixRounds: rounds, members, cost, note, fixReports };
		}
		let guidance: string | undefined;
		// The reviewer says only a brief change can satisfy it: a fix round would be wasted.
		let conflict = review.briefConflict ? `${review.reviewer} says the brief itself must change: ${review.briefConflict}` : undefined;
		for (;;) {
			let blocker: string | undefined = conflict;
			conflict = undefined;
			if (!blocker && rounds < budget) {
				rounds++;
				const fix = await opts.fix(fixPrompt(opts.brief, review.reviewer, review.findings, guidance), rounds);
				push(fix.member);
				cost += fix.cost;
				if (fix.report.trim()) fixReports.push(fix.report.trim());
				guidance = undefined;
				if (!fix.blocker) break; // re-review the fixed diff
				blocker = fix.blocker;
			}
			const why = blocker ?? `The fix budget (${budget} round${budget === 1 ? "" : "s"}) is spent and ${review.reviewer} still blocks.`;
			const ans = await opts.choose(
				`${review.reviewer} still blocks ${opts.repo}. How should the Quest continue?`,
				`${why}\n\nLatest ${review.reviewer} findings:\n${clipFindings(review.findings)}`,
				[ACCEPT, RETRY, STOP],
			);
			if (ans.approved && ans.choice === ACCEPT) {
				return {
					outcome: "accepted", reviewer: review.reviewer, fixRounds: rounds, members, cost, findings: review.findings, fixReports,
					note: `## Independent review: risk accepted by the user\n${review.reviewer} blocked this change${rounds ? ` after ${rounds} fix round${rounds > 1 ? "s" : ""}` : ""}. The user chose to keep it. Unresolved findings:\n\n${clipFindings(review.findings)}`,
				};
			}
			if (ans.approved && ans.choice === RETRY) {
				const g = await opts.answer(`Guidance for the next fix round (${opts.repo})`, `What should the Builder do about the ${review.reviewer} findings?`);
				if (!g.approved) throw new Error(`Stopped: no guidance given after the ${review.reviewer} review. Worktree preserved.\n\n${clipFindings(review.findings)}`);
				guidance = g.text?.trim() || undefined;
				budget = rounds + 1;
				continue;
			}
			throw new Error(`Stopped by the user after the ${review.reviewer} review blocked ${opts.repo}. Worktree preserved; nothing pushed.\n\n${clipFindings(review.findings)}`);
		}
	}
}
