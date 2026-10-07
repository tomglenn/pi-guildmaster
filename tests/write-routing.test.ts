import { test } from "node:test";
import assert from "node:assert/strict";
import { RECIPES } from "../src/orchestration/recipes.ts";
import { useFastWrite } from "../src/orchestration/write-routing.ts";

test("one-repo bounded write runs as one edit-and-test worker", () => {
	assert.equal(useFastWrite(RECIPES.write, 1, "Add a cue schema field and run its tests"), true);
	assert.equal(useFastWrite(RECIPES["write-in-place"], 1, "Fix a label"), true);
});

test("complex, risk-sensitive and explicit party work retains full party", () => {
	assert.equal(useFastWrite(RECIPES.write, 2, "Update schema"), false);
	assert.equal(useFastWrite(RECIPES.write, 1, "Fix authorization permissions"), false);
	assert.equal(useFastWrite(RECIPES.write, 1, "Migrate the database schema"), false);
	assert.equal(useFastWrite(RECIPES["write-party"], 1, "Change one line"), false);
	assert.equal(useFastWrite(RECIPES["plan-implement"], 1, "Change one line"), false);
});
