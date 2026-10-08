/**
 * Operation-aware permission policy (§10).
 *
 * Command names are NOT sufficient evidence of danger. `gh pr view` is a read;
 * `gh pr merge` is a mutation (and, for Guildmaster, forbidden). This classifier
 * understands the subcommand well enough to distinguish them, so gating decisions
 * are based on the actual operation rather than the binary name.
 */

export type OpClass = "read" | "mutate" | "forbidden";

export interface OpDecision {
	klass: OpClass;
	operation: string;
	reason: string;
}

function basename(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i === -1 ? p : p.slice(i + 1);
}

// `checkout` is local-only (fetches the PR ref + switches a local branch); no remote
// mutation, so it counts as a read for gating purposes.
const GH_PR_READ = new Set(["view", "list", "checks", "diff", "status", "checkout"]);

/**
 * Read-only verbs per gh resource (besides `pr`, above). Anything not listed is
 * treated as a mutation and needs approval, so this list fails closed. `run
 * download` / `release download` only write artifacts to the local worktree.
 */
const GH_READ_VERBS: Record<string, ReadonlySet<string>> = {
	issue: new Set(["view", "list", "status"]),
	repo: new Set(["view", "list"]),
	run: new Set(["view", "list", "watch", "download"]),
	workflow: new Set(["view", "list"]),
	release: new Set(["view", "list", "download"]),
	label: new Set(["list"]),
	ruleset: new Set(["view", "list", "check"]),
	cache: new Set(["list"]),
	gist: new Set(["view", "list"]),
};

/**
 * Split ONE command into its argv words the way a POSIX shell would (whitespace
 * separates; single quotes are literal; double quotes and backslash escape), with the
 * quotes removed. Lenient: an unterminated quote runs to the end. It does NOT interpret
 * operators or expansions — {@link findShellControl} detects those.
 */
export function shellWords(command: string): string[] {
	const words: string[] = [];
	let cur = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else cur += c;
			continue;
		}
		if (c === "\\" && i + 1 < command.length) {
			cur += command[++i];
			inWord = true;
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = undefined;
			else cur += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
			continue;
		}
		if (/\s/.test(c)) {
			if (inWord) words.push(cur);
			cur = "";
			inWord = false;
			continue;
		}
		cur += c;
		inWord = true;
	}
	if (inWord) words.push(cur);
	return words;
}

/**
 * The first ACTIVE shell control operator or substitution in a command line — one that
 * is not quoted away — or undefined if there is none. Covers `;`, `&`/`&&`, `|`/`||`,
 * `<`, `>`, backticks, `$(`, newlines and an unterminated quote. Inside double quotes
 * only backticks and `$(` are active; inside single quotes nothing is.
 */
export function findShellControl(command: string): string | undefined {
	if (/[\r\n]/.test(command)) return "newline";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === "'") {
			if (c === "'") quote = undefined;
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "`") return "`";
		if (c === "$" && command[i + 1] === "(") return "$(";
		if (quote === '"') {
			if (c === '"') quote = undefined;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (";&|<>".includes(c)) {
			const two = command.slice(i, i + 2);
			return two === "&&" || two === "||" || two === ">>" ? two : c;
		}
	}
	return quote ? `unterminated ${quote}` : undefined;
}

/*
 * `gh api` READ detection is an ALLOWLIST, not a permissive re-parse of gh's flags:
 * pflag accepts grouped short flags (`-iXPUT`, `-ifbody=x`) and lets a value-taking flag
 * swallow the next word (`-p -XGET -f body=x`), so any parse that tries to be lenient can
 * be made to see GET while gh POSTs. A call is a READ only if every flag word is one of
 * the standalone read flags below (each consuming its value exactly as gh does), and
 * anything else — unknown, grouped or attached short forms, `--`, `--hostname`,
 * `--input` — makes it non-read.
 */

