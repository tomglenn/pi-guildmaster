/**
 * Tests for PR feedback ingestion: fetching + normalizing review threads, bot vs
 * human separation, resolved-thread filtering, failing-check parsing, and the
 * honest "nothing actionable" brief. `gh` is mocked; no network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type GhRunner,
	formatFeedbackBrief,
	gatherPrFeedback,
	isBotLogin,
} from "../src/orchestration/pr-feedback.ts";

const META = JSON.stringify({
	number: 1942,
	url: "https://github.com/grafana/grafana-pathfinder-app/pull/1942",
	title: "Fix guided tour progress bar",
	body: "body",
	headRefName: "guildmaster/fix-guided-tour-1935",
	isCrossRepository: false,
	state: "OPEN",
});

const GRAPHQL = JSON.stringify({
	data: {
		repository: {
			pullRequest: {
				reviewThreads: {
					nodes: [
						{ id: "T_human", isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 111, author: { login: "Jayclifford345" }, body: "please rename this", path: "a.ts", line: 10 }] } },
						{ id: "T_resolved", isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 222, author: { login: "Jayclifford345" }, body: "RESOLVED already", path: "a.ts", line: 1 }] } },
						{ id: "T_bot", isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 333, author: { login: "cursor[bot]" }, body: "<!--meta-->bug here<div>x</div>", path: "b.ts", line: 5 }] } },
					],
				},
				reviews: {
					nodes: [
						{ author: { login: "Jayclifford345" }, state: "CHANGES_REQUESTED", body: "needs work overall" },
						{ author: { login: "cursor[bot]" }, state: "COMMENTED", body: "bot summary noise" },
					],
				},
			},
		},
	},
});

const CHECKS = JSON.stringify({
	statusCheckRollup: [
		{ __typename: "CheckRun", name: "Lint", conclusion: "SUCCESS" },
		{ __typename: "CheckRun", name: "Test", conclusion: "FAILURE", detailsUrl: "http://x" },
		{ __typename: "StatusContext", context: "ci/other", state: "ERROR", targetUrl: "http://y" },
	],
});

function mockGh(): GhRunner {
	return (args) => {
		if (args.includes("graphql")) return GRAPHQL;
		if (args.includes("statusCheckRollup")) return CHECKS;
		if (args[0] === "pr" && args[1] === "view") return META;
		throw new Error(`unexpected gh call: ${args.join(" ")}`);
	};
}

test("isBotLogin recognizes bots and [bot] suffix", () => {
	assert.ok(isBotLogin("cursor[bot]"));
	assert.ok(isBotLogin("github-actions[bot]"));
	assert.ok(isBotLogin("some-random[bot]"));
	assert.ok(!isBotLogin("Jayclifford345"));
	assert.ok(!isBotLogin(undefined));
});

test("gatherPrFeedback splits human/bot, drops resolved threads, counts actionable", () => {
	const fb = gatherPrFeedback({ number: "1942", slug: "grafana/grafana-pathfinder-app" }, "/tmp", mockGh());

	assert.equal(fb.metadata.number, 1942);
	assert.equal(fb.metadata.headRefName, "guildmaster/fix-guided-tour-1935");

	// One unresolved human thread; the resolved one is dropped.
	assert.equal(fb.humanThreads.length, 1);
	assert.equal(fb.humanThreads[0].author, "Jayclifford345");
	assert.ok(fb.humanThreads.every((t) => !t.body.includes("RESOLVED")));
	// Thread + comment ids are captured for later reply/resolve.
	assert.equal(fb.humanThreads[0].threadId, "T_human");
	assert.equal(fb.humanThreads[0].commentId, 111);
	assert.equal(fb.botThreads[0].threadId, "T_bot");

	// One unresolved bot thread.
	assert.equal(fb.botThreads.length, 1);
	assert.equal(fb.botThreads[0].author, "cursor[bot]");

	// Bot review body filtered; human change-request kept.
	assert.equal(fb.humanReviews.length, 1);
	assert.equal(fb.humanReviews[0].reviewState, "CHANGES_REQUESTED");

	// Two failing checks (FAILURE + ERROR), SUCCESS ignored.
	assert.equal(fb.failingChecks.length, 2);

	// actionable = 1 human thread + 1 bot thread + 2 failing + 1 change-request
	assert.equal(fb.actionableCount, 5);
});

test("formatFeedbackBrief renders sections and strips bot HTML noise", () => {
	const fb = gatherPrFeedback({ number: "1942", slug: "grafana/grafana-pathfinder-app" }, "/tmp", mockGh());
	const brief = formatFeedbackBrief(fb);
	assert.match(brief, /Failing CI checks \(2\)/);
	assert.match(brief, /Unresolved human review comments \(1\)/);
	assert.match(brief, /Automated bot findings \(1\)/);
	assert.match(brief, /Jayclifford345/);
	assert.doesNotMatch(brief, /RESOLVED already/); // resolved thread never shown
	assert.doesNotMatch(brief, /<!--/); // HTML comment stripped
	assert.doesNotMatch(brief, /<div>/); // HTML tag stripped
});

test("formatFeedbackBrief is honest when nothing is actionable", () => {
	const emptyGh: GhRunner = (args) => {
		if (args.includes("graphql")) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } });
		if (args.includes("statusCheckRollup")) return JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "Lint", conclusion: "SUCCESS" }] });
		return META;
	};
	const fb = gatherPrFeedback({ number: "1941", slug: "grafana/grafana-pathfinder-app" }, "/tmp", emptyGh);
	assert.equal(fb.actionableCount, 0);
	const brief = formatFeedbackBrief(fb);
	assert.match(brief, /No actionable feedback found/);
	assert.match(brief, /Do NOT invent changes/);
});
