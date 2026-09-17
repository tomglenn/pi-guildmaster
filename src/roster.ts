/**
 * Roster loading and first-use seeding.
 *
 * Guildmates are declarative Markdown files with YAML frontmatter (the same
 * shape Pi's own `subagent` example uses), so they are user-editable and durable
 * (§2, §14). The two non-roster agents (Guildmaster, Party Leader) live alongside
 * the roster as guildmaster.md / party-leader.md.
 *
 * PERFORMANCE FIX: Added in-memory caching for roster and prompts to avoid
 * synchronous filesystem I/O on every turn. Cache invalidated on /reload or
 * when TTL expires.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { ASSETS_DIR, guildDir, guildmasterPromptPath, partyLeaderPromptPath, rosterDir } from "./paths.ts";

/** Coarse capability tier (§8). Maps to real tool sets in later milestones. */
export type Tier = "read-only" | "write" | "exec" | "envoy" | "orchestrator";

const TIERS: readonly Tier[] = ["read-only", "write", "exec", "envoy", "orchestrator"];

export interface Guildmate {
	name: string;
	description: string;
	tier: Tier;
	/** Model alias or explicit provider/model. Undefined => inherit parent. */
	model?: string;
	/** One-line doctrine shown in the roster. */
	tagline?: string;
	systemPrompt: string;
	filePath: string;
}

type RosterFrontmatter = {
	name?: unknown;
	description?: unknown;
	tier?: unknown;
	model?: unknown;
	tagline?: unknown;
};

function asTier(value: unknown): Tier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value) ? (value as Tier) : "read-only";
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** In-memory cache for roster and prompts to avoid repeated synchronous disk reads. */
interface RosterCache {
	roster: Guildmate[];
	guildmasterPrompt?: string;
	partyLeaderPrompt?: string;
	/** Flag to track if guildmaster prompt has been loaded (undefined vs not-yet-loaded). */
	guildmasterLoaded: boolean;
	/** Flag to track if party leader prompt has been loaded (undefined vs not-yet-loaded). */
	partyLeaderLoaded: boolean;
	timestamp: number;
}

let rosterCache: RosterCache | undefined;
const ROSTER_CACHE_TTL = 60_000; // 1 minute

/** Invalidate the roster cache (called on /reload). */
export function invalidateRosterCache(): void {
	rosterCache = undefined;
}

/**
 * Seed the durable user-owned guild directory from bundled defaults on first
 * use. Never overwrites existing files, so user customization survives upgrades.
 * Returns true if anything was written.
 */
export function ensureGuildSeeded(): boolean {
	const dest = guildDir();
	if (fs.existsSync(dest)) return false;
	const src = path.join(ASSETS_DIR, "guild");
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.cpSync(src, dest, { recursive: true });
	// Invalidate cache since we just wrote new files
	invalidateRosterCache();
	return true;
}

/** Load one Guildmate from a Markdown file, or null if it lacks required fields. */
function loadGuildmateFile(filePath: string): Guildmate | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const { frontmatter, body } = parseFrontmatter<RosterFrontmatter>(content);
	const name = asString(frontmatter.name);
	const description = asString(frontmatter.description);
	if (!name || !description) return null;
	return {
		name,
		description,
		tier: asTier(frontmatter.tier),
		model: asString(frontmatter.model),
		tagline: asString(frontmatter.tagline),
		systemPrompt: body,
		filePath,
	};
}

/** Load the full roster of Guildmates from <guildHome>/guild/roster/*.md. */
function loadRosterUncached(): Guildmate[] {
	const dir = rosterDir();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const roster: Guildmate[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const mate = loadGuildmateFile(path.join(dir, entry.name));
		if (mate) roster.push(mate);
	}
	roster.sort((a, b) => a.name.localeCompare(b.name));
	return roster;
}

/** Load the full roster of Guildmates, using cache if available and fresh. */
export function loadRoster(): Guildmate[] {
	const now = Date.now();
	if (rosterCache && (now - rosterCache.timestamp) < ROSTER_CACHE_TTL) {
		return [...rosterCache.roster]; // Return a copy to prevent mutation
	}
	
	// Load fresh data
	const roster = loadRosterUncached();
	
	// Update cache, preserving prompts if they exist
	if (!rosterCache) {
		rosterCache = { roster, guildmasterLoaded: false, partyLeaderLoaded: false, timestamp: now };
	} else {
		rosterCache.roster = roster;
		rosterCache.timestamp = now;
	}
	
	return [...roster];
}

export function findGuildmate(roster: Guildmate[], name: string): Guildmate | undefined {
	return roster.find((m) => m.name.toLowerCase() === name.toLowerCase());
}

/** System prompt for a non-roster agent (Guildmaster / Party Leader). */
function loadPromptBody(filePath: string): string | undefined {
	try {
		const { body } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
		return body.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Load Guildmaster prompt, using cache if available and fresh. */
export function loadGuildmasterPrompt(): string | undefined {
	const now = Date.now();
	if (rosterCache && rosterCache.guildmasterLoaded && (now - rosterCache.timestamp) < ROSTER_CACHE_TTL) {
		return rosterCache.guildmasterPrompt;
	}
	
	const prompt = loadPromptBody(guildmasterPromptPath());
	
	// Update cache
	if (!rosterCache) {
		rosterCache = { roster: [], guildmasterPrompt: prompt, guildmasterLoaded: true, partyLeaderLoaded: false, timestamp: now };
	} else {
		rosterCache.guildmasterPrompt = prompt;
		rosterCache.guildmasterLoaded = true;
		rosterCache.timestamp = Date.now();
	}
	
	return prompt;
}

/** Load Party Leader prompt, using cache if available and fresh. */
export function loadPartyLeaderPrompt(): string | undefined {
	const now = Date.now();
	if (rosterCache && rosterCache.partyLeaderLoaded && (now - rosterCache.timestamp) < ROSTER_CACHE_TTL) {
		return rosterCache.partyLeaderPrompt;
	}
	
	const prompt = loadPromptBody(partyLeaderPromptPath());
	
	// Update cache
	if (!rosterCache) {
		rosterCache = { roster: [], partyLeaderPrompt: prompt, guildmasterLoaded: false, partyLeaderLoaded: true, timestamp: now };
	} else {
		rosterCache.partyLeaderPrompt = prompt;
		rosterCache.partyLeaderLoaded = true;
		rosterCache.timestamp = Date.now();
	}
	
	return prompt;
}