/** Boolean read flags; must appear as the exact word (no `=value`, no grouping). */
const GH_API_READ_BOOL = new Set(["--paginate", "--slurp", "-i", "--include", "--silent", "--verbose"]);
/** Value-taking read flags: `-q <v>` (next word, whatever it is) or `--jq=<v>`. */
const GH_API_READ_VALUE = new Set(["--cache", "-q", "--jq", "-t", "--template", "-H", "--header", "-p", "--preview"]);
/** Field flags (value `name=value`); `-F`/`--field` are typed (`@file` reads a file). */
const GH_API_FIELD: Record<string, "raw" | "typed"> = { "-f": "raw", "--raw-field": "raw", "-F": "typed", "--field": "typed" };
const GH_API_METHOD = new Set(["-X", "--method"]);

interface GhApiArgs {
	endpoint: string;
	methods: string[];
	fields: { typed: boolean; pair: string }[];
}

/** Parse `gh api` args against the allowlist; undefined when any word falls outside it. */
function parseGhApiAllowlisted(tokens: string[]): GhApiArgs | undefined {
	const positionals: string[] = [];
	const methods: string[] = [];
	const fields: { typed: boolean; pair: string }[] = [];
	for (let i = 2; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t.startsWith("-")) {
			positionals.push(t);
			continue;
		}
		if (GH_API_READ_BOOL.has(t)) continue;
		// Only long flags take the `--flag=value` form here; short attached forms are refused.
		const eq = t.startsWith("--") ? t.indexOf("=") : -1;
		const name = eq === -1 ? t : t.slice(0, eq);
		const takesValue = GH_API_READ_VALUE.has(name) || name in GH_API_FIELD || GH_API_METHOD.has(name);
		if (!takesValue) return undefined;
		let value: string;
		if (eq !== -1) value = t.slice(eq + 1);
		else {
			if (i + 1 >= tokens.length) return undefined;
			value = tokens[++i]; // pflag takes the next word unconditionally, even if it starts with "-"
		}
		if (GH_API_METHOD.has(name)) methods.push(value);
		else if (name in GH_API_FIELD) fields.push({ typed: GH_API_FIELD[name] === "typed", pair: value });
	}
	if (positionals.length !== 1) return undefined;
	return { endpoint: positionals[0], methods, fields };
}

/**
 * Is a GraphQL document read-only? After stripping comments and strings it must contain
 * no `mutation`/`subscription` keyword and begin with `{` or `query`. Anything unclear
 * (e.g. an unterminated string) counts as NOT read-only.
 */
export function isReadOnlyGraphQL(doc: string): boolean {
	let out = "";
	for (let i = 0; i < doc.length; i++) {
		const c = doc[i];
		if (c === "#") {
			while (i < doc.length && doc[i] !== "\n" && doc[i] !== "\r") i++;
			out += " ";
			continue;
		}
		if (c === '"') {
			if (doc.startsWith('"""', i)) {
				let j = i + 3;
				while (j < doc.length && !doc.startsWith('"""', j)) j += doc.startsWith('\\"""', j) ? 4 : 1;
				if (j >= doc.length) return false;
				i = j + 2;
			} else {
				let j = i + 1;
				while (j < doc.length && doc[j] !== '"') {
					if (doc[j] === "\n" || doc[j] === "\r") return false;
					j += doc[j] === "\\" ? 2 : 1;
				}
				if (j >= doc.length) return false;
				i = j;
			}
			out += " ";
			continue;
		}
		out += c;
	}
	if (/\b(?:mutation|subscription)\b/i.test(out)) return false;
	const s = out.trim();
	return s.startsWith("{") || /^query\b/.test(s);
}

/**
 * Is this `gh api` call a READ? Only when every flag is allowlisted, the endpoint is not a
 * full URL, the method is absent or exactly `GET`, and there are no field/input flags —
 * except `graphql`, where `name=value` fields (no `-F …=@file`) carrying exactly one
 * read-only `query=` document are a read. Everything else is a write.
 */
