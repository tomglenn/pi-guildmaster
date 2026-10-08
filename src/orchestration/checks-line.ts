/**
 * The party's own statement about its checks.
 *
 * Guildmaster does not verify a party's work: the party runs its checks, attacks its own
 * diff (warden / inquisitor) and iterates until done. It ends its final report with ONE
 * line, `CHECKS: PASS | FAIL | NONE — <commands and exit codes>`, and Guildmaster only
 * reads that line to decide what to report and whether to open the draft PR.
 */

export type ChecksStatus = "pass" | "fail" | "none";

export const CHECKS_LINE_HELP =
	"End the final report with exactly ONE line `CHECKS: PASS — <commands and exit codes>`, `CHECKS: FAIL — <what fails>` or `CHECKS: NONE — <why no checks apply>`.";

const LINE = /^[ \t>*_`]*CHECKS:\s*(PASS|FAIL|NONE)\b[*_`]*\s*(?:[-\u2013\u2014:]\s*)?(.*)$/gim;

/** Read the party's CHECKS line (the last one wins) and return the report without it. A missing line is NONE. */
export function parseChecksLine(report: string): { status: ChecksStatus; detail: string; body: string; stated: boolean } {
	const matches = [...report.matchAll(LINE)];
	const last = matches.at(-1);
	const body = report.replace(LINE, "").replace(/\n{3,}/g, "\n\n").trim();
	if (!last) return { status: "none", detail: "The party did not say which checks it ran.", body, stated: false };
	return { status: last[1].toLowerCase() as ChecksStatus, detail: last[2].replace(/[*_`]+$/, "").trim(), body, stated: true };
}
