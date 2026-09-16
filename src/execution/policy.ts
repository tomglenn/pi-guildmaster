/**
 * Operation-aware permission policy (§10).
 *
 * Command names are NOT sufficient evidence of danger. `gh pr view` is a read;
 * `gh pr merge` is a mutation (and, for Guildmaster, forbidden). This classifier
 * understands the subcommand well enough to distinguish them, so gating decisions
 * are based on the actual operation rather than the binary name.
 */

export type OpClass = "read" | "mutate" | "forbidden";

export interface OpDecision {
	klass: OpClass;
	operation: string;
	reason: string;
}

function basename(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i === -1 ? p : p.slice(i + 1);
}

const GH_PR_READ = new Set(["view", "list", "checks", "diff", "status"]);

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
