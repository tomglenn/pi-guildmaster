/**
 * Regression tests for the runner's non-terminating-command classifier.
 *
 * The runner (exec tier) gets a bounded shell instead of raw bash. A watch mode
 * or dev server would wedge the whole Quest, so these must be refused; ordinary
 * one-shot builds/tests/git must pass through untouched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { nonTerminatingHint } from "../src/execution/runner-shell.ts";

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
