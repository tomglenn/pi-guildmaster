/**
 * Gated PR raise (§9, §10, §11).
 *
 * Turns a write-Quest's local draft (committed branch from M8) into a real pushed
 * branch + draft PR — no approval either way. A draft exists for the human to review
 * and decide whether to mark it ready; and once a PR is up, addressing review
 * feedback is the delegated work, so the address-feedback update pushes without a
 * gate too. `gh pr merge` is ALWAYS refused (Guildmaster never merges). A likely
 * security fix is not auto-published (confirmed manually; refused outright for
 * grafana/grafana first-party per org policy). Before creating, an existing PR for
 * the branch is adopted rather than duplicated.
 *
 * git/gh are injected so this is testable without touching the network.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QuestRecord } from "../persistence/quest-store.ts";
import { classifyCommand, isGrafanaFirstParty, isLikelySecurityFix, repoSlugFromRemote } from "../execution/policy.ts";

const execFileAsync = promisify(execFile);

/** Network ops (git push, gh pr create) must not hang forever: bound them. */
const NETWORK_TIMEOUT_MS = 120_000;

export type CommandRunner = (args: string[], cwd: string) => Promise<string>;

export interface PrDeps {
	runGit?: CommandRunner;
	runGh?: CommandRunner;
	/** Confirm proceeding when the change looks like a security fix. Default: refuse. */
	confirmSecurity?: (message: string) => Promise<boolean>;
}

export interface RaisedRepo {
	repo: string;
	raised: boolean;
	url?: string;
	reason: string;
	refused?: boolean;
}

export interface RaiseResult {
	raised: number;
	results: RaisedRepo[];
}

const realGit: CommandRunner = async (args, cwd) => (await execFileAsync("git", args, { cwd, timeout: NETWORK_TIMEOUT_MS })).stdout;
const realGh: CommandRunner = async (args, cwd) => (await execFileAsync("gh", args, { cwd, timeout: NETWORK_TIMEOUT_MS })).stdout;

/** Look up an OPEN PR for a branch, if any. Best-effort: any error / non-JSON → none. */
async function findOpenPrForBranch(runGh: CommandRunner, branch: string, cwd: string): Promise<{ url: string; number: number } | undefined> {
	try {
		const out = await runGh(["pr", "list", "--head", branch, "--state", "open", "--json", "url,number", "--limit", "1"], cwd);
		const arr = JSON.parse(out || "[]");
		if (Array.isArray(arr) && arr.length && typeof arr[0]?.url === "string") {
			return { url: arr[0].url, number: Number(arr[0].number) };
		}
	} catch {
		/* no PR / not-JSON / gh error → treat as none and fall through to create */
	}
	return undefined;
}

/**
 * Raise every un-raised repo PR for a (possibly cross-repo) write-Quest. Each repo
 * is pushed independently and gated by its OWN approval, so approving/denying one
 * never blocks the others. `gh pr merge` is refused; a likely security fix is
 * confirmed (and refused outright for grafana/grafana first-party).
 */
