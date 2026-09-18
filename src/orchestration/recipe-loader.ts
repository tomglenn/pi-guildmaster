/**
 * Markdown-authored recipe loading (§ redesign, Layer 2).
 *
 * Recipes are the DECLARATIVE layer: markdown files with YAML frontmatter that
 * COMPOSE the code-owned capability primitives (github access, isolation, write,
 * delivery). A recipe can never invent a new capability — a file naming an unknown
 * github/delivery/isolation value is REJECTED, not silently granted. That guardrail
 * is what keeps the safety model in code while letting users add/override shapes.
 *
 * Resolution order (later wins): built-in table → bundled markdown → user markdown.
 * A markdown recipe whose id matches a built-in OVERRIDES it (users can retune the
 * party or guidance of a shipped recipe); a new id ADDS a recipe, and must declare
 * all four axes since it inherits nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { bundledRecipesDir, recipesDir } from "../paths.ts";
import {
	builtinRegistry,
	isDelivery,
	isGithubAccess,
	isIsolation,
	type Recipe,
	type RecipeRegistry,
} from "./recipes.ts";

type RecipeFrontmatter = {
	name?: unknown;
	id?: unknown;
	description?: unknown;
	github?: unknown;
	write?: unknown;
	isolation?: unknown;
	delivery?: unknown;
	party?: unknown;
};

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function asBool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (v === "true") return true;
	if (v === "false") return false;
	return undefined;
}
function asStringArray(v: unknown): string[] | undefined {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
	if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
	return undefined;
}

export interface RecipeLoadIssue {
	file: string;
	reason: string;
}

/**
 * Parse one markdown recipe. Returns the Recipe, or an issue describing why it was
 * rejected. `base` is the built-in of the same id (if any), whose axes an override
 * inherits when it omits them.
 */
export function parseRecipeFile(
	filePath: string,
	content: string,
	base?: Recipe,
): { recipe: Recipe } | { issue: string } {
	const { frontmatter, body } = parseFrontmatter<RecipeFrontmatter>(content);
	const id = asString(frontmatter.id) ?? asString(frontmatter.name);
	if (!id) return { issue: "missing `name`/`id`" };

	const github = frontmatter.github !== undefined ? frontmatter.github : base?.github;
	const isolation = frontmatter.isolation !== undefined ? frontmatter.isolation : base?.isolation;
	const delivery = frontmatter.delivery !== undefined ? frontmatter.delivery : base?.delivery;
	const write = asBool(frontmatter.write) ?? base?.write;

	// Guardrail: a recipe may only compose KNOWN capability values.
	if (!isGithubAccess(github)) return { issue: `invalid or missing \`github\` (got ${JSON.stringify(frontmatter.github ?? null)})` };
	if (!isIsolation(isolation)) return { issue: `invalid or missing \`isolation\` (got ${JSON.stringify(frontmatter.isolation ?? null)})` };
	if (!isDelivery(delivery)) return { issue: `invalid or missing \`delivery\` (got ${JSON.stringify(frontmatter.delivery ?? null)})` };
	if (write === undefined) return { issue: "missing `write` (true/false)" };

	const recipe: Recipe = {
		id,
		description: asString(frontmatter.description) ?? base?.description ?? id,
		write,
		github,
		isolation,
		delivery,
		party: asStringArray(frontmatter.party) ?? base?.party,
		guidance: body.trim() || base?.guidance,
		source: "markdown",
	};
	return { recipe };
}

function loadDir(dir: string, registry: RecipeRegistry, issues: RecipeLoadIssue[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const base = (() => {
			const { frontmatter } = parseFrontmatter<RecipeFrontmatter>(content);
			const id = asString(frontmatter.id) ?? asString(frontmatter.name);
			return id ? registry[id] : undefined;
		})();
		const result = parseRecipeFile(filePath, content, base);
		if ("issue" in result) {
			issues.push({ file: filePath, reason: result.issue });
			continue;
		}
		registry[result.recipe.id] = result.recipe;
	}
}

/**
 * Load the full recipe registry: built-ins overlaid with bundled then user
 * markdown. Never throws — a malformed recipe is skipped and reported in `issues`
 * so one bad file cannot disable the system.
 */
export function loadRecipeRegistry(): { registry: RecipeRegistry; issues: RecipeLoadIssue[] } {
	const registry = builtinRegistry();
	const issues: RecipeLoadIssue[] = [];
	// Bundled first (fallback for installs seeded before recipes existed), then the
	// user's own dir so their overrides win.
	loadDir(bundledRecipesDir(), registry, issues);
	loadDir(recipesDir(), registry, issues);
	return { registry, issues };
}
