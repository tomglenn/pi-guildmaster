/**
 * Guildmaster — an opinionated multi-agent development workflow built on Pi.
 *
 * Pi is the harness; Guildmaster is the workflow. This extension composes Pi's
 * public primitives (SDK sessions, model/provider selection, tool restriction,
 * events, custom UI, commands) rather than modifying Pi internals (§15).
 *
 * Milestone 1 — Extension Skeleton:
 *   - proper Pi package that loads and hot-reloads (`/reload`);
 *   - durable, user-owned roster seeded from bundled defaults on first use;
 *   - configuration (model aliases);
 *   - status commands and native TUI card rendering.
 *
 * Delegation (Consult / Quest / Party) is added in later milestones.
 *
 * PERFORMANCE FIX: The before_agent_start hook now uses in-memory caches for
 * roster, prompts, and projects to eliminate synchronous filesystem I/O on
 * every turn. Caches expire after TTL and are invalidated by write operations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApprovals } from "./approvals-ui.ts";
import { registerCommands } from "./commands.ts";
import { registerConsultTool } from "./consult.ts";
import { getApprovalManager, getQuestManager } from "./orchestration/manager.ts";
import { type Project, ProjectStore } from "./persistence/project-store.ts";
import { registerProjects } from "./projects-ui.ts";
import { registerQuestTool } from "./quest-tool.ts";
import { ensureGuildSeeded, loadGuildmasterPrompt } from "./roster.ts";
import { getStatusSurface } from "./status.ts";
import { registerInfoCard } from "./ui.ts";

/**
 * In-memory cache for persona + projects. Eliminates synchronous filesystem
 * I/O on every turn's before_agent_start hook. Cache expires after TTL.
 */
interface PromptCache {
	persona?: string;
	projects: Project[];
	timestamp: number;
}

let promptCache: PromptCache | undefined;
const PROMPT_CACHE_TTL = 60_000; // 1 minute

function getCachedPromptData(): PromptCache {
	const now = Date.now();
	if (promptCache && (now - promptCache.timestamp) < PROMPT_CACHE_TTL) {
		return promptCache;
	}
	
	// Load fresh data
	let persona: string | undefined;
	try {
		persona = loadGuildmasterPrompt();
	} catch (err) {
		console.error("[guildmaster] Failed to load persona:", err);
	}

	let projects: Project[] = [];
	try {
		projects = new ProjectStore().list();
	} catch (err) {
		console.error("[guildmaster] Failed to load projects:", err);
	}

	promptCache = { persona, projects, timestamp: now };
	return promptCache;
}

export default function guildmaster(pi: ExtensionAPI): void {
	// Seed the durable user-owned guild directory once. Filesystem-only and
	// idempotent, so it is safe during extension load.
	let seeded = false;
	try {
		seeded = ensureGuildSeeded();
	} catch {
		// Non-fatal: commands surface an empty roster if seeding failed.
	}

	registerInfoCard(pi);
	registerConsultTool(pi);
	registerQuestTool(pi);
	registerApprovals(pi);
	registerProjects(pi);
	registerCommands(pi);

	// Make the main agent actually BE the Guildmaster, and aware of the user's projects,
	// every turn. Project resolution is name-based (location-independent), not cwd-based.
	// Uses in-memory cache to avoid synchronous disk I/O on the turn-start path.
	pi.on("before_agent_start", async (event) => {
		try {
			// Build prompt from cached data, never reject or hang
			const parts: string[] = [];
			const cached = getCachedPromptData();

			// Add persona if available
			if (cached.persona) {
				parts.push(cached.persona);
			}

			// Add projects block
			const projectBlock = cached.projects.length > 0
				? `## Registered projects\n${cached.projects
						.map(
							(p) =>
								`- ${p.id}${p.aliases?.length ? ` (aka ${p.aliases.join(", ")})` : ""}: ${p.description ?? p.name} — repos: ${p.repos.map((r) => r.name).join(", ")}`,
						)
						.join("\n")}`
				: "## Registered projects\n(none yet — if the user names a project you don't know, ask where it lives and offer to register it with register_project.)";
			parts.push(projectBlock);

			// Always include guidance
			const guidance =
				"When the user refers to a project by name, resolve it to a registered project id and pass it as the `project` argument to consult/quest — do not rely on the current working directory. If the name is unknown or ambiguous, ask the user rather than guessing.";
			parts.push(guidance);

			const addition = parts.join("\n\n");
			return { systemPrompt: `${event.systemPrompt}\n\n${addition}` };
		} catch (err) {
			// Never let this hook reject or hang: fall back to base systemPrompt
			console.error("[guildmaster] before_agent_start hook error:", err);
			return { systemPrompt: event.systemPrompt };
		}
	});

	// Ambient status board: subscribes to the Quest + Approval managers and repaints
	// the widget/footer + toasts on every change, so the user never has to poll (§12).
	const status = getStatusSurface();
	status.init(pi);

	// Cancel any in-flight Quests and release any parked approvals when the session
	// tears down, so background work and dangling promises do not outlive it (§5, §9).
	pi.on("session_shutdown", async () => {
		const manager = getQuestManager();
		for (const quest of manager.getActive()) manager.cancel(quest.id);
		getApprovalManager().denyAll();
	});

	pi.on("session_start", async (event, ctx) => {
		status.attach(ctx);
		if (event.reason === "startup" && seeded) {
			ctx.ui.notify("Guildmaster: seeded default guild roster.", "info");
		}
	});
}
