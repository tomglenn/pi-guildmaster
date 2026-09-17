/**
 * PR feedback ingestion (§ addressing review comments).
 *
 * The counterpart to raising a PR: once a PR of ours has accrued reviews, this
 * module fetches the *current, unresolved* feedback and renders it into a brief a
 * Party can act on. It deliberately separates three kinds of signal so a party
 * (and the user) never again confuses them:
 *   - actionable HUMAN review comments / change requests (unresolved threads);
 *   - AUTOMATED bot findings (Cursor Bugbot, CodeRabbit, …) — real but lower trust;
 *   - failing CI checks (lint/typecheck/tests) — objective, must go green.
 *
 * Resolved review threads are dropped, so a re-run only surfaces what is still
 * open. If nothing is actionable, callers should STOP and say so rather than
 * inventing work (the exact failure mode this is designed to prevent).
 *
 * `gh` is injected so this is unit-testable without the network.
 */

import { execFileSync } from "node:child_process";

export type GhRunner = (args: string[], cwd: string) => string;

const defaultGh: GhRunner = (args, cwd) =>
	execFileSync("gh", args, { cwd, encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });

/** Known automated reviewers whose comments are context, not human change-requests. */
const BOT_LOGINS = new Set([
	"cursor",
	"cursor[bot]",
	"coderabbitai",
	"coderabbitai[bot]",
	"github-actions",
	"github-actions[bot]",
	"codecov",
	"codecov[bot]",
	"sonarcloud",
	"sonarcloud[bot]",
	"dependabot",
	"dependabot[bot]",
	"renovate",
	"renovate[bot]",
	"sourcery-ai",
	"sourcery-ai[bot]",
]);

export function isBotLogin(login: string | undefined): boolean {
	if (!login) return false;
	const l = login.toLowerCase();
	return l.endsWith("[bot]") || BOT_LOGINS.has(l);
}

export interface PrTarget {
	number: string;
	slug?: string;
}

export interface PrMetadata {
	number: number;
	url: string;
	title: string;
	body: string;
	headRefName: string;
	/** true when the PR head lives on a fork (affects push-to-update). */
	isCrossRepository: boolean;
	/** OPEN | MERGED | CLOSED */
	state: string;
	/** owner/repo of the BASE repo (where the PR lives). */
	slug: string;
}

export interface FeedbackComment {
	author: string;
	isBot: boolean;
	body: string;
	path?: string;
	line?: number;
	/** For top-level reviews: APPROVED | CHANGES_REQUESTED | COMMENTED. */
	reviewState?: string;
}

export interface FailingCheck {
	name: string;
	state: string;
	link?: string;
}

export interface PrFeedback {
	metadata: PrMetadata;
	/** Unresolved inline review threads from humans. */
	humanThreads: FeedbackComment[];
	/** Unresolved inline review threads from bots (context, lower trust). */
	botThreads: FeedbackComment[];
	/** Top-level human reviews that carry a body (summaries / change requests). */
	humanReviews: FeedbackComment[];
	/** Failing / errored CI checks. */
	failingChecks: FailingCheck[];
	/** Count of things genuinely worth acting on (human + bot threads + change-requests + failing checks). */
	actionableCount: number;
}

/** Parse owner/repo from a PR URL (fallback when slug not supplied). */
function slugFromUrl(url: string): string | undefined {
	const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i);
	return m?.[1];
}

/** Fetch PR metadata + status checks in one call. */
export function fetchPrMetadata(target: PrTarget, cwd: string, gh: GhRunner = defaultGh): PrMetadata {
	const repoFlag = target.slug ? ["--repo", target.slug] : [];
	const out = gh(
		["pr", "view", target.number, ...repoFlag, "--json", "number,url,title,body,headRefName,isCrossRepository,state"],
		cwd,
	);
	const j = JSON.parse(out) as Partial<PrMetadata> & { number?: number };
	const url = j.url ?? "";
	return {
		number: j.number ?? Number(target.number),
		url,
		title: j.title ?? "",
		body: j.body ?? "",
		headRefName: j.headRefName ?? "",
		isCrossRepository: Boolean(j.isCrossRepository),
		state: j.state ?? "OPEN",
		slug: target.slug ?? slugFromUrl(url) ?? "",
	};
}

