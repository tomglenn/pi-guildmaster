/**
 * Gated PR raise (§9, §10, §11).
 *
 * Turns a write-Quest's local draft (committed branch from M8) into a real pushed
 * branch + draft PR — no approval either way. A draft exists for the human to review
 * and decide whether to mark it ready; and once a PR is up, addressing review
 * feedback is the delegated work, so the address-feedback update pushes without a
 * gate too. `gh pr merge` is ALWAYS refused (Guildmaster never merges). Before
 * pushing, the added diff lines and PR text are scanned for credentials and internal
 * chat links (publish-scan.ts); a hit refuses the push. Before creating, an existing
 * PR for the branch is adopted rather than duplicated.
 *
 * git/gh are injected so this is testable without touching the network.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QuestIsolation, QuestRecord } from "../persistence/quest-store.ts";
import { classifyCommand } from "../execution/policy.ts";
import { describeHits, scanDiff, scanPrText } from "./publish-scan.ts";

const execFileAsync = promisify(execFile);

/** Network ops (git push, gh pr create) must not hang forever: bound them. */
const NETWORK_TIMEOUT_MS = 120_000;

export type CommandRunner = (args: string[], cwd: string) => Promise<string>;

export interface PrDeps {
	runGit?: CommandRunner;
	runGh?: CommandRunner;
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

/** One plain sentence for a failed push / PR create: known causes in words, otherwise git's first error line. */
export function explainPushFailure(raw: string, branch: string): string {
	const kept = ` The branch \`${branch}\` is kept.`;
	if (/'origin' does not appear to be a git repository|No such remote|no configured push destination/i.test(raw))
		return `Couldn't push: this repo has no \`origin\` remote.${kept}`;
	if (/Permission denied|Authentication failed|could not read Username|403|gh auth login/i.test(raw))
		return `Couldn't push: GitHub authentication failed (check \`gh auth status\` or your SSH key).${kept}`;
	if (/Could not resolve host|timed out|Connection refused|Network is unreachable|ETIMEDOUT/i.test(raw))
		return `Couldn't push: GitHub could not be reached (network).${kept}`;
	const first = raw.split("\n").map((l) => l.replace(/^(fatal|error):\s*/i, "").trim()).find((l) => l && !/^Command failed:/.test(l)) ?? raw.trim();
	return `Couldn't open the draft PR: ${first.slice(0, 200)}.${kept}`;
}

/** An error's full text: execFile errors carry git's stderr on `.stderr`, plus the message. */
function errText(e: unknown): string {
	const stderr = (e as { stderr?: unknown } | null)?.stderr;
	const message = e instanceof Error ? e.message : String(e);
	return `${stderr ? `${String(stderr)}\n` : ""}${message}`;
}

/**
 * True when a push was rejected by a "require signed commits" rule. A bare GH013 is
 * NOT enough: GH013 covers every repository-rule violation (e.g. "Changes must be made
 * through a pull request"), so signature-related text is required.
 */
export function isSignatureRejection(raw: string): boolean {
	return /verified signatures|must be signed|signed commits|commit signature/i.test(raw);
}

/**
 * What to tell the user when the remote rejected unsigned commits. The rejected
 * push never reached the remote, so the commits since `baseRef` are local only:
 * re-signing them rewrites nothing published, and the retried push is still a
 * plain fast-forward (no force push).
 */
export function signatureRejectionMessage(opts: {
	repo: string;
	branch: string;
	baseRef: string;
	worktreePath: string;
	raw: string;
	/** True when the branch already exists on the remote (an existing PR's head): only commits after baseRef are unpushed. */
	published?: boolean;
}): string {
	const lines = opts.raw
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	// Quote the actual signature violation line, plus the GH013 header when present.
	const violation = lines.find((l) => /verified signatures|must be signed|signed commits|commit signature/i.test(l)) ?? lines[0] ?? "";
	const header = lines.find((l) => /GH013/.test(l));
	const first = header && header !== violation ? `${header} ${violation}` : violation;
	const which = opts.published
		? `the commits added on top of the PR head (${opts.baseRef.slice(0, 12)}), which were not pushed`
		: "the branch's commits, none of which were pushed";
	return (
		`${opts.repo} requires verified (signed) commits, and the push was rejected because commits on \`${opts.branch}\` are unsigned. ` +
		`Configure commit signing (user.signingkey, plus ssh-agent or gpg-agent holding the key), then re-sign ${which}: ` +
		`\`git -C ${opts.worktreePath} rebase --force-rebase --gpg-sign ${opts.baseRef}\`. ` +
		"The rejected push never reached the remote, so those commits are local only; re-signing them keeps the push a fast-forward (no force push needed). " +
		`Then retry with raise_pr. (${first})`
	);
}

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
 * Explain why raise_pr cannot raise a Quest that has no un-raised draft PR recorded
 * (e.g. it failed, so no PR was drafted) and, for every branch that nonetheless has
 * commits ahead of its base, give the exact manual push + draft-PR commands. Pure:
 * `ahead` reports commits ahead of base per isolation, or undefined when unknown
 * (e.g. the worktree is gone). Never auto-raises anything.
 */
export function explainUnraisable(record: QuestRecord, ahead: (iso: QuestIsolation) => number | undefined): string {
	const status = `${record.state}${record.error ? `: ${record.error}` : ""}`;
	const head = `Quest "${record.title}" (${record.id}) is ${status}.`;
	const isolations = record.isolations ?? [];
	if (isolations.length === 0) {
		return `${head} It is not a write-Quest with a branch, so there is nothing to raise.`;
	}
	const counts = isolations.map((iso) => ({ iso, n: ahead(iso) }));
	const withCommits = counts.filter((c) => c.n !== undefined && c.n > 0);
	if (withCommits.length === 0) {
		const unknown = counts.some((c) => c.n === undefined) ? " (some worktrees could not be checked \u2014 they may be missing)" : "";
		return `${head} No draft PR was recorded and there are no commits ahead of base${unknown}, so there is nothing to raise.`;
	}
	const lines = [`${head} raise_pr cannot raise it because no draft PR was recorded for it. These branches have commits you can raise manually:`];
	for (const { iso, n } of withCommits) {
		const base = iso.baseLabel ?? iso.baseRef.slice(0, 12);
		const slug = record.sourcePr && (!record.sourcePr.repo || record.sourcePr.repo === iso.repo) ? record.sourcePr.slug : undefined;
		lines.push(
			`- ${iso.repo}: branch \`${iso.branch}\` in ${iso.worktreePath} is ${n} commit(s) ahead of ${base}.`,
			`    git -C ${iso.worktreePath} push -u origin ${iso.branch}`,
			`    cd ${iso.worktreePath} && gh pr create --draft --head ${iso.branch}${slug ? ` --repo ${slug}` : ""}`,
		);
	}
	for (const { iso } of counts.filter((c) => c.n === undefined)) {
		lines.push(`- ${iso.repo}: could not count commits on \`${iso.branch}\` (worktree ${iso.worktreePath} may be missing).`);
	}
	return lines.join("\n");
}

/**
 * Raise every un-raised repo PR for a (possibly cross-repo) write-Quest. Each repo
 * is pushed independently and gated by its OWN approval, so approving/denying one
 * never blocks the others. `gh pr merge` is refused; sensitive content is never pushed.
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

		// Last safety net before anything goes public: never publish credentials or internal chat links.
		// Only the ADDED diff lines and the PR text are scanned; a hit names the kind and place, never the value.
		let hits;
		try {
			hits = [...scanDiff(await runGit(["diff", iso.baseRef, "HEAD", "--"], worktreePath)), ...scanPrText(pr.title, pr.body)];
		} catch (e) {
			results.push({ repo: pr.repo, raised: false, refused: true, reason: `Could not read the diff to check it for secrets before publishing (${errText(e).slice(0, 200)}). Nothing was pushed.` });
			continue;
		}
		if (hits.length) {
			results.push({
				repo: pr.repo,
				raised: false,
				refused: true,
				reason: `Not published: the change or PR text looks like it contains sensitive content (${describeHits(hits)}). Nothing was pushed. Remove it from branch \`${pr.branch}\`, then ask me to open the PR.`,
			});
			continue;
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
				const raw = errText(e);
				if (isSignatureRejection(raw)) {
					// iso.baseRef is the PR head tip at attach time (attachToExistingBranch), so
					// baseRef..HEAD is exactly this Quest's unpushed commits on top of the PR.
					results.push({
						repo: pr.repo,
						raised: false,
						reason: signatureRejectionMessage({
							repo: sourcePr.slug ?? pr.repo,
							branch: iso.branch,
							baseRef: iso.baseRef,
							worktreePath,
							raw,
							published: true,
						}),
					});
					continue;
				}
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
			const raw = errText(err);
			if (isSignatureRejection(raw)) {
				// New branch: baseRef is the clean base it was cut from, so baseRef..HEAD is
				// every commit on it, none of which reached the remote.
				results.push({
					repo: pr.repo,
					raised: false,
					reason: signatureRejectionMessage({ repo: pr.repo, branch: pr.branch, baseRef: iso.baseRef, worktreePath, raw, published: false }),
				});
				continue;
			}
			results.push({ repo: pr.repo, raised: false, reason: explainPushFailure(raw, pr.branch) });
		}
	}

	return { raised: results.filter((r) => r.raised).length, results };
}
