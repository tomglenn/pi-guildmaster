/**
 * Last safety net before a draft PR is published: a fast pattern scan of the ADDED diff
 * lines and the PR title/body for things that must never be public — credentials and
 * links to internal chat. It does not judge the work (that is the party's job), and it
 * reports the kind and location of a hit, never the matched value.
 */

export type SensitiveHit = { kind: string; where: string };

const PATTERNS: { kind: string; re: RegExp }[] = [
	{ kind: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
	{ kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
	{ kind: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
	{ kind: "Slack webhook", re: /hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/_-]+/ },
	{ kind: "Slack message link", re: /\b[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+/i },
	{ kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ kind: "Stripe live key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
	{ kind: "OpenAI/Anthropic key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/ },
	{
		kind: "hard-coded secret",
		re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i,
	},
];

function scanText(text: string, where: (lineNo: number) => string): SensitiveHit[] {
	const hits: SensitiveHit[] = [];
	text.split("\n").forEach((line, i) => {
		for (const p of PATTERNS) if (p.re.test(line)) hits.push({ kind: p.kind, where: where(i + 1) });
	});
	return hits;
}

/** Scan only lines the change ADDS (unified diff `+` lines), so pre-existing content is not flagged. */
export function scanDiff(diff: string): SensitiveHit[] {
	const hits: SensitiveHit[] = [];
	let file = "?";
	let line = 0;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ ")) {
			file = raw.slice(4).replace(/^b\//, "");
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
		if (hunk) {
			line = Number(hunk[1]);
			continue;
		}
		if (raw.startsWith("+")) {
			for (const p of PATTERNS) if (p.re.test(raw.slice(1))) hits.push({ kind: p.kind, where: `${file}:${line}` });
			line++;
		} else if (!raw.startsWith("-")) line++;
	}
	return hits;
}

export function scanPrText(title: string, body: string): SensitiveHit[] {
	return [...scanText(title, () => "PR title"), ...scanText(body, (n) => `PR body line ${n}`)];
}

export function describeHits(hits: SensitiveHit[]): string {
	const shown = hits.slice(0, 5).map((h) => `${h.kind} at ${h.where}`).join("; ");
	return `${shown}${hits.length > 5 ? `; and ${hits.length - 5} more` : ""}`;
}
