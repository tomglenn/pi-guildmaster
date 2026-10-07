import type { QuestMember } from "../persistence/quest-store.ts";

/** `masked`: a check-like command chained so its exit code cannot be trusted (e.g. `npm test; echo $?`). */
export type CheckResult = { command: string; exitCode?: number; masked?: true };

const CHECK_RE = /\b(test|vitest|jest|pytest|go\s+test|cargo\s+test|typecheck|lint|build|tsc)\b/i;
/** `;`, `|`, `||` or a lone `&` can hide a failing check's exit status. `&&` and `2>&1` cannot. */
const MASKING_RE = /\|\||[|;]|(?<![&0-9>])&(?![&0-9>])/;

/** Programs that never verify anything, even when a path argument contains "test" (e.g. `git add test/x.js`). */
const NON_CHECK_PROGRAMS = new Set(["git", "cd", "cat", "ls", "echo", "printf", "sed", "awk", "grep", "rg", "find", "head", "tail", "wc", "cp", "mv", "rm", "mkdir", "touch", "diff", "less", "true", "false", "export", "pwd"]);
const SEGMENT_SPLIT = /&&|\|\||[;|]|(?<![&0-9>])&(?![&0-9>])/;

/**
 * True when some command in the line actually RUNS a check: the program is not a plain
 * file/git utility, and a check word appears outside path/file arguments.
 */
function runsCheck(command: string): boolean {
	return command.split(SEGMENT_SPLIT).some((segment) => {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift(); // FOO=1 npm test
		if (!tokens.length || NON_CHECK_PROGRAMS.has(tokens[0])) return false;
		const words = tokens.filter((t) => !/[/.]/.test(t) || /^(\.\/)?(node_modules\/\.bin\/|gradlew)/.test(t));
		return CHECK_RE.test(words.join(" "));
	});
}

/** A shell invocation counts only if it looks like a bounded verification command. */
export function isCheck(command: string): boolean {
	// Do not credit a shell command that can mask a failing check's exit status.
	if (MASKING_RE.test(command)) return false;
	return runsCheck(command);
}

/** A check-like command whose exit status may be masked: recorded so the status can say why, never credited. */
export function isMaskedCheck(command: string): boolean {
	return MASKING_RE.test(command) && runsCheck(command);
}

export function checkResults(results: { command?: string; exitCode?: number }[]): CheckResult[] {
	const out: CheckResult[] = [];
	for (const r of results) {
		if (!r.command) continue;
		if (isCheck(r.command)) out.push({ command: r.command, exitCode: r.exitCode });
		else if (isMaskedCheck(r.command)) out.push({ command: r.command, exitCode: r.exitCode, masked: true });
	}
	return out;
}

/** Never infer success from a member's prose. A failed check must be rerun successfully. */
export function evaluateVerification(
	members: QuestMember[],
	repos?: string[],
): { state: "verified" | "unverified" | "failed"; checks: CheckResult[]; masked: CheckResult[] } {
	const byRepo = new Map<string, Map<string, CheckResult>>();
	const masked: CheckResult[] = [];
	for (const member of members) for (const check of member.checks ?? []) {
		if (check.masked) {
			masked.push(check);
			continue;
		}
		const repo = member.repo ?? "cwd";
		if (!byRepo.has(repo)) byRepo.set(repo, new Map());
		byRepo.get(repo)?.set(check.command, check);
	}
	const checks = [...byRepo.values()].flatMap((r) => [...r.values()]);
	if (checks.some((c) => c.exitCode !== 0)) return { state: "failed", checks, masked };
	const expected = repos ?? [...byRepo.keys()];
	return { state: expected.length > 0 && expected.every((repo) => (byRepo.get(repo)?.size ?? 0) > 0) ? "verified" : "unverified", checks, masked };
}

/** Why a write Quest is unverified, for the record and the report. */
export function unverifiedReason(masked: CheckResult[]): string {
	if (masked.length === 0) return "No observed passing verification checks; branch kept local.";
	const cmds = [...new Set(masked.map((c) => `\`${c.command}\``))].slice(0, 3).join(", ");
	return `Checks ran, but each was chained with ';' or '|' (${cmds}), which hides the real exit code. They were not counted. Branch kept local; rerun the checks as plain commands (for example \`npm test\`).`;
}
