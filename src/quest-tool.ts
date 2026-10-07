/**
 * Quest tools (§6, §12, §13).
 *
 * `quest` starts substantial delegated work in the BACKGROUND: it creates the
 * Quest, kicks off the Party without awaiting, and returns immediately. The party
 * works while the Guildmaster stays free to keep talking, and its investigation
 * never enters the Guildmaster's context. Progress and completion surface on the
 * Guild status board (see status.ts); the full report is delivered as a card, not
 * injected into the conversation.
 *
 * `quest_status` lets the Guildmaster read Quest state / fetch a report on demand,
 * so context is only spent when the user actually wants the detail.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { effectiveConfig, loadConfig } from "./config.ts";
import type { GuildmasterConfig } from "./config.ts";
import { assertPrTarget, postReview } from "./execution/gh-tool.ts";
import { getSlackFetcher } from "./execution/slack-fetch.ts";
import { attachToExistingBranch, commitAndDiff, createWorktree, inPlaceIsolation, isGitRepo, isWorkingTreeClean } from "./execution/isolation.ts";
import { formatFeedbackBrief, gatherPrFeedback } from "./orchestration/pr-feedback.ts";
import type { ApprovalManager } from "./orchestration/approvals.ts";
import { getApprovalManager, getQuestManager } from "./orchestration/manager.ts";
import { raisePr, type RaiseResult } from "./orchestration/pr.ts";
import { extractPostableReview } from "./orchestration/review-post.ts";
import { runParty } from "./orchestration/party-leader.ts";
import { runFastWrite } from "./orchestration/fast-write.ts";
import { useFastWrite } from "./orchestration/write-routing.ts";
import { evaluateVerification, unverifiedReason } from "./orchestration/verification.ts";
import { reviewSensitiveDiff } from "./orchestration/write-review.ts";
import { runReviewLoop } from "./orchestration/review-loop.ts";
import { loadRecipeRegistry } from "./orchestration/recipe-loader.ts";
import { executionShape, preflightRecipe, resolveRecipe } from "./orchestration/recipes.ts";
import { pickRepoBySlug, readonlyContexts, resolveProjectQuery } from "./orchestration/resolve.ts";
import { ProjectStore, type RepoContext } from "./persistence/project-store.ts";
import type { QuestRecord } from "./persistence/quest-store.ts";
import { guildmasterHome, questScratchDir, questsDir } from "./paths.ts";
import { loadRoster } from "./roster.ts";

function started(record: QuestRecord, projectId?: string, targetRepo?: string, write = false, inPlace = false) {
	const scope = projectId ? ` for project ${projectId}${targetRepo ? `/${targetRepo}` : ""}` : "";
	const branch = record.isolations?.[0]?.branch;
	const tail = write
		? inPlace
			? `It is working IN-PLACE in your real checkout${branch ? ` on branch ${branch}` : ""} — changes are committed there for you to review directly. No worktree, no PR.`
			: "When verified, it will automatically open a draft PR (unless a security gate blocks it). Without observed passing checks, the branch stays local."
		: "Ask me to show the results when it's done, or check /quests.";
	return {
		content: [
			{
				type: "text" as const,
				text: `Started Quest "${record.title}" (id ${record.id})${scope} in the background. The party is working now — I'll stay free to keep talking, and the Guild board will show progress. ${tail}`,
			},
		],
		details: { id: record.id, project: projectId },
	};
}

/**
 * Build a child Quest's brief by prepending the parent Quest's report (and any
 * draft-PR branch/diff) as a structured "upstream artifact". This is how a
 * multi-step flow (e.g. review → fix) hands the prior result to the next party
 * without the Guildmaster hand-copying it.
 */
function briefWithUpstream(brief: string, parent: QuestRecord): string {
	const parts: string[] = [`## Upstream artifact — from Quest "${parent.title}" (${parent.id})`];
	parts.push(parent.report?.trim() || "(The upstream Quest recorded no report.)");
	for (const pr of parent.prs ?? []) {
		parts.push(`Upstream branch: ${pr.repo} → ${pr.branch}${pr.url ? ` (PR ${pr.url})` : " (draft, not raised)"}`);
		if (pr.diffStat) parts.push(`Upstream diff:\n${pr.diffStat}`);
	}
	parts.push("---", "## Your task", brief);
	return parts.join("\n\n");
}

