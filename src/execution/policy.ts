/**
 * Operation-aware permission policy (§10).
 *
 * Command names are NOT sufficient evidence of danger. `gh pr view` is a read;
 * `gh pr merge` is a mutation (and, for Guildmaster, forbidden). This classifier
 * understands the subcommand well enough to distinguish them, so gating decisions
 * are based on the actual operation rather than the binary name.
 *
 * Extended with DESTRUCTIVE operation recognition for host agent gating: operations
 * that must always require explicit human approval before running (PR/repo deletion,
 * force push, branch deletion, etc.).
 */

export type OpClass = "read" | "mutate" | "destructive" | "forbidden";

export interface OpDecision {
	klass: OpClass;
	operation: string;
	reason: string;
}

function basename(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i === -1 ? p : p.slice(i + 1);
}

// `checkout` is local-only (fetches the PR ref + switches a local branch); no remote
// mutation, so it counts as a read for gating purposes.
const GH_PR_READ = new Set(["view", "list", "checks", "diff", "status", "checkout"]);

/** Classify a shell command's privilege. Unknown/non-git-gh commands are treated as read. */
export function classifyCommand(command: string): OpDecision {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { klass: "read", operation: "", reason: "empty command" };

	const bin = basename(tokens[0]);

	if (bin === "git") {
		const sub = tokens.find((t, i) => i > 0 && !t.startsWith("-"));
		if (sub === "push") return { klass: "mutate", operation: "git push", reason: "pushes commits to a remote" };
		return { klass: "read", operation: `git ${sub ?? ""}`.trim(), reason: "local git operation (worktree-scoped)" };
	}

	if (bin === "gh") {
		const sub = tokens[1];
		const sub2 = tokens[2];

		if (sub === "pr" && sub2 === "merge") {
			return { klass: "forbidden", operation: "gh pr merge", reason: "Guildmaster never merges; merging is the team's decision" };
		}

		const isApiWrite = sub === "api" && /(?:-X|--method)\s*(POST|PUT|PATCH|DELETE)/i.test(command);
		const isApiRead = sub === "api" && !isApiWrite;
		const isRead =
			(sub === "pr" && GH_PR_READ.has(sub2)) ||
			(sub === "repo" && sub2 === "view") ||
			(sub === "issue" && (sub2 === "view" || sub2 === "list")) ||
			sub === "search" ||
			sub === "status" ||
			isApiRead;

		if (isRead) return { klass: "read", operation: `gh ${sub} ${sub2 ?? ""}`.trim(), reason: "read-only gh query" };
		if (isApiWrite) return { klass: "mutate", operation: "gh api (write)", reason: "mutating API call" };
		return { klass: "mutate", operation: `gh ${sub ?? ""} ${sub2 ?? ""}`.trim(), reason: "gh mutation" };
	}

	return { klass: "read", operation: bin, reason: "non-privileged command" };
}

export interface ReviewGate extends OpDecision {
	/** Requires human approval before it may run (mutations in a review quest). */
	needsApproval: boolean;
	/** Hard-blocked regardless of approval (merge; suspected security fix auto-publish). */
	blocked: boolean;
}

/**
 * Gate a shell command for the review envoy. Reads run freely; mutations require
 * approval and are only allowed in review mode; `gh pr merge` is always blocked;
 * a suspected security fix is blocked from auto-publish so it cannot be posted
 * without explicit out-of-band confirmation (§ org policy).
 */
export function gateReviewCommand(command: string, opts: { reviewMode: boolean; prText?: string }): ReviewGate {
	const d = classifyCommand(command);
	if (d.klass === "forbidden") return { ...d, needsApproval: false, blocked: true };
	if (d.klass === "read") return { ...d, needsApproval: false, blocked: false };
	// mutate:
	if (!opts.reviewMode) {
		return { ...d, reason: "mutations are only allowed inside a PR-review quest", needsApproval: false, blocked: true };
	}
	if (opts.prText && isLikelySecurityFix(opts.prText)) {
		return { ...d, reason: "suspected security fix — must be confirmed out of band before posting", needsApproval: false, blocked: true };
	}
	return { ...d, needsApproval: true, blocked: false };
}

/**
 * Split a command line into the sub-commands joined by shell operators (&& || ; |),
 * so a chained line like `npm test && git push` is classified segment-by-segment
 * and a mutation cannot ride in on the back of an innocent first token.
 */
export function splitShellSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\|/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export interface RunnerGate {
	/** Hard-refused: the runner may not run this command at all. */
	blocked: boolean;
	operation?: string;
	reason?: string;
}

/**
 * Gate a shell command for the write-Quest runner (exec tier).
 *
 * The runner does LOCAL work only — build, test, lint, and worktree-scoped git
 * (add/commit/branch/checkout). Every remote mutation is refused: `git push`,
 * `gh pr create`, mutating `gh api` calls, and (always) `gh pr merge`. Pushing a
 * branch and opening a draft PR is the job of the dedicated raise path, never a
 * runner acting mid-Quest — that is exactly the hole that let a party open a PR
 * out of band. Reads pass freely; so does all local git.
 */
