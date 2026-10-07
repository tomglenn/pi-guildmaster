import type { Recipe } from "./recipes.ts";

/** Conservative routing: uncertain or cross-cutting work keeps the full party. */
export function needsFullParty(brief: string): boolean {
	return /\b(auth(?:entication|orization)?|oauth|login|permission|privilege|secret|credential|token|cryptograph\w*|encrypt\w*|security|vulnerab\w*|injection|xss|csrf|sanitize|untrusted|user[ -]?input|migration|migrate|backfill|database schema|dependency upgrade|dependencies|supply.chain)\b/i.test(brief);
}

export function useFastWrite(recipe: Recipe, writableRepoCount: number, brief: string): boolean {
	return writableRepoCount === 1 && (recipe.id === "write" || recipe.id === "write-in-place") && !needsFullParty(brief);
}
