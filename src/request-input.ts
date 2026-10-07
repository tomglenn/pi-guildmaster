/**
 * Pure input helpers for answering inbox requests (/choose, /answer, /approve …).
 *
 * Kept free of pi APIs so the matching and completion rules are unit-testable. The
 * rules aim at "the user's intent is never silently dropped":
 * - completions never offer unrelated items (pi replaces the WHOLE argument text with
 *   a picked completion, so a stray suggestion would swallow what the user typed);
 * - an option can be picked by number, exact text, unique prefix or unique substring;
 * - anything ambiguous is reported with numbered options, never guessed.
 */

import type { UserRequest } from "./orchestration/approvals.ts";

export type OptionMatch = { choice: string } | { error: string };

/** Options as numbered lines, e.g. "1. Ship it". Options may contain commas, so never join them inline. */
export function numberedOptions(options: readonly string[]): string[] {
	return options.map((o, i) => `${i + 1}. ${o}`);
}

/** Resolve user input to exactly one option, or explain why not. */
export function matchOption(options: readonly string[], input: string): OptionMatch {
	const raw = input.trim();
	if (!raw) return { error: "No option given." };
	const n = /^#?(\d+)\.?$/.exec(raw);
	if (n) {
		const i = Number(n[1]) - 1;
		if (i >= 0 && i < options.length) return { choice: options[i] };
		return { error: `There is no option ${raw}. Choose 1–${options.length}.` };
	}
	const q = raw.toLowerCase();
	const exact = options.find((o) => o.toLowerCase() === q);
	if (exact) return { choice: exact };
	for (const pick of [(o: string) => o.toLowerCase().startsWith(q), (o: string) => o.toLowerCase().includes(q)]) {
		const hits = options.filter(pick);
		if (hits.length === 1) return { choice: hits[0] };
		if (hits.length > 1) return { error: `"${raw}" matches more than one option (${hits.map((h) => options.indexOf(h) + 1).join(", ")}). Use the option number.` };
	}
	return { error: `"${raw}" does not match any option. Use the option number.` };
}

/** Resolve by exact id or a unique suffix. */
export function resolveRequestId(pending: readonly UserRequest[], arg: string): string | undefined {
	const trimmed = arg.trim();
	if (!trimmed) return undefined;
	if (pending.some((r) => r.id === trimmed)) return trimmed;
	const matches = pending.filter((r) => r.id.endsWith(trimmed));
	return matches.length === 1 ? matches[0].id : undefined;
}

/**
 * Split command arguments into a request + the rest of the line. The id is optional
 * when exactly one pending request of the accepted kinds exists: `/choose 2` works,
 * and so does `/choose <id> 2`.
 */
export function parseRequestArgs(
	pending: readonly UserRequest[],
	kinds: readonly UserRequest["kind"][],
	args: string,
): { id?: string; rest: string; error?: string; implicit?: boolean } {
	const eligible = pending.filter((r) => kinds.includes(r.kind));
	const trimmed = args.trim();
	const sp = trimmed.search(/\s/);
	const head = sp === -1 ? trimmed : trimmed.slice(0, sp);
	const tail = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
	const id = resolveRequestId(eligible, head);
	if (id) return { id, rest: tail };
	// An id-looking token that matches nothing is a mistake, not option text.
	if (/^rq-/i.test(head)) {
		const other = resolveRequestId(pending, head);
		if (other) {
			const kind = pending.find((r) => r.id === other)?.kind;
			return { rest: tail, error: `${other} is a '${kind}' request. Use /inbox to see how to answer it.` };
		}
		return { rest: tail, error: `No pending request matches "${head}".` };
	}
	if (eligible.length === 1) return { id: eligible[0].id, rest: trimmed, implicit: true };
	if (eligible.length === 0) return { rest: trimmed, error: `No pending ${kinds.map((k) => `'${k}'`).join(" or ")} request.` };
	return { rest: trimmed };
}

export type Completion = { value: string; label: string };

/**
 * Argument completions for a request command. pi replaces the ENTIRE argument text
 * with the picked `value`, so every value is a full argument line, and nothing is
 * offered unless it extends what the user typed. Returns null (no popup) otherwise.
 */
export function requestCompletions(
	pending: readonly UserRequest[],
	kinds: readonly UserRequest["kind"][],
	argText: string,
): Completion[] | null {
	const eligible = pending.filter((r) => kinds.includes(r.kind));
	const sp = argText.search(/\s/);
	if (sp === -1) {
		const head = argText;
		const ids = eligible
			.filter((r) => r.id.startsWith(head) || (head.length > 0 && r.id.endsWith(head)))
			.map((r) => ({ value: r.id, label: `${r.id} — ${r.kind}: ${r.title}` }));
		return ids.length > 0 ? ids : null;
	}
	const id = resolveRequestId(eligible, argText.slice(0, sp));
	const req = eligible.find((r) => r.id === id);
	if (!req || req.kind !== "choose" || !req.options?.length) return null;
	const typed = argText.slice(sp + 1).trimStart().toLowerCase();
	const items = req.options
		.map((o, i) => ({ value: `${req.id} ${i + 1}`, label: `${i + 1}. ${o}`, text: o.toLowerCase(), n: String(i + 1) }))
		.filter((o) => !typed || o.n.startsWith(typed) || o.text.includes(typed))
		.map(({ value, label }) => ({ value, label }));
	return items.length > 0 ? items : null;
}
