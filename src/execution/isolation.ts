/**
 * Write isolation via git worktrees (§11).
 *
 * Delegated writes must never touch the user's active checkout. A write-Quest
 * gets its own worktree on a new branch off the current HEAD; Smith/Runner work
 * there. When the Party finishes, changes are committed to the branch so it is
 * PR-ready. Nothing is pushed — raising the PR is M9's approval-gated step.
 *
 * The branch is the reconciliation boundary: it becomes a draft PR the user
 * reviews and tweaks, then hands to their team. Guildmaster never merges.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { guildmasterHome } from "../paths.ts";

export interface Isolation {
	repo: string;
	branch: string;
	worktreePath: string;
	baseRef: string;
	repoRoot: string;
}

export interface WorktreeChanges {
	committed: boolean;
	stat: string;
	diff: string;
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

export function isGitRepo(cwd: string): boolean {
	try {
		return git(["rev-parse", "--is-inside-work-tree"], cwd).trim() === "true";
	} catch {
		return false;
	}
}

/** True if the repo has no uncommitted changes (clean base for in-place work). */
export function isWorkingTreeClean(cwd: string): boolean {
	try {
		return git(["status", "--porcelain"], cwd).trim() === "";
	} catch {
		return false;
	}
}

export function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "change"
	);
}

/**
 * Create a new worktree on a fresh branch off the current HEAD. The branch name is
 * derived from the quest title (shared across a cross-repo quest's repos); the
 * worktree lives under the quest id + repo name so multiple repos don't collide.
 */
export function createWorktree(cwd: string, questId: string, title: string, repoName?: string): Isolation {
	const repoRoot = git(["rev-parse", "--show-toplevel"], cwd).trim();
	const baseRef = git(["rev-parse", "HEAD"], repoRoot).trim();
	const repo = repoName ?? path.basename(repoRoot);
	const branch = `guildmaster/${slugify(title)}-${questId.slice(-4)}`;
	const worktreePath = path.join(guildmasterHome(), "worktrees", questId, repo);
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	git(["worktree", "add", "-b", branch, worktreePath, baseRef], repoRoot);
	return { repo, branch, worktreePath, baseRef, repoRoot };
}

/**
 * IN-PLACE isolation (opt-in, fast-iteration): no separate worktree. Creates a
 * fresh branch off HEAD checked out in the user's REAL repo, so the Party edits
 * the live checkout directly. Changes still land on a reviewable branch. Requires
 * a clean working tree so the branch has a clean base to diff against.
 *
 * This deliberately bypasses the worktree safety boundary and mutates the user's
 * actual checkout — only used when the caller explicitly asks for it.
 */
export function inPlaceIsolation(cwd: string, questId: string, title: string, repoName?: string): Isolation {
	const repoRoot = git(["rev-parse", "--show-toplevel"], cwd).trim();
	const repo = repoName ?? path.basename(repoRoot);
	if (!isWorkingTreeClean(repoRoot)) {
		throw new Error(`In-place Quest requires a clean working tree in "${repo}"; commit or stash your changes first.`);
	}
	const baseRef = git(["rev-parse", "HEAD"], repoRoot).trim();
	const branch = `guildmaster/${slugify(title)}-${questId.slice(-4)}`;
	git(["checkout", "-b", branch], repoRoot);
	return { repo, branch, worktreePath: repoRoot, baseRef, repoRoot };
}

/**
 * Stage and commit whatever the Party changed in the worktree (so the branch is
 * PR-ready), then return the diff vs the base. Skips hooks to stay bounded.
 */
export function commitAndDiff(iso: Isolation, message: string): WorktreeChanges {
	git(["add", "-A"], iso.worktreePath);

	let hasChanges = false;
	try {
		git(["diff", "--cached", "--quiet"], iso.worktreePath);
	} catch {
		hasChanges = true; // non-zero exit => staged changes exist
	}

	if (hasChanges) {
		git(["commit", "-m", message, "--no-verify"], iso.worktreePath);
	}

	const range = `${iso.baseRef}..HEAD`;
	return {
		committed: hasChanges,
		stat: hasChanges ? git(["diff", "--stat", range], iso.worktreePath).trim() : "",
		diff: hasChanges ? git(["diff", range], iso.worktreePath) : "",
	};
}

/** Remove a worktree (best-effort). Kept around by default for reattach/PR. */
export function removeWorktree(iso: Isolation): void {
	try {
		git(["worktree", "remove", "--force", iso.worktreePath], iso.repoRoot);
	} catch {
		/* ignore */
	}
}
