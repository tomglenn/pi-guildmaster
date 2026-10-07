import type { Recipe } from "./recipes.ts";

/** Conservative routing: uncertain or cross-cutting work keeps the full party. */
export function needsFullParty(brief: string): boolean {
	return /\b(auth(?:entication|orization)?|oauth|login|permission|privilege|secret|credential|token|cryptograph\w*|encrypt\w*|security|vulnerab\w*|injection|xss|csrf|sanitize|untrusted|user[ -]?input|migration|migrate|backfill|database schema|dependency upgrade|dependencies|supply.chain)\b/i.test(brief);
}

export function useFastWrite(recipe: Recipe, writableRepoCount: number, brief: string): boolean {
	// The default is a dynamic Party Leader; the one-worker shortcut is an explicit opt-in.
	return writableRepoCount === 1 && recipe.id === "write-fast" && !needsFullParty(brief);
}
