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

export type SigningMode = "explicit-on" | "explicit-off" | "key-only" | "none";

/**
 * How the user's git config (as seen from `cwd`) wants commits signed:
 *  - explicit-on / explicit-off: commit.gpgsign is set; git itself honours it.
 *  - key-only: commit.gpgsign is unset but user.signingkey is set — Guildmaster
 *    signs party commits by default (a configured key means signed commits are wanted).
 *  - none: neither is set.
 * An unreadable commit.gpgsign (e.g. an invalid boolean) is treated as explicit-on,
 * which leaves the decision (and the error) to git.
 */
export function signingMode(cwd: string): SigningMode {
	try {
		const v = git(["config", "--type=bool", "--get", "commit.gpgsign"], cwd).trim();
		return v === "false" ? "explicit-off" : "explicit-on";
	} catch (e) {
		if ((e as { status?: number }).status !== 1) return "explicit-on";
	}
	try {
		return git(["config", "--get", "user.signingkey"], cwd).trim() ? "key-only" : "none";
	} catch {
		return "none";
	}
}

/** True when signing applies to party commits in this mode (explicit-off / none leave them alone). */
function signs(mode: SigningMode): boolean {
	return mode === "explicit-on" || mode === "key-only";
}

/** Commits in baseRef..HEAD whose header has no signature (`gpgsig` / `gpgsig-sha256`). */
export function unsignedCommits(iso: Isolation): string[] {
	return git(["rev-list", `${iso.baseRef}..HEAD`], iso.worktreePath)
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)
		.filter((sha) => {
			const raw = git(["cat-file", "commit", sha], iso.worktreePath);
			const end = raw.indexOf("\n\n");
			const header = end === -1 ? raw : raw.slice(0, end);
			return !header.split("\n").some((l) => l.startsWith("gpgsig"));
		});
}

/**
 * Re-sign member commits made without signing (e.g. a runner's plain `git commit`).
 * Signing is injected only here, scoped to the worktree's own branch, never via env
 * (GIT_CONFIG_* would leak into every repo a member touches, e.g. test fixtures).
 * baseRef..HEAD is local and unpublished (a new branch's clean base, or the PR head
 * at attach), so rewriting it is safe. It refuses (without rewriting) when the range
 * holds a merge commit (a rebase would flatten it) or tracked changes are uncommitted.
 * On failure the rebase is aborted, the tip is checked against the original, and a
 * clear error is thrown: never push unsigned silently.
 */
function resignMemberCommits(iso: Isolation, mode: SigningMode): void {
	if (!signs(mode)) return;
	if (unsignedCommits(iso).length === 0) return;
	const { key, why } = signingContext(iso.worktreePath, mode);
	const keyHint = `make the key available (e.g. \`ssh-add${key ? ` ${key}` : ""}\` or unlock gpg-agent)`;
	const intro = `Commit signing is configured, but the party's member commits on \`${iso.branch}\``;

	const merges = git(["rev-list", "--merges", `${iso.baseRef}..HEAD`], iso.worktreePath).trim();
	if (merges) {
		throw new Error(
			`${intro} include merge commit(s) (${merges.split("\n")[0].slice(0, 12)}\u2026), which can't be safely re-signed automatically: ` +
				`a rebase would flatten them. Nothing was rewritten or pushed. ${why} To fix by hand: ${keyHint}, then in ${iso.worktreePath} ` +
				`re-sign each unsigned commit (e.g. \`git rebase --rebase-merges --gpg-sign ${iso.baseRef}\`, then check the history), or set commit.gpgsign=false to opt out.`,
		);
	}
	const dirty = git(["status", "--porcelain", "--untracked-files=no"], iso.worktreePath).trim();
	if (dirty) {
		throw new Error(
			`${intro} could not be re-signed: the worktree ${iso.worktreePath} has uncommitted changes to tracked files, ` +
				`so the branch was not rewritten. Nothing was pushed. Commit or discard them (\`git -C ${iso.worktreePath} status\`), ` +
				`then run \`git -C ${iso.worktreePath} rebase --force-rebase --gpg-sign ${iso.baseRef}\`, or set commit.gpgsign=false to opt out.`,
		);
	}

	const originalTip = git(["rev-parse", "HEAD"], iso.worktreePath).trim();
	try {
		// --no-verify: skip hooks, as the commit does.
		git(["rebase", "--force-rebase", "--gpg-sign", "--no-verify", iso.baseRef], iso.worktreePath);
	} catch (e) {
		try {
			git(["rebase", "--abort"], iso.worktreePath);
		} catch {
			/* best effort: nothing to abort */
		}
		let tipNow = "";
		try {
			tipNow = git(["rev-parse", "HEAD"], iso.worktreePath).trim();
		} catch {
			/* unreadable HEAD: reported as not restored */
		}
		const state =
			tipNow === originalTip
				? `The rebase was aborted and the branch was restored to its original tip ${originalTip}; no commit was rewritten.`
				: `The rebase was aborted but the branch was NOT restored: HEAD is ${tipNow || "unreadable"}, the original tip was ${originalTip} ` +
					`(recover with \`git -C ${iso.worktreePath} reset --hard ${originalTip}\`).`;
		throw new Error(
			`${intro} could not be re-signed: ${firstErrorLine(e)}. ${why} Nothing was pushed. ${state} To fix: ${keyHint}, ` +
				`then run \`git -C ${iso.worktreePath} rebase --force-rebase --gpg-sign ${iso.baseRef}\`, or set commit.gpgsign=false to opt out.`,
		);
	}
}

