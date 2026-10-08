import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, dynamicDispatchBudget } from "../src/orchestration/party-leader.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createBuilderGuildmate } from "../src/orchestration/fast-write.ts";
import { parseChecksLine } from "../src/orchestration/checks-line.ts";
import { scanDiff, scanPrText } from "../src/orchestration/publish-scan.ts";

const prompt = (legacy = false, interactive = true) => buildSystemPrompt("base", [createBuilderGuildmate()], DEFAULT_CONFIG, true, [], undefined, undefined, false, false, "<<<R>>>", "<<<E>>>", undefined, interactive, legacy);

test("dynamic write leader chooses the party; legacy pipeline is opt-in", () => {
	assert.match(prompt(), /smallest useful party/);
	assert.match(prompt(), /builder to own editing, tests, and fixes/);
	assert.doesNotMatch(prompt(), /THEN dispatch `smith`/);
	assert.doesNotMatch(prompt(), /inquisitor attack the PLAN/);
	assert.match(prompt(true), /THEN dispatch `smith`/);
	assert.ok(dynamicDispatchBudget(1) >= 12, "the budget is a runaway guard, not a cap on iterating");
});

test("the party owns its checks and its own adversarial review; Guildmaster does not", () => {
	for (const p of [prompt(), prompt(true)]) {
		assert.match(p, /not done while a\s+check fails/i);
		assert.match(p, /warden[\s\S]*attack the ACTUAL diff/);
		assert.match(p, /including the last one, goes back\s+to the SAME reviewer/);
		assert.match(p, /CHECKS: PASS/);
		assert.match(p, /public draft PR/);
		assert.doesNotMatch(p, /harness (checks|separately|enforces)/i);
	}
	assert.match(prompt(), /request_user[\s\S]*noteOptions/, "the leader can offer a one-step send-back with guidance");
	assert.match(createBuilderGuildmate().systemPrompt, /CHECKS: PASS/);
	assert.match(createBuilderGuildmate().systemPrompt, /until every check passes/);
	assert.doesNotMatch(createBuilderGuildmate().systemPrompt, /harness/);
});

test("the CHECKS line is read from the party's report and stripped from the PR body", () => {
	const pass = parseChecksLine("# Title\n\nBody\n\nCHECKS: PASS — npm test (exit 0)");
	assert.deepEqual([pass.status, pass.detail, pass.body, pass.stated], ["pass", "npm test (exit 0)", "# Title\n\nBody", true]);
	assert.equal(parseChecksLine("x\n**CHECKS: FAIL** - npm test (exit 1)").status, "fail");
	assert.equal(parseChecksLine("CHECKS: FAIL — first\nCHECKS: PASS — after fixing").status, "pass", "the last line wins");
	const missing = parseChecksLine("# Title\nNo line");
	assert.deepEqual([missing.status, missing.stated], ["none", false]);
});

test("the publish scan flags secrets and chat links in ADDED lines and PR text, not removed lines", () => {
	const diff = [
		"+++ b/src/config.js",
		"@@ -1,2 +1,3 @@",
		" const a = 1;",
		"-const old = 'AKIAABCDEFGHIJKLMNOP';",
		"+const key = 'AKIAABCDEFGHIJKLMNOP';",
	].join("\n");
	assert.deepEqual(scanDiff(diff), [{ kind: "AWS access key", where: "src/config.js:2" }]);
	assert.deepEqual(scanDiff("+++ b/a.js\n@@ -1 +1 @@\n-token = 'ghp_" + "a".repeat(36) + "'"), [], "removing a secret is fine");
	assert.deepEqual(scanPrText("Fix", "See https://acme.slack.com/archives/C0123ABCD/p1"), [{ kind: "Slack message link", where: "PR body line 1" }]);
	assert.deepEqual(scanPrText("Add cue tags", "Adds `tags` to cueSchema.\npassword field docs"), []);
});
