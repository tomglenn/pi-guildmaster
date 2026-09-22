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
 *
 * HOST SHELL GATE: The host Guildmaster agent's bash tool is now gated via a
 * tool_call event. Destructive operations (gh pr close --delete-branch, git
 * push --force, rm -rf, etc.) and remote mutations require explicit human approval
 * before they run. Child agents remain structurally sandboxed (no bash tool at all).
 */

import type { BashToolCallEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApprovals } from "./approvals-ui.ts";
import { registerCommands } from "./commands.ts";
import { registerConsultTool } from "./consult.ts";
import { gateHostCommand } from "./execution/host-gate.ts";
import { getApprovalManager, getQuestManager } from "./orchestration/manager.ts";
import { type Project, ProjectStore } from "./persistence/project-store.ts";
import { registerProjects } from "./projects-ui.ts";
import { registerQuestTool } from "./quest-tool.ts";
import { ensureGuildSeeded, loadGuildmasterPrompt } from "./roster.ts";
import { getStatusSurface } from "./status.ts";
import { registerInfoCard } from "./ui.ts";



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
			// Build prompt from cached persona + ProjectStore's cached projects
			const parts: string[] = [];

			// Add persona if available (uses roster.ts cache)
			const persona = loadGuildmasterPrompt();
			if (persona) {
				parts.push(persona);
			}

			// Add projects block (ProjectStore.list() uses its own cache)
			let projects: Project[] = [];
			try {
				projects = new ProjectStore().list();
			} catch (err) {
				console.error("[guildmaster] Failed to load projects:", err);
			}

			const projectBlock = projects.length > 0
				? `## Registered projects\n${projects
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

	// Gate the host agent's bash tool. Child agents are structurally sandboxed (no bash),
	// and the review envoy + runner shells are policy-gated separately. This event handler
	// ensures the host's own destructive actions require explicit human approval.
	//
	// Forbidden operations are blocked outright; destructive/mutating operations park an
	// approval; reads pass freely. Never throws: on internal error, fail safe by blocking.
	pi.on("tool_call", async (event, ctx) => {
		try {
			// Only gate host shell tools (bash)
			if (event.toolName !== "bash") {
				return undefined;
			}

			// Type narrow to BashToolCallEvent
			const bashEvent = event as BashToolCallEvent;
			const command = bashEvent.input.command;
			if (typeof command !== "string" || !command.trim()) {
				return undefined; // Empty/invalid command, let it pass (will fail naturally)
			}

			// Classify and gate
			const decision = gateHostCommand(command);

			// Forbidden → block
			if (decision.blocked) {
				return {
					block: true,
					reason: `REFUSED: ${decision.operation} — ${decision.reason}`,
					terminate: false,
				};
			}

			// Destructive or mutate → park approval
			if (decision.needsApproval) {
				const approvalMgr = getApprovalManager();
				const title = `Host shell: ${decision.operation}`;
				const description = `Command: ${command.length > 100 ? command.slice(0, 97) + "..." : command}`;

				const approved = await approvalMgr.request({
					title,
					description,
					operation: decision.operation,
				});

				if (!approved) {
					return {
						block: true,
						reason: `DENIED: ${decision.operation} — approval was denied by user`,
						terminate: false,
					};
				}

				// Approved → allow (return undefined)
				return undefined;
			}

			// Read → pass
			return undefined;
		} catch (err) {
			console.error("[guildmaster] tool_call handler error:", err);
			const cmd = event.toolName === "bash" ? (event as BashToolCallEvent).input.command : "";
			return {
				block: true,
				reason: `BLOCKED: internal gate error for "${cmd.slice(0, 50)}..." — failing safe`,
				terminate: false,
			};
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
