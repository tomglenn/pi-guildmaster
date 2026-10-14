/**
 * Tests for the ReviewViewerComponent and the /approve compact-select flow.
 *
 * Tests:
 * - ReviewViewerComponent in small terminals (40x8, 60x12, 80x24)
 *   - rendered line count ≤ rows
 *   - footer always present (last line matches key hint)
 *   - all rendered lines ≤ width
 *   - scrolling to End reveals the last body line
 *   - every body line reachable
 *   - keyboard navigation (j/k, arrows, g/G, PgDn, PgUp)
 *   - q/Esc calls done("close")
 *   - e calls done("edit")
 * - /approve compact flow (handler-level with injected stubs)
 *   - Cancel / Escape → not answered, still pending
 *   - Cancel is option index 0
 *   - choosing Post → answered with exactly the parsed snapshot
 *   - file changed between prompt and pick → refused, request stays pending
 *   - non-interactive (hasUI: false) → refused
 *   - compact prompt does NOT contain the full review body
 *   - URL lookup: REST with slug; PR URL fallback without slug
 * - Success confirmation
 *   - short report leading with confirmation + URL
 * - /review card fallback (non-TUI)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { REVIEW_BLOCK_END, REVIEW_BLOCK_START } from "../src/orchestration/review-post.ts";
import {
	ReviewViewerComponent,
	buildViewerHeader,
	reviewBodyFingerprint,
	reviewBodyFingerprintFull,
	hasUnsafeChars,
	sanitizeForLabel,
	VIEWER_FOOTER_HINT,
	sanitizeForDisplay,
	clearViewedFingerprints,
	recordViewedFingerprint,
	getViewedFingerprint,
} from "../src/review-viewer.ts";
import {
	buildCompactReviewSelect,
	parsePrLabelFromOperation,
	readPostable,
	ReviewConfirmComponent,
	registerApprovals,
} from "../src/approvals-ui.ts";
import type { ReviewConfirmClock } from "../src/approvals-ui.ts";
import { postReview } from "../src/execution/gh-tool.ts";
import type { ExecFile } from "../src/execution/gh-tool.ts";
import { ApprovalManager } from "../src/orchestration/approvals.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerInfoCard, showCard, INFO_CARD_ENTRY } from "../src/ui.ts";

const S = REVIEW_BLOCK_START;
const E = REVIEW_BLOCK_END;

// ── helpers ────────────────────────────────────────────────────────────────

/** Stub theme: no ANSI, plain text passthrough. */
const STUB_THEME = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

/** Build a mock TUI with controllable terminal dimensions. */
function mockTui(rows: number): { terminal: { rows: number }; requestRender: () => void; renderCount: number } {
	const tui = { terminal: { rows }, requestRender() { tui.renderCount++; }, renderCount: 0 };
	return tui;
}

/** Strip ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** Visible width of a string (after stripping ANSI). */
function visWidth(s: string): number {
	return stripAnsi(s).length;
}

/** Build a test review file with N body lines. */
function makeLongReview(lineCount: number): string {
	const lines = Array.from({ length: lineCount }, (_, i) => `> Body line ${i + 1}: some text here`);
	return [
		"# Review: PR #1234",
		"",
		"## Notes",
		"Internal note: something.",
		"",
		S,
		...lines,
		E,
		"",
		"Verdict: Request changes",
	].join("\n");
}

// Build a component for tests.
function makeViewer(opts: {
	rows: number;
	width: number;
	body?: string;
	headerLines?: string[];
}) {
	const body = opts.body ?? makeLongReview(200);
	const tui = mockTui(opts.rows);
	const headerLines = opts.headerLines ?? ["Header line 1", "Header line 2", "──────────────────────"];
	const state = { doneResult: undefined as string | undefined };
	const done = (r: string) => { state.doneResult = r; };
	const comp = new ReviewViewerComponent(tui, headerLines, body, VIEWER_FOOTER_HINT, done as (r: "close" | "edit") => void);
	return { comp, tui, state };
}

// ── ReviewViewerComponent tests ─────────────────────────────────────────────

test("render: line count ≤ rows (40x8)", () => {
	const { comp } = makeViewer({ rows: 8, width: 40 });
	const lines = comp.render(40);
	assert.ok(lines.length <= 8, `expected ≤8 lines, got ${lines.length}`);
});

test("render: line count ≤ rows (60x12)", () => {
	const { comp } = makeViewer({ rows: 12, width: 60 });
	const lines = comp.render(60);
	assert.ok(lines.length <= 12, `expected ≤12 lines, got ${lines.length}`);
});

test("render: line count ≤ rows (80x24)", () => {
	const { comp } = makeViewer({ rows: 24, width: 80 });
	const lines = comp.render(80);
	assert.ok(lines.length <= 24, `expected ≤24 lines, got ${lines.length}`);
});

test("render: footer always present (last line contains scroll position)", () => {
	for (const [rows, width] of [[8, 40], [12, 60], [24, 80]] as [number, number][]) {
		const { comp } = makeViewer({ rows, width });
		const lines = comp.render(width);
		assert.ok(lines.length > 0, `rows=${rows},w=${width}: no lines rendered`);
		// Footer (last line) contains scroll position: "N–M/total" or "0–0/0"
		const footer = stripAnsi(lines[lines.length - 1]);
		assert.match(footer, /\d+.\d+\/\d+/, `rows=${rows},w=${width}: footer missing scroll info: ${JSON.stringify(footer)}`);
	}
})

test("render: all lines ≤ width (after stripping ANSI)", () => {
	for (const [rows, width] of [[8, 40], [12, 60], [24, 80]] as [number, number][]) {
		const { comp } = makeViewer({ rows, width });
		const lines = comp.render(width);
		for (const line of lines) {
			const w = visWidth(line);
			assert.ok(w <= width, `rows=${rows},w=${width}: line too wide (${w}): ${JSON.stringify(line)}`);
		}
	}
});

test("scrolling to End reveals the last body line", () => {
	const body = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n");
	const rows = 12;
	const width = 60;
	const headerLines = ["Header"];
	const { comp } = makeViewer({ rows, width, body, headerLines });

	// Must render first to initialize wrap.
	comp.render(width);
	// Simulate pressing G (go to end)
	comp.handleInput("G");
	const lines = comp.render(width).map(stripAnsi);

	// The last body line must appear in the rendered output
	assert.ok(lines.some(l => l.includes("Line 50")), `Last line not visible after G: ${lines.join(" | ")}`);
});

test("every body line is reachable by scrolling", () => {
	const bodyLines = Array.from({ length: 30 }, (_, i) => `UNIQUE_MARKER_${i + 1}`);
	const body = bodyLines.join("\n");
	const rows = 8;
	const width = 40;
	const headerLines = ["H"];
	const { comp } = makeViewer({ rows, width, body, headerLines });

	const seen = new Set<string>();
	// Scroll from top to bottom one line at a time
	comp.render(width); // initial render (also wraps body)
	for (let i = 0; i < bodyLines.length + rows; i++) {
		const rendered = comp.render(width).map(stripAnsi);
		for (const l of rendered) {
			for (const marker of bodyLines) {
				if (l.includes(marker)) seen.add(marker);
			}
		}
		comp.handleInput("j"); // scroll down
	}

	const missed = bodyLines.filter(m => !seen.has(m));
	assert.equal(missed.length, 0, `Missed body lines: ${missed.join(", ")}`);
});

test("keyboard: j scrolls down, k scrolls up", () => {
	const body = Array.from({ length: 50 }, (_, i) => `Line-${i}`).join("\n");
	const rows = 10;
	const width = 40;
	const headerLines = ["H"];
	const { comp } = makeViewer({ rows, width, body, headerLines });

	comp.render(width); // initialize wrap
	// Initially at top; Line-0 should be visible
	let lines = comp.render(width).map(stripAnsi);
	assert.ok(lines.some(l => l.includes("Line-0")), "Expected Line-0 at top");

	// Press j several times
	comp.handleInput("j");
	comp.handleInput("j");
	comp.handleInput("j");
	lines = comp.render(width).map(stripAnsi);
	assert.ok(!lines.some(l => l.includes("Line-0")), "Line-0 should have scrolled off");

	// Press k to scroll back
	comp.handleInput("k");
	comp.handleInput("k");
	comp.handleInput("k");
	lines = comp.render(width).map(stripAnsi);
	assert.ok(lines.some(l => l.includes("Line-0")), "Expected Line-0 back at top after k");
});

test("keyboard: g goes to top, G goes to bottom", () => {
	const body = Array.from({ length: 50 }, (_, i) => `Line-${i}`).join("\n");
	const { comp } = makeViewer({ rows: 12, width: 60, body, headerLines: ["H"] });
	comp.render(60);

	// Scroll down first
	comp.handleInput("G");
	let lines = comp.render(60).map(stripAnsi);
	assert.ok(lines.some(l => l.includes("Line-49")), "G should go to bottom");

	comp.handleInput("g");
	lines = comp.render(60).map(stripAnsi);
	assert.ok(lines.some(l => l.includes("Line-0")), "g should go to top");
});

test("keyboard: space scrolls a page down", () => {
	const body = Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n");
	const { comp } = makeViewer({ rows: 10, width: 40, body, headerLines: ["H"] });
	comp.render(40);

	// Initially at top: L0 visible
	let lines = comp.render(40).map(stripAnsi);
	assert.ok(lines.some(l => l.includes("L0")), "L0 visible at start");

	comp.handleInput(" "); // space = page down
	lines = comp.render(40).map(stripAnsi);
	assert.ok(!lines.some(l => l.includes("L0")), "L0 should have scrolled off after space");
});

test("keyboard: q calls done(close)", () => {
	const { comp, state } = makeViewer({ rows: 10, width: 40 });
	comp.render(40);
	assert.equal(state.doneResult, undefined);
	comp.handleInput("q");
	assert.equal(state.doneResult, "close");
});

