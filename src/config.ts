/**
 * Guildmaster configuration.
 *
 * Model diversity is a first-class feature (§4), so models are never hardcoded
 * into orchestration code. Instead Guildmates reference configurable *aliases*
 * (model classes). The alias -> concrete model mapping lives in a boring JSON
 * file the user owns and can edit: <guildHome>/guild/config.json.
 *
 * A Guildmate's `model` frontmatter is either one of these alias names, or an
 * explicit "provider/model" string understood by Pi's model system.
 */

import * as fs from "node:fs";
import { configPath } from "./paths.ts";

/** The model classes referenced by the default roster. */
export type ModelAlias = "fast" | "capable" | "reasoning" | "adversarial" | "coding";

export interface GuildmasterConfig {
	/** alias -> "provider/model" (optionally with ":thinkingLevel"). */
	models: Record<string, string>;
	/** Model used by the Guildmaster orchestrator itself. Alias or explicit. */
	guildmasterModel: string;
	/** Model used by the Party Leader. Alias or explicit. */
	partyLeaderModel: string;
	/** Shell execution timeouts for the runner (in milliseconds). */
	shell?: {
		/** Maximum time without output before killing (default: 300000 = 5 minutes). */
		inactivityMs?: number;
		/** Maximum total runtime before killing (default: 1800000 = 30 minutes). */
		maxTotalMs?: number;
		/** Maximum output bytes to capture (default: 200000). */
		maxOutputBytes?: number;
	};
}

/**
 * Conservative defaults. These are only *defaults* written into the user's
 * config.json on first use; the user is expected to edit them to match the
 * providers they actually have authenticated. Nothing here is load-bearing in
 * orchestration code.
 */
export const DEFAULT_CONFIG: GuildmasterConfig = {
	models: {
		fast: "anthropic/claude-haiku-4-5",
		capable: "anthropic/claude-sonnet-4-5",
		reasoning: "anthropic/claude-opus-4-5",
		adversarial: "openai/gpt-5",
		coding: "anthropic/claude-sonnet-4-5",
	},
	guildmasterModel: "capable",
	partyLeaderModel: "capable",
};

/** Per-project overrides layered over the global config (§14, project-scoped). */
export interface ProjectConfigOverride {
	models?: Record<string, string>;
	guildmasterModel?: string;
	partyLeaderModel?: string;
	shell?: {
		inactivityMs?: number;
		maxTotalMs?: number;
		maxOutputBytes?: number;
	};
}

/** Merge a project's overrides over the global config. Returns a new config. */
export function effectiveConfig(base: GuildmasterConfig, overrides?: ProjectConfigOverride): GuildmasterConfig {
	if (!overrides) return base;
	return {
		models: { ...base.models, ...(overrides.models ?? {}) },
		guildmasterModel: overrides.guildmasterModel ?? base.guildmasterModel,
		partyLeaderModel: overrides.partyLeaderModel ?? base.partyLeaderModel,
		shell: overrides.shell ? { ...base.shell, ...overrides.shell } : base.shell,
	};
}

/** Load config from disk, merging over defaults. Never throws. */
export function loadConfig(): GuildmasterConfig {
	try {
		const raw = fs.readFileSync(configPath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<GuildmasterConfig>;
		return {
			models: { ...DEFAULT_CONFIG.models, ...(parsed.models ?? {}) },
			guildmasterModel: parsed.guildmasterModel ?? DEFAULT_CONFIG.guildmasterModel,
			partyLeaderModel: parsed.partyLeaderModel ?? DEFAULT_CONFIG.partyLeaderModel,
			shell: parsed.shell ? { ...parsed.shell } : undefined,
		};
	} catch {
		return { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models }, shell: undefined };
	}
}

/**
 * Resolve a Guildmate's `model` field to a concrete "provider/model" spec.
 * If it names an alias, return the alias target; otherwise return it verbatim
 * (an explicit provider/model). Returns undefined when unset (inherit parent).
 */
export function resolveModelSpec(config: GuildmasterConfig, model: string | undefined): string | undefined {
	if (!model) return undefined;
	return config.models[model] ?? model;
}
