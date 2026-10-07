/**
 * Inbox answering DX: /choose, /answer, /approve argument parsing, option matching and
 * completions. Regression for the E2E failure where the user could not answer a choose
 * request: autocomplete replaced their option text with a bare id, the option list was
 * comma-joined (options contain commas), and only exact/prefix text matched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserRequest } from "../src/orchestration/approvals.ts";
import { matchOption, numberedOptions, parseRequestArgs, requestCompletions } from "../src/request-input.ts";

const OPTIONS = [
	"Implement exactly as specified (regex strip only); flag the risk in the report",
	"Implement HTML entity escaping instead and adjust the test accordingly",
	"Implement as specified AND add a code comment warning it is not a complete XSS defence",
];

const req = (id: string, kind: UserRequest["kind"], extra: Partial<UserRequest> = {}): UserRequest =>
	({ id, kind, title: `title ${id}`, description: "", createdAt: 0, status: "pending", ...extra }) as UserRequest;

const choose = req("rq-muy1kw9s-0", "choose", { options: OPTIONS });

test("options can be picked by number, exact text, unique prefix or unique substring", () => {
	assert.deepEqual(matchOption(OPTIONS, "1"), { choice: OPTIONS[0] });
	assert.deepEqual(matchOption(OPTIONS, " #3 "), { choice: OPTIONS[2] });
	assert.deepEqual(matchOption(OPTIONS, "2."), { choice: OPTIONS[1] });
	assert.deepEqual(matchOption(OPTIONS, OPTIONS[1].toUpperCase()), { choice: OPTIONS[1] });
	assert.deepEqual(matchOption(OPTIONS, "implement exactly"), { choice: OPTIONS[0] });
	assert.deepEqual(matchOption(OPTIONS, "html entity"), { choice: OPTIONS[1] });
	assert.deepEqual(matchOption(OPTIONS, "code comment"), { choice: OPTIONS[2] });
});

test("ambiguous or unknown input is reported with option numbers, never guessed", () => {
	const amb = matchOption(OPTIONS, "as specified");
	assert.ok("error" in amb && /1, 3/.test(amb.error));
	const none = matchOption(OPTIONS, "go ahead as specified");
	assert.ok("error" in none && /option number/.test(none.error));
	const range = matchOption(OPTIONS, "4");
	assert.ok("error" in range && /1–3/.test(range.error));
	assert.ok("error" in matchOption(OPTIONS, "  "));
});

test("options are listed one per line with numbers (they contain commas)", () => {
	assert.deepEqual(numberedOptions(["a, b", "c"]), ["1. a, b", "2. c"]);
});

test("the id is optional when one request of the kind is waiting", () => {
	const pending = [choose, req("rq-x-1", "approve")];
	assert.deepEqual(parseRequestArgs(pending, ["choose"], ""), { id: choose.id, rest: "", implicit: true });
	assert.deepEqual(parseRequestArgs(pending, ["choose"], "2"), { id: choose.id, rest: "2", implicit: true });
	assert.deepEqual(parseRequestArgs(pending, ["choose"], `${choose.id} go ahead`), { id: choose.id, rest: "go ahead" });
	assert.deepEqual(parseRequestArgs(pending, ["choose"], "s-0 1"), { id: choose.id, rest: "1" }, "unique id suffix");
});

test("a wrong or wrong-kind id is an error, not option text", () => {
	const pending = [choose, req("rq-x-1", "approve")];
	assert.match(parseRequestArgs(pending, ["choose"], "rq-blah 1").error ?? "", /No pending request matches "rq-blah"/);
	assert.match(parseRequestArgs(pending, ["choose"], "rq-x-1").error ?? "", /'approve' request/);
	assert.match(parseRequestArgs([], ["choose"], "1").error ?? "", /No pending 'choose' request/);
});

test("several eligible requests and no id: no guess (the command offers a picker)", () => {
	const pending = [choose, req("rq-b-2", "choose", { options: ["x"] })];
	const r = parseRequestArgs(pending, ["choose"], "1");
	assert.equal(r.id, undefined);
	assert.equal(r.error, undefined);
	assert.equal(r.rest, "1");
});

test("completions never replace typed option text with a bare id", () => {
	const pending = [choose, req("rq-x-1", "approve")];
	// While typing the id: only matching ids of the command's kinds.
	assert.deepEqual(requestCompletions(pending, ["choose"], "rq-m")?.map((c) => c.value), [choose.id]);
	assert.equal(requestCompletions(pending, ["choose"], "rq-zzz"), null, "no unrelated fallback list");
	// After the id: the request's options, each a FULL argument line (pi replaces the whole argument text).
	const all = requestCompletions(pending, ["choose"], `${choose.id} `);
	assert.deepEqual(all?.map((c) => c.value), [`${choose.id} 1`, `${choose.id} 2`, `${choose.id} 3`]);
	assert.match(all?.[1].label ?? "", /^2\. Implement HTML/);
	assert.deepEqual(requestCompletions(pending, ["choose"], `${choose.id} html`)?.map((c) => c.value), [`${choose.id} 2`]);
	// Free text that matches no option: no popup, so Enter submits what was typed.
	assert.equal(requestCompletions(pending, ["choose"], `${choose.id} go ahead please`), null);
	// Non-choose commands offer nothing after the id (free text).
	assert.equal(requestCompletions([req("rq-a-1", "answer")], ["answer"], "rq-a-1 stag"), null);
});

test("the Guild board hints the right command per request kind (not /approve for everything)", async () => {
	const { requestHint } = await import("../src/status.ts");
	assert.equal(requestHint("choose"), "/choose");
	assert.equal(requestHint("answer"), "/answer");
	assert.equal(requestHint("approve"), "/approve");
	assert.equal(requestHint("review-artifact"), "/review");
	assert.equal(requestHint("huddle"), "ask me to pick it up");
});