function gh(args: string[], cwd: string): string {
	return execFileSync("gh", args, { cwd, encoding: "utf-8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attach a worktree to an EXISTING PR's head branch, so a write-Quest iterates on
 * a PR we already raised (addressing review feedback) instead of cutting a fresh
 * branch off main.
 *
 * It creates a detached worktree (never touching the user's real checkout) and
 * uses `gh pr checkout` inside it to fetch the PR head into a quest-scoped local
 * branch — which also sets up the correct upstream tracking, including for PRs
 * from forks. The base ref is the PR head tip at attach time, so the committed
 * diff shows only what this Quest adds on top of the existing PR.
 */
export function attachToExistingBranch(
	cwd: string,
	questId: string,
	opts: { number: number; slug?: string; repoName?: string },
): Isolation {
	const repoRoot = git(["rev-parse", "--show-toplevel"], cwd).trim();
	const repo = opts.repoName ?? path.basename(repoRoot);
	const worktreePath = path.join(guildmasterHome(), "worktrees", questId, repo);
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	// Quest-scoped local branch name avoids colliding with any branch already
	// checked out in the user's real repo or another worktree.
	const localBranch = `guildmaster/pr-${opts.number}-${questId.slice(-4)}`;
	// Detached worktree first (uses HEAD; we immediately replace its contents).
	git(["worktree", "add", "--detach", worktreePath], repoRoot);
	const repoFlag = opts.slug ? ["--repo", opts.slug] : [];
	// Fetch + checkout the PR head into the worktree, naming the local branch.
	gh(["pr", "checkout", String(opts.number), ...repoFlag, "--branch", localBranch], worktreePath);
	const baseRef = git(["rev-parse", "HEAD"], worktreePath).trim();
	return { repo, branch: localBranch, worktreePath, baseRef, baseLabel: `PR #${opts.number}`, repoRoot };
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
	/(^|\/)\.?guildmaster[-_][^/]*$/i, // stray guildmaster-* scratch files
];

function isScratch(p: string): boolean {
	return SCRATCH_PATTERNS.some((re) => re.test(p));
}

/**
 * Additional repo-root junk patterns: agent-generated planning docs and ad-hoc
 * scripts that should not enter commits. Only applied to files at repo root
 * (no "/" in path) to avoid filtering legitimate nested files.
 */
const REPO_ROOT_JUNK_PATTERNS: RegExp[] = [
	// Planning/summary docs agents write for themselves
	/^(IMPLEMENTATION|VERIFICATION|PR_DESCRIPTION|CHANGES|BUGFIX)[-_]?\w*\.md$/i,
	/^\w*[-_]?(SUMMARY|NOTES|PLAN|TODO|CHECKLIST)\.md$/i,
	// Ad-hoc verification/test scripts (NOT test-utils.ts or src/test-*.ts)
	/^(run|verify|test|check|quick|repro)[-_][\w-]*\.(js|ts|sh)$/i,
];

/**
 * Classify paths as agent junk that should be excluded from commits.
 * Returns the subset of paths that match junk patterns.
 * 
 * Existing SCRATCH_PATTERNS apply at any depth (tooling litter).
 * REPO_ROOT_JUNK_PATTERNS apply only at repo root (planning docs, ad-hoc scripts).
 */
export function classifyWorktreeJunk(paths: string[]): string[] {
	return paths.filter((p) => {
		// Existing scratch patterns apply anywhere
		if (isScratch(p)) return true;
		// Repo-root junk: only top-level files (no "/" in path)
		if (!p.includes("/") && REPO_ROOT_JUNK_PATTERNS.some((re) => re.test(p))) return true;
		return false;
	});
}

/**
 * How many commits the isolation's branch HEAD is ahead of its base
 * (`git rev-list --count <baseRef>..HEAD` in the worktree). Git errors propagate:
 * an unreadable worktree must not masquerade as "no commits".
 */
export function commitsAhead(iso: Isolation): number {
	const out = git(["rev-list", "--count", `${iso.baseRef}..HEAD`], iso.worktreePath).trim();
	const n = Number(out);
	if (!Number.isInteger(n) || n < 0) throw new Error(`Unexpected git rev-list --count output: "${out}"`);
	return n;
}

/**
 * Stage and commit whatever the Party changed in the worktree (so the branch is
 * PR-ready), then return the diff vs the base. Skips hooks to stay bounded.
 *
 * `committed` means the branch has commits ahead of the base AFTER this step —
 * including commits a member (e.g. runner) already made during the Quest, which
 * leave a clean tree and nothing staged here.
 *
 * When signing applies (explicit-on, or key-only), member commits in baseRef..HEAD
 * that lack a signature are re-signed (see resignMemberCommits); failure throws.
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
	const junk = classifyWorktreeJunk(staged);
	if (junk.length > 0) {
		console.log(`[isolation] Excluding ${junk.length} junk file(s) from commit: ${junk.join(", ")}`);
	}
	for (const f of junk) {
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

	const mode = signingMode(iso.worktreePath);
	if (hasChanges) {
		// key-only: sign this one command (scoped `-c`); explicit settings are left to git.
		const signArgs = mode === "key-only" ? ["-c", "commit.gpgsign=true"] : [];
		try {
			git([...signArgs, "commit", "-m", message, "--no-verify"], iso.worktreePath);
		} catch (e) {
			// Never fall back to an unsigned commit: the user's config asks for signing.
			if (!signs(mode)) throw e;
			throw new Error(signingFailureMessage(iso.worktreePath, mode, e));
		}
	}

	// A member (e.g. a runner) may have committed without signing: re-sign before the diff.
	resignMemberCommits(iso, mode);

	// Judge by the branch, not the index: a member's own commit is real work.
	const committed = commitsAhead(iso) > 0;
	const range = `${iso.baseRef}..HEAD`;
	return {
		committed,
		stat: committed ? git(["diff", "--stat", range], iso.worktreePath).trim() : "",
		diff: committed ? git(["diff", range], iso.worktreePath) : "",
	};
}

/** The first non-empty stderr line of a failed git call (else its message's first line). */
function firstErrorLine(e: unknown): string {
	const err = e as { stderr?: string | Buffer; message?: string };
	return (
		`${err.stderr ?? ""}`
			.split("\n")
			.map((s) => s.trim())
			.find(Boolean) ?? (err.message ?? String(e)).split("\n")[0]
	);
}

/** The configured signing key (if any) and a sentence on why Guildmaster signs. */
function signingContext(worktreePath: string, mode: SigningMode): { key: string; why: string } {
	let key = "";
	try {
		key = git(["config", "--get", "user.signingkey"], worktreePath).trim();
	} catch {
		/* no key configured */
	}
	const why =
		mode === "key-only"
			? `Your git config has a signing key (${key}); Guildmaster signs party commits when one is set.`
			: `Your git config enables commit signing (commit.gpgsign=true${key ? `, key ${key}` : ""}).`;
	return { key, why };
}

function signingFailureMessage(worktreePath: string, mode: SigningMode, e: unknown): string {
	const detail = firstErrorLine(e);
	const { key, why } = signingContext(worktreePath, mode);
	return (
		`Signing the commit failed: ${detail}. ${why} The changes are still uncommitted in ${worktreePath}. ` +
		`Make the key available (e.g. \`ssh-add${key ? ` ${key}` : ""}\` or unlock gpg-agent), then commit and push from there, ` +
		"or set commit.gpgsign=false to opt out."
	);
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
