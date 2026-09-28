/**
 * Huddle tools (§ interactive quests, Stage 2) — the foreground handshake.
 *
 * When a running party hits a genuinely COLLABORATIVE decision (e.g. agreeing a
 * plan before it implements), it raises a `huddle` request (via `request_user`)
 * and parks. A huddle is NOT answered from the terminal inbox with one command —
 * it is handed to the foreground Guildmaster, who reads the draft artifact,
 * discusses it with the user over as many rounds as needed, EDITS the artifact
 * file directly, and then resumes the party with the settled artifact.
 *
 * These two tools are that handshake, and they belong to the Guildmaster (not the
 * party):
 *   - `quest_huddle`  → pick up a pending huddle: load its topic + artifact so the
 *                        Guildmaster can work through it with the user.
 *   - `quest_resume`  → settle the huddle: unpark the party so it continues with the
 *                        (possibly user-edited) artifact. `proceed:false` ends the
 *                        huddle without settling.
 *
 * Conversation happens where it works — the foreground — and the party never has
 * to host a chat. The artifact on disk is the durable interface between them.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ApprovalManager, UserRequest } from "./orchestration/approvals.ts";
import { getApprovalManager, getQuestManager } from "./orchestration/manager.ts";

/** Find the pending huddle request for a quest (or the sole/most-recent one). Exported for tests. */
export function findHuddle(approvals: ApprovalManager, questId?: string): { request?: UserRequest; ambiguous?: UserRequest[] } {
	const huddles = approvals.list().filter((r) => r.kind === "huddle");
	if (questId) {
		const forQuest = huddles.filter((r) => r.questId === questId || r.id === questId);
		return { request: forQuest[forQuest.length - 1] };
	}
	if (huddles.length === 1) return { request: huddles[0] };
	if (huddles.length === 0) return {};
	return { ambiguous: huddles };
}

export function registerHuddleTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "quest_huddle",
		label: "Quest Huddle",
		description: [
			"Pick up a Quest that has PAUSED for a huddle — a collaborative decision (e.g. a plan) the party wants to",
			"work through with the user before it proceeds. Returns the topic and the draft artifact's path + contents.",
			"After calling this: discuss the artifact with the user, EDIT the artifact file directly as you converge,",
			"and when it is settled call quest_resume to let the party continue. Omit questId if only one huddle is pending.",
		].join(" "),
		promptSnippet: "Pick up a Quest paused for a collaborative huddle (loads the draft artifact to work through with the user)",
		promptGuidelines: [
			"When a Quest is 'waiting on you' for a huddle (see /inbox or the board), use quest_huddle to load the draft, then work through it WITH the user in the foreground — edit the artifact file directly over as many rounds as needed. When the user is happy, call quest_resume to unpark the party with the settled artifact. Use quest_resume with proceed:false only if the user wants to abandon the change.",
		],
		parameters: Type.Object({
			questId: Type.Optional(Type.String({ description: "Quest id (or request id) of the huddle. Omit if only one is pending." })),
		}),
		async execute(_toolCallId, params) {
			const approvals = getApprovalManager();
			const { request, ambiguous } = findHuddle(approvals, params.questId);
			if (ambiguous) {
				const list = ambiguous.map((r) => `${r.id}${r.questId ? ` (quest ${r.questId})` : ""}: ${r.title}`).join("\n");
				throw new Error(`Several huddles are pending — pass questId to choose one:\n${list}`);
			}
			if (!request) throw new Error(params.questId ? `No pending huddle for "${params.questId}".` : "No Quest is currently waiting for a huddle.");

			const quest = request.questId ? getQuestManager().store.load(request.questId) : undefined;
			let content = "";
			if (request.artifactPath) {
				try {
					content = fs.readFileSync(request.artifactPath, "utf-8");
				} catch {
					content = "(could not read the artifact file — it may not have been written)";
				}
			}
			const header = [
				`Huddle for Quest ${quest ? `"${quest.title}" (${quest.id})` : request.questId ?? "?"} — request ${request.id}.`,
				`Topic: ${request.title}`,
				request.description ? `Context: ${request.description}` : "",
				request.artifactPath ? `Artifact file (edit this directly as you and the user converge): ${request.artifactPath}` : "(no artifact file)",
				"",
				"Work through this WITH the user over as many rounds as they want, editing the artifact file. When it is",
				`settled, call quest_resume${request.questId ? ` (questId "${request.questId}")` : ""} to let the party continue.`,
				"",
				"--- Current artifact ---",
				content,
			]
				.filter(Boolean)
				.join("\n");
			return { content: [{ type: "text", text: header }], details: { requestId: request.id, questId: request.questId, artifactPath: request.artifactPath } };
		},
	});

	pi.registerTool({
		name: "quest_resume",
		label: "Quest Resume",
		description: [
			"Resume a Quest that is paused for a huddle, once you and the user have settled its draft artifact. This",
			"unparks the party so it continues with the (possibly user-edited) artifact as authoritative. Pass",
			"`proceed:false` (with a reason in `notes`) to END the huddle without settling — the party then stops",
			"rather than proceeding. Omit questId if only one huddle is pending.",
		].join(" "),
		promptSnippet: "Resume a huddle-paused Quest with the settled artifact (or end it with proceed:false)",
		promptGuidelines: [
			"Call quest_resume after a huddle once the user is happy with the edited artifact — the party picks up the settled version and proceeds. Use proceed:false only to abandon.",
		],
		parameters: Type.Object({
			questId: Type.Optional(Type.String({ description: "Quest id (or request id) of the huddle. Omit if only one is pending." })),
			notes: Type.Optional(Type.String({ description: "Closing notes for the party (e.g. what you agreed, or why you stopped)." })),
			proceed: Type.Optional(Type.Boolean({ description: "Default true. false ends the huddle without settling — the party stops." })),
		}),
		async execute(_toolCallId, params) {
			const approvals = getApprovalManager();
			const { request, ambiguous } = findHuddle(approvals, params.questId);
			if (ambiguous) {
				const list = ambiguous.map((r) => `${r.id}${r.questId ? ` (quest ${r.questId})` : ""}: ${r.title}`).join("\n");
				throw new Error(`Several huddles are pending — pass questId to choose one:\n${list}`);
			}
			if (!request) throw new Error(params.questId ? `No pending huddle for "${params.questId}".` : "No Quest is currently waiting for a huddle.");
			const proceed = params.proceed !== false;
			approvals.answer(request.id, { action: proceed ? "approve" : "send-back", approved: proceed, text: params.notes });
			const quest = request.questId ? getQuestManager().store.load(request.questId) : undefined;
			const label = quest ? `"${quest.title}"` : (request.questId ?? request.id);
			return {
				content: [
					{
						type: "text",
						text: proceed
							? `Resumed Quest ${label} — the party is continuing with the settled artifact. It'll surface on the Guild board again as it works.`
							: `Ended the huddle for Quest ${label} without settling — the party will stop rather than proceed.`,
					},
				],
				details: { requestId: request.id, questId: request.questId, proceed },
			};
		},
	});
}
