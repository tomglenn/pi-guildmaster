import type { QuestMember } from "../persistence/quest-store.ts";

export type CheckResult = { command: string; exitCode?: number };

/** A shell invocation counts only if it looks like a bounded verification command. */
export function isCheck(command: string): boolean {
	// Do not credit a shell command that can mask a failing check's exit status.
	if (/\|\||[|;]|(?<![&0-9])&(?![&0-9])/.test(command)) return false;
	return /\b(test|vitest|jest|pytest|go\s+test|cargo\s+test|typecheck|lint|build|tsc)\b/i.test(command);
}

export function checkResults(results: { command?: string; exitCode?: number }[]): CheckResult[] {
	return results.filter((r): r is CheckResult => Boolean(r.command && isCheck(r.command))).map((r) => ({ command: r.command, exitCode: r.exitCode }));
}

/** Never infer success from a member's prose. A failed check must be rerun successfully. */
export function evaluateVerification(members: QuestMember[], repos?: string[]): { state: "verified" | "unverified" | "failed"; checks: CheckResult[] } {
	const byRepo = new Map<string, Map<string, CheckResult>>();
	for (const member of members) for (const check of member.checks ?? []) {
		const repo = member.repo ?? "cwd";
		if (!byRepo.has(repo)) byRepo.set(repo, new Map());
		byRepo.get(repo)?.set(check.command, check);
	}
	const checks = [...byRepo.values()].flatMap((r) => [...r.values()]);
	if (checks.some((c) => c.exitCode !== 0)) return { state: "failed", checks };
	const expected = repos ?? [...byRepo.keys()];
	return { state: expected.length > 0 && expected.every((repo) => (byRepo.get(repo)?.size ?? 0) > 0) ? "verified" : "unverified", checks };
}