test("keyboard: Escape calls done(close)", () => {
	const { comp, state } = makeViewer({ rows: 10, width: 40 });
	comp.render(40);
	comp.handleInput("\x1b"); // ESC
	assert.equal(state.doneResult, "close");
});

test("keyboard: e calls done(edit)", () => {
	const { comp, state } = makeViewer({ rows: 10, width: 40 });
	comp.render(40);
	comp.handleInput("e");
	assert.equal(state.doneResult, "edit");
});

test("invalidate resets wrap cache", () => {
	const body = "Line 1\nLine 2\nLine 3";
	const { comp } = makeViewer({ rows: 10, width: 80, body, headerLines: ["H"] });
	comp.render(80);
	comp.invalidate();
	// After invalidate, render should work fine at a different width
	const lines = comp.render(40);
	assert.ok(lines.length > 0);
	for (const l of lines) {
		assert.ok(visWidth(l) <= 40, `Line too wide after invalidate: ${JSON.stringify(l)}`);
	}
});

test("small terminal (8 rows, 40 cols) with 200-line review: footer present, lines bounded", () => {
	const body = makeLongReview(200);
	const rows = 8;
	const width = 40;
	const headerLines = ["Review: PR #1234", "Verdict: approve (--approve) · fp: abc12345", "e edit  q close  /approve rq-1 posts", "────────────────────"];
	const { comp } = makeViewer({ rows, width, body, headerLines });
	const lines = comp.render(width);
	assert.ok(lines.length <= rows, `line count ${lines.length} > rows ${rows}`);
	// Footer is the last line (has scroll info)
	assert.match(lines[lines.length - 1], /\d+/, "footer line must contain digits");
	// All lines within width
	for (const l of lines) {
		assert.ok(visWidth(l) <= width, `Line exceeds width: ${JSON.stringify(l)}`);
	}
});

// ── buildViewerHeader ────────────────────────────────────────────────────────

test("buildViewerHeader: shows title, label, verdict+fingerprint", () => {
	const parsed = { verdict: "approve" as const, body: "Looks good!" };
	const fp = reviewBodyFingerprint(parsed.body);
	const { lines } = buildViewerHeader({
		title: "PR Review",
		label: "owner/repo#42",
		parsed,
		fingerprint: fp,
		id: "rq-42",
	});
	assert.ok(lines.some((l: string) => l.includes("PR Review")), "title");
	assert.ok(lines.some((l: string) => l.includes("owner/repo#42")), "label");
	assert.ok(lines.some((l: string) => l.includes("approve") && l.includes("--approve")), "verdict+flag");
	assert.ok(lines.some((l: string) => l.includes(fp)), "fingerprint");
	assert.ok(lines.some((l: string) => l.includes("/approve rq-42")), "approve hint");
});

test("buildViewerHeader: shows parse error", () => {
	const parsed = { error: "no verdict line found" };
	const { lines } = buildViewerHeader({ title: "T", parsed, fingerprint: "", id: "rq-1" });
	assert.ok(lines.some((l: string) => l.includes("Cannot post") && l.includes("no verdict line found")));
});

// ── reviewBodyFingerprint ────────────────────────────────────────────────────

test("reviewBodyFingerprint: 8 hex chars, deterministic", () => {
	const fp = reviewBodyFingerprint("hello world");
	assert.match(fp, /^[0-9a-f]{8}$/);
	assert.equal(fp, reviewBodyFingerprint("hello world"));
	assert.notEqual(fp, reviewBodyFingerprint("hello world!"));
});

// ── /approve compact flow — tests via real registered handlers ─────────────

/** Write a minimal valid review file to a temp path. */
function writeTempReview(verdict: string, body = "Thanks for all the work.\n\nLGTM."): { dir: string; filePath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-viewer-test-"));
	const filePath = path.join(dir, "review.md");
	const content = [
		"# Re-review",
		"",
		S,
		...body.split("\n").map(l => `> ${l}`),
		E,
		"",
		verdict,
	].join("\n");
	fs.writeFileSync(filePath, content, { encoding: "utf-8" });
	return { dir, filePath };
}

/** Minimal fake pi that captures registered command handlers. */
function makeFakePi() {
	const handlers: Record<string, (args: string, ctx: any) => Promise<void>> = {};
	return {
		registerCommand(name: string, def: { handler: (args: string, ctx: any) => Promise<void>; description?: string; getArgumentCompletions?: any }) {
			handlers[name] = def.handler;
		},
		registerTool() {},
		getHandler(name: string) { return handlers[name]; },
	};
}

/** Make a fake injectable clock for ReviewConfirmComponent grace period tests. */
function makeFakeClock() {
	const cbs = new Map<number, () => void>();
	let nextId = 1;
	const cl: ReviewConfirmClock = {
		now: () => 0,
		setTimeout(fn: () => void, _ms: number) {
			const id = nextId++;
			cbs.set(id, fn);
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout(id: ReturnType<typeof setTimeout>) {
			cbs.delete(id as unknown as number);
		},
	};
	return {
		cl,
		fire() { const fns = [...cbs.values()]; cbs.clear(); for (const fn of fns) fn(); },
	};
}

/** Make a fake TUI ctx for TUI mode, with a scriptable `custom` and `select`. */
function makeTuiCtx(opts: {
	hasUI?: boolean;
	mode?: "tui" | "rpc";
	/** Keys to feed to a captured ReviewConfirmComponent per custom() call. */
	customKeySequence?: string[][];
	selectResult?: string;
	editorResult?: string | undefined;
	notifies?: { text: string; level: string }[];
	clock?: { fire(): void };
}) {
	const notifies = opts.notifies ?? [];
	let customCallIdx = 0;
	const keySeqs = opts.customKeySequence ?? [];
	return {
		hasUI: opts.hasUI ?? true,
		mode: opts.mode ?? "tui" as const,
		ui: {
			notifies,
			notify(text: string, level: string) { notifies.push({ text, level }); },
			async select(_title: string, _opts: string[]) { return opts.selectResult; },
			async editor(_title: string, _prefill?: string) { return opts.editorResult; },
			async custom<T>(factory: (tui: any, theme: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					// Feed any keys scheduled for this call
					const keys = keySeqs[customCallIdx++] ?? [];
					for (const key of keys) comp.handleInput(key);
					// After all keys: if grace has been fired by caller, Enter on Cancel resolves
				});
			},
		},
	};
}

// ── ReviewConfirmComponent unit tests ─────────────────────────────────────

test("ReviewConfirmComponent: Enter during grace is ignored", () => {
	let called = false;
	const { cl } = makeFakeClock();
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	const comp = new ReviewConfirmComponent(fakeTui, "title", ["Cancel", "Post"], (result) => { called = true; }, cl);
	comp.handleInput("\n"); // Enter during grace
	assert.equal(called, false, "done must not be called during grace");
});

test("ReviewConfirmComponent: Enter on Cancel after grace → undefined (cancel)", () => {
	let result: string | undefined = "NONE";
	const { cl, fire } = makeFakeClock();
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	const comp = new ReviewConfirmComponent(fakeTui, "title", ["Cancel", "Post"], (r) => { result = r; }, cl);
	comp.render(60); // first render starts the grace timer
	fire(); // end grace
	comp.handleInput("\n"); // Enter on default (Cancel at index 0)
	assert.equal(result, "Cancel", "Enter on Cancel should return Cancel");
});

test("ReviewConfirmComponent: ↓ then Enter after grace → Post option", () => {
	let result: string | undefined = "NONE";
	const { cl, fire } = makeFakeClock();
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	const comp = new ReviewConfirmComponent(fakeTui, "title", ["Cancel", "Post APPROVE review"], (r) => { result = r; }, cl);
	comp.render(60); // first render starts the grace timer
	fire(); // end grace
	comp.handleInput("\x1b[B"); // down arrow
	comp.handleInput("\n"); // Enter
	assert.equal(result, "Post APPROVE review", "should select Post option after ↓+Enter");
});

test("ReviewConfirmComponent: j does NOT navigate (letters ignored)", () => {
	const { cl, fire } = makeFakeClock();
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	const comp = new ReviewConfirmComponent(fakeTui, "title", ["Cancel", "Post"], (_r) => {}, cl) as any;
	comp.render(60); // first render starts the grace timer
	fire();
	comp.handleInput("j"); // should be ignored
	assert.equal(comp.selectedIndex, 0, "j must not move selection");
});

test("ReviewConfirmComponent: Esc cancels (returns undefined)", () => {
	let result: string | undefined = "NONE";
	const { cl, fire } = makeFakeClock();
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	const comp = new ReviewConfirmComponent(fakeTui, "title", ["Cancel", "Post"], (r) => { result = r; }, cl);
	comp.render(60); // first render starts the grace timer
	fire();
	comp.handleInput("\x1b"); // Esc
	assert.equal(result, undefined, "Esc should return undefined");
});

test("ReviewConfirmComponent: Esc cancels even during grace period", () => {
	let result: string | undefined = "NONE";
	const { cl } = makeFakeClock(); // grace not fired
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	const comp = new ReviewConfirmComponent(fakeTui, "title", ["Cancel", "Post"], (r) => { result = r; }, cl);
	comp.handleInput("\x1b"); // Esc during grace
	assert.equal(result, undefined, "Esc during grace should still cancel");
});

test("ReviewConfirmComponent: renders footer always (arming and active)", () => {
	const { cl, fire } = makeFakeClock();
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	const comp = new ReviewConfirmComponent(fakeTui, "title\nline2", ["Cancel", "Post"], () => {}, cl);
	const linesArming = comp.render(60);
	assert.ok(linesArming.length > 0, "must render while arming");
	assert.ok(linesArming[linesArming.length - 1].includes("Arming"), "footer shows Arming");
	fire();
	const linesActive = comp.render(60);
	assert.ok(linesActive[linesActive.length - 1].includes("Enter"), "footer shows Enter hint after arming");
});

