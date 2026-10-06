/**
 * Regression tests for Bug 1: a review-mode PR Quest's /approve posted the WRONG event
 * (the verdict parsed once from the party's original report, ignoring the user's edit)
 * and the WRONG body (the whole review.md, internal notes included).
 *
 * The fix: extractPostableReview parses the CURRENT text for exactly one verdict line and
 * exactly one delimited comment block — and refuses (never falls back) when either is
 * ambiguous or missing. /approve confirms that snapshot and the post uses it verbatim.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildReviewConfirm } from "../src/approvals-ui.ts";
import type { GuildmasterConfig } from "../src/config.ts";
import { reviewFlag } from "../src/execution/gh-tool.ts";
import { ApprovalManager } from "../src/orchestration/approvals.ts";
import { buildSystemPrompt } from "../src/orchestration/party-leader.ts";
import {
	extractPostableReview,
	REVIEW_BLOCK_END,
	REVIEW_BLOCK_START,
	REVIEW_FORMAT_EXAMPLE,
} from "../src/orchestration/review-post.ts";

const S = REVIEW_BLOCK_START;
const E = REVIEW_BLOCK_END;

// Shaped like the real incident's review.md: internal notes addressed to the user, then
// the quoted comment for the PR author, then a trailing verdict line.
function draft(verdictLine: string): string {
	return [
		"# Re-review: PR #1957",
		"",
		"## 1. What I compared against",
		"",
		"- Your earlier feedback isn't a formal review. You are GitHub tomglenn.",
		"",
		"| # | Request | Verdict | Evidence |",
		"|---|---|---|---|",
		"| 1 | Fix bug | Resolved | x.go:1 |",
		"",
		"## 6. Draft review comment",
		"",
		S,
		"> Thanks for all the work here.",
		">",
		"> Approving. Nothing blocks (`useMyAssignments.ts:153`).",
		E,
		"",
		"## 7. What I couldn't verify",
		"- Load severity: not measured.",
		"",
		verdictLine,
	].join("\n");
}

function ok(text: string): { verdict: string; body: string } {
	const r = extractPostableReview(text);
	if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
	return r;
}

function err(text: string): string {
	const r = extractPostableReview(text);
	if (!("error" in r)) assert.fail(`expected an error, got ${JSON.stringify(r)}`);
	return r.error;
}

test("an edited verdict (Request changes → Approve) is honoured", () => {
	const original = draft("Verdict: Request changes");
	assert.equal(ok(original).verdict, "request-changes");
	const edited = original.replace("Verdict: Request changes", "Verdict: Approve");
	assert.equal(ok(edited).verdict, "approve");
});

test("only the block is the body: no internal notes, no Verdict line, '>' stripped", () => {
	const { body } = ok(draft("Verdict: Approve"));
	assert.equal(body, "Thanks for all the work here.\n\nApproving. Nothing blocks (`useMyAssignments.ts:153`).");
	assert.doesNotMatch(body, /tomglenn/);
	assert.doesNotMatch(body, /couldn't verify/);
	assert.doesNotMatch(body, /Verdict/);
	assert.doesNotMatch(body, /review-comment/);
	assert.ok(!body.split("\n").some((l) => l.startsWith(">")));
});

test("strips only ONE blockquote level per line", () => {
	const { body } = ok(`Verdict: Comment\n${S}\n> outer\n> > nested quote\n${E}`);
	assert.equal(body, "outer\n> nested quote");
});

test("error: no markers (never falls back to the whole file)", () => {
	const text = draft("Verdict: Approve").replace(S, "").replace(E, "");
	assert.match(err(text), /found 0 start marker\(s\) and 0 end marker\(s\)/);
});

test("error: duplicate START marker", () => {
	const text = draft("Verdict: Approve").replace(S, `${S}\n${S}`);
	assert.match(err(text), /found 2 start marker\(s\) and 1 end marker\(s\)/);
});

test("error: END before START", () => {
	assert.match(err(`Verdict: Approve\n${E}\nbody\n${S}`), /comes before/);
});

test("error: empty block (whitespace and bare '>' only)", () => {
	assert.match(err(`Verdict: Approve\n${S}\n>\n  \n>\n${E}`), /empty/);
});

test("error: no verdict line", () => {
	assert.match(err(draft("")), /no verdict line/);
});

test("error: two conflicting verdict lines", () => {
	const e = err(draft("Verdict: Approve\nVerdict: Request changes"));
	assert.match(e, /found 2 verdict lines/);
});

test("error: two identical verdict lines", () => {
	assert.match(err(draft("Verdict: Approve\nVerdict: Approve")), /found 2 verdict lines/);
});

test("error: unrecognised verdict token quotes the line", () => {
	const e = err(draft("Verdict: Approve, with follow-ups"));
	assert.match(e, /unrecognised verdict/);
	assert.match(e, /"Verdict: Approve, with follow-ups"/);
});

test("both problems are reported together", () => {
	const e = err("no verdict and no block here");
	assert.match(e, /no verdict line/);
	assert.match(e, /start marker/);
});

test("prose like 'the verdict is approve' does not count as a verdict line", () => {
	const text = draft("Verdict: Request changes").replace("## 7.", "In short, the verdict is approve: ship it.\n\n## 7.");
	assert.equal(ok(text).verdict, "request-changes");
	assert.match(err(draft("").replace("## 7.", "the verdict is approve\n\n## 7.")), /no verdict line/);
});

test("markdown bold verdict lines work", () => {
	assert.equal(ok(draft("**Verdict:** Approve")).verdict, "approve");
	assert.equal(ok(draft("**Verdict**: Request changes")).verdict, "request-changes");
	assert.equal(ok(draft("> **Verdict:** _Comment_")).verdict, "comment");
});

test("verdict token mapping", () => {
	const cases: Array<[string, string]> = [
		["approve", "approve"],
		["Approved", "approve"],
		["Request changes", "request-changes"],
		["requested changes", "request-changes"],
		["request-changes", "request-changes"],
		["Comment", "comment"],
		["comments", "comment"],
	];
	for (const [token, expected] of cases) assert.equal(ok(draft(`Verdict: ${token}`)).verdict, expected, token);
});

test("reviewFlag maps every verdict to its gh flag", () => {
	assert.equal(reviewFlag("approve"), "--approve");
	assert.equal(reviewFlag("request-changes"), "--request-changes");
	assert.equal(reviewFlag("comment"), "--comment");
});

test("the /approve confirm prompt itself carries the exact event and the FULL body", () => {
	// A long body: nothing may be truncated or deferred to a separate card.
	const body = ["Thanks for all the work here.", "", ...Array.from({ length: 200 }, (_, i) => `Line ${i}: \`file${i}.ts:${i}\` details`), "LAST LINE"].join("\n");
	const { title, message } = buildReviewConfirm("gh pr review 1957 --repo grafana/grafana-pathfinder-app", "request-changes", body);
	const text = `${title}\n${message}`;
	assert.ok(message.includes(body), "full body, verbatim and untruncated");
	assert.ok(text.includes("gh pr review 1957 --repo grafana/grafana-pathfinder-app --request-changes"), "the exact gh pr review line");
	assert.match(title, /REQUEST_CHANGES/);
	assert.match(title, /--request-changes/);
	assert.match(message, /Event: REQUEST_CHANGES/);
	assert.match(message, /Inline comments are not supported/);
	assert.doesNotMatch(text, /shown above/);
});

test("buildReviewConfirm maps each verdict to its event and flag", () => {
	const cases: Array<["approve" | "request-changes" | "comment", string, string]> = [
		["approve", "APPROVE", "--approve"],
		["request-changes", "REQUEST_CHANGES", "--request-changes"],
		["comment", "COMMENT", "--comment"],
	];
	for (const [verdict, event, flag] of cases) {
		const { title, message } = buildReviewConfirm(undefined, verdict, "LGTM");
		assert.ok(title.includes(`${event} (${flag})`), title);
		assert.ok(message.includes(`Event: ${event}\n`), message);
		assert.ok(message.includes(`Command: gh pr review ${flag}\n`), message);
		assert.ok(message.includes("\nLGTM\n"), message);
	}
});

test("REVIEW_FORMAT_EXAMPLE parses", () => {
	const r = ok(REVIEW_FORMAT_EXAMPLE);
	assert.equal(r.verdict, "request-changes");
	assert.ok(r.body.length > 0);
	assert.ok(REVIEW_FORMAT_EXAMPLE.includes(S) && REVIEW_FORMAT_EXAMPLE.includes(E));
});

test("review-mode leader prompt specifies the markers and the Verdict line", () => {
	const prompt = (reviewMode: boolean) =>
		buildSystemPrompt("base", [], {} as GuildmasterConfig, false, [], undefined, undefined, reviewMode, false, "<<<R>>>", "<<<E>>>", undefined, false);
	const review = prompt(true);
	assert.ok(review.includes(S), "start marker");
	assert.ok(review.includes(E), "end marker");
	assert.match(review, /Verdict:/);
	assert.match(review, /Scribe/);
	assert.ok(!prompt(false).includes(S), "non-review prompts are unchanged");
});

test("approvals: postsReview persists and answer() carries the confirmed review snapshot", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-review-post-"));
	const m = new ApprovalManager(dir);
	const p = m.ask({ kind: "review-artifact", postsReview: true, title: "Sense-check", artifactPath: "/tmp/review.md", operation: "gh pr review 1" });
	const id = m.list()[0].id;
	assert.equal(m.get(id)?.postsReview, true);
	const persisted = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf-8"));
	assert.equal(persisted.postsReview, true);
	m.answer(id, { action: "approve", approved: true, review: { verdict: "approve", body: "LGTM" } });
	const ans = await p;
	assert.deepEqual(ans.review, { verdict: "approve", body: "LGTM" });
});