function isGhApiRead(tokens: string[]): boolean {
	const a = parseGhApiAllowlisted(tokens);
	if (!a || a.endpoint.includes("://")) return false;
	if (a.endpoint === "graphql") {
		if (a.methods.length > 0) return false;
		const pairs: { key: string; value: string }[] = [];
		for (const f of a.fields) {
			const eq = f.pair.indexOf("=");
			if (eq <= 0) return false;
			const value = f.pair.slice(eq + 1);
			if (f.typed && value.startsWith("@")) return false;
			pairs.push({ key: f.pair.slice(0, eq), value });
		}
		const queries = pairs.filter((p) => p.key === "query");
		return queries.length === 1 && isReadOnlyGraphQL(queries[0].value);
	}
	if (a.methods.length > 1 || (a.methods.length === 1 && a.methods[0] !== "GET")) return false;
	return a.fields.length === 0;
}

/** A PR merge via the REST API (`…/pulls/<n>/merge`), in any word of the call. */
const GH_API_PR_MERGE = /pulls\/\S*merge/i;

/** Classify a shell command's privilege. Unknown/non-git-gh commands are treated as read. */
export function classifyCommand(command: string): OpDecision {
	const tokens = shellWords(command.trim());
	if (tokens.length === 0) return { klass: "read", operation: "", reason: "empty command" };

	const bin = basename(tokens[0]);

	if (bin === "git") {
		const sub = tokens.find((t, i) => i > 0 && !t.startsWith("-"));
		if (sub === "push") return { klass: "mutate", operation: "git push", reason: "pushes commits to a remote" };
		return { klass: "read", operation: `git ${sub ?? ""}`.trim(), reason: "local git operation (worktree-scoped)" };
	}

	if (bin === "gh") {
		const sub = tokens[1];
		const sub2 = tokens[2];

		if (sub === "pr" && sub2 === "merge") {
			return { klass: "forbidden", operation: "gh pr merge", reason: "Guildmaster never merges; merging is the team's decision" };
		}

		const isApiRead = sub === "api" && isGhApiRead(tokens);
		const isApiWrite = sub === "api" && !isApiRead;
		if (isApiWrite && tokens.slice(2).some((t) => GH_API_PR_MERGE.test(t))) {
			return { klass: "forbidden", operation: "gh api (merge)", reason: "Guildmaster never merges; merging is the team's decision" };
		}
		const isRead =
			(sub === "pr" && GH_PR_READ.has(sub2)) ||
			(sub !== undefined && sub2 !== undefined && GH_READ_VERBS[sub]?.has(sub2) === true) ||
			sub === "search" ||
			sub === "status" ||
			isApiRead;

		if (isRead) return { klass: "read", operation: `gh ${sub} ${sub2 ?? ""}`.trim(), reason: "read-only gh query" };
		if (isApiWrite) return { klass: "mutate", operation: "gh api (write)", reason: "mutating API call" };
		return { klass: "mutate", operation: `gh ${sub ?? ""} ${sub2 ?? ""}`.trim(), reason: "gh mutation" };
	}

	return { klass: "read", operation: bin, reason: "non-privileged command" };
}

export interface ReviewGate extends OpDecision {
	/** Requires human approval before it may run (mutations in a review quest). */
	needsApproval: boolean;
	/** Hard-blocked regardless of approval (merge; suspected security fix auto-publish). */
	blocked: boolean;
}

/** Git subcommands the envoy may run: local reads only. Anything else (config, aliases,
 * `-c` overrides, fetch --upload-pack, …) could execute an arbitrary command. */
const ENVOY_GIT_READ = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "remote"]);

const notFlag = (w: string | undefined): boolean => w !== undefined && !w.startsWith("-");

/** `git remote` / `git branch` may mutate; only their listing forms are reads. */
function isEnvoyGitListing(sub: string, args: string[]): boolean {
	if (sub === "remote") {
		if (args.length === 0) return true;
		if (args.length === 1) return args[0] === "-v";
		return args.length === 2 && (args[0] === "get-url" || args[0] === "show") && notFlag(args[1]);
	}
	if (sub === "branch") {
		if (args.length === 0) return true;
		const [flag, ...rest] = args;
		if (["--show-current", "-a", "-r", "-v", "-vv"].includes(flag)) return rest.length === 0;
		if (flag === "--contains") return rest.length === 1 && notFlag(rest[0]);
		if (flag === "--list" || flag === "--merged" || flag === "--no-merged") return rest.length === 0 || (rest.length === 1 && notFlag(rest[0]));
		return false;
	}
	return true;
}

