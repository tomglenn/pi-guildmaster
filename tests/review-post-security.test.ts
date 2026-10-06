/**
 * Security hardening of the review-post path (Bug 1 follow-up).
 *
 * Review posting goes ONLY through the confirmed /approve snapshot (postReview). These
 * tests pin the holes a security review found around it:
 *   - F1: the envoy gate classified by the leading command only, so a post could ride
 *     behind a read (`gh pr view 1; gh pr review 1 --approve`), and `gh api -f …` (which
 *     gh sends as POST) counted as a read. The review-mode envoy could also post itself.
 *   - F2: PR number / slug reached a shell unvalidated.
 *   - F3: the review body temp file was predictable and written non-exclusively.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { buildReviewArgs, createEnvoyShellTool, type ExecFile, postReview } from "../src/execution/gh-tool.ts";
import { classifyCommand, findShellControl, gateReviewCommand, shellWords } from "../src/execution/policy.ts";
import { parsePrTarget } from "../src/quest-tool.ts";

const mockCtx: any = { cwd: process.cwd() };

const CHAINED = [
	"gh pr view 1; gh pr review 1 --approve -b x",
	"echo x && gh pr review 1 --approve -b x",
	"gh pr view 1 || gh pr review 1 --approve -b x",
	"gh pr view 1 | gh pr review 1 --approve -b x",
	"gh pr view 1 & gh pr review 1 --approve -b x",
	"gh pr view $(gh pr review 1 --approve -b x)",
	"gh pr view `gh pr review 1 --approve -b x`",
	'gh pr view "$(gh pr review 1 --approve -b x)"',
	"gh pr view 1\ngh pr review 1 --approve -b x",
	"gh pr view 1 > /tmp/out",
	"gh api repos/o/r/pulls/1/reviews --input < body.json",
];

test("chained / substituted commands are never 'read' in the envoy gate (both modes)", () => {
	for (const cmd of CHAINED) {
		for (const reviewMode of [true, false]) {
			const g = gateReviewCommand(cmd, { reviewMode, envoy: true });
			assert.notEqual(g.klass, "read", `expected NOT read (reviewMode=${reviewMode}): ${cmd}`);
			assert.ok(g.blocked, `expected BLOCKED (reviewMode=${reviewMode}): ${cmd}`);
			assert.equal(g.needsApproval, false);
		}
	}
});

test("shell wrappers and git command-execution tricks are refused in the envoy gate", () => {
	for (const cmd of [
		'bash -c "gh pr review 1 --approve -b x"',
		"sh -c 'gh pr review 1 --approve -b x'",
		"env gh pr review 1 --approve -b x",
		"./gh pr view 1",
		"git -c alias.x='!gh pr review 1 --approve -b x' x",
		"git config alias.x '!gh pr review 1 --approve -b x'",
		"git diff --output=/tmp/x",
		"git push",
	]) {
		const g = gateReviewCommand(cmd, { reviewMode: true, envoy: true });
		assert.ok(g.blocked, `expected BLOCKED: ${cmd}`);
	}
});

test("operators inside quotes are literal and do not trip the gate", () => {
	assert.equal(findShellControl(`gh api repos/o/r/pulls/1/comments --jq '.[] | {path, body}'`), undefined);
	assert.equal(findShellControl(`gh pr view 1 --json reviews -q ".reviews[-1].url"`), undefined);
	assert.equal(findShellControl(`gh pr view 1 --json body -q "a;b"`), undefined);
	assert.equal(findShellControl(`gh pr view 1 "$(id)"`), "$(");
	assert.equal(findShellControl(`gh pr view 1 'unterminated`), "unterminated '");
	assert.deepEqual(shellWords(`gh api x --jq '.[] | .a' -q "b c"`), ["gh", "api", "x", "--jq", ".[] | .a", "-q", "b c"]);
});

test("gh api with field/input flags is mutating unless the method is explicitly GET", () => {
	for (const cmd of [
		"gh api repos/x/y/pulls/1/reviews -f event=APPROVE",
		"gh api repos/x/y/pulls/1/reviews -F event=APPROVE",
		"gh api repos/x/y/pulls/1/reviews --field event=APPROVE",
		"gh api repos/x/y/pulls/1/reviews --raw-field body=hi",
		"gh api repos/x/y/pulls/1/reviews --input body.json",
		"gh api repos/x/y/pulls/1/reviews -fevent=APPROVE",
		"gh api repos/x/y/pulls/1/reviews --method=POST",
		'gh api repos/x/y/pulls/1/reviews -X "POST"',
		'gh api repos/x/y/pulls/1/reviews "-f" event=APPROVE',
		"gh api repos/x/y/pulls/1/reviews -X GET -X POST",
		// S1 tightening: REST fields are never a read (even with -X GET), and the method must be exactly GET.
		"gh api -X GET repos/x/y/pulls -f per_page=100",
		"gh api --method=get repos/x/y/pulls -F state=open",
		"gh api -XGET repos/x/y/pulls",
	]) {
		assert.equal(classifyCommand(cmd).klass, "mutate", `expected mutate: ${cmd}`);
	}
	assert.equal(classifyCommand("gh api repos/x/y/pulls/1").klass, "read");
	assert.equal(classifyCommand("gh api --method GET repos/x/y/pulls").klass, "read");
	assert.equal(classifyCommand("gh api --method=GET repos/x/y/pulls").klass, "read");
});

test("pflag bypasses of the gh api read check are never read (both modes)", () => {
	for (const cmd of [
		// grouped short flags
		"gh api repos/o/r/pulls/1/reviews -ifbody=x",
		"gh api repos/o/r/pulls/1/reviews -iXPUT",
		"gh api repos/o/r/pulls/1/reviews -iFbody=@file",
		// a value-taking flag swallows the next word: gh sees -p="-XGET" and POSTs the field
		"gh api repos/o/r/issues/1/comments -p -XGET -f body=x",
		"gh api -H -XGET repos/o/r/issues/1/comments -f body=x",
		// another host / full URL
		"gh api --hostname evil.example repos/o/r/pulls/1",
		"gh api --hostname=evil.example repos/o/r/pulls/1",
		"gh api https://api.github.com/repos/o/r/pulls/1",
		// unknown / attached / terminator forms
		"gh api repos/o/r/pulls/1 --input body.json",
		"gh api repos/o/r/pulls/1 -q.body",
		"gh api repos/o/r/pulls/1 --paginate=true",
		"gh api -- repos/o/r/pulls/1",
		"gh api repos/o/r/pulls/1 extra",
		"gh api repos/o/r/pulls/1 --jq",
	]) {
		assert.notEqual(classifyCommand(cmd).klass, "read", `expected NOT read: ${cmd}`);
		for (const reviewMode of [true, false]) {
			const g = gateReviewCommand(cmd, { reviewMode, envoy: true });
			assert.notEqual(g.klass, "read", `expected NOT read (reviewMode=${reviewMode}): ${cmd}`);
			if (!reviewMode) assert.ok(g.blocked, `expected BLOCKED outside review mode: ${cmd}`);
		}
	}
});

test("gh api PR merge is forbidden in every mode; a GET of the merge status is a read", () => {
	for (const cmd of [
		"gh api -X PUT repos/o/r/pulls/1/merge",
		"gh api --method=PUT repos/o/r/pulls/1/merge -f merge_method=squash",
		"gh api repos/{owner}/{repo}/pulls/1/merge -f merge_method=merge",
		"gh api repos/o/r/pulls/1/merge -iXPUT",
	]) {
		assert.equal(classifyCommand(cmd).klass, "forbidden", `expected forbidden: ${cmd}`);
		for (const reviewMode of [true, false]) {
			for (const envoy of [true, false]) {
				const g = gateReviewCommand(cmd, { reviewMode, envoy });
				assert.equal(g.klass, "forbidden", `expected forbidden (reviewMode=${reviewMode}, envoy=${envoy}): ${cmd}`);
				assert.ok(g.blocked && !g.needsApproval);
			}
		}
	}
	assert.equal(classifyCommand("gh api repos/o/r/pulls/1/merge").klass, "read");
});

const GQL_READ = `gh api graphql -f query='query { repository(owner:"o",name:"r") { pullRequest(number:1) { reviewThreads(first:50) { nodes { isResolved } } } } }'`;

test("gh api graphql: read-only queries are reads; mutations and ambiguous documents are not (both modes)", () => {
	const reads = [
		GQL_READ,
		`${GQL_READ} -F number=1`,
		`gh api graphql -F number=1 -f query='query($number:Int!) { repository(owner:"o",name:"r") { pullRequest(number:$number) { title } } }'`,
		`gh api graphql -f query='{ viewer { login } }'`,
		// keywords inside strings and comments are ignored
		`gh api graphql -f query='query { search(query:"mutation subscription", type:ISSUE, first:1) { issueCount } } # mutation'`,
		`gh api graphql --raw-field query='{ viewer { login } }' --jq .data.viewer.login`,
	];
	const writes = [
		`gh api graphql -f query='mutation { addPullRequestReview(input: {}) { clientMutationId } }'`,
		`gh api graphql -f query='query { viewer { login } } mutation { x }'`,
		`gh api graphql -f query='subscription { x }'`,
		// ambiguous: not starting with { or query, a fragment first, an unterminated string
		`gh api graphql -f query='fragment F on User { login } query { viewer { ...F } }'`,
		`gh api graphql -f query='M { x }'`,
		`gh api graphql -f query='query { search(query:"x) { issueCount } }'`,
		// no query, two queries, file input, a method, grouped flags
		"gh api graphql -F number=1",
		`gh api graphql -f query='{ a }' -f query='{ b }'`,
		"gh api graphql -F query=@q.graphql",
		`gh api graphql -f query='{ viewer { login } }' -F v=@secret`,
		"gh api graphql --input q.json",
		`gh api graphql -X GET -f query='{ viewer { login } }'`,
		`gh api graphql -ifquery='{ viewer { login } }'`,
	];
	for (const reviewMode of [true, false]) {
		for (const cmd of reads) {
			const g = gateReviewCommand(cmd, { reviewMode, envoy: true });
			assert.equal(g.klass, "read", `expected read (reviewMode=${reviewMode}): ${cmd} (got: ${g.reason})`);
			assert.ok(!g.blocked && !g.needsApproval);
		}
		for (const cmd of writes) {
			const g = gateReviewCommand(cmd, { reviewMode, envoy: true });
			assert.notEqual(g.klass, "read", `expected NOT read (reviewMode=${reviewMode}): ${cmd}`);
			assert.ok(g.blocked && !g.needsApproval, `expected BLOCKED (reviewMode=${reviewMode}): ${cmd}`);
			// In review mode the existing GraphQL-write refusal applies.
			if (reviewMode) assert.match(g.reason, /review\.md/);
		}
	}
});

test("envoy git: remote/branch only in listing forms", () => {
	for (const cmd of [
		"git remote set-url origin https://evil.example/x.git",
		"git remote add evil https://evil.example/x.git",
		"git remote -v add x y",
		"git branch -D main",
		"git branch -f main HEAD~1",
		"git branch new-branch",
		"git branch --list -D x",
	]) {
		const g = gateReviewCommand(cmd, { reviewMode: true, envoy: true });
		assert.ok(g.blocked, `expected BLOCKED: ${cmd}`);
	}
	for (const cmd of [
		"git remote",
		"git remote -v",
		"git remote get-url origin",
		"git remote show origin",
		"git branch",
		"git branch --show-current",
		"git branch -a",
		"git branch -vv",
		"git branch --list 'feat/*'",
		"git branch --contains abc123",
		"git branch --merged",
		"git branch --no-merged main",
	]) {
		const g = gateReviewCommand(cmd, { reviewMode: true, envoy: true });
		assert.ok(!g.blocked && g.klass === "read", `expected ALLOWED: ${cmd} (got: ${g.reason})`);
	}
});

const ENVOY_READS = [
	"gh pr view 1957",
	"gh pr view 1957 --repo grafana/grafana-pathfinder-app --json title,body,files,reviews",
	"gh pr diff 1957",
	"gh pr diff 1957 --repo grafana/grafana-pathfinder-app",
	"gh pr checks 1957",
	"gh pr checkout 1957",
	"gh api repos/x/y/pulls/1",
	"gh api repos/{owner}/{repo}/pulls/1957/comments",
	"gh api -X GET repos/x/y/pulls/1/comments",
	`gh api repos/x/y/pulls/1/comments --jq '.[] | {path, body}'`,
	"gh api repos/{owner}/{repo}/pulls/1/comments --paginate",
	`gh api repos/{owner}/{repo}/pulls/1/comments --paginate --jq '.[] | .body'`,
	"gh api --jq=.title -H 'Accept: application/vnd.github+json' --cache 1h repos/o/r/pulls/1",
	GQL_READ,
	`${GQL_READ} -F number=1`,
	"git remote -v",
	"git branch --show-current",
	`gh pr view 1 --json reviews -q ".reviews[-1].url"`,
	"git status",
	"git log --oneline -5",
	"git diff origin/main...HEAD",
];

test("the envoy's common reads still pass, in review and acquire mode", () => {
	for (const cmd of ENVOY_READS) {
		for (const reviewMode of [true, false]) {
			const g = gateReviewCommand(cmd, { reviewMode, envoy: true });
			assert.equal(g.klass, "read", `expected read (reviewMode=${reviewMode}): ${cmd} (got: ${g.reason})`);
			assert.ok(!g.blocked && !g.needsApproval, `expected ALLOWED: ${cmd}`);
		}
	}
});

test("review-mode envoy may not post reviews or comments; the post path still may", () => {
	for (const cmd of [
		"gh pr review 1 --approve -b x",
		"gh pr review 1 --repo o/r --request-changes --body-file f",
		"gh pr comment 1 -b x",
		"gh issue comment 1 -b x",
		"gh api repos/o/r/pulls/1/reviews -f event=APPROVE",
		"gh api -X POST repos/o/r/issues/1/comments -f body=x",
		"gh api -X POST repos/o/r/pulls/1/comments/2/replies -f body=x",
		"gh api graphql -f query='mutation { addPullRequestReview(input: {}) { clientMutationId } }'",
	]) {
		const g = gateReviewCommand(cmd, { reviewMode: true, envoy: true });
		assert.ok(g.blocked, `expected BLOCKED: ${cmd}`);
		assert.equal(g.needsApproval, false, `must not even ask for approval: ${cmd}`);
		assert.match(g.reason, /review\.md/);
		assert.match(g.reason, /\/approve/);
	}
	// postReview's own gate (not the envoy) still allows the confirmed post to proceed.
	const post = gateReviewCommand("gh pr review 1 --repo o/r --approve", { reviewMode: true });
	assert.ok(!post.blocked && post.needsApproval);
});

test("the review-mode envoy shell tool refuses gh pr review without asking for approval", async () => {
	const approvals: any = {
		request: async () => assert.fail("envoy must not request approval to post"),
		ask: async () => assert.fail("envoy must not request approval to post"),
	};
	const tool = createEnvoyShellTool({ cwd: mockCtx.cwd, reviewMode: true, approvals, questId: "q" });
	const result = await tool.execute("t", { command: "gh pr review 1 --approve -b x" }, undefined, undefined, mockCtx);
	const text = (result.content[0] as any).text as string;
	assert.match(text, /^BLOCKED/);
	assert.match(text, /review\.md/);

	const chained = await tool.execute("t", { command: "gh pr view 1; gh pr review 1 --approve -b x" }, undefined, undefined, mockCtx);
	assert.match((chained.content[0] as any).text, /^BLOCKED/);
});

test("parsePrTarget accepts the supported forms", () => {
	assert.deepEqual(parsePrTarget("1957"), { number: "1957" });
	assert.deepEqual(parsePrTarget("#1957"), { number: "1957" });
	assert.deepEqual(parsePrTarget("grafana/grafana-pathfinder-app#1957"), { slug: "grafana/grafana-pathfinder-app", number: "1957" });
	assert.deepEqual(parsePrTarget("https://github.com/grafana/grafana-pathfinder-app/pull/1957"), {
		slug: "grafana/grafana-pathfinder-app",
		number: "1957",
	});
});

test("parsePrTarget rejects an injected slug and a non-numeric number", () => {
	assert.throws(() => parsePrTarget("https://github.com/a$(touch x)/b/pull/1"), /Invalid PR target.*slug/s);
	assert.throws(() => parsePrTarget("o$(id)/r#1"), /Invalid PR target.*slug/s);
	assert.throws(() => parsePrTarget("o/r;id#1"), /Invalid PR target/);
	assert.throws(() => parsePrTarget("1; gh pr review 1 --approve"), /Invalid PR target.*number/s);
	assert.throws(() => parsePrTarget("abc"), /Invalid PR number/);
});

test("buildReviewArgs builds a shell-free argv and validates the target", () => {
	assert.deepEqual(buildReviewArgs({ number: "12", slug: "o/r", verdict: "request-changes", bodyFile: "/t/body.md" }), [
		"pr",
		"review",
		"12",
		"--repo",
		"o/r",
		"--request-changes",
		"--body-file",
		"/t/body.md",
	]);
	assert.deepEqual(buildReviewArgs({ number: "12", verdict: "approve", bodyFile: "f" }), ["pr", "review", "12", "--approve", "--body-file", "f"]);
	assert.throws(() => buildReviewArgs({ number: "1;id", verdict: "approve", bodyFile: "f" }), /Invalid PR number/);
	assert.throws(() => buildReviewArgs({ number: "1", slug: "o/$(id)", verdict: "approve", bodyFile: "f" }), /Invalid repo slug/);
});

test("postReview execs gh with an argv (no shell), via a private 0600 body file it cleans up", () => {
	const calls: { file: string; args: string[]; body?: string; mode?: number }[] = [];
	const exec: ExecFile = (file, args) => {
		const i = args.indexOf("--body-file");
		if (i === -1) {
			calls.push({ file, args });
			return "https://github.com/o/r/pull/12#pullrequestreview-1\n";
		}
		const bodyFile = args[i + 1];
		calls.push({ file, args, body: fs.readFileSync(bodyFile, "utf-8"), mode: fs.statSync(bodyFile).mode & 0o777 });
		return "";
	};
	const res = postReview({ cwd: process.cwd(), number: "12", slug: "o/r", verdict: "comment", body: "hello $(id) `x`", exec });
	assert.equal(res.error, undefined);
	assert.equal(res.url, "https://github.com/o/r/pull/12#pullrequestreview-1");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].file, "gh");
	assert.deepEqual(calls[0].args.slice(0, 6), ["pr", "review", "12", "--repo", "o/r", "--comment"]);
	assert.equal(calls[0].body, "hello $(id) `x`");
	if (process.platform !== "win32") assert.equal(calls[0].mode, 0o600);
	const bodyFile = calls[0].args[calls[0].args.indexOf("--body-file") + 1];
	assert.ok(!fs.existsSync(bodyFile), "body file removed");
	assert.ok(!fs.existsSync(bodyFile.slice(0, bodyFile.lastIndexOf("/"))), "private temp dir removed");
	assert.deepEqual(calls[1], { file: "gh", args: ["pr", "view", "12", "--repo", "o/r", "--json", "reviews", "-q", ".reviews[-1].url"] });
});

test("postReview refuses an invalid target before running anything", () => {
	const exec: ExecFile = () => assert.fail("must not exec");
	assert.match(postReview({ cwd: process.cwd(), number: "1 --approve", verdict: "comment", body: "x", exec }).error ?? "", /Invalid PR number/);
	assert.match(postReview({ cwd: process.cwd(), number: "1", slug: "o/r x", verdict: "comment", body: "x", exec }).error ?? "", /Invalid repo slug/);
});
