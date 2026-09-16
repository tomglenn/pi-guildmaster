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

import { spawn } from "node:child_process";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Default: kill after this long with NO output at all (not a total-runtime cap). */
const DEFAULT_INACTIVITY_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;

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

export function createRunnerShellTool(opts: { cwd: string; inactivityMs?: number; maxOutputBytes?: number }): ToolDefinition {
	const inactivityMs = opts.inactivityMs ?? DEFAULT_INACTIVITY_MS;
	const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
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
		execute: async (_toolCallId, params, signal) => {
			const hint = nonTerminatingHint(params.command);
			if (hint) {
				return {
					content: [{ type: "text", text: `REFUSED: "${params.command}" looks non-terminating. ${hint}. Command not run.` }],
					details: { refused: true },
				};
			}
			return await new Promise<RunnerShellResult>((resolve) => {
				const child = spawn(params.command, { cwd: opts.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
				let out = "";
				let killedForHang = false;
				let timer: ReturnType<typeof setTimeout> | undefined;

				const bump = () => {
					if (timer) clearTimeout(timer);
					timer = setTimeout(() => {
						killedForHang = true;
						child.kill("SIGKILL");
					}, inactivityMs);
				};
				const onData = (d: Buffer) => {
					if (out.length < maxOutputBytes) out += d.toString();
					bump();
				};
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				const onAbort = () => child.kill("SIGKILL");
				signal?.addEventListener("abort", onAbort, { once: true });

				bump();
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					const body = out.slice(0, maxOutputBytes) || "(no output)";
					const note = killedForHang
						? `\n\n[KILLED: no output for ${Math.round(inactivityMs / 1000)}s — treated as hung/non-terminating]`
						: `\n\n[exit ${code ?? "?"}]`;
					resolve({ content: [{ type: "text", text: body + note }], details: { exitCode: code, killedForHang } });
				});
				child.on("error", (err) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve({ content: [{ type: "text", text: `Command failed to start: ${err.message}` }], details: { error: true } });
				});
			});
		},
	});
}
