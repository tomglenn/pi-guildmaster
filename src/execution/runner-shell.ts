/**
 * The runner's bounded shell (§8).
 *
 * The exec tier (Runner) does NOT get the raw `bash` tool. It gets this instead,
 * for the same structural reason the envoy gets a gated shell: a runner that
 * starts a non-terminating process (a `--watch`, a dev server, a pager) wedges
 * the whole Quest — the child session blocks forever on a command that never
 * returns, and with no turn/time budget nothing reaps it.
 *
 * Two controls, neither a fixed wall-clock cap (genuine builds/tests can run for
 * many minutes):
 *   1. Refuse known non-terminating commands up front, pointing at the one-shot
 *      form (e.g. `jest --watchAll=false`).
 *   2. An INACTIVITY watchdog: kill a command that produces no output for a long
 *      stretch. A build streaming progress survives; a silently hung process does not.
 */

import { spawn, execSync } from "node:child_process";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { gateRunnerCommand } from "./policy.ts";

/** Default: kill after this long with NO output at all (not a total-runtime cap). */
const DEFAULT_INACTIVITY_MS = 300_000;
/** Generous absolute backstop: catches a command that STREAMS output forever (e.g. a
 * server that logs continuously), which the inactivity watchdog alone never reaps.
 * Set high enough not to kill legitimate long builds/tests. */
const DEFAULT_MAX_TOTAL_MS = 1_800_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
/** Grace period for SIGTERM → SIGKILL escalation on Unix. */
const GRACE_PERIOD_MS = 5000;
/** Minimum inactivity timeout (10 seconds). */
const MIN_INACTIVITY_MS = 10_000;
/** Minimum total timeout (30 seconds). */
const MIN_MAX_TOTAL_MS = 30_000;

type TerminationReason = "inactivity" | "totalTimeout" | "abort" | null;

/**
 * Clamp shell config values to safe minimums so a caller cannot set a watchdog
 * so tight it reaps a legitimate build/test.
 *
 * `allowSubMinimumTimeouts` exists ONLY for this module's own tests: it lets them
 * exercise the timeout/inactivity/kill paths at sub-second durations instead of
 * waiting out the real 10s/30s floors, which turned the suite into ~40s of pure
 * sleeping. It must never be set by production callers — hence the ugly name.
 */
function clampShellConfig(
	config: { inactivityMs?: number; maxTotalMs?: number; maxOutputBytes?: number },
	allowSubMinimumTimeouts = false,
): {
	inactivityMs: number;
	maxTotalMs: number;
	maxOutputBytes: number;
} {
	const minInactivity = allowSubMinimumTimeouts ? 1 : MIN_INACTIVITY_MS;
	const minTotal = allowSubMinimumTimeouts ? 1 : MIN_MAX_TOTAL_MS;
	return {
		inactivityMs: Math.max(config.inactivityMs ?? DEFAULT_INACTIVITY_MS, minInactivity),
		maxTotalMs: Math.max(config.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS, minTotal),
		maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
	};
}

/**
 * Kill a process tree. On Unix, sends signal to process group. On Windows, uses taskkill.
 */
function killProcessTree(pid: number, signal: NodeJS.Signals): void {
	try {
		if (process.platform === "win32") {
			// Best-effort tree kill on Windows
			if (signal === "SIGKILL") {
				try {
					execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
				} catch {
					// Fallback to simple kill
					process.kill(pid, signal);
				}
			} else {
				process.kill(pid, signal);
			}
		} else {
			// Unix: kill the process group (negative pid)
			process.kill(-pid, signal);
		}
	} catch (err: unknown) {
		// Silently ignore ESRCH (process not found) and EPERM (permission denied)
		const code = (err as { code?: string }).code;
		if (code !== "ESRCH" && code !== "EPERM") {
			// Unexpected error, but don't crash
		}
	}
}

/**
 * Classify a command as non-terminating. Returns a one-shot hint if it must be
 * refused, else undefined. Deliberately conservative: it targets unambiguous
 * watch modes / servers / pagers, so ordinary builds and tests pass through.
 */
