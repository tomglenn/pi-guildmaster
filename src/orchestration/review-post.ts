/**
 * What a review-Quest is allowed to post (Bug 1 fix).
 *
 * The party's review.md is a working document: it mixes internal analysis and notes
 * addressed to the user with the comment meant for the PR author. Only ONE delimited
 * block is ever posted, and the verdict is read from ONE unambiguous line — both
 * parsed from the CURRENT (possibly user-edited) text at approval time.
 *
 * Format:
 *   - exactly one line `Verdict: Approve | Request changes | Comment` (markdown bold tolerated);
 *   - exactly one block between {@link REVIEW_BLOCK_START} and {@link REVIEW_BLOCK_END}.
 *     Its contents, with one level of `>` blockquote stripped per line and trimmed, are the
 *     review body. Everything outside the block is never posted.
 *
 * Inline / line comments are NOT supported: only this single block is posted as the
 * review body. Anything ambiguous or missing is an error — there is never a fallback
 * to posting the whole file.
 *
 * Pure: no I/O, no runtime imports (type-only import below, so no import cycle).
 */

import type { ReviewVerdict } from "../execution/gh-tool.ts";

export type { ReviewVerdict };

export const REVIEW_BLOCK_START = "<!-- review-comment:start -->";
export const REVIEW_BLOCK_END = "<!-- review-comment:end -->";

/** A small, valid example of the postable format (parses with {@link extractPostableReview}). */
export const REVIEW_FORMAT_EXAMPLE = [
	"Verdict: Request changes",
	"",
	REVIEW_BLOCK_START,
	"Thanks for this. One blocking issue before merge:",
	"",
	"- `src/handler.ts:42` swallows the upstream error; please propagate it to the caller.",
	REVIEW_BLOCK_END,
].join("\n");

/** A line-anchored verdict label: `Verdict:`, `**Verdict:**`, `> Verdict:`, `_Verdict_:`. Prose does not match. */
const VERDICT_LINE = /^[ \t>*_]*verdict[*_ \t]*:/im;

const VERDICT_VALUES: ReadonlyMap<string, ReviewVerdict> = new Map<string, ReviewVerdict>([
	["approve", "approve"],
	["approved", "approve"],
	["request changes", "request-changes"],
	["requested changes", "request-changes"],
	["request-changes", "request-changes"],
	["comment", "comment"],
	["comments", "comment"],
]);

function countOf(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function parseVerdictLine(text: string): { verdict: ReviewVerdict } | { error: string } {
	const lines = text.split(/\r?\n/).filter((l) => VERDICT_LINE.test(l));
	if (lines.length === 0) {
		return { error: "no verdict line found — add exactly one line `Verdict: Approve | Request changes | Comment`" };
	}
	if (lines.length > 1) {
		return {
			error: `found ${lines.length} verdict lines (${lines.map((l) => `"${l.trim()}"`).join(", ")}) — keep exactly one`,
		};
	}
	const line = lines[0];
	const value = line
		.replace(VERDICT_LINE, "")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	const verdict = VERDICT_VALUES.get(value);
	if (!verdict) {
		return { error: `unrecognised verdict in "${line.trim()}" — use exactly Approve, Request changes or Comment` };
	}
	return { verdict };
}

function parseBody(text: string): { body: string } | { error: string } {
	const starts = countOf(text, REVIEW_BLOCK_START);
	const ends = countOf(text, REVIEW_BLOCK_END);
	if (starts !== 1 || ends !== 1) {
		return {
			error:
				`the review comment must be in exactly one ${REVIEW_BLOCK_START} … ${REVIEW_BLOCK_END} block ` +
				`(found ${starts} start marker(s) and ${ends} end marker(s))`,
		};
	}
	const startIdx = text.indexOf(REVIEW_BLOCK_START);
	const endIdx = text.indexOf(REVIEW_BLOCK_END);
	if (endIdx < startIdx) {
		return { error: `${REVIEW_BLOCK_END} comes before ${REVIEW_BLOCK_START} — put the comment between start and end` };
	}
	const body = text
		.slice(startIdx + REVIEW_BLOCK_START.length, endIdx)
		.split(/\r?\n/)
		.map((l) => l.replace(/^>[ \t]?/, ""))
		.join("\n")
		.trim();
	if (!body) return { error: "the review comment block is empty" };
	return { body };
}

/**
 * Extract the verdict and the ONLY postable body from review text. Returns an error
 * (never a fallback) when either cannot be determined unambiguously.
 */
export function extractPostableReview(text: string): { verdict: ReviewVerdict; body: string } | { error: string } {
	const v = parseVerdictLine(text);
	const b = parseBody(text);
	if ("error" in v || "error" in b) {
		const errors: string[] = [];
		if ("error" in v) errors.push(v.error);
		if ("error" in b) errors.push(b.error);
		return { error: errors.join("; ") };
	}
	return { verdict: v.verdict, body: b.body };
}
