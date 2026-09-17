/**
 * Unit tests for responsive member chip rendering in the Quest Log.
 *
 * Verify that:
 *  - Small parties render full individual chips when they fit.
 *  - Large parties collapse ONLY completed members into `✓N`, keeping active
 *    (running/pending/failed) members visible in full.
 *  - The counts-only summary is used only as a last resort when even the active
 *    chips overflow the width budget.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, memberSummary, formatMemberChips } from "../src/status.ts";
import type { QuestRecord } from "../src/persistence/quest-store.ts";

// Mock theme helper that returns plain text without ANSI codes for easier testing
function mockTheme() {
	return {
		fg: (_color: string, text: string) => text,
	};
}

test("visibleWidth strips ANSI escape codes", () => {
	const plain = "hello world";
	const colored = "\x1b[32mhello\x1b[0m \x1b[31mworld\x1b[0m";
	assert.equal(visibleWidth(plain), 11);
	assert.equal(visibleWidth(colored), 11);
});

test("visibleWidth handles no ANSI codes", () => {
	assert.equal(visibleWidth("test"), 4);
	assert.equal(visibleWidth(""), 0);
});

test("memberSummary shows counts for all non-zero statuses", () => {
	const members: QuestRecord["members"] = [
		{ name: "scout", status: "done", task: "explore", summary: "" },
		{ name: "delver", status: "done", task: "dig", summary: "" },
		{ name: "runner", status: "running", task: "run", summary: "" },
		{ name: "waiter", status: "pending", task: "wait", summary: "" },
		{ name: "crasher", status: "failed", task: "crash", summary: "" },
	];

	const theme = mockTheme();
	const result = memberSummary(members, theme);

	// Check structure: · 5 members · ✓2 ●1 ○1 ✗1
	assert.match(result, /^· 5 members · ✓2 ●1 ○1 ✗1$/);
});

test("memberSummary omits zero-count statuses", () => {
	const members: QuestRecord["members"] = [
		{ name: "scout", status: "done", task: "explore", summary: "" },
		{ name: "delver", status: "done", task: "dig", summary: "" },
		{ name: "runner", status: "running", task: "run", summary: "" },
	];

	const theme = mockTheme();
	const result = memberSummary(members, theme);

	// Only done and running should appear, no pending or failed
	assert.match(result, /^· 3 members · ✓2 ●1$/);
	assert.doesNotMatch(result, /○/);
	assert.doesNotMatch(result, /✗/);
});

test("memberSummary uses singular 'member' for count of 1", () => {
	const members: QuestRecord["members"] = [
		{ name: "solo", status: "done", task: "work", summary: "" },
	];

	const theme = mockTheme();
	const result = memberSummary(members, theme);
	assert.match(result, /^· 1 member · ✓1$/);
});

test("formatMemberChips returns empty string for zero members", () => {
	const record: QuestRecord = {
		id: "q1",
		title: "Empty Quest",
		brief: "Test quest",
		cwd: "/test",
		state: "running",
		members: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const theme = mockTheme();
	const result = formatMemberChips(record, theme, 100);
	assert.equal(result, "");
});

test("formatMemberChips always shows full chip for single member", () => {
	const record: QuestRecord = {
		id: "q1",
		title: "Solo Quest",
		brief: "Test quest",
		cwd: "/test",
		state: "running",
		members: [{ name: "lonewolf", status: "running", task: "work", summary: "" }],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const theme = mockTheme();
	// Even with zero budget, single member shows full chip
	const result = formatMemberChips(record, theme, 0);
	assert.match(result, /● lonewolf/);
});

test("formatMemberChips uses full chips when they fit the budget", () => {
	const record: QuestRecord = {
		id: "q1",
		title: "Small Party",
		brief: "Test quest",
		cwd: "/test",
		state: "running",
		members: [
			{ name: "scout", status: "done", task: "explore", summary: "" },
			{ name: "delver", status: "running", task: "dig", summary: "" },
		],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const theme = mockTheme();
	// Budget large enough for both chips (✓ scout  ● delver ~ 19 chars visible)
	const result = formatMemberChips(record, theme, 30);
	assert.match(result, /✓ scout/);
	assert.match(result, /● delver/);
	// Should NOT be summary format
	assert.doesNotMatch(result, /·.*members/);
});

test("formatMemberChips collapses completed but keeps active members when full chips exceed budget", () => {
	const record: QuestRecord = {
		id: "q1",
		title: "Large Party",
		brief: "Test quest",
		cwd: "/test",
		state: "running",
		members: [
			{ name: "scout", status: "done", task: "explore", summary: "" },
			{ name: "delver", status: "done", task: "dig", summary: "" },
			{ name: "runner", status: "running", task: "run", summary: "" },
		],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const theme = mockTheme();
	// Budget too small for full chips (✓ scout  ✓ delver  ● runner ~ 31 chars) but
	// roomy enough to collapse the 2 completed into ✓2 and still show the active runner.
	const result = formatMemberChips(record, theme, 20);
	assert.match(result, /✓2/); // completed collapsed to a count
	assert.match(result, /● runner/); // active member still shown in full
	assert.doesNotMatch(result, /scout|delver/); // completed names hidden
	assert.doesNotMatch(result, /·.*members/); // NOT the counts-only summary
});

test("formatMemberChips keeps active members visible on a large party (the ✓21 ●1 case)", () => {
	const record: QuestRecord = {
		id: "q1",
		title: "Big Party",
		brief: "Test quest",
		cwd: "/test",
		state: "running",
		members: [
			...Array.from({ length: 21 }, () => ({ name: "worker", status: "done" as const, task: "w", summary: "" })),
			{ name: "runner", status: "running" as const, task: "run", summary: "" },
		],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const theme = mockTheme();
	// Full chips for 22 members are far too wide, but the collapsed form keeps the
	// one active member visible — the visibility the old collapse-everything hid.
	const result = formatMemberChips(record, theme, 40);
	assert.match(result, /✓21/);
	assert.match(result, /● runner/);
	assert.doesNotMatch(result, /·.*members/);
});

test("formatMemberChips uses 6-member threshold when budget is undefined", () => {
	const smallParty: QuestRecord = {
		id: "q1",
		title: "Small Party",
		brief: "Test quest",
		cwd: "/test",
		state: "running",
		members: Array.from({ length: 5 }, (_, i) => ({
			name: `member${i}`,
			status: "done" as const,
			task: "work",
			summary: "",
		})),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const largeParty: QuestRecord = {
		id: "q2",
		title: "Large Party",
		brief: "Test quest",
		cwd: "/test",
		state: "running",
		members: Array.from({ length: 6 }, (_, i) => ({
			name: `member${i}`,
			status: "done" as const,
			task: "work",
			summary: "",
		})),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const theme = mockTheme();

	// 5 members: should use full chips
	const smallResult = formatMemberChips(smallParty, theme, undefined);
	assert.match(smallResult, /✓ member0/);
	assert.doesNotMatch(smallResult, /·.*members/);

	// 6 members (all completed): collapse into ✓6 (no active members to show)
	const largeResult = formatMemberChips(largeParty, theme, undefined);
	assert.match(largeResult, /^✓6$/);
	assert.doesNotMatch(largeResult, /member0/);
	assert.doesNotMatch(largeResult, /·.*members/);
});

test("formatMemberChips handles mixed statuses in summary correctly", () => {
	const record: QuestRecord = {
		id: "q1",
		title: "Mixed Party",
		brief: "Test quest",
		cwd: "/test",
		state: "running",
		members: [
			...Array.from({ length: 11 }, () => ({ name: "done", status: "done" as const, task: "done", summary: "" })),
			...Array.from({ length: 2 }, () => ({ name: "running", status: "running" as const, task: "run", summary: "" })),
		],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const theme = mockTheme();
	// Force summary with small budget
	const result = formatMemberChips(record, theme, 10);
	assert.match(result, /· 13 members · ✓11 ●2/);
});
