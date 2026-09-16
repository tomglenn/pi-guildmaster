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

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { effectiveConfig, loadConfig } from "./config.ts";
import type { GuildmasterConfig } from "./config.ts";
import { commitAndDiff, createWorktree, inPlaceIsolation, isGitRepo, isWorkingTreeClean } from "./execution/isolation.ts";
import { getQuestManager } from "./orchestration/manager.ts";
import { runParty } from "./orchestration/party-leader.ts";
import { readonlyContexts, resolveProjectQuery } from "./orchestration/resolve.ts";
import { ProjectStore, type RepoContext } from "./persistence/project-store.ts";
import type { QuestRecord } from "./persistence/quest-store.ts";
import { questsDir } from "./paths.ts";
import { loadRoster } from "./roster.ts";

function started(record: QuestRecord, projectId?: string, targetRepo?: string, write = false, inPlace = false) {
	const scope = projectId ? ` for project ${projectId}${targetRepo ? `/${targetRepo}` : ""}` : "";
	const branch = record.isolations?.[0]?.branch;
	const tail = write
		? inPlace
			? `It is working IN-PLACE in your real checkout${branch ? ` on branch ${branch}` : ""} — changes are committed there for you to review directly. No worktree, no PR.`
			: "When it finishes it will produce a draft PR you can raise with raise_pr."
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
async function runQuestInBackground(
	record: QuestRecord,
	opts: { write: boolean; inPlace?: boolean; contexts: RepoContext[]; config: GuildmasterConfig; instructions?: string },
): Promise<void> {
	const manager = getQuestManager();
	const roster = loadRoster();
	try {
		await manager.run(record, async (api) => {
			const party = await runParty({
				brief: api.record.brief,
				contexts: opts.contexts,
				roster,
				config: opts.config,
				signal: api.signal,
				write: opts.write,
				instructions: opts.instructions,
				onProgress: (members) => api.setMembers(members),
			});
			if (!party.report?.trim() && party.error) throw new Error(party.error);

			// Commit each writable repo's worktree + draft a PR per changed repo BEFORE
			// completion, so the completed record already carries its branches/PRs.
			if (opts.write && record.isolations?.length && party.report) {
				const { title, body } = draftPrFromReport(party.report);
				const multi = record.isolations.length > 1;
				const prs = [];
				for (const iso of record.isolations) {
					const changes = commitAndDiff(iso, title);
					if (!changes.committed) continue;
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
			}
			return { report: party.report, usage: party.usage };
		}, {});
	} catch {
		// manager.run already transitioned the record to failed and persisted it.
	}
}

function describeQuest(q: QuestRecord): string {
	const lines = [`Quest "${q.title}" (${q.id}) — ${q.state}${q.project ? ` [${q.project}]` : ""}`];
	if (q.members.length) lines.push(`Party: ${q.members.map((m) => `${m.name}@${m.repo ?? "?"}:${m.status}`).join(", ")}`);
	if (q.isolations?.length) lines.push(`Branches: ${q.isolations.map((i) => `${i.repo}→${i.branch}`).join(", ")}`);
	for (const pr of q.prs ?? []) {
		lines.push(`PR (${pr.repo}): ${pr.url ?? "draft, not raised — use raise_pr"}${pr.diffStat ? `\n${pr.diffStat}` : ""}`);
	}
	if (q.error) lines.push(`Error: ${q.error}`);
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
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const manager = getQuestManager();
			const write = params.write ?? false;
			const inPlace = (params.inPlace ?? false) && write;

			// Resolve the named project (if any). cwd is only a fallback.
			const projectStore = new ProjectStore();
			const project = params.project ? (() => {
				const r = resolveProjectQuery(projectStore, params.project as string);
				if (r.error) throw new Error(r.error);
				return r.project;
			})() : undefined;

			// Effective config = global merged with this project's overrides (Phase 2).
			const config = effectiveConfig(loadConfig(), project?.config);
			const instructions = project?.instructions;

			let contexts: RepoContext[];
			let baseCwd: string;

			if (write) {
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
				const record = manager.create({ cwd: targets[0].path, title: params.title, brief: params.brief, project: project?.id });
				record.isolations = targets.map((t) =>
					inPlace ? inPlaceIsolation(t.path, record.id, params.title, t.name) : createWorktree(t.path, record.id, params.title, t.name),
				);
				manager.store.save(record);
				contexts = record.isolations.map((iso) => ({ name: iso.repo, path: iso.worktreePath, writable: true }));
				if (project) {
					for (const r of project.repos) if (!targets.some((t) => t.name === r.name)) contexts.push({ name: r.name, path: r.path, writable: false });
				}
				void runQuestInBackground(record, { write: true, inPlace, contexts, config, instructions });
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
			const record = manager.create({ cwd: baseCwd, title: params.title, brief: params.brief, project: project?.id });
			void runQuestInBackground(record, { write: false, contexts, config, instructions });
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
			if (params.questId) {
				const q = manager.store.load(params.questId);
				if (!q) throw new Error(`No Quest with id ${params.questId}.`);
				return { content: [{ type: "text", text: describeQuest(q) }], details: q };
			}
			const active = new Set(manager.getActive().map((q) => q.id));
			const list = manager.store
				.list()
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
			"Quest it tears down the isolated worktree + branch, deletes the record and its saved diff, and",
			"refreshes the board. In-place Quests keep their branch (that is the user's real checkout) — only the",
			"record is removed. Never touches the user's checkout. Use to clean up demo/abandoned Quests.",
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
			const { record, cancelledRunning, tornDown } = manager.dismiss(params.questId);
			if (!record) throw new Error(`No Quest with id ${params.questId}.`);
			const title = `"${record.title}"`;
			const text = cancelledRunning
				? `Quest ${title} was still running — sent it a cancel. It will settle to "cancelled" shortly; dismiss again afterwards to remove its record and worktree.`
				: `Dismissed Quest ${title} — ${tornDown ? "worktree + branch torn down" : "in-place branch left intact"}, record and diff removed, and cleared from the Guild board.`;
			return { content: [{ type: "text", text }], details: { id: params.questId, cancelledRunning, tornDown } };
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
