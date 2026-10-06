/**
 * The review envoy's gate. Reads run freely, mutations need approval, and
 * merge is refused. Regression tests for read-only gh commands (e.g. `gh run
 * view`) that were wrongly parked for approval, for `gh api` calls that
 * default to POST being treated as reads, and for mutations chained behind
 * a read.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand, gateReviewCommand } from "../src/execution/policy.ts";

const gate = (c: string) => gateReviewCommand(c, { reviewMode: true });

const READS = [
	"gh pr view 1957 --json reviews",
	"gh pr diff 1957",
	"gh pr checks 1957",
	"gh run view 37454274328 --log-failed",
	"gh run list --branch main",
	"gh run watch 123",
	"gh run download 123 -n artifact",
	"gh workflow view ci.yml",
	"gh workflow list",
	"gh release view v1.2.3",
	"gh release list",
	"gh issue view 12",
	"gh issue list --state open",
	"gh issue status",
	"gh repo view grafana/grafana-pathfinder-app",
	"gh label list",
	"gh ruleset check main",
	"gh search prs --review-requested=@me",
	"gh api repos/o/r/pulls/1/comments",
	"gh api -X GET repos/o/r/pulls/1/reviews",
	`gh api graphql -f query='query { viewer { login } }'`,
];

const NEEDS_APPROVAL = [
	"gh pr review 1 --approve --body x",
	"gh pr comment 1 --body x",
	"gh issue comment 12 --body x",
	"gh run rerun 123",
	"gh run cancel 123",
	"gh workflow run ci.yml",
	"gh release create v1",
	"gh api -X POST repos/o/r/issues/1/comments",
	"gh api --method PATCH repos/o/r/pulls/1",
	// No explicit method plus a field or input flag: gh defaults to POST.
	"gh api repos/o/r/issues/1/comments -f body=hi",
	"gh api repos/o/r/issues/1/comments --field body=hi",
	"gh api repos/o/r/pulls/1/reviews --input review.json",
	`gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'`,
	// A field flag forces a non-read even with GET; the allowlist parser is conservative.
	"gh api --method=GET search/issues -f q=is:open",
];

const FORBIDDEN = [
	"gh pr merge 1",
	// Shell operators are refused outright, so nothing can ride behind a read.
	"gh pr view 1 && gh pr merge 1 --squash",
	"gh pr diff 1 | cat ; gh pr merge 1",
	"gh pr view 1 && gh pr comment 1 --body x",
	"gh run view 1 ; gh run rerun 1",
	`gh run view 37454274328 --log-failed 2>&1 | grep -A 60 "x" | head -70`,
];

for (const c of READS) {
	test(`read runs without approval: ${c}`, () => {
		const g = gate(c);
		assert.equal(g.blocked, false, g.reason);
		assert.equal(g.needsApproval, false, `${g.operation}: ${g.reason}`);
	});
}

for (const c of NEEDS_APPROVAL) {
	test(`mutation parks for approval: ${c}`, () => {
		const g = gate(c);
		assert.equal(g.blocked, false, g.reason);
		assert.equal(g.needsApproval, true, `${g.operation} classified ${g.klass}`);
	});
}

for (const c of FORBIDDEN) {
	test(`refused: ${c}`, () => {
		assert.equal(gate(c).blocked, true);
	});
}

test("outside review mode, mutations are blocked rather than parked", () => {
	const g = gateReviewCommand("gh pr comment 1 --body x", { reviewMode: false });
	assert.equal(g.blocked, true);
	assert.equal(g.needsApproval, false);
});

test("unknown gh subcommands still fail closed (mutate)", () => {
	assert.equal(classifyCommand("gh secret set FOO").klass, "mutate");
	assert.equal(classifyCommand("gh run delete 1").klass, "mutate");
});
