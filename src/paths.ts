/**
 * Filesystem locations for Guildmaster.
 *
 * Two roots matter:
 *   - PACKAGE_DIR: where this extension's bundled default assets live (read-only,
 *     replaced on upgrade).
 *   - guildHome():  the user-owned, durable copy under the agent dir. Seeded from
 *     the bundled defaults on first use and never overwritten afterwards (§14).
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Directory containing this module (src/). Resolves through dev symlinks. */
export const PACKAGE_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Bundled default assets shipped with the package. */
export const ASSETS_DIR = path.join(PACKAGE_SRC_DIR, "assets");

/** User-owned Guildmaster home, e.g. ~/.pi/agent/guildmaster. */
export function guildmasterHome(): string {
	return path.join(getAgentDir(), "guildmaster");
}

/** User-owned guild directory (roster + non-roster agents + config). */
export function guildDir(): string {
	return path.join(guildmasterHome(), "guild");
}

export function rosterDir(): string {
	return path.join(guildDir(), "roster");
}

/**
 * Durable Quest state, deliberately OUTSIDE Pi's session storage so Quests are
 * process-independent and inspectable by external tooling (§5, §16).
 * e.g. ~/.pi/agent/guildmaster/quests/<id>.json
 */
export function questsDir(): string {
	return path.join(guildmasterHome(), "quests");
}

/** Durable pending-approval records (outside Pi, inspectable by external tooling). */
export function approvalsDir(): string {
	return path.join(guildmasterHome(), "approvals");
}

/** Named project registry (multi-repo). Location-independent: resolved by name, not cwd. */
export function projectsDir(): string {
	return path.join(guildmasterHome(), "projects");
}

export function configPath(): string {
	return path.join(guildDir(), "config.json");
}

export function guildmasterPromptPath(): string {
	return path.join(guildDir(), "guildmaster.md");
}

export function partyLeaderPromptPath(): string {
	return path.join(guildDir(), "party-leader.md");
}
