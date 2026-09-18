/**
 * Regression tests for the runner's non-terminating-command classifier and
 * integration tests for the bounded shell execution (timeout, inactivity, abort).
 *
 * The runner (exec tier) gets a bounded shell instead of raw bash. A watch mode
 * or dev server would wedge the whole Quest, so these must be refused; ordinary
 * one-shot builds/tests/git must pass through untouched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nonTerminatingHint, createRunnerShellTool } from "../src/execution/runner-shell.ts";


// Mock context for testing
const mockCtx: any = { cwd: process.cwd() };
const REFUSED = [
	"jest --watch",
	"jest --watch tests/foo.spec.ts",
	"npm run dev",
	"npm start",
	"yarn serve",
	"pnpm run watch",
	"vitest",
	"vitest --watch",
	"vite",
	"nodemon server.js",
	"next dev",
	"docker compose up",
	"docker-compose up --build",
	"tail -f log.txt",
	"watch ls",
	"less README.md",
];

const ALLOWED = [
	"jest --watchAll=false",
	"jest --ci",
	"vitest run",
	"npm run test:ci",
	"npm run typecheck",
	"npm run lint",
	"tsc --noEmit",
	"docker compose up -d",
	"git diff origin/main..HEAD",
	"git status --short",
	"tail -n 50 log.txt",
	"eslint --cache .",
];

for (const cmd of REFUSED) {
	test(`refuses non-terminating: ${cmd}`, () => {
		assert.ok(nonTerminatingHint(cmd), `expected a refusal hint for: ${cmd}`);
	});
}

for (const cmd of ALLOWED) {
	test(`allows bounded: ${cmd}`, () => {
		assert.equal(nonTerminatingHint(cmd), undefined, `expected no refusal for: ${cmd}`);
	});
}

// Integration tests for shell execution hardening
test("hard timeout terminates with killedForTotal", { timeout: 10_000 }, async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "runner-shell-test-"));
	try {
		// Small real-time budgets: the watchdog behaves identically at 800ms as at
		// 31s, and burning tens of real seconds here (a) made `npm test` slow and
		// (b) widened the window for a mis-reaped child to wedge the whole suite.
		const tool = createRunnerShellTool({ cwd: tmpDir, maxTotalMs: 800, inactivityMs: 5_000, allowSubMinimumTimeouts: true });
		const result = await tool.execute("test-1", { command: 'node -e "setTimeout(() => {}, 60000)"' }, undefined, undefined, mockCtx);
		assert.ok((result.details as any).killedForTotal, "expected killedForTotal=true");
		assert.ok(!(result.details as any).killedForHang, "expected killedForHang=false");
		assert.ok((result.content[0] as any).text.includes("KILLED"), "expected KILLED message");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("inactivity timeout terminates with killedForHang", { timeout: 10_000 }, async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "runner-shell-test-"));
	try {
		const tool = createRunnerShellTool({ cwd: tmpDir, inactivityMs: 500, maxTotalMs: 5_000, allowSubMinimumTimeouts: true });
		const result = await tool.execute("test-2", { command: 'node -e "setTimeout(() => {}, 60000)"' }, undefined, undefined, mockCtx);
		assert.ok((result.details as any).killedForHang, "expected killedForHang=true");
		assert.ok(!(result.details as any).killedForTotal, "expected killedForTotal=false");
		assert.ok((result.content[0] as any).text.includes("KILLED"), "expected KILLED message");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("output resets inactivity timer", { timeout: 10_000 }, async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "runner-shell-test-"));
	try {
		// Prints every 150ms for ~750ms; each print must reset the 500ms hang timer
		// so the command completes instead of being killed.
		const tool = createRunnerShellTool({ cwd: tmpDir, inactivityMs: 500, maxTotalMs: 10_000, allowSubMinimumTimeouts: true });
		const result = await tool.execute(
			"test-3",
			{ command: 'node -e "let i=0; const iv=setInterval(() => { if(i++<5) console.log(i); else { clearInterval(iv); process.exit(0); } }, 150)"' },
			undefined,
			undefined,
			mockCtx,
		);
		assert.ok(!(result.details as any).killedForHang, "expected command to complete normally");
		assert.ok(!(result.details as any).killedForTotal, "expected command to complete normally");
		assert.equal((result.details as any).exitCode, 0, "expected exit code 0");
		assert.ok((result.content[0] as any).text.includes("exit 0"), "expected normal exit");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("normal command completes with exit code", { timeout: 10_000 }, async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "runner-shell-test-"));
	try {
		const tool = createRunnerShellTool({ cwd: tmpDir });
		const result = await tool.execute("test-4", { command: 'node -e "console.log(\'hello\')"' }, undefined, undefined, mockCtx);
		assert.equal((result.details as any).exitCode, 0, "expected exit code 0");
		assert.ok(!(result.details as any).killedForHang, "expected killedForHang=false");
		assert.ok(!(result.details as any).killedForTotal, "expected killedForTotal=false");
		assert.ok((result.content[0] as any).text.includes("hello"), "expected 'hello' in output");
		assert.ok((result.content[0] as any).text.includes("exit 0"), "expected 'exit 0' in output");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("CI environment is forced to true", { timeout: 10_000 }, async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "runner-shell-test-"));
	try {
		// Save and set CI to a different value
		const oldCI = process.env.CI;
		process.env.CI = "false";
		try {
			const tool = createRunnerShellTool({ cwd: tmpDir });
			const result = await tool.execute("test-5", { command: 'node -e "console.log(process.env.CI)"' }, undefined, undefined, mockCtx);
			assert.ok((result.content[0] as any).text.includes("true"), "expected CI=true in output even when process.env.CI is false");
		} finally {
			if (oldCI !== undefined) process.env.CI = oldCI;
			else delete process.env.CI;
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// Regression: the direct child exits, but a DETACHED grandchild (setsid/its own
// process group) inherits and holds the stdout pipe open. Resolving on stdio EOF
// (`close`) would wedge the Runner until the grandchild dies; resolving on the
// child's `exit` must return promptly. Mirrors the real hang seen when `npm test`
// spawned a detached fixture that outlived the pipeline.
test("resolves on child exit even when a detached grandchild holds the pipe", { timeout: 8_000 }, async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "runner-shell-test-"));
	try {
		const tool = createRunnerShellTool({ cwd: tmpDir, inactivityMs: 60_000, maxTotalMs: 60_000 });
		// Parent spawns a detached child that inherits stdout and sleeps 15s, then the
		// parent exits 0. The inherited pipe stays open long after the parent is gone.
		const command =
			"node -e \"const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{detached:true,stdio:'inherit'});c.unref();console.log('parent done');\"";
		const start = Date.now();
		const result = await tool.execute("test-7", { command }, undefined, undefined, mockCtx);
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 2000, `expected prompt resolution on child exit, got ${elapsed}ms (pipe-EOF deadlock?)`);
		assert.equal((result.details as any).exitCode, 0, "expected exit code 0");
		assert.ok(!(result.details as any).killedForHang, "expected not killed for hang");
		assert.ok(!(result.details as any).killedForTotal, "expected not killed for total");
		assert.ok((result.content[0] as any).text.includes("parent done"), "expected parent output captured");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("production floors still clamp sub-minimum timeouts (no bypass flag)", { timeout: 10_000 }, async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "runner-shell-test-"));
	try {
		// Without allowSubMinimumTimeouts, a tiny inactivity budget must be clamped up
		// to the 10s floor — so a command that finishes in ~200ms is NOT killed.
		const tool = createRunnerShellTool({ cwd: tmpDir, inactivityMs: 50, maxTotalMs: 50 });
		const result = await tool.execute("test-clamp", { command: 'node -e "setTimeout(() => console.log(\'ok\'), 200)"' }, undefined, undefined, mockCtx);
		assert.equal((result.details as any).exitCode, 0, "clamped floors must let a fast command finish");
		assert.ok(!(result.details as any).killedForHang, "must not be killed for hang under the clamped floor");
		assert.ok(!(result.details as any).killedForTotal, "must not be killed for total under the clamped floor");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("abort terminates immediately", { timeout: 10_000 }, async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "runner-shell-test-"));
	try {
		const controller = new AbortController();
		const tool = createRunnerShellTool({ cwd: tmpDir, inactivityMs: 60_000, maxTotalMs: 60_000 });
		const promise = tool.execute("test-6", { command: 'node -e "setTimeout(() => {}, 60000)"' }, controller.signal, undefined, mockCtx);
		const startTime = Date.now();
		// Abort after 500ms
		setTimeout(() => controller.abort(), 500);
		const result = await promise;
		const elapsed = Date.now() - startTime;
		// Should terminate quickly (well under the 5s grace period)
		assert.ok(elapsed < 3000, `expected quick termination, got ${elapsed}ms`);
		assert.equal((result.details as any).terminationReason, "abort", "expected terminationReason=abort");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
