/**
 * Markdown recipe loading: the declarative layer must COMPOSE code-owned
 * capabilities and REJECT anything that invents a new one. These tests pin the
 * guardrail (unknown capability → rejected) and the built-in inheritance for
 * overrides, and confirm the bundled pr-feedback-to-plan recipe loads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecipeFile, loadRecipeRegistry } from "../src/orchestration/recipe-loader.ts";
import { RECIPES } from "../src/orchestration/recipes.ts";

const NL = "\n";

function md(frontmatter: string, body = "Do the thing."): string {
	return `---${NL}${frontmatter}${NL}---${NL}${body}${NL}`;
}

test("parses a well-formed new recipe with all axes", () => {
	const res = parseRecipeFile(
		"/x/custom.md",
		md(["name: custom", "description: A custom recipe", "github: read", "write: false", "isolation: none", "delivery: report"].join(NL)),
	);
	assert.ok("recipe" in res);
	if ("recipe" in res) {
		assert.equal(res.recipe.id, "custom");
		assert.equal(res.recipe.github, "read");
		assert.equal(res.recipe.source, "markdown");
		assert.equal(res.recipe.guidance, "Do the thing.");
	}
});

test("GUARDRAIL: rejects a recipe naming an unknown github capability", () => {
	const res = parseRecipeFile(
		"/x/bad.md",
		md(["name: bad", "github: admin", "write: false", "isolation: none", "delivery: report"].join(NL)),
	);
	assert.ok("issue" in res);
	if ("issue" in res) assert.match(res.issue, /invalid or missing `github`/);
});

test("GUARDRAIL: rejects an unknown delivery", () => {
	const res = parseRecipeFile(
		"/x/bad.md",
		md(["name: bad", "github: none", "write: false", "isolation: none", "delivery: merge-it"].join(NL)),
	);
	assert.ok("issue" in res);
});

test("a new recipe missing axes is rejected (inherits nothing)", () => {
	const res = parseRecipeFile("/x/partial.md", md(["name: partial", "github: read"].join(NL)));
	assert.ok("issue" in res);
});

test("an override of a built-in inherits the built-in's omitted axes", () => {
	// Only re-declares the party/guidance; axes come from the pr-investigate built-in.
	const res = parseRecipeFile(
		"/x/pr-investigate.md",
		md(["name: pr-investigate", "party: [scout, architect]"].join(NL), "Custom guidance."),
		RECIPES["pr-investigate"],
	);
	assert.ok("recipe" in res);
	if ("recipe" in res) {
		assert.equal(res.recipe.github, "read"); // inherited
		assert.equal(res.recipe.delivery, "report"); // inherited
		assert.deepEqual(res.recipe.party, ["scout", "architect"]);
		assert.equal(res.recipe.guidance, "Custom guidance.");
	}
});

test("the bundled pr-feedback-to-plan recipe loads and is a read-only report recipe", () => {
	const { registry } = loadRecipeRegistry();
	const r = registry["pr-feedback-to-plan"];
	assert.ok(r, "pr-feedback-to-plan should be loaded from bundled assets");
	assert.equal(r.github, "read");
	assert.equal(r.write, false);
	assert.equal(r.delivery, "report");
	assert.equal(r.source, "markdown");
	assert.ok(r.party && r.party.includes("architect"));
});

test("loadRecipeRegistry always includes the built-ins", () => {
	const { registry } = loadRecipeRegistry();
	for (const id of Object.keys(RECIPES)) assert.ok(registry[id], `built-in ${id} present`);
});
