/**
 * Write isolation via git worktrees (§11).
 *
 * Delegated writes must never touch the user's active checkout. A write-Quest
 * gets its own worktree on a new branch off a CLEAN base (the repo's default
 * branch tip), not whatever the user has checked out; Smith/Runner work there.
 * When the Party finishes, changes are committed to the branch so it is
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
	/** The commit SHA the branch was cut from (used for the base..HEAD diff). */
	baseRef: string;
	/** Human-readable label of that base, e.g. "origin/main" (or "HEAD" fallback). */
	baseLabel?: string;
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
 * Resolve a CLEAN base to branch a write-Quest from: the repo's canonical default
 * branch tip (origin/HEAD → origin/main → origin/master → local main/master), NOT
 * whatever the user happens to have checked out. This stops a Quest inheriting the
 * user's in-progress, unmerged work as its base — which once silently made an
 * unrelated WIP branch look like the Quest's own output. Falls back to the current
 * HEAD only when no canonical branch resolves (detached/remote-less repo).
 */
export function resolveCleanBase(repoRoot: string): { ref: string; sha: string } {
	const candidates: string[] = [];
	try {
		// e.g. "refs/remotes/origin/HEAD" -> "refs/remotes/origin/main" -> "origin/main"
		const originHead = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repoRoot).trim();
		if (originHead) candidates.push(originHead.replace(/^refs\/remotes\//, ""));
	} catch {
		/* no origin/HEAD; fall through to explicit candidates */
	}
	candidates.push("origin/main", "origin/master", "main", "master");
	for (const ref of candidates) {
		try {
			const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot).trim();
			if (sha) return { ref, sha };
		} catch {
			/* try next candidate */
		}
	}
	return { ref: "HEAD", sha: git(["rev-parse", "HEAD"], repoRoot).trim() };
}

/**
 * Create a new worktree on a fresh branch off a CLEAN base (see resolveCleanBase).
 * The branch name is derived from the quest title (shared across a cross-repo
 * quest's repos); the worktree lives under the quest id + repo name so multiple
 * repos don't collide.
 */
export function createWorktree(cwd: string, questId: string, title: string, repoName?: string): Isolation {
	const repoRoot = git(["rev-parse", "--show-toplevel"], cwd).trim();
	const base = resolveCleanBase(repoRoot);
	const repo = repoName ?? path.basename(repoRoot);
	const branch = `guildmaster/${slugify(title)}-${questId.slice(-4)}`;
	const worktreePath = path.join(guildmasterHome(), "worktrees", questId, repo);
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	// Branch off the resolved base by SHA (stable even if refs move mid-Quest).
	git(["worktree", "add", "-b", branch, worktreePath, base.sha], repoRoot);
	return { repo, branch, worktreePath, baseRef: base.sha, baseLabel: base.ref, repoRoot };
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
 * Agent scratch/tooling litter that must never enter a commit. Kept narrow and
 * unambiguous so real new files are never excluded. Critical for in-place mode,
 * where the index maps onto the user's real repo; harmless in a disposable worktree.
 */
const SCRATCH_PATTERNS: RegExp[] = [
	/(^|\/)\.?temp[_-]?commit[^/]*\.sh$/i, // e.g. a runner's .temp_commit.sh used to self-commit
	/(^|\/)\.guildmaster[-_][^/]*$/i, // stray guildmaster-* scratch files
];

function isScratch(p: string): boolean {
	return SCRATCH_PATTERNS.some((re) => re.test(p));
}

/**
 * Stage and commit whatever the Party changed in the worktree (so the branch is
 * PR-ready), then return the diff vs the base. Skips hooks to stay bounded.
 *
 * Agent scratch litter is unstaged before committing so it never enters history.
 * In in-place mode (index == the user's real repo) such litter is also deleted
 * from disk, since a clean start means it was created by this quest.
 */
export function commitAndDiff(iso: Isolation, message: string): WorktreeChanges {
	git(["add", "-A"], iso.worktreePath);

	// Never commit agent scratch/tooling litter.
	const staged = git(["diff", "--cached", "--name-only"], iso.worktreePath)
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const f of staged.filter(isScratch)) {
		try {
			git(["restore", "--staged", "--", f], iso.worktreePath);
		} catch {
			try {
				git(["reset", "-q", "--", f], iso.worktreePath);
			} catch {
				/* ignore */
			}
		}
		if (isInPlace(iso)) {
			try {
				fs.unlinkSync(path.join(iso.worktreePath, f));
			} catch {
				/* ignore */
			}
		}
	}

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

/** True when this isolation is the user's real checkout (in-place mode), not a worktree. */
export function isInPlace(iso: Isolation): boolean {
	return iso.worktreePath === iso.repoRoot;
}

/**
 * Tear down a worktree isolation: remove the worktree, delete its branch, prune.
 * NO-OP for in-place isolations — that branch lives in the user's real checkout and
 * must never be force-removed by a dismiss.
 */
export function discardIsolation(iso: Isolation): void {
	if (isInPlace(iso)) return;
	removeWorktree(iso);
	try {
		git(["branch", "-D", iso.branch], iso.repoRoot);
	} catch {
		/* ignore */
	}
	try {
		git(["worktree", "prune"], iso.repoRoot);
	} catch {
		/* ignore */
	}
}
