/**
 * Tests for the typed request inbox (ApprovalManager) — the primitive that lets a
 * running party PAUSE and ask the user (approve / choose / answer / review-artifact),
 * and the desktop-notification helper. Pins the parked-promise contract: a request
 * resolves only when answered, siblings are never blocked, and the boolean
 * `request()` wrapper still behaves for existing callers.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ApprovalManager } from "../src/orchestration/approvals.ts";
import { desktopNotify } from "../src/execution/notify-desktop.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gm-requests-"));
}

test("boolean request() still resolves true on approve (back-compat)", async () => {
	const m = new ApprovalManager(tmpDir());
	const p = m.request({ title: "Post review?", description: "d", operation: "gh pr review" });
	const [pending] = m.list();
	assert.equal(pending.kind, "approve");
	assert.ok(m.resolve(pending.id, true));
	assert.equal(await p, true);
	assert.equal(m.list().length, 0);
});

test("boolean request() resolves false on deny", async () => {
	const m = new ApprovalManager(tmpDir());
	const p = m.request({ title: "t", description: "d", operation: "op" });
	m.resolve(m.list()[0].id, false);
	assert.equal(await p, false);
});

test("choose request resolves with the picked option", async () => {
	const m = new ApprovalManager(tmpDir());
	const p = m.ask({ kind: "choose", title: "Which approach?", options: ["A", "B"] });
	const id = m.list()[0].id;
	assert.deepEqual(m.get(id)?.options, ["A", "B"]);
	m.answer(id, { action: "choose", approved: true, choice: "B" });
	const ans = await p;
	assert.equal(ans.choice, "B");
	assert.equal(ans.approved, true);
});

test("answer request carries free text", async () => {
	const m = new ApprovalManager(tmpDir());
	const p = m.ask({ kind: "answer", title: "Which env?" });
	m.answer(m.list()[0].id, { action: "answer", approved: true, text: "staging" });
	assert.equal((await p).text, "staging");
});

test("review-artifact persists the artifact path and can be sent back with notes", async () => {
	const m = new ApprovalManager(tmpDir());
	const p = m.ask({ kind: "review-artifact", title: "Sense-check", artifactPath: "/tmp/review.md" });
	const req = m.get(m.list()[0].id);
	assert.equal(req?.kind, "review-artifact");
	assert.equal(req?.artifactPath, "/tmp/review.md");
	m.answer(req!.id, { action: "send-back", approved: false, text: "tighten the summary" });
	const ans = await p;
	assert.equal(ans.approved, false);
	assert.equal(ans.text, "tighten the summary");
});

test("a parked request never blocks a sibling", async () => {
	const m = new ApprovalManager(tmpDir());
	const slow = m.ask({ kind: "approve", title: "slow" });
	const fast = m.ask({ kind: "approve", title: "fast" });
	// Resolve the second while the first stays parked.
	m.resolve(m.list().find((r) => r.title === "fast")!.id, true);
	assert.equal((await fast).approved, true);
	assert.equal(m.list().length, 1); // slow still parked
	m.resolve(m.list()[0].id, false);
	assert.equal((await slow).approved, false);
});

test("an aborted signal auto-denies a parked request", async () => {
	const m = new ApprovalManager(tmpDir());
	const ctl = new AbortController();
	const p = m.ask({ kind: "approve", title: "cancel me", signal: ctl.signal });
	ctl.abort();
	assert.equal((await p).approved, false);
	assert.equal(m.list().length, 0);
});

test("denyAll resolves every parked request as not-approved", async () => {
	const m = new ApprovalManager(tmpDir());
	const a = m.ask({ kind: "approve", title: "a" });
	const b = m.ask({ kind: "choose", title: "b", options: ["x"] });
	m.denyAll();
	assert.equal((await a).approved, false);
	assert.equal((await b).approved, false);
	assert.equal(m.list().length, 0);
});

test("requests are persisted while pending and removed on answer", async () => {
	const dir = tmpDir();
	const m = new ApprovalManager(dir);
	m.ask({ kind: "answer", title: "persist me", questId: "q1" });
	const id = m.list()[0].id;
	const file = path.join(dir, `${id}.json`);
	assert.ok(fs.existsSync(file), "pending request should be persisted");
	const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
	assert.equal(onDisk.questId, "q1");
	assert.equal(onDisk.kind, "answer");
	m.answer(id, { action: "answer", approved: true, text: "ok" });
	assert.ok(!fs.existsSync(file), "resolved request should be unpersisted");
});

test("answering an unknown id is a no-op that returns false", () => {
	const m = new ApprovalManager(tmpDir());
	assert.equal(m.answer("nope", { action: "deny", approved: false }), false);
	assert.equal(m.resolve("nope", true), false);
});

test("desktopNotify never throws regardless of platform", () => {
	assert.doesNotThrow(() => desktopNotify("title", "a message with \"quotes\" and \\ backslash"));
});
