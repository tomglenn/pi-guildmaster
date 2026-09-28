/**
 * Dismissing a Quest must PRESERVE its report before deleting the record, so a
 * completed Quest's artifact is never lost by default. The report is written to
 * the Guildmaster reports store (never the user's home root).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { reportsDir } from "../src/paths.ts";
import { QuestManager } from "../src/orchestration/quest.ts";
import { QuestStore } from "../src/persistence/quest-store.ts";

function tmpStore(): QuestStore {
	return new QuestStore(fs.mkdtempSync(path.join(os.tmpdir(), "gm-dismiss-")));
}

test("reportsDir lives under the guildmaster store, not the home root", () => {
	const dir = reportsDir();
	assert.ok(dir.includes(path.join("guildmaster", "reports")), `expected guildmaster/reports, got ${dir}`);
});

test("dismiss preserves a completed Quest's report to the reports store", () => {
	const mgr = new QuestManager(tmpStore());
	const rec = mgr.create({ cwd: "/tmp", title: "My Report Quest", brief: "b", project: "proj" });
	rec.state = "completed";
	rec.report = "# Findings\n\nSomething important worth keeping.";
	mgr.store.save(rec);

	const { savedReport } = mgr.dismiss(rec.id);
	assert.ok(savedReport, "expected a savedReport path");
	assert.ok(fs.existsSync(savedReport!), "report file should exist on disk");
	const body = fs.readFileSync(savedReport!, "utf-8");
	assert.match(body, /Something important worth keeping/);
	assert.match(body, /My Report Quest/); // header carries the title
	assert.ok(savedReport!.includes(rec.id), "filename should include the quest id");

	// And the record itself is gone.
	assert.equal(mgr.store.load(rec.id), undefined);
});

test("dismiss of a Quest with no report saves nothing", () => {
	const mgr = new QuestManager(tmpStore());
	const rec = mgr.create({ cwd: "/tmp", title: "No Report", brief: "b" });
	// leave it non-terminal with no report, then dismiss
	const { savedReport } = mgr.dismiss(rec.id);
	assert.equal(savedReport, undefined);
});
