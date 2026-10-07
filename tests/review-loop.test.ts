/**
 * A Warden/Inquisitor BLOCK must feed a fix round, not end the Quest. Regression for the
 * E2E run where Warden blocked the final diff and the Quest simply failed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCEPT, RETRY, STOP, runReviewLoop, type FixResult } from "../src/orchestration/review-loop.ts";
import type { ReviewOutcome } from "../src/orchestration/write-review.ts";
import type { UserAnswer } from "../src/orchestration/approvals.ts";

const m = (name: string) => ({ name, task: name, status: "done" as const });
const block = (f = "XSS bypass at src/cue.js:12\nVERDICT: BLOCK"): ReviewOutcome => ({ verdict: "block", reviewer: "warden", member: m("warden"), cost: 1, findings: f });
const pass: ReviewOutcome = { verdict: "pass", reviewer: "warden", member: m("warden"), cost: 1, findings: "VERDICT: PASS" };
const fixed = (blocker?: string): FixResult => ({ member: m("builder"), cost: 2, report: "done", blocker });

function harness(reviews: ReviewOutcome[], fixes: FixResult[], answers: UserAnswer[] = []) {
	const log: string[] = [];
	const prompts: string[] = [];
	return {
		log, prompts,
		run: (maxFixRounds?: number) => runReviewLoop({
			repo: "fixture", brief: "BRIEF", maxFixRounds,
			review: async () => { log.push("review"); return reviews.shift() ?? pass; },
			fix: async (prompt) => { log.push("fix"); prompts.push(prompt); return fixes.shift() ?? fixed(); },
			choose: async (_t, description) => { log.push(`choose:${description.split("\n")[0]}`); return answers.shift() ?? { action: "deny", approved: false }; },
			answer: async () => { log.push("answer"); return answers.shift() ?? { action: "deny", approved: false }; },
		}),
	};
}

test("a block sends the findings to a fix round and passes on re-review", async () => {
	const h = harness([block(), pass], [fixed()]);
	const r = await h.run();
	assert.equal(r.outcome, "passed");
	assert.equal(r.fixRounds, 1);
	assert.deepEqual(h.log, ["review", "fix", "review"]);
	assert.match(h.prompts[0], /XSS bypass at src\/cue\.js:12/);
	assert.match(h.prompts[0], /BRIEF/);
	assert.match(h.prompts[0], /CONFLICT:/);
	assert.match(r.note ?? "", /After 1 fix round, it passed/);
	assert.equal(r.members.length, 3);
	assert.equal(r.cost, 4);
});

test("no review needed: skipped with no members", async () => {
	const h = harness([{ verdict: "skipped", cost: 0 }], []);
	assert.equal((await h.run()).outcome, "skipped");
});

test("the fix budget is bounded, then the user decides (accept keeps the findings)", async () => {
	const h = harness([block(), block(), block("still bad\nVERDICT: BLOCK")], [fixed(), fixed()], [{ action: "choose", approved: true, choice: ACCEPT }]);
	const r = await h.run(2);
	assert.deepEqual(h.log, ["review", "fix", "review", "fix", "review", "choose:The fix budget (2 rounds) is spent and warden still blocks."]);
	assert.equal(r.outcome, "accepted");
	assert.match(r.note ?? "", /risk accepted by the user[\s\S]*still bad/);
});

test("a brief conflict goes straight to the user instead of looping", async () => {
	const h = harness([block()], [fixed("The Builder reports that a finding conflicts with the brief: no other escaping")], [{ action: "choose", approved: true, choice: STOP }]);
	await assert.rejects(() => h.run(), /Stopped by the user[\s\S]*XSS bypass/);
	assert.deepEqual(h.log, ["review", "fix", "choose:The Builder reports that a finding conflicts with the brief: no other escaping"]);
});

test("retry with guidance runs one more fix round carrying the guidance", async () => {
	const h = harness([block(), pass], [fixed("CONFLICT"), fixed()], [
		{ action: "choose", approved: true, choice: RETRY },
		{ action: "answer", approved: true, text: "Use HTML entity escaping and update the test" },
	]);
	const r = await h.run();
	assert.equal(r.outcome, "passed");
	assert.deepEqual(h.log, ["review", "fix", "choose:CONFLICT", "answer", "fix", "review"]);
	assert.match(h.prompts[1], /User guidance for this round[\s\S]*HTML entity escaping/);
});

test("an abort or declined choice stops (fail-closed), worktree preserved", async () => {
	const h = harness([block()], [fixed("checks failed")]);
	await assert.rejects(() => h.run(), /Worktree preserved; nothing pushed/);
});