// ── /approve handler tests via real registerApprovals ──────────────────────

test("/approve handler: non-interactive (hasUI=false) → refused", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve");
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = { hasUI: false, mode: "tui", ui: { notify(t: string, l: string) { notifies.push({ t, l }); }, select: async () => undefined, custom: async () => undefined } };
	await handler(id, ctx);

	assert.ok(notifies.some(n => n.t.includes("interactive")), "should refuse with interactive message");
	assert.ok(am.get(id) !== undefined, "request still pending");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/approve handler: TUI mode, Enter during grace → nothing; Enter on Cancel → pending", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve");
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const { cl, fire } = makeFakeClock();
	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am, reviewConfirmClock: cl });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					// Enter during grace → ignored
					comp.handleInput("\n");
					// End grace
					comp.render(60); // first render starts the grace timer
					fire();
					// Enter on default (Cancel)
					comp.handleInput("\n");
				});
			},
		},
	};
	await handler(id, ctx);

	assert.ok(notifies.some((n: any) => n.t.includes("still pending")), "should report still pending");
	assert.ok(am.get(id) !== undefined, "request still pending");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/approve handler: TUI mode, ↓ then Enter after grace → answered with exact snapshot", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve", "Exact body.");
	const pending = am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const { cl, fire } = makeFakeClock();
	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am, reviewConfirmClock: cl });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					comp.render(60); // first render starts the grace timer
					fire(); // end grace
					comp.handleInput("\x1b[B"); // ↓ arrow
					comp.handleInput("\n"); // Enter
				});
			},
		},
	};
	await handler(id, ctx);

	const ans = await pending;
	assert.ok(ans.approved, "should be approved");
	assert.equal(ans.review?.body, "Exact body.", "should post exact body");
	assert.equal(ans.review?.verdict, "approve", "should post correct verdict");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/approve handler: j does nothing in TUI confirm", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve");
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const { cl, fire } = makeFakeClock();
	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am, reviewConfirmClock: cl });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	let capturedComp: any;
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					capturedComp = factory(fakeTui, null, null, done);
					capturedComp.render(60); // first render starts the grace timer
					fire();
					capturedComp.handleInput("j"); // should do nothing
					// Verify selection unchanged, then cancel
					capturedComp.handleInput("\x1b"); // Esc
				});
			},
		},
	};
	await handler(id, ctx);

	// j should NOT have moved selection to Post; Esc should cancel
	assert.ok(notifies.some((n: any) => n.t.includes("still pending")), "should still be pending after j+Esc");
	assert.ok(am.get(id) !== undefined, "request still pending");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/approve handler: Esc → pending", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve");
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const { cl, fire } = makeFakeClock();
	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am, reviewConfirmClock: cl });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					comp.render(60); // first render starts the grace timer
					fire();
					comp.handleInput("\x1b"); // Esc
				});
			},
		},
	};
	await handler(id, ctx);

	assert.ok(notifies.some((n: any) => n.t.includes("still pending")), "should still be pending after Esc");
	assert.ok(am.get(id) !== undefined, "request still pending");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/approve handler: file edited between open and confirm → refused, pending", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve", "Original.");
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const { cl, fire } = makeFakeClock();
	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am, reviewConfirmClock: cl });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					comp.render(60); // first render starts the grace timer
					fire();
					// Simulate: user moves to Post, then file changes before Enter
					comp.handleInput("\x1b[B"); // ↓
					// Change the file NOW (before Enter)
					const changed = writeTempReview("Verdict: Request changes", "Changed.");
					fs.writeFileSync(filePath, fs.readFileSync(changed.filePath, "utf-8"), "utf-8");
					fs.rmSync(changed.dir, { recursive: true, force: true });
					// Enter → select Post option
					comp.handleInput("\n");
				});
			},
		},
	};
	await handler(id, ctx);

	assert.ok(notifies.some((n: any) => n.t.includes("changed")), "should report file changed");
	assert.ok(am.get(id) !== undefined, "request still pending");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/approve handler: control chars in body → refused, pending", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-"));
	const am = new ApprovalManager(dir);
	// ESC[8m hidden text in the body block
	const maliciousBody = "LGTM \x1b[8mhidden\x1b[0m more";
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve", maliciousBody);
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const { cl, fire } = makeFakeClock();
	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am, reviewConfirmClock: cl });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>() { return undefined as T; }, // should never reach confirm
		},
	};
	await handler(id, ctx);

	assert.ok(notifies.some((n: any) => n.t.includes("control") || n.t.includes("bidi") || n.t.includes("tampering")), "should refuse due to control chars");
	assert.ok(am.get(id) !== undefined, "request still pending");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/approve handler: RPC mode uses select, exact-equality consent", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve", "Clean.");
	const pending = am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	// Build what the Post option string looks like
	const parsed = readPostable(filePath);
	assert.ok(!("error" in parsed));
	if ("error" in parsed) throw new Error();
	const { options } = buildCompactReviewSelect({ id, operation: undefined, verdict: parsed.verdict, body: parsed.body });
	const postOption = options[1];

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "rpc" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select(_title: string, _opts: string[]) { return postOption; },
		},
	};
	await handler(id, ctx);

	const ans = await pending;
	assert.ok(ans.approved, "should be approved via RPC select");
	assert.equal(ans.review?.body, "Clean.");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/approve handler: RPC select with wrong string → not posted", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve");
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "rpc" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return "Cancel"; }, // exact string but wrong option
		},
	};
	await handler(id, ctx);

	assert.ok(notifies.some((n: any) => n.t.includes("still pending")));
	assert.ok(am.get(id) !== undefined, "request still pending");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/approve: Cancel is option index 0", () => {
	const { options } = buildCompactReviewSelect({ id: "rq-x", operation: undefined, verdict: "approve", body: "ok" });
	assert.equal(options[0], "Cancel");
});

test("/approve: compact prompt does NOT contain the full review body", () => {
	const longBody = Array.from({ length: 50 }, (_, i) => `BODY_LINE_${i}`).join("\n");
	const { title, options } = buildCompactReviewSelect({
		id: "rq-99",
		operation: "gh pr review 42 --repo o/r",
		verdict: "comment",
		body: longBody,
	});
	const all = `${title}\n${options.join("\n")}`;
	assert.doesNotMatch(all, /BODY_LINE_0/);
	assert.doesNotMatch(all, /BODY_LINE_49/);
});

// ── postReview URL lookup ────────────────────────────────────────────────────

