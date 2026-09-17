/**
 * Tests for config loading, especially the globalInstructions field.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, effectiveConfig, type GuildmasterConfig } from "../src/config.ts";

test("DEFAULT_CONFIG includes globalInstructions as empty string", () => {
	assert.equal(DEFAULT_CONFIG.globalInstructions, "");
});

test("effectiveConfig preserves globalInstructions from base when no override", () => {
	const base: GuildmasterConfig = { ...DEFAULT_CONFIG, globalInstructions: "Be concise." };
	const result = effectiveConfig(base, {});
	assert.equal(result.globalInstructions, "Be concise.");
});

test("effectiveConfig preserves globalInstructions when override has no globalInstructions", () => {
	const base: GuildmasterConfig = { ...DEFAULT_CONFIG, globalInstructions: "Guild-wide rule." };
	const result = effectiveConfig(base, { guildmasterModel: "fast" });
	assert.equal(result.globalInstructions, "Guild-wide rule.");
	assert.equal(result.guildmasterModel, "fast"); // override applied
});