export function gateRunnerCommand(command: string): RunnerGate {
	for (const seg of splitShellSegments(command)) {
		const d = classifyCommand(seg);
		if (d.klass === "forbidden") {
			return { blocked: true, operation: d.operation, reason: d.reason };
		}
		if (d.klass === "mutate") {
			const reason =
				d.operation === "git push"
					? "the runner never pushes; a completed write-Quest is pushed and opened as a draft PR via the raise_pr path"
					: `${d.operation} is a remote mutation and is not allowed from a runner`;
			return { blocked: true, operation: d.operation, reason };
		}
	}
	return { blocked: false };
}

/**
 * Detect shell wrapper bypass attempts: bash -c "...", sh -c "...", eval "..."
 * Returns the inner command if found, otherwise undefined.
 */
function extractShellWrapperCommand(command: string): string | undefined {
	const wrapperMatch = command.match(
		/^\s*(?:\/(?:usr\/)?bin\/)?(bash|sh|dash|zsh|ksh)\s+-c\s+(['"]?)(.+)\2\s*$/
	);
	if (wrapperMatch) return wrapperMatch[3];
	const evalMatch = command.match(/^\s*eval\s+(['"]?)(.+)\1\s*$/);
	if (evalMatch) return evalMatch[2];
	return undefined;
}

/**
 * Detect command substitution: $(cmd) or `cmd`
 */
function hasCommandSubstitution(command: string): boolean {
	if (/\$\([^)]+\)/.test(command)) return true;
	if (/(?<!\\)`[^`]+`/.test(command)) return true;
	return false;
}

/**
 * Classify a command for the HOST agent, recognizing DESTRUCTIVE operations that
 * always require explicit human approval. Reuses segment splitting so destructive
 * ops cannot ride in on chained commands.
 *
 * Destructive operations (always need approval):
 *   - gh pr close, gh pr delete, gh pr edit (state changes)
 *   - gh pr create/comment/review (and any flag containing --delete-branch)
 *   - gh repo delete
 *   - git push --force / -f / --force-with-lease
 *   - git push --delete / :branch (ref deletion)
 *   - git branch -D / -d (local branch deletion)
 *   - git reset --hard
 *   - git clean -fd
 *   - gh api with DELETE method
 *   - rm -rf / rm -fr
 *
 * Forbidden (always blocked):
 *   - gh pr merge
 *
 * Mutate (need approval for remote actions):
 *   - git push (non-force), gh pr create/comment/review, gh api POST/PUT/PATCH
 *
 * Read (pass freely):
 *   - git status/log/diff, gh pr view/list, cat, ls, grep, etc.
 */
export function classifyHostCommand(command: string): OpDecision {
	// SECURITY: Block command substitution — too complex to parse safely
	if (hasCommandSubstitution(command)) {
		return {
			klass: "destructive",
			operation: "command substitution",
			reason: "command contains $() or backtick substitution — requires approval",
		};
	}

	// SECURITY: Unwrap shell wrappers and classify the inner command
	const innerCmd = extractShellWrapperCommand(command);
	if (innerCmd) {
		const inner = classifyHostCommand(innerCmd);
		if (inner.klass !== "read") {
			return {
				...inner,
				operation: `shell -c: ${inner.operation}`,
				reason: `${inner.reason} (via shell wrapper)`,
			};
		}
		// Read commands in shell wrappers are allowed
	}
	// Check each segment for destructive/forbidden/mutate operations
	// Return immediately if we find any non-read operation; otherwise continue
	for (const seg of splitShellSegments(command)) {
		const tokens = seg.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;

		const bin = basename(tokens[0]);

		// rm -rf is destructive (handle all flag variants: -rf, -fr, -RF, -Rf, -rF, -Fr, -rfv, etc.)
		if (bin === "rm") {
			const hasRF = tokens.some((t) => /^-[a-z]*(r[a-z]*f|f[a-z]*r)[a-z]*$/i.test(t));
			if (hasRF) {
				return {
					klass: "destructive",
					operation: "rm -rf",
					reason: "recursive force deletion requires approval",
				};
			}
			// rm without -rf is read-level (continue to next segment)
			continue;
		}

		if (bin === "git") {
			const sub = tokens.find((t, i) => i > 0 && !t.startsWith("-"));

			// git push with force or delete
			if (sub === "push") {
				const hasForce = tokens.some((t) => t === "--force" || t === "-f" || t.startsWith("--force-with-lease"));
				const hasDelete = tokens.includes("--delete") || tokens.some((t) => t.startsWith(":"));
				if (hasForce) {
					return {
						klass: "destructive",
						operation: "git push --force",
						reason: "force push can rewrite shared history and requires approval",
					};
				}
				if (hasDelete) {
					return {
						klass: "destructive",
						operation: "git push --delete",
						reason: "deleting remote branches requires approval",
					};
				}
				// Regular push is mutate (not destructive)
				return { klass: "mutate", operation: "git push", reason: "pushes commits to a remote" };
			}

			// git branch -D/-d (deletion)
			if (sub === "branch" && (tokens.includes("-D") || tokens.includes("-d"))) {
				return {
					klass: "destructive",
					operation: "git branch -D/-d",
					reason: "deleting local branches requires approval",
				};
			}

			// git reset --hard
			if (sub === "reset" && tokens.includes("--hard")) {
				return {
					klass: "destructive",
					operation: "git reset --hard",
					reason: "hard reset discards uncommitted changes and requires approval",
				};
			}

			// git clean -fd
			if (sub === "clean" && (tokens.includes("-fd") || tokens.includes("-df"))) {
				return {
					klass: "destructive",
					operation: "git clean -fd",
					reason: "force cleaning untracked files requires approval",
				};
			}

			// Other git commands are read-level (continue to next segment)
			continue;
		}

		if (bin === "gh") {
			const sub = tokens[1];
			const sub2 = tokens[2];

			// gh pr merge is always forbidden
			if (sub === "pr" && sub2 === "merge") {
				return {
					klass: "forbidden",
					operation: "gh pr merge",
					reason: "Guildmaster never merges; merging is the team's decision",
				};
			}

			// gh pr close/delete/edit or any command with --delete-branch
			if (sub === "pr") {
				const hasDeleteBranch = tokens.includes("--delete-branch");
				if (sub2 === "close" || sub2 === "delete" || hasDeleteBranch) {
					return {
						klass: "destructive",
						operation: hasDeleteBranch ? "gh pr ... --delete-branch" : `gh pr ${sub2}`,
						reason: "closing/deleting PRs or branches requires approval",
					};
				}
				if (sub2 === "edit") {
					return {
						klass: "destructive",
						operation: "gh pr edit",
						reason: "editing PR state/metadata requires approval",
					};
				}
				// gh pr create/comment/review are mutations (need approval but not destructive)
				if (sub2 === "create" || sub2 === "comment" || sub2 === "review") {
					return {
						klass: "mutate",
						operation: `gh pr ${sub2}`,
						reason: "PR creation/interaction requires approval",
					};
				}
				// gh pr read operations (continue to next segment)
				if (GH_PR_READ.has(sub2)) {
					continue;
				}
			}

			// gh repo delete
			if (sub === "repo" && sub2 === "delete") {
				return {
					klass: "destructive",
					operation: "gh repo delete",
					reason: "deleting repositories requires approval",
				};
			}

			// gh api with DELETE method (handle both -X DELETE and --method=DELETE)
			const isApiDelete = sub === "api" && /(?:-X\s*|--method[=\s])DELETE/i.test(seg);
			if (isApiDelete) {
				return {
					klass: "destructive",
					operation: "gh api DELETE",
					reason: "DELETE API calls require approval",
				};
			}

			// gh api with other write methods
			const isApiWrite = sub === "api" && /(?:-X\s*|--method[=\s])(POST|PUT|PATCH)/i.test(seg);
			const isApiRead = sub === "api" && !isApiWrite && !isApiDelete;

			// gh read operations
			const isRead =
				(sub === "repo" && sub2 === "view") ||
				(sub === "issue" && (sub2 === "view" || sub2 === "list")) ||
				sub === "search" ||
				sub === "status" ||
				isApiRead;

			if (isRead) {
				// Read operation, continue to next segment
				continue;
			}
			if (isApiWrite) {
				return { klass: "mutate", operation: "gh api (write)", reason: "mutating API call requires approval" };
			}

			// Default gh mutation
			return {
				klass: "mutate",
				operation: `gh ${sub ?? ""} ${sub2 ?? ""}`.trim(),
				reason: "gh mutation requires approval",
			};
		}

		// Unknown command, treat as read-level (continue to next segment)
	}

	// If we processed all segments and none were destructive/forbidden/mutate, it's a read
	return { klass: "read", operation: "", reason: "non-privileged command" };
}

// Heuristic only. Errs toward flagging so a security fix is not auto-published (§ org policy).
const SECURITY_SIGNALS =
	/\b(cve-\d|vulnerabilit|security fix|security patch|exploit|xss|csrf|\bssrf\b|\brce\b|sql injection|auth(?:entication|orization)?\s+bypass|privilege escalation|path traversal|secret leak|hardcoded (?:secret|password|token))\b/i;

export function isLikelySecurityFix(text: string): boolean {
	return SECURITY_SIGNALS.test(text);
}

/** Extract an "owner/repo" slug from a GitHub remote URL, if present. */
export function repoSlugFromRemote(remoteUrl: string): string | undefined {
	const m = remoteUrl.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
	return m ? m[1] : undefined;
}

/** grafana/grafana first-party: security fixes must not become public PRs without confirmation. */
export function isGrafanaFirstParty(slug: string | undefined): boolean {
	return slug === "grafana/grafana";
}
