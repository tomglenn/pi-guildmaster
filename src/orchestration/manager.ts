/**
 * Process-wide QuestManager singleton, shared by the `quest` tool and the
 * `/quests` / `/party` commands so they observe the same active Quests.
 */

import { ApprovalManager } from "./approvals.ts";
import { QuestManager } from "./quest.ts";

let manager: QuestManager | undefined;
let approvals: ApprovalManager | undefined;

export function getQuestManager(): QuestManager {
	manager ??= new QuestManager();
	return manager;
}

export function getApprovalManager(): ApprovalManager {
	approvals ??= new ApprovalManager();
	return approvals;
}
