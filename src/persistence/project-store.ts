/**
 * Project registry (§ project support).
 *
 * A Project is a NAMED grouping of one or more repos, resolved by name rather
 * than by the launch directory — so `pi` from anywhere can talk about any project.
 * Stored as boring JSON, one file per project, outside Pi's session storage.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectConfigOverride } from "../config.ts";
import { projectsDir } from "../paths.ts";
import { slugify } from "../execution/isolation.ts";

/** Cache for the default projects directory to avoid repeated synchronous fs reads. */
let defaultDirCache: { dir: string; projects: Project[]; timestamp: number } | undefined;
const CACHE_TTL = 60_000; // 1 minute

/** Invalidate the project cache (used by reload command). */
export function invalidateProjectCache(): void {
	defaultDirCache = undefined;
}

export interface ProjectRepo {
	name: string;
	path: string;
}

export interface Project {
	id: string;
	name: string;
	description?: string;
	repos: ProjectRepo[];
	aliases?: string[];
	createdAt: number;
	/** Per-project model-alias overrides (Phase 2). */
	config?: ProjectConfigOverride;
	/** Standing project context injected into Consults/Quests for this project (Phase 2). */
	instructions?: string;
}

/** A repo made available to a Party, with whether writes are allowed there. */
export interface RepoContext {
	name: string;
	path: string;
	writable: boolean;
}

/** Detect git repos at a path: the path itself if it's a repo, else its immediate git subdirs. */
export function detectRepos(root: string): ProjectRepo[] {
	const abs = path.resolve(root);
	const isRepo = (p: string) => fs.existsSync(path.join(p, ".git"));
	if (isRepo(abs)) return [{ name: path.basename(abs), path: abs }];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(abs, { withFileTypes: true });
	} catch {
		return [];
	}
	const repos: ProjectRepo[] = [];
	for (const e of entries) {
		if (!e.isDirectory() && !e.isSymbolicLink()) continue;
		const p = path.join(abs, e.name);
		if (isRepo(p)) repos.push({ name: e.name, path: p });
	}
	return repos;
}

export class ProjectStore {
	private readonly dir: string;

	constructor(dir: string = projectsDir()) {
		this.dir = dir;
	}

	private filePath(id: string): string {
		return path.join(this.dir, `${id}.json`);
	}

	save(project: Project): Project {
		fs.mkdirSync(this.dir, { recursive: true });
		const tmp = this.filePath(`.${project.id}.tmp`);
		fs.writeFileSync(tmp, JSON.stringify(project, null, 2), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, this.filePath(project.id));
		// Invalidate cache if this is the default directory
		if (this.dir === projectsDir()) {
			invalidateProjectCache();
		}
		return project;
	}

	load(id: string): Project | undefined {
		try {
			return JSON.parse(fs.readFileSync(this.filePath(id), "utf-8")) as Project;
		} catch {
			return undefined;
		}
	}

	list(): Project[] {
		const defaultDir = projectsDir();
		const isDefault = this.dir === defaultDir;

		// Check cache if this is the default directory
		if (isDefault && defaultDirCache && defaultDirCache.dir === defaultDir) {
			const age = Date.now() - defaultDirCache.timestamp;
			if (age < CACHE_TTL) {
				// Return a deep clone to prevent cache corruption
				return JSON.parse(JSON.stringify(defaultDirCache.projects)) as Project[];
			}
		}

		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return [];
		}
		const out: Project[] = [];
		for (const n of names) {
			if (!n.endsWith(".json") || n.startsWith(".")) continue;
			const p = this.load(n.slice(0, -".json".length));
			if (p) out.push(p);
		}
		const result = out.sort((a, b) => a.name.localeCompare(b.name));

		// Cache if this is the default directory - store a clone
		if (isDefault) {
			defaultDirCache = { dir: defaultDir, projects: result, timestamp: Date.now() };
		}

		// Always return a deep clone to prevent cache corruption from caller mutations
		return JSON.parse(JSON.stringify(result)) as Project[];
	}

	remove(id: string): void {
		try {
			fs.rmSync(this.filePath(id), { force: true });
			// Invalidate cache if this is the default directory
			if (this.dir === projectsDir()) {
				invalidateProjectCache();
			}
		} catch {
			/* ignore */
		}
	}

	/** Create/replace a project from a name + one or more paths (git repos auto-detected). */
	register(input: { name: string; description?: string; paths: string[]; aliases?: string[] }): Project {
		const repos: ProjectRepo[] = [];
		const seen = new Set<string>();
		for (const p of input.paths) {
			for (const repo of detectRepos(p)) {
				if (seen.has(repo.path)) continue;
				seen.add(repo.path);
				repos.push(repo);
			}
		}
		if (repos.length === 0) {
			throw new Error(`No git repositories found under: ${input.paths.join(", ")}`);
		}
		const project: Project = {
			id: slugify(input.name),
			name: input.name,
			description: input.description,
			repos,
			aliases: input.aliases,
			createdAt: Date.now(),
		};
		return this.save(project);
	}
}
