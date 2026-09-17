/**
 * Gated PR raise (§9, §10, §11).
 *
 * Turns a write-Quest's local draft (committed branch from M8) into a real pushed
 * branch + draft PR — but only after asynchronous human approval, and only within
 * policy: mutations are gated, `gh pr merge` is refused (Guildmaster never merges),
 * and a likely security fix is not auto-published (confirmed manually; refused
 * outright for grafana/grafana first-party per org policy).
 *
 * git/gh are injected so this is testable without touching the network.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QuestRecord } from "../persistence/quest-store.ts";
import { classifyCommand, isGrafanaFirstParty, isLikelySecurityFix, repoSlugFromRemote } from "../execution/policy.ts";
import type { ApprovalManager } from "./approvals.ts";

const execFileAsync = promisify(execFile);

/** Network ops (git push, gh pr create) must not hang forever: bound them. */
const NETWORK_TIMEOUT_MS = 120_000;

export type CommandRunner = (args: string[], cwd: string) => Promise<string>;

export interface PrDeps {
	approvals: ApprovalManager;
	runGit?: CommandRunner;
	runGh?: CommandRunner;
	/** Confirm proceeding when the change looks like a security fix. Default: refuse. */
	confirmSecurity?: (message: string) => Promise<boolean>;
	/** Called when the raise enters the awaiting-approval state. */
	onAwaitingApproval?: () => void;
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

		// Independent, parked approval for THIS repo's push.
		deps.onAwaitingApproval?.();
		const approved = await deps.approvals.request({
			questId: record.id,
			title: sourcePr ? `Update PR #${sourcePr.number} (${pr.repo}): push to ${sourcePr.headBranch}` : `Raise draft PR (${pr.repo}): ${pr.title}`,
			description: sourcePr ? `git push (fast-forward) → ${sourcePr.headBranch} of PR #${sourcePr.number}` : `git push -u origin ${pr.branch}; gh pr create --draft`,
			operation: "pr-raise",
		});
		if (!approved) {
			results.push({ repo: pr.repo, raised: false, reason: `Denied; branch \`${pr.branch}\` remains committed locally.` });
			continue;
		}

		if (sourcePr) {
			// UPDATE an existing PR: fast-forward push to its head branch via the upstream
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
			results.push({ repo: pr.repo, raised: true, url: sourcePr.url, reason: `Updated existing PR #${sourcePr.number}.` });
			continue;
		}

		await runGit(["push", "-u", "origin", pr.branch], worktreePath);
		const out = await runGh(
			["pr", "create", "--draft", "--title", pr.title, "--body", `${pr.body}${siblingNote}`, "--head", pr.branch],
			worktreePath,
		);
		const url = out.match(/https?:\/\/\S+/)?.[0];
		pr.url = url;
		pr.draft = true;
		results.push({ repo: pr.repo, raised: true, url, reason: "Raised as a draft PR." });
	}

	return { raised: results.filter((r) => r.raised).length, results };
}