const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          isResolved
          isOutdated
          comments(first:1){ nodes{ author{login} body path line originalLine } }
        }
      }
      reviews(first:50){ nodes{ author{login} state body } }
    }
  }
}`;

interface GraphQlThreadComment {
	author?: { login?: string } | null;
	body?: string;
	path?: string;
	line?: number | null;
	originalLine?: number | null;
}
interface GraphQlReviewThread {
	isResolved: boolean;
	isOutdated: boolean;
	comments: { nodes: GraphQlThreadComment[] };
}
interface GraphQlReview {
	author?: { login?: string } | null;
	state: string;
	body: string;
}

/** Failing-check states from statusCheckRollup / gh. */
const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

interface StatusCheckNode {
	__typename?: string;
	name?: string;
	context?: string;
	conclusion?: string | null;
	state?: string | null;
	status?: string | null;
	detailsUrl?: string;
	targetUrl?: string;
}

/** Fetch failing checks via the status-check rollup (best-effort). */
export function fetchFailingChecks(target: PrTarget, cwd: string, gh: GhRunner = defaultGh): FailingCheck[] {
	const repoFlag = target.slug ? ["--repo", target.slug] : [];
	let nodes: StatusCheckNode[] = [];
	try {
		const out = gh(["pr", "view", target.number, ...repoFlag, "--json", "statusCheckRollup"], cwd);
		const j = JSON.parse(out) as { statusCheckRollup?: StatusCheckNode[] };
		nodes = j.statusCheckRollup ?? [];
	} catch {
		return [];
	}
	const failing: FailingCheck[] = [];
	for (const n of nodes) {
		const verdict = (n.conclusion ?? n.state ?? "").toUpperCase();
		if (FAILING.has(verdict)) {
			failing.push({ name: n.name ?? n.context ?? "check", state: verdict, link: n.detailsUrl ?? n.targetUrl });
		}
	}
	return failing;
}

/** Fetch unresolved review threads + top-level reviews via GraphQL. */
export function fetchReviewThreads(
	metadata: PrMetadata,
	cwd: string,
	gh: GhRunner = defaultGh,
): { humanThreads: FeedbackComment[]; botThreads: FeedbackComment[]; humanReviews: FeedbackComment[] } {
	const [owner, repo] = (metadata.slug || "").split("/");
	const humanThreads: FeedbackComment[] = [];
	const botThreads: FeedbackComment[] = [];
	const humanReviews: FeedbackComment[] = [];
	if (!owner || !repo) return { humanThreads, botThreads, humanReviews };

	let data: {
		data?: { repository?: { pullRequest?: { reviewThreads?: { nodes: GraphQlReviewThread[] }; reviews?: { nodes: GraphQlReview[] } } } };
	};
	try {
		const out = gh(
			["api", "graphql", "-f", `query=${REVIEW_THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${metadata.number}`],
			cwd,
		);
		data = JSON.parse(out);
	} catch {
		return { humanThreads, botThreads, humanReviews };
	}

	const pr = data.data?.repository?.pullRequest;
	for (const t of pr?.reviewThreads?.nodes ?? []) {
		if (t.isResolved) continue; // only surface OPEN threads
		const c = t.comments?.nodes?.[0];
		if (!c) continue;
		const login = c.author?.login ?? "unknown";
		const item: FeedbackComment = {
			author: login,
			isBot: isBotLogin(login),
			body: (c.body ?? "").trim(),
			path: c.path,
			line: c.line ?? c.originalLine ?? undefined,
		};
		(item.isBot ? botThreads : humanThreads).push(item);
	}
	for (const r of pr?.reviews?.nodes ?? []) {
		const login = r.author?.login ?? "unknown";
		if (isBotLogin(login)) continue; // bot review bodies are noise; their inline threads already captured
		const body = (r.body ?? "").trim();
		if (!body && r.state !== "CHANGES_REQUESTED") continue;
		humanReviews.push({ author: login, isBot: false, body, reviewState: r.state });
	}
	return { humanThreads, botThreads, humanReviews };
}

/** Gather all feedback for a PR into one normalized structure. */
export function gatherPrFeedback(target: PrTarget, cwd: string, gh: GhRunner = defaultGh): PrFeedback {
	const metadata = fetchPrMetadata(target, cwd, gh);
	const { humanThreads, botThreads, humanReviews } = fetchReviewThreads(metadata, cwd, gh);
	const failingChecks = fetchFailingChecks(target, cwd, gh);
	const changeRequests = humanReviews.filter((r) => r.reviewState === "CHANGES_REQUESTED").length;
	const actionableCount = humanThreads.length + botThreads.length + failingChecks.length + changeRequests;
	return { metadata, humanThreads, botThreads, humanReviews, failingChecks, actionableCount };
}

function renderComment(c: FeedbackComment): string {
	const loc = c.path ? ` \`${c.path}${c.line ? `:${c.line}` : ""}\`` : "";
	// Strip HTML comment blocks that bots embed (e.g. Cursor's metadata) for a clean brief.
	const clean = c.body
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return `- **@${c.author}**${loc}:\n  ${clean.split("\n").join("\n  ")}`;
}

/**
 * Render feedback into a markdown brief the Party can act on. Honest by
 * construction: if there is nothing actionable it says so explicitly.
 */
export function formatFeedbackBrief(fb: PrFeedback): string {
	const parts: string[] = [`## Review feedback to address on PR #${fb.metadata.number} (${fb.metadata.url})`];

	if (fb.actionableCount === 0) {
		parts.push(
			"No actionable feedback found: no unresolved review threads, no change-requests, and no failing CI checks. " +
				"Do NOT invent changes — report that there is nothing to address.",
		);
		return parts.join("\n\n");
	}

	if (fb.failingChecks.length) {
		parts.push(
			`### Failing CI checks (${fb.failingChecks.length}) — must go green\n` +
				fb.failingChecks.map((c) => `- ${c.name} — ${c.state}${c.link ? ` (${c.link})` : ""}`).join("\n"),
		);
	}
	if (fb.humanReviews.some((r) => r.reviewState === "CHANGES_REQUESTED" || r.body)) {
		parts.push(
			`### Reviewer summaries (human)\n` +
				fb.humanReviews.map((r) => `- **@${r.author}** [${r.reviewState ?? "COMMENTED"}]:\n  ${r.body.split("\n").join("\n  ")}`).join("\n"),
		);
	}
	if (fb.humanThreads.length) {
		parts.push(`### Unresolved human review comments (${fb.humanThreads.length}) — ACTION THESE\n` + fb.humanThreads.map(renderComment).join("\n"));
	}
	if (fb.botThreads.length) {
		parts.push(
			`### Automated bot findings (${fb.botThreads.length}) — real but lower trust; evaluate before acting\n` +
				fb.botThreads.map(renderComment).join("\n"),
		);
	}
	parts.push(
		"### Rules\n" +
			"- Address each item above; for every one, note what you changed (or why it needs no change).\n" +
			"- Make all failing checks pass (run the repo's real lint/typecheck/test commands, one-shot).\n" +
			"- Do NOT make unrelated changes. If an item is already resolved in the current code, say so and move on.",
	);
	return parts.join("\n\n");
}
