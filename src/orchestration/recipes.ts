/**
 * Quest recipes — the explicit capability model (§ redesign).
 *
 * A Quest "type" is not one thing. It is a composition of FOUR orthogonal axes:
 *
 *   - github     : what GitHub access the party is granted (none / read / review)
 *   - write      : may the party dispatch write/exec members into a writable tree?
 *   - isolation  : how the working tree is isolated (none / worktree / attach-pr / in-place)
 *   - delivery   : what the finished party produces (report / draft-pr / post-review / push-existing-pr)
 *
 * Historically these were welded together inside a cascade of `if` branches in
 * quest-tool.ts, so only a handful of fixed points in that 4-D space were reachable.
 * The combination "acquire a PR (github:read) + analyse read-only + deliver a report"
 * had no home — you could fetch a PR only by entering review mode, which then forced
 * a post-a-review delivery. That gap is the `pr-investigate` recipe below.
 *
 * This module names the reachable points as DATA. The capability primitives the
 * recipes compose (the read-only envoy shell, worktrees, approval-gated posting)
 * stay in code — a recipe can only SELECT from them, never invent a new grant.
 */

/** GitHub access granted to the party's envoy. */
export type GithubAccess =
	| "none" // no envoy; the party cannot reach GitHub
	| "read" // read-only envoy: gh pr view/diff/checkout, gh api reads — mutations refused
	| "review"; // envoy may also POST a review, gated behind human approval

export type Delivery =
	| "report" // a written report, delivered as a card
	| "draft-pr" // a committed branch + drafted PR (raise_pr to open)
	| "post-review" // a PR review, posted after /approve (or left as a draft)
	| "push-existing-pr"; // commits fast-forwarded onto an existing PR's branch (raise_pr to push)

export type IsolationMode =
	| "none" // read-only; runs in the existing checkout, nothing written
	| "worktree" // isolated git worktree on a fresh branch off the clean base
	| "attach-pr" // worktree attached to an existing PR's head branch
	| "in-place"; // the user's real checkout, on a fresh branch (opt-in, dangerous)

export interface Recipe {
	id: string;
	description: string;
	write: boolean;
	github: GithubAccess;
	isolation: IsolationMode;
	delivery: Delivery;
	/** Optional restriction of the dispatchable party to these Guildmate names. */
	party?: string[];
	/** Optional guidance body (from a markdown recipe) folded into the brief. */
	guidance?: string;
	/** Where this recipe came from: a built-in or a markdown file. */
	source?: "builtin" | "markdown";
}

const GITHUB_ACCESS: readonly GithubAccess[] = ["none", "read", "review"];
const DELIVERIES: readonly Delivery[] = ["report", "draft-pr", "post-review", "push-existing-pr"];
const ISOLATIONS: readonly IsolationMode[] = ["none", "worktree", "attach-pr", "in-place"];

export function isGithubAccess(v: unknown): v is GithubAccess {
	return typeof v === "string" && (GITHUB_ACCESS as readonly string[]).includes(v);
}
export function isDelivery(v: unknown): v is Delivery {
	return typeof v === "string" && (DELIVERIES as readonly string[]).includes(v);
}
export function isIsolation(v: unknown): v is IsolationMode {
	return typeof v === "string" && (ISOLATIONS as readonly string[]).includes(v);
}

/**
 * The concrete execution shape a recipe runs as — the setup/IO path in the quest
 * tool. Derived from the capability AXES, not the recipe id, so a NEW (e.g.
 * markdown-authored) recipe runs correctly as long as its axes match a known
 * shape. This is what makes recipes composable rather than a closed enum.
 */
export type ExecutionShape = "read" | "pr-investigate" | "pr-review" | "address-feedback" | "write";

export function executionShape(recipe: Recipe): ExecutionShape {
	if (recipe.delivery === "push-existing-pr" || recipe.isolation === "attach-pr") return "address-feedback";
	if (recipe.delivery === "post-review" || recipe.github === "review") return "pr-review";
	if (recipe.write) return "write";
	if (recipe.github === "read") return "pr-investigate";
	return "read";
}

/**
 * The built-in recipes. Each is a named point in the capability space. Adding a
 * new shape means adding a row here (composing existing capabilities), not a new
 * branch in the dispatcher.
 */
