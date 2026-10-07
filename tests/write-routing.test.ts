import { test } from "node:test";
import assert from "node:assert/strict";
import { RECIPES } from "../src/orchestration/recipes.ts";
import { useFastWrite } from "../src/orchestration/write-routing.ts";

test("default writes use a dynamic leader; an explicit bounded shortcut runs one worker", () => {
	assert.equal(useFastWrite(RECIPES.write, 1, "Add a cue schema field and run its tests"), false);
	assert.equal(useFastWrite(RECIPES["write-in-place"], 1, "Fix a label"), false);
	assert.equal(useFastWrite(RECIPES["write-fast"], 1, "Fix a label"), true);
});

test("complex, risk-sensitive and explicit party work retains full party", () => {
	assert.equal(useFastWrite(RECIPES["write-fast"], 2, "Update schema"), false);
	assert.equal(useFastWrite(RECIPES["write-fast"], 1, "Fix authorization permissions"), false);
	assert.equal(useFastWrite(RECIPES.write, 1, "Fix authorization permissions"), false);
	assert.equal(useFastWrite(RECIPES.write, 1, "Migrate the database schema"), false);
	assert.equal(useFastWrite(RECIPES["write-party"], 1, "Change one line"), false);
	assert.equal(useFastWrite(RECIPES["plan-implement"], 1, "Change one line"), false);
});