export async function raisePr(record: QuestRecord, deps: PrDeps): Promise<RaiseResult> {
	const prs = (record.prs ?? []).filter((p) => !p.url);
	if (prs.length === 0) {
		return { raised: 0, results: [{ repo: "", raised: false, reason: "This Quest has no un-raised drafted PRs." }] };
	}
	const runGit = deps.runGit ?? realGit;
	const runGh = deps.runGh ?? realGh;
	const isolations = record.isolations ?? [];

	// Cross-repo link note: every PR references the shared branch + sibling repos.
	const siblingNote =
		prs.length > 1
			? `\n\n---\nPart of a cross-repo change on branch \`${prs[0].branch}\` spanning: ${prs.map((p) => p.repo).join(", ")}.`
			: "";

	const results: RaisedRepo[] = [];
	for (const pr of prs) {
		const iso = isolations.find((i) => i.repo === pr.repo);
		if (!iso) {
			results.push({ repo: pr.repo, raised: false, reason: "No worktree for this repo." });
			continue;
		}
		const worktreePath = iso.worktreePath;

		// Is this repo updating an existing PR (address-feedback) rather than creating one?
		const sourcePr = record.sourcePr && (!record.sourcePr.repo || record.sourcePr.repo === pr.repo) ? record.sourcePr : undefined;

		// Operation-aware guard.
		const guardCmds = sourcePr ? ["git push"] : [`git push -u origin ${pr.branch}`, "gh pr create --draft"];
		const forbidden = guardCmds.map(classifyCommand).find((d) => d.klass === "forbidden");
		if (forbidden) {
			results.push({ repo: pr.repo, raised: false, refused: true, reason: forbidden.reason });
			continue;
		}

		// Security-fix policy (per repo, since remotes may differ).
		if (isLikelySecurityFix(`${pr.title}\n${pr.body}`)) {
			let slug: string | undefined;
			try {
				slug = repoSlugFromRemote(await runGit(["remote", "get-url", "origin"], worktreePath));
			} catch {
				/* no remote */
			}
			if (isGrafanaFirstParty(slug)) {
				results.push({
					repo: pr.repo,
					raised: false,
					refused: true,
					reason: "Looks like a first-party security fix for grafana/grafana — not auto-raised (org policy).",
				});
				continue;
			}
			const ok = deps.confirmSecurity ? await deps.confirmSecurity(`Change to ${pr.repo} looks like a security fix. Raise a PR anyway?`) : false;
			if (!ok) {
				results.push({ repo: pr.repo, raised: false, refused: true, reason: "Security-fix PR not confirmed." });
				continue;
			}
		}

		if (sourcePr) {
			// UPDATE an existing PR (address-feedback): the PR is already up and the reviewer
			// just wants their feedback actioned, so this pushes without a gate. Fast-forward
			// push to its head branch via the upstream
			// `gh pr checkout` configured (handles fork remotes). NEVER force-push — if the
			// branch diverged (someone pushed after we attached), refuse and let the user rebase.
			try {
				await runGit(["push"], worktreePath);
			} catch (e) {
				results.push({
					repo: pr.repo,
					raised: false,
					reason: `Push to PR #${sourcePr.number} rejected (branch likely diverged / non-fast-forward). Not force-pushed. Pull or rebase \`${sourcePr.headBranch}\` and retry. (${(e as Error).message.split("\n")[0]})`,
				});
				continue;
			}
			pr.url = sourcePr.url;
			pr.number = sourcePr.number;
			pr.draft = false;

			// Best-effort: reply to each addressed review thread and resolve it, so the
			// PR conversation reflects what was done. Never fails the raise.
			let closed = 0;
			const threads = sourcePr.threads ?? [];
			if (threads.length && sourcePr.slug) {
				const replyBody = `Addressed in the update just pushed to this PR (via Guildmaster).`;
				const resolveMutation = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}`;
				for (const th of threads) {
					try {
						if (th.commentId) {
							await runGh(
								["api", "--method", "POST", `repos/${sourcePr.slug}/pulls/${sourcePr.number}/comments/${th.commentId}/replies`, "-f", `body=${replyBody}`],
								worktreePath,
							);
						}
						if (th.threadId) {
							await runGh(["api", "graphql", "-f", `query=${resolveMutation}`, "-f", `threadId=${th.threadId}`], worktreePath);
						}
						closed++;
					} catch {
						/* best effort — a failed reply/resolve must not fail the push */
					}
				}
			}
			const threadNote = threads.length ? ` Replied to/resolved ${closed}/${threads.length} thread(s).` : "";
			results.push({ repo: pr.repo, raised: true, url: sourcePr.url, reason: `Updated existing PR #${sourcePr.number}.${threadNote}` });
			continue;
		}

		// Opening a NEW draft PR: no approval needed (a draft is for the human to review
		// and decide on). Push first, then reconcile against the remote — a PR may already
		// exist for this branch (e.g. opened out of band); adopt it rather than colliding
		// on `gh pr create`. Wrapped so a push/create failure (network/auth) becomes a
		// reported result rather than throwing: auto-raise-on-completion must not crash the
		// Quest, and raise_pr can retry.
		try {
			await runGit(["push", "-u", "origin", pr.branch], worktreePath);

			const existing = await findOpenPrForBranch(runGh, pr.branch, worktreePath);
			if (existing?.url) {
				pr.url = existing.url;
				pr.number = existing.number;
				pr.draft = true;
				results.push({
					repo: pr.repo,
					raised: true,
					url: existing.url,
					reason: `A PR already existed for \`${pr.branch}\` — adopted PR #${existing.number} and pushed the latest commits (no duplicate created).`,
				});
				continue;
			}

			const out = await runGh(
				["pr", "create", "--draft", "--title", pr.title, "--body", `${pr.body}${siblingNote}`, "--head", pr.branch],
				worktreePath,
			);
			const url = out.match(/https?:\/\/\S+/)?.[0];
			pr.url = url;
			pr.draft = true;
			results.push({ repo: pr.repo, raised: true, url, reason: "Raised as a draft PR." });
		} catch (err) {
			results.push({
				repo: pr.repo,
				raised: false,
				reason: `Push/PR creation failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	return { raised: results.filter((r) => r.raised).length, results };
}