export const RECIPES = {
	investigate: {
		id: "investigate",
		description: "Read-only investigation of the codebase; produces a report.",
		write: false,
		github: "none",
		isolation: "none",
		delivery: "report",
	},
	"pr-investigate": {
		id: "pr-investigate",
		description: "Fetch a PR (read-only) and analyse it — e.g. assess a reviewer's feedback and produce a plan. NEVER posts.",
		write: false,
		github: "read",
		isolation: "none",
		delivery: "report",
	},
	"pr-review": {
		id: "pr-review",
		description: "Review a PR and post the review (after human approval).",
		write: false,
		github: "review",
		isolation: "worktree",
		delivery: "post-review",
	},
	write: {
		id: "write",
		description: "Implement a change in an isolated worktree; produces a draft PR.",
		write: true,
		github: "none",
		isolation: "worktree",
		delivery: "draft-pr",
	},
	"write-in-place": {
		id: "write-in-place",
		description: "Implement a change directly in the user's checkout on a fresh branch; no PR.",
		write: true,
		github: "none",
		isolation: "in-place",
		delivery: "report",
	},
	"address-feedback": {
		id: "address-feedback",
		description: "Action a PR's review feedback on its own branch; fast-forwards the same PR.",
		write: true,
		github: "none", // feedback is gathered up front; the push is a separate approval-gated step
		isolation: "attach-pr",
		delivery: "push-existing-pr",
	},
} satisfies Record<string, Recipe>;

export type RecipeId = keyof typeof RECIPES;

/** A registry maps recipe id → Recipe. The built-in table is the default registry. */
export type RecipeRegistry = Record<string, Recipe>;

export function builtinRegistry(): RecipeRegistry {
	const reg: RecipeRegistry = {};
	for (const [id, r] of Object.entries(RECIPES)) reg[id] = { ...r, source: "builtin" };
	return reg;
}

export interface RecipeSelector {
	/** Explicit recipe name (built-in or markdown). Wins over param classification. */
	recipe?: string;
	pr?: string;
	mode?: "review" | "address-feedback" | "investigate";
	write?: boolean;
	inPlace?: boolean;
}

/**
 * Classify the quest-tool parameters into a single Recipe. This is the ONE place
 * that decides a Quest's shape, replacing the scattered flag cascade. An explicit
 * `recipe` name wins; otherwise params are classified. Given a bad combination
 * (e.g. `mode:"investigate"` without a PR) it falls back to the closest sound
 * recipe rather than inventing an unreachable one.
 */
export function resolveRecipe(sel: RecipeSelector, registry: RecipeRegistry = builtinRegistry()): Recipe {
	if (sel.recipe) {
		const named = registry[sel.recipe];
		if (!named) {
			throw new Error(
				`No recipe named "${sel.recipe}". Available: ${Object.keys(registry).sort().join(", ")}.`,
			);
		}
		return named;
	}
	const pick = (id: RecipeId) => registry[id] ?? RECIPES[id];
	if (sel.pr) {
		if (sel.mode === "address-feedback") return pick("address-feedback");
		if (sel.mode === "investigate") return pick("pr-investigate");
		return pick("pr-review"); // default for a PR
	}
	if (sel.write) return sel.inPlace ? pick("write-in-place") : pick("write");
	return pick("investigate");
}

/**
 * Preflight: fail fast when the resolved recipe cannot actually be executed with
 * the resources at hand — BEFORE any specialist runs. This is the check that would
 * have caught the envoy-less failure (a PR-context recipe with no way to reach
 * GitHub) at request time instead of after a full party dead-ended.
 */
export function preflightRecipe(
	recipe: Recipe,
	ctx: { hasPr: boolean; hasLocalRepo: boolean; hasSlug: boolean; isGitRepo: boolean },
): { ok: true } | { ok: false; error: string } {
	const shape = executionShape(recipe);
	const needsPr = shape === "pr-investigate" || shape === "pr-review" || shape === "address-feedback";
	if (needsPr && !ctx.hasPr) {
		return { ok: false, error: `Recipe "${recipe.id}" needs a PR to act on, but none was given. Pass \`pr\`.` };
	}
	// A read/review of a PR needs SOME way for the envoy to reach it: either a local
	// checkout as cwd, or an owner/repo slug to pass to \`gh --repo\`.
	if (recipe.github !== "none" && needsPr && !ctx.hasLocalRepo && !ctx.hasSlug) {
		return {
			ok: false,
			error: `Recipe "${recipe.id}" fetches PR data from GitHub, but there is no local checkout and no owner/repo slug. Pass a full PR URL (or \`project\`/\`repo\`) so the envoy can reach it.`,
		};
	}
	if ((recipe.write || shape === "write") && ctx.hasLocalRepo && !ctx.isGitRepo) {
		return { ok: false, error: `Recipe "${recipe.id}" writes code, but the target is not a git repository.` };
	}
	return { ok: true };
}