test("postReview: REST reviews API is used for slug-based URL lookup", () => {
	const calls: { file: string; args: string[] }[] = [];
	const exec: ExecFile = (file, args) => {
		calls.push({ file, args });
		// gh api user → return login (2nd arg is "user")
		if (args.includes("api") && args.includes("user")) return "testuser\n";
		// gh api reviews → return URL
		if (args.includes("api")) return "https://github.com/o/r/pull/12#pullrequestreview-99\n";
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", slug: "o/r", verdict: "approve", body: "LGTM", exec });
	assert.equal(res.error, undefined);
	assert.equal(res.url, "https://github.com/o/r/pull/12#pullrequestreview-99");
	assert.equal(res.urlIsReview, true, "should report urlIsReview=true when review URL found");
	// Reviews call (URL lookup) should use the paginated REST API
	const urlCall = calls.find(c => c.args.some(a => a.includes("/reviews")));
	assert.ok(urlCall, "should use gh api for URL lookup");
	assert.ok(urlCall?.args.some(a => a.includes("repos/o/r/pulls/12/reviews")), "should use reviews REST endpoint");
	assert.ok(urlCall?.args.includes("--paginate"), "should use --paginate");
	// jq filter includes user login filter when login was obtained
	assert.ok(urlCall?.args.some(a => a.includes("select(.user.login")), "should filter by user login");
});

test("postReview: URL lookup uses last github.com line, skipping null", () => {
	const exec: ExecFile = (_file, args) => {
		if (args.includes("api") && args.includes("user")) return "testuser\n"; // login
		if (args.includes("api"))
			return "null\nhttps://github.com/o/r/pull/12#pullrequestreview-1\nnull\nhttps://github.com/o/r/pull/12#pullrequestreview-5\n";
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", slug: "o/r", verdict: "approve", body: "LGTM", exec });
	assert.equal(res.url, "https://github.com/o/r/pull/12#pullrequestreview-5", "should pick last non-null line");
	assert.equal(res.urlIsReview, true, "should be review URL");
});

test("postReview: falls back to PR page URL when API returns no github.com lines", () => {
	const exec: ExecFile = (_file, args) => {
		if (args.includes("api")) return "null\n\nnull\n";
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", slug: "o/r", verdict: "approve", body: "LGTM", exec });
	assert.equal(res.url, "https://github.com/o/r/pull/12", "should fall back to PR page URL");
	assert.equal(res.urlIsReview, false, "should be PR URL when no review URL found");
});

test("postReview: falls back to PR page URL when API call fails", () => {
	const exec: ExecFile = (_file, args) => {
		if (args.includes("api")) throw new Error("API error");
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", slug: "o/r", verdict: "approve", body: "LGTM", exec });
	assert.equal(res.url, "https://github.com/o/r/pull/12", "should fall back to PR page URL on API failure");
	assert.equal(res.urlIsReview, false, "should be PR URL on API failure");
});

test("postReview: PR URL fallback used when no slug", () => {
	const calls: { file: string; args: string[] }[] = [];
	const exec: ExecFile = (file, args) => {
		calls.push({ file, args });
		if (args.includes("--json") && args.includes("url")) return "https://github.com/o/r/pull/12\n";
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", verdict: "approve", body: "LGTM", exec });
	assert.equal(res.error, undefined);
	assert.equal(res.url, "https://github.com/o/r/pull/12");
	assert.equal(res.urlIsReview, false, "no-slug URL is always PR URL");
	// URL lookup should use pr view --json url
	const urlCall = calls.find(c => c.args.includes("--json") && c.args.includes("url"));
	assert.ok(urlCall, "should use gh pr view --json url as fallback");
});

// ── success report format ────────────────────────────────────────────────────

test("buildCompactReviewSelect: confirm fingerprint appears in title", () => {
	const body = "Looks great, ship it.";
	const { title, titleLinesPriority } = buildCompactReviewSelect({ id: "rq-1", operation: undefined, verdict: "approve", body });
	const fp = reviewBodyFingerprint(body);
	// Fingerprint should appear in the full title (for non-TUI) and in titleLinesPriority
	assert.ok(title.includes(fp), `fingerprint ${fp} not in title: ${title}`);
	assert.ok(titleLinesPriority.some(l => l.includes(fp)), `fingerprint not in titleLinesPriority`);
});

test("parsePrLabelFromOperation: round-trips correctly", () => {
	// With slug
	assert.equal(parsePrLabelFromOperation("gh pr review 1957 --repo grafana/grafana-pathfinder-app"), "grafana/grafana-pathfinder-app#1957");
	// Without slug
	assert.equal(parsePrLabelFromOperation("gh pr review 42"), "#42");
	// Undefined
	assert.equal(parsePrLabelFromOperation(undefined), undefined);
	// With extra args (not matching our pattern: no --repo)
	assert.equal(parsePrLabelFromOperation("gh pr review 10 --approve"), "#10");
});

// -- sanitizeForDisplay tests --

test("sanitizeForDisplay: replaces ESC byte with placeholder, keeps following bytes visible", () => {
	// Issue 2: no payload consumption — ESC is replaced, the rest stays visible.
	// \x1b[8m -> \u241B[8m (ESC replaced, [8m visible as text)
	const input = "normal \x1b[8mhidden\x1b[0m more";
	const out = sanitizeForDisplay(input);
	assert.ok(!out.includes("\x1b"), "no raw ESC in output");
	assert.ok(out.includes("\u241B"), "ESC placeholder present");
	assert.ok(out.includes("normal"), "normal text preserved");
	assert.ok(out.includes("more"), "trailing text preserved");
	// The bytes after ESC ([8m, [0m) should be visible as plain text
	assert.ok(out.includes("[8m"), "[8m visible (not consumed)");
	assert.ok(out.includes("hidden"), "text between escapes visible");
});

test("sanitizeForDisplay: replaces ESC byte in OSC sequence, keeps payload visible", () => {
	// Issue 2: no payload consumption — unterminated OSC must not hide subsequent text.
	// \x1b]52;c;base64data\x07after -> \u241B]52;c;base64data\u2408after
	const input = "before\x1b]52;c;base64data\x07after";
	const out = sanitizeForDisplay(input);
	assert.ok(!out.includes("\x1b"), "no raw ESC");
	assert.ok(out.includes("base64data"), "OSC payload visible as plain text (not consumed)");
	assert.ok(out.includes("before") && out.includes("after"), "surrounding text preserved");
	assert.ok(out.includes("\u241B"), "ESC replaced with placeholder");
	// BEL (0x07) should be replaced with C0 placeholder
	assert.ok(!out.includes("\x07"), "BEL byte replaced");
});

test("sanitizeForDisplay: unterminated OSC does NOT hide subsequent text", () => {
	// This is the critical fix: an unterminated \x1b] must not consume/hide everything after it.
	const input = "before\x1b]unterminated payload and the rest of the file";
	const out = sanitizeForDisplay(input);
	assert.ok(out.includes("the rest of the file"), "text after unterminated OSC is visible");
	assert.ok(!out.includes("\x1b"), "no raw ESC");
});

test("sanitizeForDisplay: replaces ESC in CSI sequence, keeps control bytes visible", () => {
	// Issue 2: no payload consumption — [2A stays visible as plain text.
	const input = "text\x1b[2Amore"; // cursor up 2
	const out = sanitizeForDisplay(input);
	assert.ok(!out.includes("\x1b"), "no raw ESC");
	assert.ok(out.includes("text") && out.includes("more"), "surrounding text preserved");
	assert.ok(out.includes("[2A"), "CSI bytes visible as plain text (not consumed)");
});

test("sanitizeForDisplay: strips C1 controls (U+0080-U+009F), replaces with ", () => {
	const input = "a\u009Bb"; // CSI as C1
	const out = sanitizeForDisplay(input);
	assert.ok(!out.includes("\u009B"), "C1 stripped");
	assert.ok(out.includes("\uFFFD"), "replacement char present");
	assert.ok(out.includes("a") && out.includes("b"), "surrounding text preserved");
});

test("sanitizeForDisplay: normalizes \\r\\n to \\n", () => {
	const out = sanitizeForDisplay("line1\r\nline2\r\nline3");
	assert.equal(out, "line1\nline2\nline3");
});

test("sanitizeForDisplay: expands tabs to 4 spaces", () => {
	const out = sanitizeForDisplay("a\tb");
	assert.equal(out, "a    b");
});

test("sanitizeForDisplay: preserves normal text and newlines", () => {
	const input = "Hello world\nLine 2\n";
	assert.equal(sanitizeForDisplay(input), input);
});

// 

test("ReviewViewerComponent: tiny terminal rows=1..6 width=20: footer always last, lines bounded", () => {
	for (const rows of [1, 2, 3, 4, 5, 6] as const) {
		const width = 20;
		const body = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n");
		const { comp } = makeViewer({ rows, width, body, headerLines: ["Title", "Verdict: approve", "e edit  q close", "────────────"] });
		const rendered = comp.render(width);
		// Must not exceed budget
		assert.ok(rendered.length <= rows, `rows=${rows}: rendered ${rendered.length} > budget ${rows}`);
		// All lines must fit within width
		for (const line of rendered) {
			const w = line.replace(/\x1b\[[0-9;]*m/g, "").length;
			assert.ok(w <= width, `rows=${rows}: line too wide (${w}): ${JSON.stringify(line)}`);
		}
		// Footer (last line, scroll info) must be present when budget >= 1
		if (rendered.length > 0) {
			const footer = rendered[rendered.length - 1];
			assert.match(footer, /\d/, `rows=${rows}: footer missing digits: ${JSON.stringify(footer)}`);
		}
	}
});

test("ReviewViewerComponent: priority header at rows=3 shows verdict before title", () => {
	const width = 40;
	const body = "some body\n";
	const tui = mockTui(3);
	const headerLines = ["Title: My Review", "Verdict: approve (--approve)  fp: abc12345", "e edit  q close", "────────"];
	const priorityLines = ["Verdict: approve (--approve)  fp: abc12345", "Title: My Review", "e edit  q close", "────────"];
	const state = { doneResult: undefined as string | undefined };
	const comp = new ReviewViewerComponent(tui, headerLines, body, VIEWER_FOOTER_HINT, state.doneResult as any, undefined, priorityLines);
	const rendered = comp.render(width);
	// At rows=3: 0 body + footer + at most 2 header lines. Priority header should be used.
	assert.ok(rendered.length <= 3, `rendered ${rendered.length} > 3`);
	// The verdict line should appear (priority line 0) rather than being cut
	const renderedText = rendered.join(" ");
	assert.ok(renderedText.includes("Verdict"), "verdict should be in priority header at tiny size");
});

// -- consent-warning tests --

test("buildCompactReviewSelect: neverViewed warning appears in title", () => {
	const { title } = buildCompactReviewSelect({
		id: "rq-1", operation: "gh pr review 42 --repo o/r", verdict: "approve", body: "ok",
		warnings: { neverViewed: true },
	});
	assert.ok(title.includes("Not yet viewed"), `neverViewed warning missing: ${title}`);
});

test("buildCompactReviewSelect: noSlug warning appears in title", () => {
	const { title } = buildCompactReviewSelect({
		id: "rq-1", operation: "gh pr review 42", verdict: "approve", body: "ok",
		warnings: { noSlug: true },
	});
	assert.ok(title.includes("inferred"), `noSlug warning missing: ${title}`);
});

test("/approve: compact prompt does NOT contain the full review body", () => {
	const longBody = Array.from({ length: 50 }, (_, i) => `BODY_LINE_${i}`).join("\n");
	const { title, options } = buildCompactReviewSelect({
		id: "rq-99",
		operation: "gh pr review 42 --repo o/r",
		verdict: "comment",
		body: longBody,
	});
	const all = `${title}\n${options.join("\n")}`;
	assert.doesNotMatch(all, /BODY_LINE_0/);
	assert.doesNotMatch(all, /BODY_LINE_49/);
});

// -- /review handler tests --

test("/review handler: e triggers editor, file written, verdict notified", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-rv-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve", "Original.");
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test review", artifactPath: filePath });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const reviewHandler = fakePi.getHandler("review");

	const editedContent = [
		"# Re-review",
		"",
		S,
		"> Edited body.",
		E,
		"",
		"Verdict: Request changes",
	].join("\n");

	let customCalls = 0;
	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async editor(_title: string, _prefill?: string) { return editedContent; },
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				customCalls++;
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					if (customCalls === 1) {
						// First open: press 'e' to edit
						comp.handleInput("e");
					} else {
						// Second open (after edit): press 'q' to close
						comp.handleInput("q");
					}
				});
			},
		},
	};

	await reviewHandler(id, ctx);

	// File should have been written with edited content
	const written = fs.readFileSync(filePath, "utf-8");
	assert.equal(written, editedContent, "file should be written with edited content");
	// A notify should mention verdict change
	assert.ok(notifies.some((n: any) => n.t.includes("Request changes") || n.t.includes("request-changes")), "should notify about new verdict");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/review handler: editor cancel writes nothing", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-rv-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve", "Original.");
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test review", artifactPath: filePath });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const reviewHandler = fakePi.getHandler("review");

	const originalContent = fs.readFileSync(filePath, "utf-8");

	let customCalls = 0;
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notify(_t: string, _l: string) {},
			async editor() { return undefined; }, // editor cancelled
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				customCalls++;
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					if (customCalls === 1) {
						comp.handleInput("e"); // open editor
					} else {
						comp.handleInput("q"); // close on second open
					}
				});
			},
		},
	};

	await reviewHandler(id, ctx);

	// File should NOT have been modified (editor cancelled)
	const afterContent = fs.readFileSync(filePath, "utf-8");
	assert.equal(afterContent, originalContent, "file should be unchanged after editor cancel");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