export function nonTerminatingHint(command: string): string | undefined {
	const c = command.toLowerCase();
	if (/--watch\b/.test(c) && !/--watch=false\b/.test(c)) return "drop --watch (e.g. `jest --watchAll=false`, `tsc --noEmit`)";
	if (/--watchall\b/.test(c) && !/--watchall=false\b/.test(c)) return "use `--watchAll=false`";
	if (/\bvitest\b/.test(c) && !/\bvitest\s+run\b/.test(c) && !/--run\b/.test(c)) return "use `vitest run`";
	if (/\b(npm|pnpm|yarn)\s+(run\s+)?(dev|start|serve|watch)\b/.test(c)) return "dev/watch scripts do not terminate; use a one-shot build/test script";
	if (/\b(vite|nodemon|http-server|serve|webpack-dev-server)\b/.test(c)) return "this starts a long-running server";
	if (/\bwebpack\s+serve\b/.test(c)) return "`webpack serve` is a dev server; build without `serve`";
	if (/\b(next|nuxt|astro|remix|gatsby)\s+dev\b/.test(c)) return "framework dev servers do not terminate";
	if (/\bdocker(\s+|-)compose\s+up\b/.test(c) && !/\s-d\b|--detach\b/.test(c)) return "use `docker compose up -d` (detached)";
	if (/\btail\s+-[a-z]*f/.test(c)) return "use `tail -n <N>` without -f";
	if (/^\s*(watch|less|more|top|htop|vi|vim|nano)\b/.test(c)) return "interactive/continuous command not allowed";
	return undefined;
}

interface RunnerShellResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

