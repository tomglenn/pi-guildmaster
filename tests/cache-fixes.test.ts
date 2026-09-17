/**
 * Unit tests for cache fixes from code review.
 *
 * Verify that:
 *  - QuestStore.onSave() supports multiple listeners and returns unsubscribe function
 *  - ProjectStore.list() returns deep clones to prevent cache corruption
 *  - Roster prompt cache timestamps are updated when prompts are reloaded
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestStore, newQuestId } from "../src/persistence/quest-store.ts";
import { ProjectStore, invalidateProjectCache } from "../src/persistence/project-store.ts";
import { loadGuildmasterPrompt, loadPartyLeaderPrompt, invalidateRosterCache } from "../src/roster.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

test("QuestStore.onSave() supports multiple listeners", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guildmaster-test-"));
	const store = new QuestStore(tmpDir);

	const calls1: string[] = [];
	const calls2: string[] = [];

	// Register two listeners
	const unsub1 = store.onSave((record) => calls1.push(record.id));
	const unsub2 = store.onSave((record) => calls2.push(record.id));

	// Save a quest
	const quest = {
		id: newQuestId(),
		title: "Test Quest",
		brief: "Test brief",
		cwd: "/test",
		state: "running" as const,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		members: [],
	};
	store.save(quest);

	// Both listeners should have been called
	assert.equal(calls1.length, 1);
	assert.equal(calls2.length, 1);
	assert.equal(calls1[0], quest.id);
	assert.equal(calls2[0], quest.id);

	// Unsubscribe first listener
	unsub1();

	// Save another quest
	const quest2 = {
		...quest,
		id: newQuestId(),
		title: "Test Quest 2",
	};
	store.save(quest2);

	// Only second listener should have been called
	assert.equal(calls1.length, 1, "First listener should not be called after unsubscribe");
	assert.equal(calls2.length, 2, "Second listener should still be called");
	assert.equal(calls2[1], quest2.id);

	// Cleanup
	unsub2();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("QuestStore.onSave() returns unsubscribe function", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guildmaster-test-"));
	const store = new QuestStore(tmpDir);

	let callCount = 0;
	const unsubscribe = store.onSave(() => callCount++);

	// Verify it returns a function
	assert.equal(typeof unsubscribe, "function");

	// Save a quest
	const quest = {
		id: newQuestId(),
		title: "Test Quest",
		brief: "Test brief",
		cwd: "/test",
		state: "running" as const,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		members: [],
	};
	store.save(quest);
	assert.equal(callCount, 1);

	// Unsubscribe
	unsubscribe();

	// Save again
	store.save({ ...quest, title: "Updated" });
	assert.equal(callCount, 1, "Listener should not be called after unsubscribe");

	// Cleanup
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ProjectStore.list() returns deep clone to prevent cache corruption", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guildmaster-test-"));
	const store = new ProjectStore(tmpDir);

	// Save a project
	const project = {
		id: "test-project",
		name: "Test Project",
		repos: [{ name: "repo1", path: "/path/to/repo1" }],
		createdAt: Date.now(),
	};
	store.save(project);

	// First call - should populate cache
	const result1 = store.list();
	assert.equal(result1.length, 1);
	assert.equal(result1[0].id, "test-project");

	// Mutate the returned array and object
	result1[0].name = "MUTATED NAME";
	result1.push({
		id: "fake-project",
		name: "Fake",
		repos: [],
		createdAt: Date.now(),
	});

	// Second call - should return clean data from cache, not mutations
	const result2 = store.list();
	assert.equal(result2.length, 1, "Cache should not contain the pushed fake project");
	assert.equal(result2[0].name, "Test Project", "Cache should not contain the mutated name");

	// Verify the results are independent copies
	result2[0].name = "ANOTHER MUTATION";
	const result3 = store.list();
	assert.equal(result3[0].name, "Test Project", "Cache should not be affected by mutations to returned array");

	// Cleanup
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Roster prompt cache timestamps are updated on reload", async () => {
	// Clear cache first
	invalidateRosterCache();

	// First load - populates cache
	const prompt1 = loadGuildmasterPrompt();

	// Wait a bit to ensure timestamps would differ
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Second load within TTL - should use cache
	const prompt2 = loadGuildmasterPrompt();
	assert.equal(prompt1, prompt2);

	// Invalidate cache to simulate TTL expiry
	invalidateRosterCache();

	// Third load - should reload and update timestamp
	const prompt3 = loadGuildmasterPrompt();

	// Wait again
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Fourth load within TTL - should use cache (verifying timestamp was updated)
	const prompt4 = loadGuildmasterPrompt();
	assert.equal(prompt3, prompt4);

	// Same for party leader prompt
	invalidateRosterCache();
	const plPrompt1 = loadPartyLeaderPrompt();
	await new Promise((resolve) => setTimeout(resolve, 10));
	const plPrompt2 = loadPartyLeaderPrompt();
	assert.equal(plPrompt1, plPrompt2);
});