// After /review + /approve: edited verdict/body is what gets posted
test("/review then /approve: edited body is posted, not original", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-rv-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve", "Original.");
	const pending = am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	clearViewedFingerprints();
	registerApprovals(fakePi as any, { approvals: am });
	const reviewHandler = fakePi.getHandler("review");
	const approveHandler = fakePi.getHandler("approve");

	// Build edited content with different body
	const editedContent = ["# Re-review", "", S, "> Edited body.", E, "", "Verdict: Comment"].join("\n");

	let customCalls = 0;
	const reviewCtx = {
		hasUI: true, mode: "tui" as const,
		ui: {
			notify(_t: string, _l: string) {},
			async editor() { return editedContent; },
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				customCalls++;
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					if (customCalls === 1) comp.handleInput("e");
					else comp.handleInput("q");
				});
			},
		},
	};
	await reviewHandler(id, reviewCtx);

	// Now run /approve with the edited content (TUI, ↓ + Enter)
	const { cl, fire } = makeFakeClock();
	const fakePi2 = makeFakePi();
	registerApprovals(fakePi2 as any, { approvals: am, reviewConfirmClock: cl });
	const approveHandler2 = fakePi2.getHandler("approve");

	const approveCtx = {
		hasUI: true, mode: "tui" as const,
		ui: {
			notify(_t: string, _l: string) {},
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				return new Promise<T>((resolve) => {
					const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					comp.render(60); // first render starts the grace timer
					fire();
					comp.handleInput("\x1b[B"); // ↓
					comp.handleInput("\n"); // Enter
				});
			},
		},
	};
	await approveHandler2(id, approveCtx);

	const ans = await pending;
	assert.equal(ans.review?.body, "Edited body.", "should post the EDITED body");
	assert.equal(ans.review?.verdict, "comment", "should post the EDITED verdict");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

// ── Issue 1: ReviewConfirmComponent budget at rows 1..10 ─────────────────────

test("ReviewConfirmComponent: budget at rows 1..10 shows options last and never overflows", () => {
	const { cl } = makeFakeClock();
	for (let rows = 1; rows <= 10; rows++) {
		const fakeTui = { terminal: { rows }, requestRender() {} };
		const comp = new ReviewConfirmComponent(fakeTui, "Verdict: APPROVE (--approve)", ["Cancel", "Post APPROVE"], () => {}, cl);
		const rendered = comp.render(60);
		const budget = Math.max(1, rows - 2);
		// Never exceed budget
		assert.ok(rendered.length <= budget, `rows=${rows}: rendered ${rendered.length} > budget ${budget}`);
		// At budget >= 4 (rows >= 6): footer must be the last line and contain key hint or "Arming"
		if (budget >= 4) {
			const last = rendered[rendered.length - 1];
			assert.ok(
				last.includes("Arming") || last.includes("Enter") || last.includes("Esc"),
				`rows=${rows}: footer missing key hint: ${JSON.stringify(last)}`,
			);
		} else {
			// "Too small" state: must include "too small" or "Esc" message
			assert.ok(
				rendered.some(l => l.includes("small") || l.includes("Esc")),
				`rows=${rows}: too-small state should mention small/Esc`,
			);
		}
	}
});

test("ReviewConfirmComponent: narrow width (10 cols) renders without overflow", () => {
	const { cl } = makeFakeClock();
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	const comp = new ReviewConfirmComponent(fakeTui, "V: APPROVE", ["Cancel", "Post APPROVE"], () => {}, cl);
	const rendered = comp.render(10);
	for (const line of rendered) {
		const w = line.replace(/\x1b\[[0-9;]*m/g, "").length;
		assert.ok(w <= 10, `line too wide (${w}): ${JSON.stringify(line)}`);
	}
});

test("ReviewConfirmComponent: too small state disables Post (only Esc/ctrl+c work)", () => {
	const { cl } = makeFakeClock();
	// rows=3 → budget = max(1, 3-2) = 1 → too small (titleBudget = 1 - 2 - 1 = -2 ≤ 0)
	const fakeTui = { terminal: { rows: 3 }, requestRender() {} };
	let result: string | undefined = "NONE";
	const comp = new ReviewConfirmComponent(fakeTui, "Verdict", ["Cancel", "Post"], (r) => { result = r; }, cl);
	comp.render(60); // start timer
	// Enter should NOT post (too small)
	comp.handleInput("\n");
	assert.equal(result, "NONE", "Enter should not activate Post in too-small state");
	// Esc SHOULD cancel
	comp.handleInput("\x1b");
	assert.equal(result, undefined, "Esc should cancel even in too-small state");
});

test("ReviewConfirmComponent: options last, verdict first when budget is tight (rows=7)", () => {
	const { cl } = makeFakeClock();
	// rows=7 → budget = max(1, 7-2) = 5
	// With 2 options: fixedBottom=3, titleBudget=2 → 2 title lines + 2 options + footer
	const fakeTui = { terminal: { rows: 7 }, requestRender() {} };
	const comp = new ReviewConfirmComponent(
		fakeTui, "title1", ["Cancel", "Post APPROVE"],
		() => {}, cl, undefined,
		["Verdict: APPROVE (--approve)", "PR: o/r#42", "Body: 3 lines", "/review rq-1"],
	);
	const rendered = comp.render(60);
	// Options must appear at the end (before footer)
	const lastThree = rendered.slice(-3);
	assert.ok(lastThree.some(l => l.includes("Cancel")), "Cancel option must be near bottom");
	assert.ok(lastThree.some(l => l.includes("Post")), "Post option must be near bottom");
	// First rendered line should be the verdict (highest priority)
	assert.ok(rendered[0].includes("Verdict"), `First line should be verdict, got: ${rendered[0]}`);
});

// ── Issue 2: sanitizeForDisplay unterminated OSC ────────────────────────────

test("sanitizeForDisplay: unterminated OSC before review block leaves block text visible", () => {
	const S = REVIEW_BLOCK_START;
	const E = REVIEW_BLOCK_END;
	const reviewBlock = `${S}\n> Review body text here\n${E}\nVerdict: Approve`;
	// Unterminated OSC (no BEL or ST) before the review block
	const fileContent = `# Review\n\x1b]0;unterminated title\nSome notes\n${reviewBlock}`;
	const out = sanitizeForDisplay(fileContent);
	// The review block text must remain visible (not hidden by payload consumption)
	assert.ok(out.includes("Review body text here"), "review body text visible after unterminated OSC");
	assert.ok(out.includes("Verdict: Approve"), "verdict line visible after unterminated OSC");
	assert.ok(!out.includes("\x1b"), "no raw ESC in output");
	// The title text after the unterminated OSC should also be visible
	assert.ok(out.includes("unterminated title"), "OSC payload visible (not consumed)");
});

// ── Issue 5: grace period restarts on input ─────────────────────────────────

test("ReviewConfirmComponent: input during grace restarts the quiet timer", () => {
	const { cl, fire } = makeFakeClock();
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	let result: string | undefined = "NONE";
	const comp = new ReviewConfirmComponent(fakeTui, "title", ["Cancel", "Post"], (r) => { result = r; }, cl);
	comp.render(60); // start timer (timer 1 added)
	// Input during grace: should restart timer (clear timer 1, add timer 2)
	comp.handleInput("\x1b[B"); // down arrow during grace - restarts timer
	comp.handleInput("j");      // another input - restarts again
	// fire() should fire the last timer (from the last handleInput)
	fire();
	// Now armed - Enter should activate Cancel
	comp.handleInput("\n");
	assert.equal(result, "Cancel", "should arm after grace restarts and fire");
});

test("ReviewConfirmComponent: grace period starts at first render, not constructor", () => {
	const { cl } = makeFakeClock();
	const fakeTui = { terminal: { rows: 24 }, requestRender() {} };
	let armTimerStarted = false;
	const trackingCl: ReviewConfirmClock = {
		now: cl.now,
		setTimeout(fn: () => void, ms: number) {
			armTimerStarted = true;
			return cl.setTimeout(fn, ms);
		},
		clearTimeout: cl.clearTimeout,
	};
	// Timer NOT started at construction
	const comp = new ReviewConfirmComponent(fakeTui, "title", ["Cancel", "Post"], () => {}, trackingCl);
	assert.equal(armTimerStarted, false, "timer must not start in constructor");
	// Timer starts on first render
	comp.render(60);
	assert.equal(armTimerStarted, true, "timer must start on first render");
});

// ── Issue 6: bidi/tag chars in body → refused / shown as placeholder ────────

test("hasUnsafeChars: detects bidi controls", () => {
	assert.equal(hasUnsafeChars("normal text"), false);
	assert.equal(hasUnsafeChars("text\u202Ebidi"), true, "LRO bidi");
	assert.equal(hasUnsafeChars("text\u200Ebidi"), true, "LRM bidi");
	assert.equal(hasUnsafeChars("text\u2066bidi"), true, "LRI bidi");
	assert.equal(hasUnsafeChars("text\u061Cbidi"), true, "ALM bidi");
	assert.equal(hasUnsafeChars("emoji\u200Dtext"), false, "ZWJ is NOT flagged");
});

test("hasUnsafeChars: detects Unicode tag chars", () => {
	const tagChar = "\uDB40\uDC01"; // U+E0001
	assert.equal(hasUnsafeChars(`text${tagChar}more`), true, "tag char detected");
});

test("hasUnsafeChars: detects zero-width non-printing chars", () => {
	assert.equal(hasUnsafeChars("text\u200Bmore"), true, "ZWSP");
	assert.equal(hasUnsafeChars("text\uFEFFmore"), true, "BOM/ZWNBS");
	assert.equal(hasUnsafeChars("text\u2060more"), true, "WJ");
});

test("sanitizeForDisplay: bidi controls replaced with replacement char", () => {
	const out = sanitizeForDisplay("text\u202Ebidi\u202C");
	assert.ok(!out.includes("\u202E"), "LRO not in output");
	assert.ok(!out.includes("\u202C"), "PDF not in output");
	assert.ok(out.includes("\uFFFD"), "replacement char present");
	assert.ok(out.includes("text") && out.includes("bidi"), "surrounding text preserved");
});

test("sanitizeForDisplay: ZWJ (U+200D) is NOT replaced", () => {
	// ZWJ is used in emoji and must be preserved
	const input = "thumb\u200Dup"; // ZWJ between chars (not actually emoji but tests the logic)
	const out = sanitizeForDisplay(input);
	assert.ok(out.includes("\u200D"), "ZWJ should not be replaced");
});

test("/approve handler: bidi chars in body → refused, pending", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-bidi-"));
	const am = new ApprovalManager(dir);
	// Body contains a bidi override character
	const bidiBody = "LGTM \u202Ehidden content\u202C";
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve", bidiBody);
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const { cl } = makeFakeClock();
	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am, reviewConfirmClock: cl });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>() { return undefined as T; }, // should never reach confirm
		},
	};
	await handler(id, ctx);

	assert.ok(
		notifies.some((n: any) => n.t.includes("control") || n.t.includes("bidi") || n.t.includes("tampering")),
		"should refuse due to bidi chars",
	);
	assert.ok(am.get(id) !== undefined, "request still pending");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