export function createRunnerShellTool(opts: {
	cwd: string;
	inactivityMs?: number;
	maxTotalMs?: number;
	maxOutputBytes?: number;
	/** TEST ONLY: bypass the 10s/30s watchdog floors so tests run in ~1s. Never set in production. */
	allowSubMinimumTimeouts?: boolean;
}): ToolDefinition {
	const { inactivityMs, maxTotalMs, maxOutputBytes } = clampShellConfig(opts, opts.allowSubMinimumTimeouts);
	return defineTool({
		name: "shell",
		label: "Shell (bounded)",
		description:
			"Run a BOUNDED shell command (build, test, lint, git). The command MUST terminate on its own: " +
			"watch modes, dev servers and pagers are refused — use their one-shot form (e.g. `jest --watchAll=false`, " +
			"`vitest run`, `tsc --noEmit`). A command that produces no output for a long time is treated as hung and killed.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run. Must terminate on its own." }),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
			// Policy gate first: the runner does local work only. Remote mutations
			// (git push, gh pr create/api writes) and merges are refused here so a
			// party can never push or open a PR out of band, bypassing the gated raise.
			const gate = gateRunnerCommand(params.command);
			if (gate.blocked) {
				return {
					content: [{ type: "text", text: `REFUSED: "${params.command}" — ${gate.reason}. Command not run.` }],
					details: { refused: true, blocked: true, operation: gate.operation },
				};
			}
			const hint = nonTerminatingHint(params.command);
			if (hint) {
				return {
					content: [{ type: "text", text: `REFUSED: "${params.command}" looks non-terminating. ${hint}. Command not run.` }],
					details: { refused: true },
				};
			}
			return await new Promise<RunnerShellResult>((resolve) => {
				const spawnOpts = {
					cwd: opts.cwd,
					shell: true,
					stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
					detached: process.platform !== "win32",
					env: { ...process.env, CI: "true" },
				};
				const child = spawn(params.command, [], spawnOpts);

				let out = "";
				let terminationReason: TerminationReason = null;
				let exitCode: number | null = null;
				let settled = false;
				let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
				let totalTimer: ReturnType<typeof setTimeout> | undefined;
				let graceTimer: ReturnType<typeof setTimeout> | undefined;
				let drainTimer: ReturnType<typeof setTimeout> | undefined;
				let forceResolveTimer: ReturnType<typeof setTimeout> | undefined;

				/** Clear every timer and stdio listener. Safe to call repeatedly. */
				const cleanup = () => {
					if (inactivityTimer) clearTimeout(inactivityTimer);
					if (totalTimer) clearTimeout(totalTimer);
					if (graceTimer) clearTimeout(graceTimer);
					if (drainTimer) clearTimeout(drainTimer);
					if (forceResolveTimer) clearTimeout(forceResolveTimer);
					signal?.removeEventListener("abort", onAbort);
					child.stdout?.removeAllListeners("data");
					child.stderr?.removeAllListeners("data");
				};

				/**
				 * Resolve exactly once and stop caring about the child's stdio.
				 *
				 * Crucially this does NOT wait for the stdout/stderr pipes to reach EOF.
				 * A descendant that escaped our process group (called setsid / was spawned
				 * detached — e.g. an esbuild or vitest worker, or one of this repo's own
				 * runner-shell test fixtures) inherits and can hold the write end of the
				 * pipe open indefinitely. A `close`-gated resolve therefore hangs the
				 * Runner forever, and a process-group kill can never reach the escapee.
				 * We finalize on the direct child's `exit` (or a watchdog) and forcibly
				 * destroy the pipes so a leaked descendant cannot wedge the Quest.
				 */
				const finalize = () => {
					if (settled) return;
					settled = true;
					cleanup();
					try {
						child.stdout?.destroy();
						child.stderr?.destroy();
					} catch {
						// stream already gone
					}
					const body = out.slice(0, maxOutputBytes) || "(no output)";
					const killedForTotal = terminationReason === "totalTimeout";
					const killedForHang = terminationReason === "inactivity";
					const note = killedForTotal
						? `\n\n[KILLED: exceeded ${Math.round(maxTotalMs / 60000)}m total runtime — treated as non-terminating]`
						: killedForHang
							? `\n\n[KILLED: no output for ${Math.round(inactivityMs / 1000)}s — treated as hung/non-terminating]`
							: `\n\n[exit ${exitCode ?? "?"}]`;
					resolve({
						content: [{ type: "text", text: body + note }],
						details: { exitCode, killedForHang, killedForTotal, terminationReason },
					});
				};

				/** Graceful kill with SIGTERM → SIGKILL escalation. Idempotent. */
				const killGracefully = (reason: TerminationReason) => {
					if (terminationReason !== null) return; // Already terminating
					terminationReason = reason;

					if (child.pid) {
						if (process.platform === "win32") {
							// Windows: best-effort tree kill
							killProcessTree(child.pid, "SIGKILL");
						} else if (reason === "abort") {
							// Unix abort: immediate SIGKILL to process group
							killProcessTree(child.pid, "SIGKILL");
						} else {
							// Unix timeout: SIGTERM → grace period → SIGKILL
							killProcessTree(child.pid, "SIGTERM");
							graceTimer = setTimeout(() => {
								if (child.pid) killProcessTree(child.pid, "SIGKILL");
							}, GRACE_PERIOD_MS);
						}
					}

					// GUARANTEE resolution even if neither `exit` nor `close` ever fires:
					// a process-group kill cannot reach a descendant that left the group
					// (setsid/detached) and is holding the stdio pipe open. Without this the
					// Runner would wait on the child forever. This is the last line of defence.
					forceResolveTimer = setTimeout(finalize, GRACE_PERIOD_MS + 1000);
				};

				// Absolute backstop for a command that keeps streaming output but never exits.
				totalTimer = setTimeout(() => {
					killGracefully("totalTimeout");
				}, maxTotalMs);

				const bumpInactivity = () => {
					if (inactivityTimer) clearTimeout(inactivityTimer);
					inactivityTimer = setTimeout(() => {
						killGracefully("inactivity");
					}, inactivityMs);
				};

				const onData = (d: Buffer) => {
					if (out.length < maxOutputBytes) out += d.toString();
					bumpInactivity();
				};
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				const onAbort = () => killGracefully("abort");
				signal?.addEventListener("abort", onAbort, { once: true });

				bumpInactivity();

				// Resolve on the direct child's termination, NOT on stdio EOF. Once the
				// process we spawned has exited, briefly drain buffered output, then
				// finalize regardless of whether inherited pipes are still open.
				child.on("exit", (code: number | null) => {
					if (exitCode === null) exitCode = code;
					if (drainTimer) clearTimeout(drainTimer);
					drainTimer = setTimeout(finalize, 200);
				});

				// When the pipes DO close cleanly (the normal case) finalize immediately
				// with the full output rather than waiting out the drain delay.
				child.on("close", (code: number | null) => {
					if (exitCode === null) exitCode = code;
					finalize();
				});

				child.on("error", (err: Error) => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve({ content: [{ type: "text", text: `Command failed to start: ${err.message}` }], details: { error: true } });
				});
			});
		},
	});
}
