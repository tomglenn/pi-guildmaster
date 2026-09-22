/**
 * Host agent bash tool gate (§10, addresses Quest feedback).
 *
 * The host Guildmaster agent has access to the raw `bash` tool, which child agents
 * (scouts, writers, runners, envoys) do NOT. Today that tool is ungated, which let
 * a destructive command (`gh pr close 1953 --delete-branch`) run with zero approval.
 *
 * This module classifies host shell commands and returns whether they need approval,
 * are forbidden, or may pass freely:
 *   - FORBIDDEN → block outright (gh pr merge)
 *   - DESTRUCTIVE or remote MUTATE → park an approval
 *   - READ → pass
 *
 * Integrated via a `tool_call` event in src/index.ts that intercepts bash
 * tool calls and gates them before execution.
 */

import { classifyHostCommand, splitShellSegments } from "./policy.ts";

export interface HostGateDecision {
	/** The command should be blocked outright (forbidden operations). */
	blocked: boolean;
	/** The command requires human approval before running (destructive/mutate). */
	needsApproval: boolean;
	operation: string;
	reason: string;
}

/**
 * Gate a bash command for the HOST agent. Reads pass freely; destructive operations
 * and remote mutations require approval; forbidden operations are blocked.
 *
 * Returns a decision: blocked (refuse), needsApproval (park), or neither (allow).
 */
export function gateHostCommand(command: string): HostGateDecision {
	// Classify all segments; take the most severe classification
	const segments = splitShellSegments(command);
	
	// Track the worst classification we've seen
	let hasDestructive = false;
	let hasMutate = false;
	let worstOp = "";
	let worstReason = "";

	for (const seg of segments) {
		const decision = classifyHostCommand(seg);
		
		// Forbidden → return immediately
		if (decision.klass === "forbidden") {
			return {
				blocked: true,
				needsApproval: false,
				operation: decision.operation,
				reason: decision.reason,
			};
		}
		
		// Track destructive
		if (decision.klass === "destructive") {
			hasDestructive = true;
			worstOp = decision.operation;
			worstReason = decision.reason;
		}
		
		// Track mutate (only if we haven't seen destructive yet)
		if (decision.klass === "mutate" && !hasDestructive) {
			hasMutate = true;
			worstOp = decision.operation;
			worstReason = decision.reason;
		}
	}

	// If we found destructive or mutate, require approval
	if (hasDestructive || hasMutate) {
		return {
			blocked: false,
			needsApproval: true,
			operation: worstOp,
			reason: worstReason,
		};
	}

	// Read or empty command
	return {
		blocked: false,
		needsApproval: false,
		operation: worstOp,
		reason: worstReason || "non-privileged command",
	};
}