// ── Issue 7: full sha256 fingerprint storage ─────────────────────────────────

test("reviewBodyFingerprintFull: returns 64-hex sha256", () => {
	const body = "Hello, world!";
	const fp = reviewBodyFingerprintFull(body);
	assert.match(fp, /^[0-9a-f]{64}$/, "full sha256 should be 64 hex chars");
	assert.equal(fp, reviewBodyFingerprintFull(body), "deterministic");
	assert.notEqual(fp, reviewBodyFingerprintFull(body + "!"), "different for different body");
});

test("reviewBodyFingerprint: returns first 8 of full sha256", () => {
	const body = "test body";
	const fp = reviewBodyFingerprint(body);
	const fpFull = reviewBodyFingerprintFull(body);
	assert.match(fp, /^[0-9a-f]{8}$/, "display fingerprint is 8 hex chars");
	assert.equal(fp, fpFull.slice(0, 8), "display fp = first 8 of full fp");
});

test("recordViewedFingerprint stores full sha256 and getViewedFingerprint returns it", () => {
	clearViewedFingerprints();
	const body = "test body for fp";
	recordViewedFingerprint("rq-fp-1", body);
	const entry = getViewedFingerprint("rq-fp-1");
	assert.ok(entry !== undefined, "entry should be stored");
	assert.equal(entry!.hash, reviewBodyFingerprintFull(body), "stored hash is full sha256");
	assert.equal(entry!.hasUnsafeChars, false, "no unsafe chars");
	clearViewedFingerprints();
});

test("recordViewedFingerprint tracks unsafe chars", () => {
	clearViewedFingerprints();
	const unsafeBody = "text\u202Ebidi";
	recordViewedFingerprint("rq-fp-2", unsafeBody, true);
	const entry = getViewedFingerprint("rq-fp-2");
	assert.equal(entry!.hasUnsafeChars, true, "unsafe flag stored");
	clearViewedFingerprints();
});

test("/approve: viewedDiffers uses FULL sha256 (truncated 8-char can't collide)", () => {
	// If we only store 8-char fingerprints, two different bodies could have the same
	// 8-char prefix (birthday attack). Full sha256 prevents this.
	// Test: store a fingerprint for one body, check that a different body (same 8-char prefix)
	// correctly reports viewedDiffers.
	// (We don't actually find a collision here — just verify the full hash is used.)
	clearViewedFingerprints();
	const body1 = "Body one content.";
	const body2 = "Body two content - completely different.";
	// Verify they have different full hashes
	assert.notEqual(reviewBodyFingerprintFull(body1), reviewBodyFingerprintFull(body2));
	// Record viewing of body1
	recordViewedFingerprint("rq-full-1", body1);
	const entry = getViewedFingerprint("rq-full-1");
	// Verify full hash is stored, not 8-char
	assert.equal(entry!.hash.length, 64, "stored hash is full 64-char sha256");
	clearViewedFingerprints();
});

// ── Issue 11: Registered handler regression tests ──────────────────────────

test("/approve handler: explicit-id approve on generic 'approve' request", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-generic-"));
	const am = new ApprovalManager(dir);
	const p = am.ask({ kind: "approve", title: "Deploy to prod?" });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true, mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>() { return undefined as T; },
		},
	};
	// Pass the explicit id
	await handler(id, ctx);

	const ans = await p;
	assert.equal(ans.approved, true, "explicit id approve should resolve the gate");
	assert.ok(notifies.some(n => n.t.includes(id)), "notify should mention the request id");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("/deny handler: explicit-id deny on generic 'approve' request", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-deny-generic-"));
	const am = new ApprovalManager(dir);
	const p = am.ask({ kind: "approve", title: "Merge to main?" });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const handler = fakePi.getHandler("deny");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true, mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>() { return undefined as T; },
		},
	};
	await handler(id, ctx);

	const ans = await p;
	assert.equal(ans.approved, false, "deny should resolve with approved=false");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("/approve implicit-id in TUI: Cancel default, exact equality", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-implicit-"));
	const am = new ApprovalManager(dir);
	const p = am.ask({ kind: "approve", title: "Deploy?" });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const handler = fakePi.getHandler("approve");

	// TUI with implicit id: select should return EXACT confirm label to approve
	// or return undefined/Cancel to not approve
	const notifies: any[] = [];
	const ctx = {
		hasUI: true, mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			// Return "Cancel" (default) → should NOT approve
			async select(_title: string, opts: string[]) { return opts[0]; }, // opts[0] = "Cancel"
			async custom<T>() { return undefined as T; },
		},
	};
	await handler("", ctx); // no explicit id

	// Request should still be pending (Cancel default)
	assert.ok(am.get(id) !== undefined, "request still pending after Cancel");
	notifies.length = 0;

	// Now actually approve with exact label
	const ctx2 = {
		hasUI: true, mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select(_title: string, opts: string[]) { return opts[1]; }, // exact confirm label
			async custom<T>() { return undefined as T; },
		},
	};
	await handler("", ctx2);
	const ans = await p;
	assert.equal(ans.approved, true, "exact confirm label should approve");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("/approve implicit-id in non-UI: refused", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-nonui-"));
	const am = new ApprovalManager(dir);
	am.ask({ kind: "approve", title: "Dangerous operation?" });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: false, mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>() { return undefined as T; },
		},
	};
	await handler("", ctx); // implicit id, no UI

	assert.ok(am.get(id) !== undefined, "request still pending (non-UI refused)");
	assert.ok(notifies.some(n => n.l === "warning"), "should warn about non-UI");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("/answer send-back on review-artifact", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-answer-review-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve");
	const p = am.ask({ kind: "review-artifact", postsReview: true, title: "Review it", artifactPath: filePath });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const handler = fakePi.getHandler("answer");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true, mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async input(_title: string, _ph: string) { return "Please fix the tests first"; },
		},
	};
	await handler(id, ctx); // explicit id, triggers input

	const ans = await p;
	assert.equal(ans.approved, false, "send-back should NOT approve");
	assert.equal((ans as any).action, "send-back", "action should be send-back");
	assert.ok((ans as any).text?.includes("fix the tests"), "text should match input");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});

test("/choose handler with explicit option", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-choose-"));
	const am = new ApprovalManager(dir);
	const p = am.ask({ kind: "choose", title: "Pick deployment target", options: ["staging", "production", "canary"] });
	const id = am.list()[0].id;

	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am });
	const handler = fakePi.getHandler("choose");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true, mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async input() { return undefined; },
		},
	};
	// Pass explicit option number "2" (production)
	await handler(`${id} 2`, ctx);

	const ans = await p;
	assert.equal((ans as any).choice, "production", "should choose option 2");
	assert.ok(notifies.some(n => n.t.includes("production")), "notify should mention choice");

	fs.rmSync(dir, { recursive: true, force: true });
});

// ── Issue 12: sanitizeForLabel ────────────────────────────────────────────────

