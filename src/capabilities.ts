/**
 * Capability tiers → concrete Pi tool allowlists (§8).
 *
 * Tiers are enforced STRUCTURALLY, not by prompting. A read-only Guildmate is
 * built with a session that simply does not include write or exec tools, so it
 * *cannot* mutate the tree even if instructed to. This is the invariant the brief
 * insists on: "Scout should not merely be instructed not to edit files. Scout
 * should not have write tools available."
 *
 * Note: `read-only` deliberately excludes `bash`, because bash can both execute
 * and mutate. `write` gets edit/write but not bash. `exec` (Runner) does NOT get
 * raw `bash` either: it gets read-only FILE tools here plus a BOUNDED custom shell
 * injected by orchestration (execution/runner-shell.ts), so it structurally cannot
 * start a non-terminating process that would wedge the Quest.
 */

import type { Tier } from "./roster.ts";

const TIER_TOOLS: Record<Tier, string[]> = {
	"read-only": ["read", "grep", "find", "ls"],
	write: ["read", "grep", "find", "ls", "edit", "write"],
	// Shell access is a bounded custom tool injected by orchestration (runner-shell.ts),
	// never the raw `bash` tool — so a runner cannot start a watch/server that never returns.
	exec: ["read", "grep", "find", "ls"],
	// Envoy talks to GitHub. It gets read-only FILE tools here; its shell access is a
	// separate POLICY-GATED custom tool injected by orchestration (see execution/gh-tool.ts),
	// never the raw `bash` tool — so it structurally cannot run an ungated mutation.
	envoy: ["read", "grep", "find", "ls"],
	// Orchestrators do not run as child agents; give them read-only if ever built as one.
	orchestrator: ["read", "grep", "find", "ls"],
};

export function toolsForTier(tier: Tier): string[] {
	return TIER_TOOLS[tier] ?? TIER_TOOLS["read-only"];
}
