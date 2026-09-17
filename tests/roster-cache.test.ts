/**
 * Regression test for the RosterCache population-ordering bug.
 *
 * `before_agent_start` calls loadGuildmasterPrompt() on every turn. That prompt
 * loader used to prime the shared cache with `roster: []`, after which
 * loadRoster() would return the empty placeholder from a "fresh" cache and never
 * read the roster files from disk — silently disabling all dispatch with
 * "No Guildmates are available". loadRoster must populate from disk regardless of
 * a prompt loader having primed the cache first.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureGuildSeeded, invalidateRosterCache, loadGuildmasterPrompt, loadPartyLeaderPrompt, loadRoster } from "../src/roster.ts";

test("loadRoster populates from disk even when a prompt loader primed the cache first", () => {
	ensureGuildSeeded(); // idempotent; guarantees roster files exist
	invalidateRosterCache();

	// Mimic the real per-turn ordering: prompts first (which prime the cache), roster second.
	loadGuildmasterPrompt();
	loadPartyLeaderPrompt();

	const roster = loadRoster();
	assert.ok(roster.length > 0, `expected a non-empty roster, got ${roster.length} (cache returned empty placeholder?)`);
	assert.ok(
		roster.some((m) => m.name.toLowerCase() === "runner"),
		"expected the runner Guildmate to be present",
	);
});

test("loadRoster is stable across repeated calls after a prompt prime", () => {
	ensureGuildSeeded();
	invalidateRosterCache();
	loadGuildmasterPrompt();

	const first = loadRoster();
	const second = loadRoster();
	assert.equal(first.length, second.length, "roster size must be stable between calls");
	assert.ok(first.length > 0, "roster must not be empty");
});
