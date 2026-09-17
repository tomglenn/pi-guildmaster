/**
 * Project / repo resolution for the consult and quest tools.
 *
 * Resolution is name-based (never cwd): the Guildmaster passes a `project` string
 * (and optional `repo`); we map it to a registered Project. Ambiguity and unknown
 * names return an error the model surfaces to the user ("ask when unsure"), rather
 * than guessing.
 */

import { execFileSync } from "node:child_process";
import type { Project, ProjectRepo, RepoContext } from "../persistence/project-store.ts";
import type { ProjectStore } from "../persistence/project-store.ts";
import { repoSlugFromRemote } from "../execution/policy.ts";

export interface ProjectResolution {
	project?: Project;
	error?: string;
}

export function resolveProjectQuery(store: ProjectStore, query: string): ProjectResolution {
	const all = store.list();
	const q = query.trim().toLowerCase();
	if (!q) return { error: "No project name given." };
	if (all.length === 0) {
		return { error: `No projects are registered yet. Ask the user where "${query}" lives, then register it with register_project.` };
	}
	const exact = all.find(
		(p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q || (p.aliases ?? []).some((a) => a.toLowerCase() === q),
	);
	if (exact) return { project: exact };

	const partial = all.filter(
		(p) =>
			p.id.toLowerCase().includes(q) ||
			p.name.toLowerCase().includes(q) ||
			(p.description ?? "").toLowerCase().includes(q),
	);
	if (partial.length === 1) return { project: partial[0] };
	if (partial.length > 1) {
		return { error: `"${query}" is ambiguous — could be: ${partial.map((p) => p.id).join(", ")}. Ask the user which one.` };
	}
	return {
		error: `Unknown project "${query}". Registered: ${all.map((p) => p.id).join(", ") || "none"}. Ask the user where it lives and offer to register it.`,
	};
}

export interface RepoPick {
	repo?: ProjectRepo;
	error?: string;
}

/** Pick a single repo from a project: by name, or the sole repo, else ask. */
export function pickRepo(project: Project, repo?: string): RepoPick {
	if (repo) {
		const found = project.repos.find((r) => r.name === repo);
		return found
			? { repo: found }
			: { error: `Project "${project.id}" has no repo "${repo}". Repos: ${project.repos.map((r) => r.name).join(", ")}.` };
	}
	if (project.repos.length === 1) return { repo: project.repos[0] };
	return {
		error: `Project "${project.id}" has multiple repos (${project.repos.map((r) => r.name).join(", ")}). Specify which with \`repo\`.`,
	};
}

/** All of a project's repos as read-only contexts (for investigation across repos). */
export function readonlyContexts(project: Project): RepoContext[] {
	return project.repos.map((r) => ({ name: r.name, path: r.path, writable: false }));
}

/** The GitHub owner/repo slug of a checkout's origin remote, if any. */
export function repoOriginSlug(repoPath: string): string | undefined {
	try {
		const url = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd: repoPath,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return repoSlugFromRemote(url);
	} catch {
		return undefined;
	}
}

/**
 * Pick the project repo whose origin remote matches a GitHub owner/repo slug
 * (case-insensitive). Lets an "address-feedback" quest infer the repo straight
 * from a PR URL instead of the user naming it.
 */
export function pickRepoBySlug(project: Project, slug: string | undefined): ProjectRepo | undefined {
	if (!slug) return undefined;
	const want = slug.toLowerCase();
	return project.repos.find((r) => repoOriginSlug(r.path)?.toLowerCase() === want);
}
