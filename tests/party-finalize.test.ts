/**
 * Regression tests for the Party finalization gate.
 *
 * These pin the fix for the incident where a Party run that ran out of budget
 * mid-investigation had its half-finished reasoning promoted into a "completed"
 * Quest report. A report must now be accepted ONLY when the leader deliberately
 * finalized it (emitted the <<<REPORT>>> marker) AND the run ended normally.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractReport, finalizePartyOutcome } from "../src/orchestration/party-leader.ts";

test("extractReport reports finalized=false when no marker is present", () => {
	const r = extractReport("just some thinking, no marker here");
	assert.equal(r.finalized, false);
	assert.equal(r.body, "just some thinking, no marker here");
});

test("extractReport extracts the marked body and reports finalized=true", () => {
	const r = extractReport("preamble\n<<<REPORT>>>\n# Title\nbody text\n<<<END>>>\ntrailing");
	assert.equal(r.finalized, true);
	assert.equal(r.body, "# Title\nbody text");
});

test("extractReport is robust to delimiter tokens quoted inside the body", () => {
	// The regression: a report ABOUT this machinery quotes the tokens; first-open/
	// last-close pairing keeps the outermost wrapper so the body is preserved whole.
	const text = "thinking\n<<<REPORT>>>\nThe extractor matches `<<<REPORT>>>` and `<<<END>>>` tokens.\n<<<END>>>";
	const r = extractReport(text);
	assert.equal(r.finalized, true);
	assert.equal(r.body, "The extractor matches `<<<REPORT>>>` and `<<<END>>>` tokens.");
});

test("extractReport with a per-run tag ignores generic token mentions before it", () => {
	const text = "junk <<<REPORT>>> not real\n<<<REPORT:abcd1234>>>\nreal body mentioning <<<REPORT>>>\n<<<END:abcd1234>>>";
	const r = extractReport(text, "<<<REPORT:abcd1234>>>", "<<<END:abcd1234>>>");
	assert.equal(r.finalized, true);
	assert.equal(r.body, "real body mentioning <<<REPORT>>>");
});

// The incident itself: mid-stream reasoning, run cut off (aborted). Must NOT complete.
test("incident: mid-stream reasoning + aborted is a failure, not a report", () => {
	const midStream = "Perfect! This is the critical insight.\nLet me refine the plan with the Architect based on this evidence:";
	const out = finalizePartyOutcome({ lastText: midStream, stopReason: "aborted" });
	assert.equal(out.report, "");
	assert.match(out.error ?? "", /without finalizing/);
});

test("natural stop but no marker still fails (no report is trusted unmarked)", () => {
	const out = finalizePartyOutcome({ lastText: "I think I'm done but forgot the marker.", stopReason: "endTurn" });
	assert.equal(out.report, "");
	assert.match(out.error ?? "", /no report delimiter/);
});

test("a deliberately finalized report completes", () => {
	const out = finalizePartyOutcome({
		lastText: "thinking...\n<<<REPORT>>>\n# Fix\nAll done.\n<<<END>>>",
		stopReason: "endTurn",
	});
	assert.equal(out.error, undefined);
	assert.equal(out.report, "# Fix\nAll done.");
});

test("explicit FAILED signal is an honest failure with its reason", () => {
	const out = finalizePartyOutcome({
		lastText: "<<<REPORT>>>\nFAILED: could not acquire the PR\n<<<END>>>",
		stopReason: "endTurn",
	});
	assert.equal(out.report, "");
	assert.equal(out.error, "could not acquire the PR");
});

test("a transport/model error is a failure even with a marked body", () => {
	const out = finalizePartyOutcome({
		lastText: "<<<REPORT>>>\n# ok\n<<<END>>>",
		stopReason: "error",
		error: "500 from provider",
	});
	assert.equal(out.report, "");
	assert.equal(out.error, "500 from provider");
});

test("an empty finalized report fails rather than completing blank", () => {
	const out = finalizePartyOutcome({ lastText: "<<<REPORT>>>\n\n<<<END>>>", stopReason: "endTurn" });
	assert.equal(out.report, "");
	assert.match(out.error ?? "", /empty report/);
});