/** A PR review / comment post: `gh pr|issue review|comment`, a review/comment API write, or any GraphQL write. */
function isReviewPost(tokens: string[]): boolean {
	if (tokens[0] !== "gh") return false;
	for (let i = 1; i + 1 < tokens.length; i++) {
		if ((tokens[i] === "pr" || tokens[i] === "issue") && (tokens[i + 1] === "review" || tokens[i + 1] === "comment")) return true;
	}
	if (tokens[1] === "api" && !isGhApiRead(tokens)) {
		if (tokens.some((t) => t === "graphql")) return true; // the mutation's content cannot be inspected reliably
		if (tokens.some((t) => /(?:pulls|issues)\/.*(?:reviews|comments)/.test(t))) return true;
	}
	return false;
}

const forbid = (operation: string, reason: string): ReviewGate => ({
	klass: "forbidden",
	operation,
	reason,
	needsApproval: false,
	blocked: true,
});

/**
 * Gate a shell command for the review envoy. Reads run freely; mutations require
 * approval and are only allowed in review mode; `gh pr merge` is always blocked;
 * a suspected security fix is blocked from auto-publish so it cannot be posted
 * without explicit out-of-band confirmation (§ org policy).
 *
 * The command must be ONE plain `gh` or read-only `git` invocation: any active shell
 * operator or substitution is refused, so a mutation cannot ride behind a read
 * (`gh pr view 1; gh pr review 1 --approve`), and the caller runs the exact argv
 * classified here ({@link shellWords}) without a shell.
 *
 * `envoy`: the command comes from the envoy's own shell. In a review Quest the envoy
 * may NOT post a review or comment — posting happens only via the review.md comment
 * block and the user's /approve (postReview).
 */
export function gateReviewCommand(
	command: string,
	opts: { reviewMode: boolean; prText?: string; envoy?: boolean },
): ReviewGate {
	const ctl = findShellControl(command);
	if (ctl) {
		return forbid(
			"shell operator",
			`shell operators and substitutions (found ${ctl}) are not allowed; run exactly one gh or git command per call, without pipes, chaining, redirects or $(…)`,
		);
	}
	const tokens = shellWords(command.trim());
	const bin = tokens[0];
	if (bin !== undefined && bin !== "gh" && bin !== "git") {
		return forbid(bin, "only `gh` and read-only `git` commands may run here");
	}
	if (bin === "git" && (!ENVOY_GIT_READ.has(tokens[1] ?? "") || tokens.some((t) => t.startsWith("--output")))) {
		return forbid(
			`git ${tokens[1] ?? ""}`.trim(),
			`only read-only git subcommands (${[...ENVOY_GIT_READ].join(", ")}) may run here, with no global options before them and no --output`,
		);
	}
	if (bin === "git" && !isEnvoyGitListing(tokens[1], tokens.slice(2))) {
		return forbid(
			`git ${tokens[1]}`,
			"only listing forms may run here: `git remote` [-v | get-url <name> | show <name>], `git branch` [--show-current | -a | -r | -v | -vv | --list [pattern] | --contains <x> | --merged [x] | --no-merged [x]]",
		);
	}
	const d = classifyCommand(command);
	if (d.klass === "forbidden") return { ...d, needsApproval: false, blocked: true };
	if (d.klass === "read") return { ...d, needsApproval: false, blocked: false };
	if (opts.envoy && opts.reviewMode && isReviewPost(tokens)) {
		return forbid(
			d.operation,
			"the envoy never posts reviews or comments: the review is posted only from the review.md comment block when the user runs /approve",
		);
	}
	// mutate:
	if (!opts.reviewMode) {
		return { ...d, reason: "mutations are only allowed inside a PR-review quest", needsApproval: false, blocked: true };
	}
	if (opts.prText && isLikelySecurityFix(opts.prText)) {
		return { ...d, reason: "suspected security fix — must be confirmed out of band before posting", needsApproval: false, blocked: true };
	}
	return { ...d, needsApproval: true, blocked: false };
}

