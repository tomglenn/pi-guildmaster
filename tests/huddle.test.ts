/**
 * Stage 2 — the huddle foreground handshake.
 *
 * A party raises a `huddle` request and parks; the foreground Guildmaster picks it
 * up (findHuddle), edits the artifact WITH the user, and resumes the party by
 * answering the request. These tests pin the selection logic and the resolve
 * contract, plus the plan-implement recipe that drives the flow.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ApprovalManager } from "../src/orchestration/approvals.ts";
import { findHuddle } from "../src/huddle-tool.ts";
import { executionShape, resolveRecipe } from "../src/orchestration/recipes.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gm-huddle-"));
}

test("findHuddle returns the sole pending huddle when no id is given", () => {
	const m = new ApprovalManager(tmpDir());
	m.ask({ kind: "huddle", title: "Agree the plan", questId: "q1", artifactPath: "/tmp/plan.md" });
	const { request, ambiguous } = findHuddle(m);
	assert.equal(ambiguous, undefined);
	assert.equal(request?.questId, "q1");
	assert.equal(request?.kind, "huddle");
});

test("findHuddle ignores non-huddle requests", () => {
	const m = new ApprovalManager(tmpDir());
	m.ask({ kind: "approve", title: "post?" });
	m.ask({ kind: "review-artifact", title: "sense-check", artifactPath: "/tmp/r.md" });
	assert.equal(findHuddle(m).request, undefined);
});

test("findHuddle reports ambiguity when several huddles are pending and no id is given", () => {
	const m = new ApprovalManager(tmpDir());
	m.ask({ kind: "huddle", title: "plan A", questId: "qa" });
	m.ask({ kind: "huddle", title: "plan B", questId: "qb" });
	const { request, ambiguous } = findHuddle(m);
	assert.equal(request, undefined);
	assert.equal(ambiguous?.length, 2);
});

test("findHuddle selects by questId", () => {
	const m = new ApprovalManager(tmpDir());
	m.ask({ kind: "huddle", title: "plan A", questId: "qa" });
	m.ask({ kind: "huddle", title: "plan B", questId: "qb" });
	assert.equal(findHuddle(m, "qb").request?.title, "plan B");
});

test("resuming a huddle unparks the party with proceed=true and the user's notes", async () => {
	const m = new ApprovalManager(tmpDir());
	const parked = m.ask({ kind: "huddle", title: "Agree the plan", questId: "q1" });
	const { request } = findHuddle(m, "q1");
	// The Guildmaster settles the huddle (as quest_resume does).
	m.answer(request!.id, { action: "approve", approved: true, text: "go with option B" });
	const ans = await parked;
	assert.equal(ans.approved, true);
	assert.equal(ans.text, "go with option B");
	assert.equal(m.list().length, 0);
});

test("ending a huddle with proceed=false tells the party to stop", async () => {
	const m = new ApprovalManager(tmpDir());
	const parked = m.ask({ kind: "huddle", title: "Agree the plan", questId: "q1" });
	m.answer(findHuddle(m, "q1").request!.id, { action: "send-back", approved: false, text: "abandon" });
	const ans = await parked;
	assert.equal(ans.approved, false);
	assert.equal(ans.text, "abandon");
});

test("plan-implement recipe is a collaborative write recipe with huddle guidance", () => {
	const r = resolveRecipe({ recipe: "plan-implement" });
	assert.equal(r.id, "plan-implement");
	assert.equal(r.write, true);
	assert.equal(r.isolation, "worktree");
	assert.equal(r.delivery, "draft-pr");
	assert.equal(executionShape(r), "write");
	assert.match(r.guidance ?? "", /huddle/i);
	assert.match(r.guidance ?? "", /review-artifact/i);
});