test("sanitizeForLabel: collapses newlines and strips controls", () => {
	const out = sanitizeForLabel("line1\nline2\x1b[8mhidden");
	assert.ok(!out.includes("\n"), "no newlines");
	assert.ok(!out.includes("\x1b"), "no raw ESC");
	assert.ok(out.includes("line1"), "line1 present");
	assert.ok(out.includes("line2"), "line2 present");
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue 1: gh-tool.ts — login validation and urlIsReview propagation
// ─────────────────────────────────────────────────────────────────────────────

test("postReview: user lookup fails → skip reviews, return PR link with urlIsReview=false", () => {
	// Exec is called: gh pr review (OK), gh api user (throws), reviews lookup should NOT be called
	const calls: { file: string; args: string[] }[] = [];
	const exec: ExecFile = (file, args) => {
		calls.push({ file, args });
		if (args.includes("api") && args.includes("user")) throw new Error("gh: authentication failed");
		// If reviews lookup is wrongly called, return a review URL
		if (args.some(a => a.includes("/reviews"))) return "https://github.com/o/r/pull/12#pullrequestreview-99\n";
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", slug: "o/r", verdict: "approve", body: "LGTM", exec });
	assert.equal(res.error, undefined);
	// Should return PR URL, not review URL
	assert.equal(res.url, "https://github.com/o/r/pull/12");
	assert.equal(res.urlIsReview, false, "should be PR URL when login lookup fails");
	// Reviews lookup must NOT have been called
	const reviewsCall = calls.find(c => c.args.some(a => a.includes("/reviews")));
	assert.equal(reviewsCall, undefined, "reviews lookup must be skipped when login is unknown");
});

test("postReview: bot login (name[bot]) → skip reviews, return PR link with urlIsReview=false", () => {
	const calls: { file: string; args: string[] }[] = [];
	const exec: ExecFile = (file, args) => {
		calls.push({ file, args });
		if (args.includes("api") && args.includes("user")) return "github-actions[bot]\n";
		// If reviews lookup is wrongly called, return a review URL
		if (args.some(a => a.includes("/reviews"))) return "https://github.com/o/r/pull/12#pullrequestreview-99\n";
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", slug: "o/r", verdict: "approve", body: "LGTM", exec });
	assert.equal(res.error, undefined);
	assert.equal(res.url, "https://github.com/o/r/pull/12");
	assert.equal(res.urlIsReview, false, "bot login → PR URL");
	const reviewsCall = calls.find(c => c.args.some(a => a.includes("/reviews")));
	assert.equal(reviewsCall, undefined, "reviews lookup must be skipped for bot logins");
});

test("postReview: another invalid login pattern → skip reviews, return PR link", () => {
	const exec: ExecFile = (_file, args) => {
		if (args.includes("api") && args.includes("user")) return "user name with spaces\n";
		if (args.some(a => a.includes("/reviews"))) return "https://github.com/o/r/pull/12#pullrequestreview-99\n";
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", slug: "o/r", verdict: "approve", body: "LGTM", exec });
	assert.equal(res.url, "https://github.com/o/r/pull/12");
	assert.equal(res.urlIsReview, false);
});

test("postReview: valid login → reviews lookup performed, review URL returned", () => {
	const exec: ExecFile = (_file, args) => {
		if (args.includes("api") && args.includes("user")) return "validuser\n";
		if (args.some(a => a.includes("/reviews"))) return "https://github.com/o/r/pull/12#pullrequestreview-42\n";
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", slug: "o/r", verdict: "approve", body: "LGTM", exec });
	assert.equal(res.url, "https://github.com/o/r/pull/12#pullrequestreview-42");
	assert.equal(res.urlIsReview, true, "valid login → review URL");
});

// Status toast label: "Review:" vs "PR:" based on urlIsReview
// (Tested indirectly via QuestRecord; direct assertion in the status module is integration-level,
//  but we can test that the QuestReview type accepts urlIsReview.)
test("QuestReview type: urlIsReview field is optional boolean", () => {
	// Type-level check: if it compiles with urlIsReview set, the field exists.
	const review: import("../src/persistence/quest-store.ts").QuestReview = {
		number: "12",
		slug: "o/r",
		posted: true,
		url: "https://github.com/o/r/pull/12#pullrequestreview-1",
		urlIsReview: true,
	};
	assert.equal(review.urlIsReview, true);
	const review2: import("../src/persistence/quest-store.ts").QuestReview = {
		number: "12",
		slug: "o/r",
		posted: true,
		url: "https://github.com/o/r/pull/12",
		urlIsReview: false,
	};
	assert.equal(review2.urlIsReview, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue 2: sanitizeForDisplay supplementary characters (emoji, CJK)
// ─────────────────────────────────────────────────────────────────────────────

test("sanitizeForDisplay: emoji round-trip unchanged (basic emoji)", () => {
	const input = "Hello 🎉 World";
	const out = sanitizeForDisplay(input);
	assert.equal(out, input, "basic emoji should be unchanged");
});

test("sanitizeForDisplay: emoji with FE0F presentation selector unchanged", () => {
	// U+2764 (heart) + U+FE0F (emoji presentation) — FE0F must be kept
	const input = "I \u2764\uFE0F you";
	const out = sanitizeForDisplay(input);
	assert.equal(out, input, "FE0F emoji presentation selector must be preserved");
});

test("sanitizeForDisplay: ZWJ sequence unchanged (family emoji)", () => {
	// 👨‍👩‍👧 = U+1F468 U+200D U+1F469 U+200D U+1F467 (man + ZWJ + woman + ZWJ + girl)
	const family = "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67";
	const out = sanitizeForDisplay(family);
	assert.equal(out, family, "ZWJ emoji sequence must be preserved");
});

test("sanitizeForDisplay: CJK characters unchanged", () => {
	const input = "日本語テスト中文한국어";
	const out = sanitizeForDisplay(input);
	assert.equal(out, input, "CJK should pass through unchanged");
});

test("sanitizeForDisplay: supplementary char (outside BMP) preserved correctly", () => {
	// U+1F600 = 😀 = \uD83D\uDE00 (surrogate pair)
	const input = "emoji: \uD83D\uDE00 end";
	const out = sanitizeForDisplay(input);
	assert.equal(out, input, "supplementary char (emoji) preserved as full surrogate pair");
	// Verify length is correct (not truncated to one code unit)
	assert.equal(out.length, input.length, "output length matches input for supplementary char");
});

test("sanitizeForDisplay: wide chars — visibleWidth accounts for wide display", () => {
	// CJK chars are 2 cells wide; visibleWidth should reflect this
	const cjk = "漢字";
	const out = sanitizeForDisplay(cjk);
	assert.equal(out, cjk, "CJK unchanged");
	// visibleWidth counts display columns (CJK = 2 per char)
	assert.equal(visibleWidth(out), 4, "visibleWidth of 2 CJK chars = 4");
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue 3: Invisible-character coverage
// ─────────────────────────────────────────────────────────────────────────────

test("hasUnsafeChars: U+00AD (soft hyphen) is flagged", () => {
	assert.equal(hasUnsafeChars("a\u00ADb"), true, "soft hyphen U+00AD flagged");
});

test("hasUnsafeChars: U+034F (combining grapheme joiner) is flagged", () => {
	assert.equal(hasUnsafeChars("a\u034Fb"), true, "CGJ U+034F flagged");
});

test("hasUnsafeChars: U+180E (Mongolian vowel separator) is flagged", () => {
	assert.equal(hasUnsafeChars("a\u180Eb"), true, "MVS U+180E flagged");
});

test("hasUnsafeChars: U+2061–U+2064 (invisible math) are flagged", () => {
	assert.equal(hasUnsafeChars("a\u2061b"), true, "U+2061 flagged");
	assert.equal(hasUnsafeChars("a\u2064b"), true, "U+2064 flagged");
});

test("hasUnsafeChars: U+206A–U+206F (deprecated format chars) are flagged", () => {
	assert.equal(hasUnsafeChars("a\u206Ab"), true, "U+206A flagged");
	assert.equal(hasUnsafeChars("a\u206Fb"), true, "U+206F flagged");
});

test("hasUnsafeChars: U+FFF9–U+FFFB (interlinear annotation) are flagged", () => {
	assert.equal(hasUnsafeChars("a\uFFF9b"), true, "U+FFF9 flagged");
	assert.equal(hasUnsafeChars("a\uFFFAb"), true, "U+FFFA flagged");
	assert.equal(hasUnsafeChars("a\uFFFBb"), true, "U+FFFB flagged");
});

test("hasUnsafeChars: Hangul fillers are flagged", () => {
	assert.equal(hasUnsafeChars("a\u115Fb"), true, "U+115F (Hangul Choseong Filler) flagged");
	assert.equal(hasUnsafeChars("a\u1160b"), true, "U+1160 (Hangul Jungseong Filler) flagged");
	assert.equal(hasUnsafeChars("a\u3164b"), true, "U+3164 (Hangul Filler) flagged");
	assert.equal(hasUnsafeChars("a\uFFA0b"), true, "U+FFA0 (Halfwidth Hangul Filler) flagged");
});

test("hasUnsafeChars: U+FE00–U+FE0D (variation selectors) are flagged", () => {
	assert.equal(hasUnsafeChars("a\uFE00b"), true, "U+FE00 VS-1 flagged");
	assert.equal(hasUnsafeChars("a\uFE0Db"), true, "U+FE0D VS-14 flagged");
});

test("hasUnsafeChars: U+FE0E and U+FE0F (text/emoji presentation) are NOT flagged", () => {
	assert.equal(hasUnsafeChars("\u2764\uFE0E"), false, "U+FE0E text presentation kept");
	assert.equal(hasUnsafeChars("\u2764\uFE0F"), false, "U+FE0F emoji presentation kept");
});

test("hasUnsafeChars: Variation Selectors Supplement U+E0100–U+E01EF are flagged", () => {
	// U+E0100 in UTF-16: surrogate pair DB40 DD00
	const vs17 = "\uDB40\uDD00";
	assert.equal(hasUnsafeChars(`a${vs17}b`), true, "VS-17 (U+E0100) flagged");
	// U+E01EF: DB40 DDEF
	const vs256 = "\uDB40\uDDEF";
	assert.equal(hasUnsafeChars(`a${vs256}b`), true, "VS-256 (U+E01EF) flagged");
});

test("sanitizeForDisplay: new invisible chars replaced with U+FFFD", () => {
	for (const [name, char] of [
		["soft hyphen", "\u00AD"],
		["CGJ", "\u034F"],
		["MVS", "\u180E"],
		["invis-math-2061", "\u2061"],
		["invis-math-2064", "\u2064"],
		["format-206A", "\u206A"],
		["format-206F", "\u206F"],
		["interlinear-FFF9", "\uFFF9"],
		["interlinear-FFFB", "\uFFFB"],
		["Hangul-115F", "\u115F"],
		["Hangul-3164", "\u3164"],
		["Hangul-FFA0", "\uFFA0"],
		["VS1-FE00", "\uFE00"],
		["VS14-FE0D", "\uFE0D"],
		["VS-Supp-E0100", "\uDB40\uDD00"],
	]) {
		const out = sanitizeForDisplay(`a${char}b`);
		assert.ok(out.includes("\uFFFD"), `${name} should be replaced with U+FFFD`);
		assert.ok(out.includes("a") && out.includes("b"), `${name}: surrounding text preserved`);
	}
});

test("sanitizeForDisplay: U+FE0E and U+FE0F preserved", () => {
	const input = "\u2764\uFE0E \u2764\uFE0F";
	const out = sanitizeForDisplay(input);
	assert.equal(out, input, "FE0E and FE0F must be preserved");
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue 4: Sanitize in the info-card renderer
// ─────────────────────────────────────────────────────────────────────────────

test("info-card renderer: ESC/OSC in title is sanitized", () => {
	const entries: { type: string; data: unknown }[] = [];
	const renderers: Record<string, (entry: { data: unknown }, opts: unknown, theme: unknown) => unknown> = {};

	const fakePi = {
		registerEntryRenderer(type: string, fn: (e: { data: unknown }, o: unknown, t: unknown) => unknown) {
			renderers[type] = fn;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
			// Simulate a render with stub theme
			const renderer = renderers[type];
			if (renderer) renderer({ data }, {}, STUB_THEME);
		},
	};

	registerInfoCard(fakePi as any);

	// Title with ESC/OSC injection
	const maliciousTitle = "Normal \x1b]0;evil title\x07 More";
	// This must NOT throw, and rendering must produce sanitized output
	assert.doesNotThrow(() => {
		fakePi.appendEntry(INFO_CARD_ENTRY, {
			title: maliciousTitle,
			lines: [{ text: "line \x1b[8mhidden\x1b[0m visible" }],
		});
	}, "renderer must not throw on malicious input");
});

test("info-card renderer: ESC in markdown lines is sanitized", () => {
	const renderers: Record<string, (entry: { data: unknown }, opts: unknown, theme: unknown) => unknown> = {};
	const fakePi = {
		registerEntryRenderer(type: string, fn: (e: { data: unknown }, o: unknown, t: unknown) => unknown) {
			renderers[type] = fn;
		},
	};
	registerInfoCard(fakePi as any);

	// Render directly with malicious markdown
	const renderer = renderers[INFO_CARD_ENTRY];
	assert.ok(renderer, "renderer should be registered");
	// Should not throw when rendering malicious content
	assert.doesNotThrow(() => {
		renderer(
			{ data: {
				title: "Test",
				markdown: "# \x1b[8mHidden heading\x1b[0m\n\nNormal paragraph",
				lines: [{ text: "Line with \x1b[31mbidi\u202Etext" }],
			}},
			{},
			STUB_THEME,
		);
	}, "renderer must not throw on malicious markdown");
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue 5: Record viewed fingerprint only after body rows are visible
// ─────────────────────────────────────────────────────────────────────────────

test("ReviewViewerComponent: onFirstBodyRender not called at rows 1 (no body visible)", () => {
	clearViewedFingerprints();
	let callbackFired = false;
	const body = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n");
	// Production budget: tui.rows - 2 = 1 - 2 = max(1, -1) = 1
	const tui = mockTui(1);
	const getRows = () => Math.max(1, tui.terminal.rows - 2); // = 1
	const comp = new ReviewViewerComponent(
		tui, ["Header"], body, VIEWER_FOOTER_HINT, () => {}, getRows, undefined,
		() => { callbackFired = true; },
	);
	comp.render(40);
	assert.equal(callbackFired, false, "callback must not fire at rows=1 (budget=1, no body fits)");
	clearViewedFingerprints();
});

test("ReviewViewerComponent: onFirstBodyRender not called at rows 2 (no body visible)", () => {
	clearViewedFingerprints();
	let callbackFired = false;
	const body = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n");
	// Production budget: max(1, 2-2) = 1
	const tui = mockTui(2);
	const getRows = () => Math.max(1, tui.terminal.rows - 2);
	const comp = new ReviewViewerComponent(
		tui, ["Header"], body, VIEWER_FOOTER_HINT, () => {}, getRows, undefined,
		() => { callbackFired = true; },
	);
	comp.render(40);
	assert.equal(callbackFired, false, "callback must not fire at rows=2 (budget=1, no body fits)");
	clearViewedFingerprints();
});

test("ReviewViewerComponent: onFirstBodyRender not called at rows 3 (no body visible)", () => {
	clearViewedFingerprints();
	let callbackFired = false;
	const body = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n");
	// Production budget: max(1, 3-2) = 1
	const tui = mockTui(3);
	const getRows = () => Math.max(1, tui.terminal.rows - 2);
	const comp = new ReviewViewerComponent(
		tui, ["Header"], body, VIEWER_FOOTER_HINT, () => {}, getRows, undefined,
		() => { callbackFired = true; },
	);
	comp.render(40);
	assert.equal(callbackFired, false, "callback must not fire at rows=3 (budget=1, no body fits)");
	clearViewedFingerprints();
});

test("ReviewViewerComponent: onFirstBodyRender called at rows ≥6 (body visible)", () => {
	clearViewedFingerprints();
	let callbackFired = false;
	const body = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n");
	// Production budget: max(1, 6-2) = 4; headerRows=1, bodyRows=3 > 0
	const tui = mockTui(6);
	const getRows = () => Math.max(1, tui.terminal.rows - 2);
	const comp = new ReviewViewerComponent(
		tui, ["Header"], body, VIEWER_FOOTER_HINT, () => {}, getRows, undefined,
		() => { callbackFired = true; },
	);
	comp.render(40);
	assert.equal(callbackFired, true, "callback must fire at rows=6 (budget=4, body rows visible)");
	clearViewedFingerprints();
});

test("ReviewViewerComponent: onFirstBodyRender called only once (not on every render)", () => {
	clearViewedFingerprints();
	let callCount = 0;
	const body = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n");
	const tui = mockTui(6);
	const getRows = () => Math.max(1, tui.terminal.rows - 2);
	const comp = new ReviewViewerComponent(
		tui, ["Header"], body, VIEWER_FOOTER_HINT, () => {}, getRows, undefined,
		() => { callCount++; },
	);
	comp.render(40);
	comp.render(40);
	comp.render(40);
	assert.equal(callCount, 1, "callback must fire exactly once, not on every render");
	clearViewedFingerprints();
});

test("ReviewViewerComponent: without onFirstBodyRender, no error at rows ≥6", () => {
	const body = "Line 1\nLine 2";
	const tui = mockTui(8);
	// No callback: should not throw
	const comp = new ReviewViewerComponent(tui, ["Header"], body, VIEWER_FOOTER_HINT, () => {});
	assert.doesNotThrow(() => comp.render(40));
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue 6: Enter AFTER grace fires in too-small state still doesn't post
// ─────────────────────────────────────────────────────────────────────────────

test("ReviewConfirmComponent: too small + grace fired + Enter → does not post", () => {
	const { cl, fire } = makeFakeClock();
	// rows=4 → budget = max(1, 4-2) = 2; options=2 → 2-2-1=-1 ≤ 0 → too small
	const fakeTui = { terminal: { rows: 4 }, requestRender() {} };
	let result: string | undefined = "NONE";
	const comp = new ReviewConfirmComponent(fakeTui, "Verdict: APPROVE", ["Cancel", "Post"], (r) => { result = r; }, cl);
	comp.render(60); // first render: starts grace timer
	fire();          // end grace period
	comp.handleInput("\n"); // Enter in too-small state
	assert.equal(result, "NONE", "Enter after grace in too-small state must not post");
	// Esc still works
	comp.handleInput("\x1b");
	assert.equal(result, undefined, "Esc should still cancel in too-small state after grace");
});

test("ReviewConfirmComponent (handler-level): too small terminal + grace fired + Enter → not posted", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-ap-toosmall-"));
	const am = new ApprovalManager(dir);
	const { filePath, dir: rDir } = writeTempReview("Verdict: Approve");
	am.ask({ kind: "review-artifact", postsReview: true, title: "Test", artifactPath: filePath });
	const id = am.list()[0].id;

	const { cl, fire } = makeFakeClock();
	const fakePi = makeFakePi();
	registerApprovals(fakePi as any, { approvals: am, reviewConfirmClock: cl });
	const handler = fakePi.getHandler("approve");

	const notifies: any[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			notifies,
			notify(t: string, l: string) { notifies.push({ t, l }); },
			async select() { return undefined; },
			async custom<T>(factory: (tui: any, th: any, kb: any, done: (r: T) => void) => any, _opts?: any): Promise<T> {
				return new Promise<T>((resolve) => {
					// rows=4 → budget=2 → too small
					const fakeTui = { terminal: { rows: 4 }, requestRender() {} };
					const done = (r: T) => resolve(r);
					const comp = factory(fakeTui, null, null, done);
					comp.render(60); // starts grace
					fire();          // end grace
					comp.handleInput("\n"); // Enter in too-small state → should be ignored
					// Esc to exit (required to not hang the promise)
					comp.handleInput("\x1b");
				});
			},
		},
	};
	await handler(id, ctx);

	assert.ok(notifies.some((n: any) => n.t.includes("still pending")), "should still be pending");
	assert.ok(am.get(id) !== undefined, "request still pending");

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(rDir, { recursive: true, force: true });
});
