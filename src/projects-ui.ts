/**
 * Project management surface.
 *
 * The Guildmaster resolves a spoken project name to a registered Project (see the
 * persona injection in index.ts). These tools let it *register* a project on the
 * fly when the user names one it doesn't know ("ask when unsure"), and list what's
 * registered. Repos are auto-detected from the given paths.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { detectRepos, ProjectStore } from "./persistence/project-store.ts";
import { type CardLine, showCard } from "./ui.ts";

export function registerProjects(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "register_project",
		label: "Register Project",
		description:
			"Register a named project so it can be worked on from anywhere. Give one or more paths; git repos " +
			"under them are auto-detected. Use this when the user names a project you don't recognise, after " +
			"confirming with them where it lives.",
		promptSnippet: "Register a named project (with its repos) so Quests/Consults can target it from any directory",
		promptGuidelines: [
			"Use register_project only after the user tells you where an unknown project lives. Confirm the detected repos back to them.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Human name for the project (e.g. 'Pathfinder')" }),
			paths: Type.Array(Type.String(), { description: "Directories to scan for git repos (a repo, or a folder of repos)" }),
			description: Type.Optional(Type.String({ description: "One-line description" })),
			aliases: Type.Optional(Type.Array(Type.String(), { description: "Alternative names the user might use" })),
		}),
		async execute(_toolCallId, params) {
			const project = new ProjectStore().register(params);
			const repos = project.repos.map((r) => `${r.name} (${r.path})`).join(", ");
			return {
				content: [{ type: "text", text: `Registered project "${project.id}" with repos: ${repos}.` }],
				details: project,
			};
		},
	});

	pi.registerTool({
		name: "projects",
		label: "Projects",
		description: "List registered projects and their repos. Use to see what projects you can target.",
		promptSnippet: "List registered projects and their repos",
		parameters: Type.Object({}),
		async execute() {
			const all = new ProjectStore().list();
			if (all.length === 0) {
				return { content: [{ type: "text", text: "No projects registered yet." }], details: { projects: all } };
			}
			const text = all
				.map((p) => `- ${p.id}${p.aliases?.length ? ` (aka ${p.aliases.join(", ")})` : ""}: ${p.description ?? p.name}\n    repos: ${p.repos.map((r) => `${r.name} → ${r.path}`).join(", ")}`)
				.join("\n");
			return { content: [{ type: "text", text }], details: { projects: all } };
		},
	});

	pi.registerTool({
		name: "update_project",
		label: "Update Project",
		description:
			"Modify a registered project: add/remove repos, set description/aliases, set standing instructions, or " +
			"set per-project model aliases. Use to maintain a project without editing files.",
		promptSnippet: "Edit a registered project (repos, description, aliases, instructions, model overrides)",
		parameters: Type.Object({
			id: Type.String({ description: "Project id to update" }),
			addPaths: Type.Optional(Type.Array(Type.String(), { description: "Paths to scan for repos to add" })),
			removeRepos: Type.Optional(Type.Array(Type.String(), { description: "Repo names to remove" })),
			description: Type.Optional(Type.String()),
			aliases: Type.Optional(Type.Array(Type.String())),
			instructions: Type.Optional(Type.String({ description: "Standing context injected into this project's Consults/Quests" })),
			models: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Per-project alias → provider/model overrides" })),
			guildmasterModel: Type.Optional(Type.String()),
			partyLeaderModel: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params) {
			const store = new ProjectStore();
			const project = store.load(params.id);
			if (!project) throw new Error(`No project "${params.id}". Registered: ${store.list().map((p) => p.id).join(", ") || "none"}.`);

			if (params.addPaths?.length) {
				const seen = new Set(project.repos.map((r) => r.path));
				for (const p of params.addPaths) for (const repo of detectRepos(p)) if (!seen.has(repo.path)) { seen.add(repo.path); project.repos.push(repo); }
			}
			if (params.removeRepos?.length) project.repos = project.repos.filter((r) => !params.removeRepos!.includes(r.name));
			if (project.repos.length === 0) throw new Error("Refusing to leave a project with no repos.");
			if (params.description !== undefined) project.description = params.description;
			if (params.aliases !== undefined) project.aliases = params.aliases;
			if (params.instructions !== undefined) project.instructions = params.instructions;
			if (params.models || params.guildmasterModel !== undefined || params.partyLeaderModel !== undefined) {
				project.config = {
					...project.config,
					models: { ...project.config?.models, ...(params.models ?? {}) },
					guildmasterModel: params.guildmasterModel ?? project.config?.guildmasterModel,
					partyLeaderModel: params.partyLeaderModel ?? project.config?.partyLeaderModel,
				};
			}
			store.save(project);
			const repos = project.repos.map((r) => r.name).join(", ");
			return { content: [{ type: "text", text: `Updated "${project.id}". Repos: ${repos}.` }], details: project };
		},
	});

	pi.registerTool({
		name: "remove_project",
		label: "Remove Project",
		description: "Unregister a project (does not touch the repos on disk). Confirm with the user first.",
		promptSnippet: "Unregister a project from the registry (repos on disk are untouched)",
		parameters: Type.Object({ id: Type.String({ description: "Project id to remove" }) }),
		async execute(_toolCallId, params) {
			const store = new ProjectStore();
			if (!store.load(params.id)) throw new Error(`No project "${params.id}".`);
			store.remove(params.id);
			return { content: [{ type: "text", text: `Unregistered project "${params.id}". Repos on disk are untouched.` }], details: {} };
		},
	});

	pi.registerCommand("project-remove", {
		description: "Unregister a project by id",
		getArgumentCompletions: (prefix) => {
			const items = new ProjectStore().list().map((p) => ({ value: p.id, label: p.name }));
			const f = items.filter((i) => i.value.startsWith(prefix.trim()));
			return f.length > 0 ? f : items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const id = args.trim();
			const store = new ProjectStore();
			if (!store.load(id)) {
				ctx.ui.notify(`No project "${id}".`, "warning");
				return;
			}
			store.remove(id);
			ctx.ui.notify(`Unregistered project "${id}".`, "info");
		},
	});

	pi.registerCommand("projects", {
		description: "Show registered projects",
		handler: async (_args, _ctx) => {
			const all = new ProjectStore().list();
			if (all.length === 0) {
				showCard(pi, { title: "Projects", lines: [{ text: "No projects registered yet.", color: "muted" }] });
				return;
			}
			const lines: CardLine[] = [];
			for (const p of all) {
				lines.push({ text: `${p.id}${p.aliases?.length ? ` (aka ${p.aliases.join(", ")})` : ""}`, bold: true });
				lines.push({ text: p.description ?? p.name, color: "muted", indent: 2 });
				for (const r of p.repos) lines.push({ text: `${r.name} → ${r.path}`, color: "dim", indent: 2 });
			}
			showCard(pi, { title: `Projects (${all.length})`, lines });
		},
	});
}