function draftPrFromReport(report: string): { title: string; body: string } {
	let title = "Guildmaster change";
	for (const line of report.trim().split("\n")) {
		const t = line.replace(/^#+\s*/, "").trim();
		if (t) {
			title = t.slice(0, 72);
			break;
		}
	}
	return { title, body: report.trim() };
}

/** Run a Quest to completion in the background. Errors are recorded as failed by the manager. */
/**
 * Parse a PR target: a number, `owner/repo#number`, or a full GitHub PR URL.
 * Throws unless the number is digits-only and the slug is a plain `owner/repo`,
 * since both reach `gh` argv and the prompts.
 */
export function parsePrTarget(pr: string): { number: string; slug?: string } {
	const url = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
	const slugHash = pr.match(/^([^/\s]+\/[^/\s#]+)#(\d+)$/);
	const num = pr.match(/^#?(\d+)$/);
	const target: { number: string; slug?: string } = url
		? { slug: url[1], number: url[2] }
		: slugHash
			? { slug: slugHash[1], number: slugHash[2] }
			: { number: num ? num[1] : pr };
	try {
		assertPrTarget(target.number, target.slug);
	} catch (err) {
		throw new Error(`Invalid PR target "${pr}": ${(err as Error).message} Use a number, owner/repo#number, or a GitHub PR URL.`);
	}
	return target;
}

async function runQuestInBackground(
	record: QuestRecord,
	opts: {
		write: boolean;
		inPlace?: boolean;
		contexts: RepoContext[];
		config: GuildmasterConfig;
		globalInstructions?: string;
		instructions?: string;
		review?: { prText?: string; approvals: ApprovalManager; number: string; slug?: string; repoName?: string; label: string };
		/** Read-only GitHub acquisition (investigate mode): envoy can fetch but not post. */
		acquire?: boolean;
		/** Read-only Slack acquisition: a gated Herald can fetch channels/threads but not post. */
		slack?: boolean;
		/** Advisory preferred party (from the recipe). */
		partyHint?: string[];
		fastWrite?: boolean;
		legacyWrite?: boolean;
	},
): Promise<void> {
	const manager = getQuestManager();
	const roster = loadRoster();
	try {
		await manager.run(record, async (api) => {
			const leaderFile = manager.store.leaderOutputPath(record.id);
			// Fence late side effects: a run that was cancelled or failed by the stall watchdog
			// (possibly already settled) must never go on to commit, raise a PR, save or post a review.
			// Checked after EVERY await in the post-party path, and every direct save goes through
			// api.save(), which no-ops once run() has settled.
			const fence = (why: string) => {
				if (api.signal.aborted) throw new Error(why);
			};
			const party = await (opts.fastWrite ? runFastWrite({
				brief: api.record.brief,
				context: opts.contexts[0],
				config: opts.config,
				signal: api.signal,
				instructions: opts.instructions,
				globalInstructions: opts.globalInstructions,
				onProgress: (members) => api.setMembers(members),
				onActivity: () => api.touch(),
				onLeaderText: (text) => api.notePartial(text),
				onLeaderMessage: (text) => {
					if (!api.signal.aborted) fs.writeFileSync(leaderFile, text, { mode: 0o600 });
				},
			}) : runParty({
				brief: api.record.brief,
				contexts: opts.contexts,
				roster,
				config: opts.config,
				signal: api.signal,
				write: opts.write,
				legacyWrite: opts.legacyWrite,
				globalInstructions: opts.globalInstructions,
				instructions: opts.instructions,
				review: opts.review ? { prText: opts.review.prText, approvals: opts.review.approvals, questId: record.id } : undefined,
				acquire: opts.acquire,
				slack: opts.slack,
				slackFetch: getSlackFetcher(),
				partyHint: opts.partyHint,
				onProgress: (members) => api.setMembers(members),
				// Leader liveness + latest text for the stall watchdog (partial output survives a stall).
				onActivity: () => api.touch(),
				onLeaderText: (text) => api.notePartial(text),
				// Each COMPLETED leader message goes to disk, so a process that dies keeps it
				// (reconcileOrphans recovers it). The final write after runParty overwrites it.
				onLeaderMessage: (text) => {
					// A cancelled / stall-failed run must not keep rewriting the recovery artifact.
					if (api.signal.aborted) return;
					try {
						fs.writeFileSync(leaderFile, text, { mode: 0o600 });
					} catch {
						/* best effort */
					}
				},
				// Let the party pause mid-run and ask the user (the `request_user` tool). State
				// flips running ↔ awaiting-input around each gate so the Guild board reflects the pause.
				interactive: {
					approvals: getApprovalManager(),
					questId: record.id,
					setState: (state) => manager.transition(record, state),
					scratchDir: questScratchDir(record.id),
				},
			}));
			// Persist how the party's run ended, for forensics, before anything can throw.
			record.stopReason = party.stopReason;

			// Persist the leader's RAW final message before anything can throw. This is the
			// recovery artifact: even if delimiter extraction truncates or the run failed,
			// the full report source is on disk (the one lossy-without-recovery gap we hit).
			// An empty rawFinal (e.g. an aborted party) never clobbers a non-empty leader.md.
			try {
				const raw = party.rawFinal ?? "";
				let existing = "";
				if (!raw.trim()) {
					try {
						existing = fs.readFileSync(leaderFile, "utf-8");
					} catch {
						/* none yet */
					}
				}
				if (raw.trim() || !existing.trim()) fs.writeFileSync(leaderFile, raw, { mode: 0o600 });
			} catch {
				/* best effort */
			}

			fence(party.error || "Party aborted");

			// A party that did not finalize has no trustworthy report: fail honestly rather
			// than promoting partial/aborted output to a "completed" Quest.
			if (!party.report?.trim()) {
				throw new Error(party.error || "Party produced no report before finalizing.");
			}
			if (opts.write) {
				const verification = evaluateVerification(party.members, record.isolations?.map((iso) => iso.repo));
				record.verification = verification.state;
				if (verification.state === "unverified") record.raiseError = unverifiedReason(verification.masked);
				api.save();
				if (verification.state === "failed") {
					throw new Error(`Verification failed or returned no exit code: ${verification.checks.filter((c) => c.exitCode !== 0).map((c) => `${c.command} (exit ${c.exitCode ?? "?"})`).join(", ")}. Worktree preserved for repair.`);
				}
			}

			// Independently inspect risk from the ACTUAL diff, not just the brief. This gate is
			// enforced by the harness even when the leader elects not to dispatch a reviewer.
			// A BLOCK is a finding to iterate on (Builder fix round → checks → re-review); the
			// user decides only when iterating cannot settle it (see review-loop.ts).
			if (opts.write) for (const iso of record.isolations ?? []) {
				const approvals = getApprovalManager();
				const ask = async (input: Parameters<ApprovalManager["ask"]>[0]) => {
					manager.transition(record, "awaiting-input");
					try {
						return await approvals.ask({ ...input, questId: record.id, signal: api.signal });
					} finally {
						if (!api.signal.aborted) manager.transition(record, "running");
					}
				};
				const context = { name: iso.repo, path: iso.worktreePath, writable: true };
				const loop = await runReviewLoop({
					repo: iso.repo,
					brief: record.brief,
					onMembers: (members) => api.setMembers([...party.members, ...members]),
					review: () => reviewSensitiveDiff({
						isolation: iso, brief: record.brief, roster, config: opts.config, signal: api.signal,
						onProgress: (member) => api.setMembers([...party.members, member]),
					}),
					fix: async (prompt) => {
						fence("Quest aborted during review fix round.");
						const fixed = await runFastWrite({
							brief: prompt, context, config: opts.config, signal: api.signal,
							instructions: opts.instructions, globalInstructions: opts.globalInstructions,
							onProgress: (members) => api.setMembers([...party.members, ...members]),
							onActivity: () => api.touch(),
						});
						const member = fixed.members[0];
						member.task = `Fix round: ${prompt.split("\n")[0]}`;
						const report = fixed.rawFinal ?? "";
						const checks = evaluateVerification([member], [iso.repo]);
						const blocker = /^CONFLICT:/i.test(report.trim())
							? `The Builder reports that a finding conflicts with the brief:\n${report.trim().slice(0, 2_000)}`
							: fixed.error
								? `The fix round did not finish: ${fixed.error.slice(0, 2_000)}`
								: checks.state !== "verified"
									? `The fix round's checks did not pass (${checks.state}${checks.checks.length ? `: ${checks.checks.map((c) => `${c.command} (exit ${c.exitCode ?? "?"})`).join(", ")}` : ""}).`
									: undefined;
						return { member, cost: fixed.usage.cost, report, blocker };
					},
					choose: (title, description, options) => ask({ kind: "choose", title, description, options }),
					answer: (title, description) => ask({ kind: "answer", title, description }),
				});
				fence("Quest aborted during independent review.");
				party.members.push(...loop.members);
				party.usage.cost += loop.cost;
				api.setMembers(party.members.slice());
				if (loop.note) party.report = `${party.report}\n\n${loop.note}`;
				if (loop.fixRounds > 0) {
					// Fix rounds changed the code: earlier checks are stale. Re-derive from every member
					// (the latest result per command wins), so a failing fix cannot ride on an old pass.
					const verification = evaluateVerification(party.members, record.isolations?.map((i) => i.repo));
					record.verification = verification.state;
					record.raiseError = verification.state === "unverified"
						? unverifiedReason(verification.masked)
						: verification.state === "failed"
							? `Checks fail after the review fix round (${verification.checks.filter((c) => c.exitCode !== 0).map((c) => c.command).join(", ")}); branch kept local.`
							: undefined;
				}
				api.save();
			}

			// Commit each writable repo's worktree + draft a PR per changed repo BEFORE
			// completion, so the completed record already carries its branches/PRs.
			let committedAny = false;
			if (opts.write && record.isolations?.length) {
				const { title, body } = draftPrFromReport(party.report);
				const multi = record.isolations.length > 1;
				const prs = [];
				for (const iso of record.isolations) {
					const changes = commitAndDiff(iso, title);
					if (!changes.committed) continue;
					committedAny = true;
					if (changes.diff) {
						try {
							fs.writeFileSync(path.join(questsDir(), `${record.id}.${iso.repo}.diff`), changes.diff, { mode: 0o600 });
						} catch {
							/* best effort */
						}
					}
					// In-place: changes are already committed on the user's real branch; no PR is drafted.
					if (opts.inPlace) continue;
					prs.push({
						repo: iso.repo,
						branch: iso.branch,
						title: multi ? `${title} (${iso.repo})` : title,
						body,
						draft: true,
						diffStat: changes.stat || "(no changes)",
					});
				}
				record.prs = prs;

				// Auto-raise: push and open draft PRs on completion — no approval (a draft is
				// the human's review artifact). Security guard still applies: Grafana first-party
				// security fixes stay local, and with no confirmSecurity callback any other
				// security-looking change is refused by default (safe). raise_pr can retry.
				let raiseResult: RaiseResult | undefined;
				if (prs.length > 0 && record.verification === "verified") {
					let raiseFailure: unknown;
					try {
						raiseResult = await raisePr(record, {
							confirmSecurity: undefined, // refuses security-looking changes by default
						});
					} catch (err) {
						raiseFailure = err;
					}
					// An abort/stall during raisePr stops here: no further saves or side effects.
					fence("Quest aborted while raising its PR; later side effects skipped.");
					if (raiseResult) {
						// Check for per-repo failures and record them
						const failures = raiseResult.results.filter((r) => !r.raised);
						if (failures.length > 0) {
							record.raiseError = failures.map((f) => `${f.repo}: ${f.reason}`).join("; ");
						}
					} else {
						// Unexpected failures (not per-repo network issues) are recorded
						record.raiseError = raiseFailure instanceof Error ? raiseFailure.message : String(raiseFailure);
					}
					// Save immediately so raised URLs are persisted even if something fails later
					api.save();
				}

				// A write-Quest that committed nothing did not do its job. Never present an
				// empty branch as a success — that is what hid a party that planned but never wrote.
				if (!committedAny) {
					throw new Error(
						"Write Quest produced no changes — the party committed nothing to any repo. " +
							"Treating as failed rather than completing with an empty branch.",
					);
				}
			}

			// Review-Quest finalize: surface the drafted review as an EDITABLE artifact and pause.
			// The user reads/edits review.md in the inbox (/review). Interactive /approve parses the
			// CURRENT file (extractPostableReview), shows the exact event + body, and on confirm answers
			// with that snapshot — which is exactly what posts. Never the whole file, never a cached
			// verdict. An approval without that snapshot re-parks; nothing is posted.
			if (opts.review && party.report?.trim()) {
				fence("Quest aborted before its review was drafted; nothing posted.");
				const review = opts.review;
				record.review = { number: review.number, slug: review.slug, repoName: review.repoName };
				const initial = extractPostableReview(party.report);
				if (!("error" in initial)) record.review.verdict = initial.verdict;
				record.report = party.report; // so the card / quest_status show the review while it awaits approval
				record.state = "awaiting-approval";
				api.save();

				// Write the drafted review to a scratch file the user can edit before it posts. Without
				// it the user cannot sense-check what would post, so refuse rather than post blind.
				const scratch = questScratchDir(record.id);
				const artifactPath = path.join(scratch, "review.md");
				try {
					fs.mkdirSync(scratch, { recursive: true });
					fs.writeFileSync(artifactPath, party.report, { mode: 0o600 });
				} catch (err) {
					throw new Error(
						`Could not write the review draft to ${artifactPath} (${err instanceof Error ? err.message : String(err)}). ` +
							"Refusing to post a review that cannot be sense-checked first.",
					);
				}

				// The operation carries no flag: the event comes from the file at /approve time.
				const operation = `gh pr review ${review.number}${review.slug ? ` --repo ${review.slug}` : ""}`;
				let notPostedReason: string | undefined;
				// Loop until the user posts a confirmed snapshot or declines; the Quest stays awaiting-approval.
				for (;;) {
					let current: ReturnType<typeof extractPostableReview>;
					try {
						current = extractPostableReview(fs.readFileSync(artifactPath, "utf-8"));
					} catch (err) {
						current = { error: `could not read ${artifactPath} (${err instanceof Error ? err.message : String(err)})` };
					}
					const ans = await review.approvals.ask({
						kind: "review-artifact",
						postsReview: true,
						title: notPostedReason
							? `Review for ${review.label} NOT posted: ${notPostedReason} — edit review.md and /approve again`
							: `Sense-check the review for ${review.label} before it posts`,
						description: "error" in current ? `Cannot post yet: ${current.error}` : current.body,
						operation,
						artifactPath,
						questId: record.id,
						signal: api.signal,
					});
					// Cancelled/stalled while parked on the approval: stop, never post.
					fence("Quest aborted while awaiting review approval; nothing posted.");
					if (!ans.approved) {
						const back = ans.text ? `\n\nYour notes: ${ans.text}` : "";
						return {
							report: `${party.report}\n\n---\n🚪 Not posted — left as a draft. Ask me to post it when you're ready.${back}`,
							usage: party.usage,
						};
					}
					if (!ans.review) {
						// Some non-interactive path approved without the confirmed snapshot: never post blind.
						notPostedReason = "approval must come from interactive /approve, which shows the exact body";
						continue;
					}
					// Post EXACTLY the snapshot the user confirmed (not a re-read of the file).
					const { verdict, body } = ans.review;
					fence("Quest aborted before its review posted; nothing posted.");
					record.review.verdict = verdict;
					const cwd = opts.contexts[0]?.path ?? process.cwd();
					const res = postReview({ cwd, number: review.number, slug: review.slug, verdict, body, prText: review.prText });
					if (!res.error) {
						record.review.posted = true;
						record.review.url = res.url;
					}
					const note = res.error
						? `\n\n---\n⚠\ufe0f Posting failed: ${res.error}. Left as a draft.`
						: `\n\n---\n✅ Posted **${verdict}** review${res.url ? `: ${res.url}` : ""}.`;
					return { report: `${body}${note}`, usage: party.usage };
				}
			}
			return { report: record.verification === "unverified" ? `${party.report}\n\n⚠️ UNVERIFIED: ${record.raiseError ?? "no observed passing build, lint, typecheck or test."} Branch committed but draft PR not auto-raised; run verification before raising.` : party.report, usage: party.usage };
		}, {});
	} catch {
		// manager.run already transitioned the record to failed and persisted it.
	}
}

function describeQuest(q: QuestRecord): string {
	const lines = [`Quest "${q.title}" (${q.id}) — ${q.state}${q.project ? ` [${q.project}]` : ""}`];
	if (q.members.length) lines.push(`Party: ${q.members.map((m) => `${m.name}@${m.repo ?? "?"}:${m.status}`).join(", ")}`);
	for (const m of q.members.filter((m) => m.status === "running")) {
		const mins = Math.max(0, Math.floor((Date.now() - (m.startedAt ?? q.createdAt)) / 60_000));
		lines.push(`Current: ${m.name} (${mins}m) — ${m.step ?? m.task.split("\n")[0]}${m.lastTest ? `; test ${m.lastTest}` : ""}${m.budgetExceededAt ? "; past 5m soft budget" : ""}`);
	}
	if (q.isolations?.length)
		lines.push(
			`Branches: ${q.isolations.map((i) => `${i.repo}→${i.branch}${i.baseLabel ? ` (base ${i.baseLabel})` : ""}`).join(", ")}`,
		);
	for (const pr of q.prs ?? []) {
		const status = pr.url
			? pr.url
			: q.verification === "unverified"
				? "unverified — run checks before raising"
			: q.raiseError
				? `raise failed — use raise_pr to retry`
				: "draft, not raised — use raise_pr";
		lines.push(`PR (${pr.repo}): ${status}${pr.diffStat ? `\n${pr.diffStat}` : ""}`);
	}
	if (q.raiseError && q.prs?.some((p) => !p.url)) lines.push(`Raise error: ${q.raiseError}`);
	if (q.error) lines.push(`Error: ${q.error}${q.stopReason ? ` [stopReason: ${q.stopReason}]` : ""}`);
	if (q.report) lines.push(`\n${q.report}`);
	return lines.join("\n");
}

export function registerQuestTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "quest",
		label: "Quest",
		description: [
			"Start a background Quest: substantial delegated work coordinated by a Party Leader who composes a",
			"Party of specialist Guildmates. Returns immediately; the party works in the background while you stay",
			"free. Use for multi-step or multi-specialist work (investigate-and-report, reviews, implementation).",
			"For a single bounded question prefer consult.",
		].join(" "),
		promptSnippet: "Start a background Party-coordinated Quest for substantial work; returns immediately",
		promptGuidelines: [
			"Use quest for substantial delegated work needing multiple specialists or several steps. It runs in the background and returns immediately — do not wait for it; tell the user it has started and carry on. Its work never enters your context. Use quest_status (or ask the user to check the Guild board / /quests) to see results when they want them. Set write:true only for implementation Quests that must change code.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short title for the Quest (a few words)" }),
			brief: Type.String({ description: "The task brief for the Party Leader: the goal and any constraints." }),
			recipe: Type.Optional(
				Type.String({
					description:
						"Explicit recipe name to shape the Quest (built-in or a markdown-authored one). Overrides the " +
						"pr/mode/write classification. Omit to let the parameters classify the shape.",
				}),
			),
			project: Type.Optional(
				Type.String({ description: "Registered project id/name to scope the Quest to. Omit to use the current directory." }),
			),
			repo: Type.Optional(
				Type.String({ description: "For a write Quest changing ONE repo of a multi-repo project: which repo." }),
			),
			repos: Type.Optional(
				Type.Array(Type.String(), {
					description: "For a CROSS-REPO write Quest: the repos to change together (each gets its own branch + draft PR).",
				}),
			),
			write: Type.Optional(
				Type.Boolean({
					description:
						"True for implementation Quests that change code. The Party works in an isolated git worktree and " +
						"produces a committed branch + drafted PR (never touching the user's checkout, nothing pushed).",
				}),
			),
			inPlace: Type.Optional(
				Type.Boolean({
					description:
						"Opt-in fast-iteration mode for write Quests only. Skips the isolated worktree and lets the Party " +
						"edit the user's REAL checkout directly, on a fresh branch (requires a clean working tree; commits " +
						"but does not open a PR). Dangerous — only when the user explicitly asks to bypass isolation.",
				}),
			),
			fromQuest: Type.Optional(
				Type.String({
					description:
						"Chain this Quest off a previous one: auto-loads that Quest's report (and any draft-PR branch/diff) " +
						"into the brief as an upstream artifact, and records lineage. Use for multi-step flows like review → fix.",
				}),
			),
			pr: Type.Optional(
				Type.String({
					description:
						"A pull request: a PR number, `owner/repo#number`, or a full GitHub PR URL. By default runs a review " +
						"party (envoy fetches → specialists review → Scribe writes it up → posting needs your /approve). Use " +
						"`mode:\"investigate\"` to fetch the PR read-only and produce a REPORT (e.g. assess a reviewer's " +
						"feedback and draft a plan) with NO posting or code changes. Use `mode:\"address-feedback\"` to " +
						"iterate on the PR and action its review comments. Pass `project`/`repo` when the PR's repo is " +
						"registered so it can be checked out locally.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("review"), Type.Literal("address-feedback"), Type.Literal("investigate")], {
					description:
						"With `pr`: 'review' (default) drafts a review to post; 'address-feedback' checks out the PR's OWN " +
						"branch, ingests its unresolved review comments + failing CI, has the party fix them, and updates " +
						"the SAME PR via raise_pr (fast-forward push) — no new PR; 'investigate' fetches the PR read-only " +
						"and produces a REPORT (e.g. assess a reviewer's feedback and draft an implementation plan) — it " +
						"never posts, comments or changes code.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const manager = getQuestManager();

			// Resolve the named project (if any). cwd is only a fallback.
			const projectStore = new ProjectStore();
			const project = params.project ? (() => {
				const r = resolveProjectQuery(projectStore, params.project as string);
				if (r.error) throw new Error(r.error);
				return r.project;
			})() : undefined;

			// SHAPE THE QUEST: one recipe decides the four capability axes (github / write /
			// isolation / delivery). Markdown recipes overlay the built-ins; an explicit
			// `recipe` name wins, else the pr/mode/write params classify the shape.
			const { registry: recipeRegistry } = loadRecipeRegistry();
			const recipe = resolveRecipe(
				{ recipe: params.recipe, pr: params.pr, mode: params.mode, write: params.write, inPlace: params.inPlace },
				recipeRegistry,
			);
			const shape = executionShape(recipe);
			const write = recipe.write;
			const inPlace = recipe.isolation === "in-place";
			const acquire = recipe.github === "read";

			// PREFLIGHT: fail fast if the resolved recipe cannot be executed with what we
			// have (e.g. a PR-context recipe with no way to reach GitHub) — BEFORE any
			// specialist runs. This is the capability-vs-goal check the envoy-less run lacked.
			const preTarget = params.pr ? parsePrTarget(params.pr as string) : undefined;
			const preRepoPath = project
				? (params.repo
						? project.repos.find((x) => x.name === params.repo)?.path
						: project.repos.length === 1
							? project.repos[0].path
							: pickRepoBySlug(project, preTarget?.slug)?.path)
				: ctx.cwd;
			const pre = preflightRecipe(recipe, {
				hasPr: Boolean(params.pr),
				hasLocalRepo: Boolean(preRepoPath),
				hasSlug: Boolean(preTarget?.slug),
				isGitRepo: preRepoPath ? isGitRepo(preRepoPath) : false,
			});
			if (!pre.ok) throw new Error(pre.error);

			// Effective config = global merged with this project's overrides (Phase 2).
			const config = effectiveConfig(loadConfig(), project?.config);
			const instructions = project?.instructions;

			// Fold any recipe guidance into the brief, then chain off a prior Quest.
			const questBrief = recipe.guidance
				? `${params.brief}\n\n## Recipe guidance (${recipe.id})\n${recipe.guidance}`
				: params.brief;
			const parent = params.fromQuest ? manager.store.load(params.fromQuest) : undefined;
			if (params.fromQuest && !parent) throw new Error(`fromQuest: no Quest with id ${params.fromQuest}.`);
			const brief = parent ? briefWithUpstream(questBrief, parent) : questBrief;

			let contexts: RepoContext[];
			let baseCwd: string;

			// ADDRESS-FEEDBACK: iterate on an existing PR of ours (action its review
			// comments / failing CI) on the PR's OWN branch, then update the same PR.
			if (shape === "address-feedback") {
				if (!params.pr) throw new Error("address-feedback requires a `pr` (the PR to iterate on).");
				if (params.repos?.length) throw new Error("address-feedback works on a single PR/repo; use `repo`, not `repos`.");
				const target = parsePrTarget(params.pr as string);

				// Need a local git checkout of the PR's repo to attach a worktree to.
				let repoPath: string;
				let repoName: string;
				if (project) {
					let r = params.repo ? project.repos.find((x) => x.name === params.repo) : undefined;
					if (params.repo && !r) throw new Error(`Project "${project.id}" has no repo "${params.repo}".`);
					// No repo named: use the sole repo, else infer it from the PR's owner/repo slug.
					if (!r && project.repos.length === 1) r = project.repos[0];
					if (!r) r = pickRepoBySlug(project, target.slug);
					if (!r)
						throw new Error(
							`Project "${project.id}" has multiple repos (${project.repos.map((x) => x.name).join(", ")}) and I couldn't infer which from the PR. Pass a full PR URL (so I can match owner/repo) or set \`repo\`.`,
						);
					repoPath = r.path;
					repoName = r.name;
				} else {
					repoPath = ctx.cwd;
					repoName = ctx.cwd.split("/").filter(Boolean).pop() ?? "repo";
				}
				if (!isGitRepo(repoPath)) throw new Error(`address-feedback needs a local git checkout; "${repoName}" is not one.`);

				// Fetch metadata + feedback (read-only) up front.
				let feedback;
				try {
					feedback = gatherPrFeedback(target, repoPath);
				} catch (e) {
					throw new Error(
						`Could not fetch PR ${params.pr}: ${(e as Error).message.split("\n")[0]}. Is gh authenticated and the PR reachable?`,
					);
				}
				const meta = feedback.metadata;
				if (meta.state === "MERGED") throw new Error(`PR #${meta.number} is already MERGED — nothing to iterate on.`);
				if (!meta.headRefName) throw new Error(`Could not resolve the head branch of PR #${meta.number}.`);

				// Honest stop: nothing actionable → do not start a Quest or invent work.
				if (feedback.actionableCount === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No actionable feedback on PR #${meta.number} (${meta.url}): no unresolved review threads, no change-requests, and no failing CI checks. Not starting a Quest — there's nothing to address right now.`,
							},
						],
						details: { pr: `#${meta.number}`, actionable: 0 },
					};
				}

				const combinedBrief = [formatFeedbackBrief(feedback), "---", "## Additional instructions", questBrief]
					.filter(Boolean)
					.join("\n\n");
				const record = manager.create({
					cwd: repoPath,
					title: params.title,
					brief: parent ? briefWithUpstream(combinedBrief, parent) : combinedBrief,
					project: project?.id,
				});
				if (parent) record.parentId = parent.id;
				record.sourcePr = {
					number: meta.number,
					url: meta.url,
					headBranch: meta.headRefName,
					slug: meta.slug,
					repo: repoName,
					isCrossRepository: meta.isCrossRepository,
					threads: [...feedback.humanThreads, ...feedback.botThreads]
						.filter((t) => t.threadId)
						.map((t) => ({ threadId: t.threadId, commentId: t.commentId, author: t.author })),
				};
				const iso = attachToExistingBranch(repoPath, record.id, { number: meta.number, slug: meta.slug, repoName });
				record.isolations = [iso];
				manager.store.save(record);
				contexts = [{ name: iso.repo, path: iso.worktreePath, writable: true }];
				if (project) for (const r of project.repos) if (r.name !== repoName) contexts.push({ name: r.name, path: r.path, writable: false });
				void runQuestInBackground(record, { write: true, contexts, config, globalInstructions: config.globalInstructions, instructions, partyHint: recipe.party });
				const counts = `${feedback.humanThreads.length} human, ${feedback.botThreads.length} bot, ${feedback.failingChecks.length} failing check(s)`;
				return {
					content: [
						{
							type: "text" as const,
							text: `Started address-feedback Quest "${record.title}" (id ${record.id}) on PR #${meta.number} (${counts}). The party actions the feedback on the PR's own branch (${meta.headRefName}); when done, raise_pr PUSHES the update to PR #${meta.number} (fast-forward, needs your /approve) — no new PR.`,
						},
					],
					details: { id: record.id, project: project?.id, pr: `#${meta.number}` },
				};
			}

			// INVESTIGATE: fetch a PR read-only and produce a REPORT (e.g. assess a
			// reviewer's feedback and draft a plan). The party gets a read-only envoy —
			// it can fetch but cannot post/comment/merge, and no code is changed.
			if (shape === "pr-investigate") {
				if (!params.pr) throw new Error("investigate requires a `pr` to fetch.");
				const target = parsePrTarget(params.pr as string);

				// A local checkout gives the envoy a cwd for `gh pr diff <n>`; otherwise it
				// fetches by `--repo <slug>`. Read-only: we run in the checkout directly, no worktree.
				let repoPath: string | undefined;
				let repoName: string | undefined;
				if (project) {
					const r = params.repo
						? project.repos.find((x) => x.name === params.repo)
						: project.repos.length === 1
							? project.repos[0]
							: pickRepoBySlug(project, target.slug);
					if (params.repo && !r) throw new Error(`Project "${project.id}" has no repo "${params.repo}".`);
					if (r) {
						repoPath = r.path;
						repoName = r.name;
					}
				}

				const prLabel = target.slug ? `${target.slug}#${target.number}` : `#${target.number}`;
				const investigateBrief = [
					`Investigate pull request ${prLabel} and produce a REPORT. Do NOT post, comment, review, or change code.`,
					target.slug ? `Repo: ${target.slug}.` : "",
					repoPath
						? `A checkout of the repo is your cwd; have the envoy run \`gh pr view ${target.number} --json title,body,files,reviews\`, \`gh pr diff ${target.number}\`, and \`gh api repos/{owner}/{repo}/pulls/${target.number}/comments\` for inline review threads.`
						: `No local checkout; have the envoy run \`gh pr view ${target.number}${target.slug ? ` --repo ${target.slug}` : ""} --json title,body,files,reviews\` and \`gh pr diff ${target.number}${target.slug ? ` --repo ${target.slug}` : ""}\`.`,
					"",
					questBrief,
				]
					.filter(Boolean)
					.join("\n");

				const baseDir = repoPath ?? ctx.cwd;
				const record = manager.create({
					cwd: baseDir,
					title: params.title,
					brief: parent ? briefWithUpstream(investigateBrief, parent) : investigateBrief,
					project: project?.id,
				});
				if (parent) record.parentId = parent.id;
				manager.store.save(record);
				contexts = [{ name: repoName ?? "cwd", path: baseDir, writable: false }];
				if (project) for (const r of project.repos) if (r.name !== repoName) contexts.push({ name: r.name, path: r.path, writable: false });
				void runQuestInBackground(record, {
					write: false,
					acquire,
					contexts,
					config,
					globalInstructions: config.globalInstructions,
					instructions,
					partyHint: recipe.party,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Started investigate Quest "${record.title}" (id ${record.id})${project ? ` for ${project.id}` : ""} on ${prLabel}. The party fetches the PR read-only (envoy can fetch but CANNOT post or change anything) and produces a report. Nothing is posted; no code is changed.`,
						},
					],
					details: { id: record.id, project: project?.id, pr: prLabel },
				};
			}

			if (shape === "pr-review") {
				const approvals = getApprovalManager();
				const target = parsePrTarget(params.pr as string);

				// A local checkout to review in, when the PR's repo is registered.
				let repoPath: string | undefined;
				let repoName: string | undefined;
				if (project) {
					const r = params.repo
						? project.repos.find((x) => x.name === params.repo)
						: project.repos.length === 1
							? project.repos[0]
							: undefined;
					if (params.repo && !r) throw new Error(`Project "${project.id}" has no repo "${params.repo}".`);
					if (r) {
						repoPath = r.path;
						repoName = r.name;
					}
				}

				// Best-effort: fetch PR title/body up front for the security gate (and to confirm it exists).
				let prText: string | undefined;
				try {
					const repoArgs = target.slug ? ["--repo", target.slug] : [];
					const out = execFileSync("gh", ["pr", "view", target.number, ...repoArgs, "--json", "title,body"], {
						cwd: repoPath ?? process.cwd(),
						encoding: "utf-8",
						timeout: 20_000,
						stdio: ["ignore", "pipe", "pipe"],
					});
					const j = JSON.parse(out) as { title?: string; body?: string };
					prText = [j.title, j.body].filter(Boolean).join("\n\n") || undefined;
				} catch {
					/* envoy will fetch; if that also fails the party reports FAILED and the Quest fails honestly */
				}

				const prLabel = target.slug ? `${target.slug}#${target.number}` : `#${target.number}`;
				const reviewBrief = [
					`Review pull request ${prLabel}.`,
					target.slug ? `Repo: ${target.slug}.` : "",
					repoPath
						? `A git worktree of the repo is your cwd; have the envoy run \`gh pr checkout ${target.number}\` to get the code, plus \`gh pr diff ${target.number}\`.`
						: `No local checkout; have the envoy run \`gh pr diff ${target.number}${target.slug ? ` --repo ${target.slug}` : ""}\` and \`gh pr view\` to gather the PR.`,
					"",
					questBrief,
				]
					.filter(Boolean)
					.join("\n");

				const record = manager.create({
					cwd: repoPath ?? process.cwd(),
					title: params.title,
					brief: parent ? briefWithUpstream(reviewBrief, parent) : reviewBrief,
					project: project?.id,
				});
				if (parent) record.parentId = parent.id;

				if (repoPath && isGitRepo(repoPath)) {
					const iso = createWorktree(repoPath, record.id, params.title, repoName);
					record.isolations = [iso];
					contexts = [{ name: iso.repo, path: iso.worktreePath, writable: true }];
				} else {
					const scratch = path.join(guildmasterHome(), "review", record.id);
					fs.mkdirSync(scratch, { recursive: true });
					contexts = [{ name: "pr", path: scratch, writable: true }];
				}
				manager.store.save(record);
				void runQuestInBackground(record, {
					write: false,
					contexts,
					config,
					globalInstructions: config.globalInstructions,
					instructions,
					review: { prText, approvals, number: target.number, slug: target.slug, repoName, label: prLabel },
					partyHint: recipe.party,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Started PR review Quest "${record.title}" (id ${record.id})${project ? ` for ${project.id}` : ""} on ${prLabel}. The party fetches the PR, reviews it (correctness, security, adversarial), and Scribe drafts the review. When it's ready the Quest PAUSES and drops the review into your inbox as an EDITABLE draft: /review it (read + edit review.md), then /approve to post the edited version or /deny to leave it as a draft. Nothing is posted without your approval, and it never merges.`,
						},
					],
					details: { id: record.id, project: project?.id, pr: prLabel },
				};
			}

			if (shape === "write") {
				// A write Quest targets one OR MORE repos (each worktree writable); any other
				// project repos are available read-only for context.
				let targets: { name: string; path: string }[];
				if (project) {
					const names =
						params.repos?.length ? params.repos : params.repo ? [params.repo] : project.repos.length === 1 ? [project.repos[0].name] : undefined;
					if (!names) {
						throw new Error(
							`Project "${project.id}" has multiple repos (${project.repos.map((r) => r.name).join(", ")}). Specify which to change with \`repo\` (one) or \`repos\` (several).`,
						);
					}
					targets = names.map((n) => {
						const r = project.repos.find((x) => x.name === n);
						if (!r) throw new Error(`Project "${project.id}" has no repo "${n}". Repos: ${project.repos.map((x) => x.name).join(", ")}.`);
						return { name: r.name, path: r.path };
					});
				} else {
					targets = [{ name: ctx.cwd.split("/").filter(Boolean).pop() ?? "repo", path: ctx.cwd }];
				}
				for (const t of targets) {
					if (!isGitRepo(t.path)) throw new Error(`Write Quests require a git repository; "${t.name}" is not one.`);
					if (inPlace && !isWorkingTreeClean(t.path))
						throw new Error(`In-place Quest requires a clean working tree in "${t.name}"; commit or stash your changes first.`);
				}
				const record = manager.create({ cwd: targets[0].path, title: params.title, brief, project: project?.id });
				if (parent) record.parentId = parent.id;
				record.isolations = targets.map((t) =>
					inPlace ? inPlaceIsolation(t.path, record.id, params.title, t.name) : createWorktree(t.path, record.id, params.title, t.name),
				);
				manager.store.save(record);
				contexts = record.isolations.map((iso) => ({ name: iso.repo, path: iso.worktreePath, writable: true }));
				if (project) {
					for (const r of project.repos) if (!targets.some((t) => t.name === r.name)) contexts.push({ name: r.name, path: r.path, writable: false });
				}
				void runQuestInBackground(record, { write: true, inPlace, contexts, config, globalInstructions: config.globalInstructions, instructions, partyHint: recipe.party, fastWrite: useFastWrite(recipe, targets.length, brief), legacyWrite: recipe.id === "write-legacy" });
				return started(record, project?.id, targets.map((t) => t.name).join("+"), true, inPlace);
			}

			// Read/investigation Quest: all project repos read-only, or the cwd.
			if (project) {
				contexts = readonlyContexts(project);
				baseCwd = project.repos[0]?.path ?? ctx.cwd;
			} else {
				contexts = [{ name: "cwd", path: ctx.cwd, writable: false }];
				baseCwd = ctx.cwd;
			}
			const record = manager.create({ cwd: baseCwd, title: params.title, brief, project: project?.id });
			if (parent) {
				record.parentId = parent.id;
				manager.store.save(record);
			}
			void runQuestInBackground(record, { write: false, acquire, slack: recipe.slack === "read", contexts, config, globalInstructions: config.globalInstructions, instructions, partyHint: recipe.party });
			return started(record, project?.id, undefined, false);
		},

		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("quest "))}${theme.fg("accent", args.title ?? "…")}`, 0, 0);
		},
		renderResult(result) {
			const t = result.content[0];
			return new Text(t?.type === "text" ? t.text : "(started)", 0, 0);
		},
	});

	pi.registerTool({
		name: "quest_status",
		label: "Quest Status",
		description:
			"Read the state of background Quests. With no argument, lists recent Quests and their state. With a " +
			"questId, returns that Quest's party, draft PR, and full report. Use when the user asks what's happening " +
			"or wants a Quest's results.",
		promptSnippet: "Check background Quest state or fetch a Quest's report on demand",
		promptGuidelines: [
			"Use quest_status to answer questions about running or finished Quests instead of guessing. Pass a questId to retrieve a Quest's full report only when the user wants the detail.",
		],
		parameters: Type.Object({
			questId: Type.Optional(Type.String({ description: "Quest id for full detail; omit to list recent Quests" })),
			project: Type.Optional(Type.String({ description: "Only list Quests for this project id" })),
		}),
		async execute(_toolCallId, params) {
			const manager = getQuestManager();
			// Fail any orphaned non-terminal Quest first, so a dead run never reads as running.
			const records = manager.reconcileOrphans();
			if (params.questId) {
				const q = records.find((r) => r.id === params.questId);
				if (!q) throw new Error(`No Quest with id ${params.questId}.`);
				return { content: [{ type: "text", text: describeQuest(q) }], details: q };
			}
			const active = new Set(manager.getActive().map((q) => q.id));
			const list = records
				.filter((q) => !params.project || q.project === params.project)
				.slice(0, 12);
			const text = list.length
				? list
						.map((q) => {
							const raised = q.prs?.filter((p) => p.url).length ?? 0;
							const drafts = q.prs?.filter((p) => !p.url).length ?? 0;
							const pr = raised ? `  [${raised} PR(s) raised]` : drafts ? `  [${drafts} draft PR(s) ready]` : "";
							const proj = q.project ? `[${q.project}] ` : "";
							return `${active.has(q.id) ? "● " : "  "}${q.state.padEnd(11)} ${proj}${q.title}  ${q.id}${pr}`;
						})
						.join("\n")
				: "No Quests yet.";
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "quest_dismiss",
		label: "Quest Dismiss",
		description: [
			"Stand a Quest down and remove it from the Guild board. Cancels it if still running; for a finished",
			"Quest it first PRESERVES its report to the Guildmaster reports store, then tears down the isolated",
			"worktree + branch, deletes the record and its saved diff, and refreshes the board. In-place Quests keep",
			"their branch (that is the user's real checkout) — only the record is removed. Never touches the user's",
			"checkout. Use to clean up demo/abandoned Quests.",
		].join(" "),
		promptSnippet: "Stand down and remove a Quest (cancel if running, tear down its worktree/branch, clear the board)",
		promptGuidelines: [
			"Use quest_dismiss to stand down and clean up a Quest the user is done with instead of deleting files by hand. It cancels a running Quest, and for a finished one removes its worktree, branch, record and diff, then refreshes the Guild board. In-place Quests keep their branch (the user's real checkout).",
		],
		parameters: Type.Object({
			questId: Type.String({ description: "Id of the Quest to stand down and remove." }),
		}),
		async execute(_toolCallId, params) {
			const manager = getQuestManager();
			const { record, cancelledRunning, tornDown, inPlaceKept, savedReport } = manager.dismiss(params.questId);
			if (!record) throw new Error(`No Quest with id ${params.questId}.`);
			const title = `"${record.title}"`;
			const branchNote = tornDown ? "worktree + branch torn down, " : inPlaceKept ? "in-place branch left intact, " : "";
			const savedNote = savedReport ? ` Report preserved to ${savedReport}.` : "";
			const text = cancelledRunning
				? `Quest ${title} was still running — sent it a cancel. It will settle to "cancelled" shortly; dismiss again afterwards to remove its record and worktree.`
				: `Dismissed Quest ${title} — ${branchNote}record and diff removed, and cleared from the Guild board.${savedNote}`;
			return { content: [{ type: "text", text }], details: { id: params.questId, cancelledRunning, tornDown, savedReport } };
		},
	});

	pi.registerTool({
		name: "quest_turn_in",
		label: "Quest Turn In",
		description: [
			"Turn in (acknowledge) a finished Quest so it leaves the Guild board while staying in history.",
			"Completed and failed Quests persist on the board until turned in, so a completion is never missed",
			"while multitasking. Non-destructive: keeps the record, report, branch and any draft PR. Use",
			"quest_dismiss instead to fully stand a Quest down and delete it.",
		].join(" "),
		promptSnippet: "Turn in (acknowledge) a finished Quest so it leaves the board but stays in history",
		promptGuidelines: [
			"Completed and failed Quests stay on the Guild board until turned in. Use quest_turn_in when the user has seen a finished Quest and wants it cleared from the board without deleting it (report/branch/PR are kept). Use quest_dismiss only to fully delete + tear down.",
		],
		parameters: Type.Object({
			questId: Type.String({ description: "Id of the finished Quest to turn in." }),
		}),
		async execute(_toolCallId, params) {
			const manager = getQuestManager();
			const rec = manager.acknowledge(params.questId);
			if (!rec) throw new Error(`No Quest with id ${params.questId}.`);
			if (!rec.acknowledgedAt)
				throw new Error(`Quest "${rec.title}" is ${rec.state}, not finished yet — only completed/failed Quests can be turned in.`);
			return {
				content: [{ type: "text", text: `Turned in Quest "${rec.title}" — cleared from the Guild board, kept in history.` }],
				details: { id: params.questId },
			};
		},
	});
}
