/**
 * Recipe resolution: the ONE classifier that maps quest-tool params to a Quest
 * shape. These lock the mapping so the 4 capability axes (github / write /
 * isolation / delivery) stay explicit and the previously-missing "fetch a PR and
 * report" combination (pr-investigate) is reachable.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { executionShape, preflightRecipe, RECIPES, resolveRecipe } from "../src/orchestration/recipes.ts";

test("a plain read Quest resolves to investigate (no github, report)", () => {
	const r = resolveRecipe({});
	assert.equal(r.id, "investigate");
	assert.equal(r.github, "none");
	assert.equal(r.write, false);
	assert.equal(r.delivery, "report");
});

test("a PR with no mode defaults to pr-review (posts after approval)", () => {
	const r = resolveRecipe({ pr: "123" });
	assert.equal(r.id, "pr-review");
	assert.equal(r.github, "review");
	assert.equal(r.delivery, "post-review");
});

test("pr + mode:investigate resolves to pr-investigate: read-only github, report, no write", () => {
	const r = resolveRecipe({ pr: "123", mode: "investigate" });
	assert.equal(r.id, "pr-investigate");
	assert.equal(r.github, "read");
	assert.equal(r.write, false);
	assert.equal(r.delivery, "report");
	assert.equal(r.isolation, "none");
});

test("pr-investigate is the combination that had no home before: fetch + read-only + report", () => {
	// Regression for the DX failure: acquiring a PR must NOT force a posting delivery.
	const r = resolveRecipe({ pr: "https://github.com/o/r/pull/9", mode: "investigate" });
	assert.equal(r.github, "read");
	assert.notEqual(r.delivery, "post-review");
});

test("pr + mode:address-feedback resolves to address-feedback (attach-pr, push)", () => {
	const r = resolveRecipe({ pr: "123", mode: "address-feedback" });
	assert.equal(r.id, "address-feedback");
	assert.equal(r.write, true);
	assert.equal(r.isolation, "attach-pr");
	assert.equal(r.delivery, "push-existing-pr");
});

test("write resolves to an isolated worktree + draft PR", () => {
	const r = resolveRecipe({ write: true });
	assert.equal(r.id, "write");
	assert.equal(r.isolation, "worktree");
	assert.equal(r.delivery, "draft-pr");
});

test("write + inPlace resolves to write-in-place (real checkout, no PR)", () => {
	const r = resolveRecipe({ write: true, inPlace: true });
	assert.equal(r.id, "write-in-place");
	assert.equal(r.isolation, "in-place");
});

test("mode:investigate without a PR falls back to plain investigate rather than an unreachable shape", () => {
	const r = resolveRecipe({ mode: "investigate" });
	assert.equal(r.id, "investigate");
	assert.equal(r.github, "none");
});

test("every built-in recipe's table key matches its id", () => {
	for (const [key, recipe] of Object.entries(RECIPES)) {
		assert.equal(key, recipe.id, `recipe key ${key} must equal its id ${recipe.id}`);
	}
});

test("only pr-investigate and pr-review grant github without being a write Quest", () => {
	assert.equal(RECIPES["pr-investigate"].github, "read");
	assert.equal(RECIPES["pr-review"].github, "review");
	assert.equal(RECIPES.investigate.github, "none");
});

test("an explicit recipe name overrides param classification", () => {
	const r = resolveRecipe({ recipe: "pr-review", write: true });
	assert.equal(r.id, "pr-review");
});

test("resolveRecipe throws a helpful error for an unknown recipe name", () => {
	assert.throws(() => resolveRecipe({ recipe: "nope" }), /No recipe named "nope"/);
});

test("executionShape derives the IO path from axes, not the id", () => {
	assert.equal(executionShape(RECIPES.investigate), "read");
	assert.equal(executionShape(RECIPES["pr-investigate"]), "pr-investigate");
	assert.equal(executionShape(RECIPES["pr-review"]), "pr-review");
	assert.equal(executionShape(RECIPES["address-feedback"]), "address-feedback");
	assert.equal(executionShape(RECIPES.write), "write");
	assert.equal(executionShape(RECIPES["write-in-place"]), "write");
	// A novel recipe with pr-investigate axes runs through that shape regardless of id.
	assert.equal(
		executionShape({ id: "x", description: "", write: false, github: "read", isolation: "none", delivery: "report" }),
		"pr-investigate",
	);
});

test("preflight passes for a PR-context recipe when a slug is available", () => {
	const r = preflightRecipe(RECIPES["pr-investigate"], { hasPr: true, hasLocalRepo: false, hasSlug: true, isGitRepo: false });
	assert.equal(r.ok, true);
});

test("preflight FAILS a PR-context recipe with no way to reach GitHub (the envoy-less failure)", () => {
	const r = preflightRecipe(RECIPES["pr-investigate"], { hasPr: true, hasLocalRepo: false, hasSlug: false, isGitRepo: false });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /no local checkout and no owner\/repo slug/);
});

test("preflight FAILS a PR recipe with no PR", () => {
	const r = preflightRecipe(RECIPES["pr-review"], { hasPr: false, hasLocalRepo: true, hasSlug: false, isGitRepo: true });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /needs a PR/);
});

test("preflight FAILS a write recipe whose target is not a git repo", () => {
	const r = preflightRecipe(RECIPES.write, { hasPr: false, hasLocalRepo: true, hasSlug: false, isGitRepo: false });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /not a git repository/);
});

test("preflight passes a plain investigate (no PR, no git needed)", () => {
	const r = preflightRecipe(RECIPES.investigate, { hasPr: false, hasLocalRepo: true, hasSlug: false, isGitRepo: false });
	assert.equal(r.ok, true);
});