/**
 * Split a command line into the sub-commands joined by shell operators (&& || ; |),
 * so a chained line like `npm test && git push` is classified segment-by-segment
 * and a mutation cannot ride in on the back of an innocent first token.
 */
function splitShellSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\|/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export interface RunnerGate {
	/** Hard-refused: the runner may not run this command at all. */
	blocked: boolean;
	operation?: string;
	reason?: string;
}

/**
 * Gate a shell command for the write-Quest runner (exec tier).
 *
 * The runner does LOCAL work only — build, test, lint, and worktree-scoped git
 * (add/commit/branch/checkout). Every remote mutation is refused: `git push`,
 * `gh pr create`, mutating `gh api` calls, and (always) `gh pr merge`. Pushing a
 * branch and opening a draft PR is the job of the dedicated raise path, never a
 * runner acting mid-Quest — that is exactly the hole that let a party open a PR
 * out of band. Reads pass freely; so does all local git.
 */
/**
 * Git commands that run a nested command with GIT_DIR exported to it:
 * `git rebase --exec/-x` and `git bisect run`. In a linked worktree GIT_DIR points
 * into the MAIN repo's .git/worktrees/<name>, so a test suite run this way sends
 * every `git config` / `git init` its fixtures make in temp dirs to the user's real
 * repo (that is how a quest set core.bare=true on the user's checkout). Returns the
 * operation name, or undefined.
 */
export function gitNestedExec(command: string): string | undefined {
	const t = shellWords(command.trim());
	if (basename(t[0] ?? "") !== "git") return undefined;
	const subIdx = t.findIndex((w, i) => i > 0 && !w.startsWith("-"));
	const sub = t[subIdx];
	const rest = t.slice(subIdx + 1);
	if (sub === "rebase" && rest.some((w) => w === "--exec" || w.startsWith("--exec=") || /^-[A-Za-z]*x/.test(w))) {
		return "git rebase --exec";
	}
	if (sub === "bisect" && rest[0] === "run") return "git bisect run";
	return undefined;
}

export function gateRunnerCommand(command: string): RunnerGate {
	for (const seg of splitShellSegments(command)) {
		const nested = gitNestedExec(seg);
		if (nested) {
			return {
				blocked: true,
				operation: nested,
				reason: `${nested} exports GIT_DIR to the command it runs, which makes test fixtures write to the user's real repo; check out each commit and run the command directly instead`,
			};
		}
		const d = classifyCommand(seg);
		if (d.klass === "forbidden") {
			return { blocked: true, operation: d.operation, reason: d.reason };
		}
		if (d.klass === "mutate") {
			const reason =
				d.operation === "git push"
					? "the runner never pushes; a completed write-Quest is pushed and opened as a draft PR via the raise_pr path"
					: `${d.operation} is a remote mutation and is not allowed from a runner`;
			return { blocked: true, operation: d.operation, reason };
		}
	}
	return { blocked: false };
}

// Heuristic only. Errs toward flagging so a security fix is not auto-published (§ org policy).
const SECURITY_SIGNALS =
	/\b(cve-\d|vulnerabilit|security fix|security patch|exploit|xss|csrf|\bssrf\b|\brce\b|sql injection|auth(?:entication|orization)?\s+bypass|privilege escalation|path traversal|secret leak|hardcoded (?:secret|password|token))\b/i;

export function isLikelySecurityFix(text: string): boolean {
	return SECURITY_SIGNALS.test(text);
}

/** Extract an "owner/repo" slug from a GitHub remote URL, if present. */
export function repoSlugFromRemote(remoteUrl: string): string | undefined {
	const m = remoteUrl.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
	return m ? m[1] : undefined;
}
