import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, dynamicDispatchBudget } from "../src/orchestration/party-leader.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createBuilderGuildmate } from "../src/orchestration/fast-write.ts";
import { evaluateVerification, checkResults, unverifiedReason } from "../src/orchestration/verification.ts";
import { requiredReviewer, reviewPassed } from "../src/orchestration/write-review.ts";
import type { QuestMember } from "../src/persistence/quest-store.ts";

const prompt = (legacy = false) => buildSystemPrompt("base", [createBuilderGuildmate()], DEFAULT_CONFIG, true, [], undefined, undefined, false, false, "<<<R>>>", "<<<E>>>", undefined, false, legacy);

test("dynamic write leader chooses the party; legacy pipeline is opt-in", () => {
	assert.match(prompt(), /smallest useful party/);
	assert.match(prompt(), /builder to own editing, tests, and fixes/);
	assert.doesNotMatch(prompt(), /THEN dispatch `smith`/);
	assert.doesNotMatch(prompt(), /inquisitor attack the PLAN/);
	assert.match(prompt(true), /THEN dispatch `smith`/);
	assert.equal(dynamicDispatchBudget(1), 6);
	assert.equal(dynamicDispatchBudget(2), 10);
});

test("verification uses observed exit codes, not final prose", () => {
	const member = (checks?: QuestMember["checks"]): QuestMember => ({ name: "builder", task: "test", status: "done", checks });
	assert.equal(evaluateVerification([member()]).state, "unverified");
	assert.equal(evaluateVerification([member([{ command: "npm test", exitCode: 1 }])]).state, "failed");
	assert.equal(evaluateVerification([member([{ command: "npm test", exitCode: 1 }, { command: "npm test", exitCode: 0 }])]).state, "verified");
	assert.equal(evaluateVerification([member([{ command: "npm test" }])]).state, "failed");
	assert.deepEqual(checkResults([{ command: "git diff HEAD", exitCode: 0 }, { command: "npm test", exitCode: 0 }, { command: "npm test || true", exitCode: 0 }]), [{ command: "npm test", exitCode: 0 }, { command: "npm test || true", exitCode: 0, masked: true }]);
	assert.equal(evaluateVerification([{ ...member([{ command: "npm test", exitCode: 0 }]), repo: "one" }], ["one", "two"]).state, "unverified");
});

test("a chained check is recorded as masked: never credited, and the unverified status says why", () => {
	const member = (checks?: QuestMember["checks"]): QuestMember => ({ name: "builder", task: "test", status: "done", checks });
	// The E2E failure: the builder ran the failing test chained with echo, which exits 0.
	const checks = checkResults([{ command: 'cd /wt && npm test 2>&1; echo "EXIT=$?"', exitCode: 0 }]);
	assert.equal(checks.length, 1);
	assert.equal(checks[0].masked, true);
	const v = evaluateVerification([member(checks)]);
	assert.equal(v.state, "unverified");
	assert.equal(v.masked.length, 1);
	assert.match(unverifiedReason(v.masked), /chained with ';' or '\|'.*npm test 2>&1; echo/);
	assert.match(unverifiedReason([]), /No observed passing verification checks/);
	// A masked check never upgrades or downgrades real results.
	assert.equal(evaluateVerification([member([...checks, { command: "npm test", exitCode: 0 }])]).state, "verified");
	assert.equal(evaluateVerification([member([...checks, { command: "npm test", exitCode: 1 }])]).state, "failed");
	// Redirects and && do not mask an exit code.
	assert.deepEqual(checkResults([{ command: "npm test 2>&1", exitCode: 1 }, { command: "cd x && npm test &>out.log", exitCode: 1 }]), [{ command: "npm test 2>&1", exitCode: 1 }, { command: "cd x && npm test &>out.log", exitCode: 1 }]);
	// Builder is told to run plain checks.
	assert.match(createBuilderGuildmate().systemPrompt, /ONE plain command/);
});

test("post-diff risk review is independent and fail-closed", () => {
	assert.equal(requiredReviewer("Add cue hint", ["src/cue.js"], "+  hint: {type: 'string'}"), undefined);
	assert.equal(requiredReviewer("Add hint", ["src/auth/session.ts"], "+  hint: true"), "warden");
	assert.equal(requiredReviewer("Change dependencies", ["package.json"], "+  version: 1"), "inquisitor");
	assert.equal(requiredReviewer("Add migration", ["db/migrations/001.sql"], ""), "inquisitor");
	assert.equal(reviewPassed("VERDICT: PASS\nNo material findings"), true);
	assert.equal(reviewPassed("Looks fine"), false);
	assert.equal(reviewPassed("VERDICT: PASS\nVERDICT: BLOCK"), false);
});
