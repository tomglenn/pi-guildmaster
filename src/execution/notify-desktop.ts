/**
 * Best-effort desktop notifications.
 *
 * When a background party parks a request for the user, it surfaces in the
 * terminal inbox (status board + /inbox). But the user is often elsewhere, so we
 * ALSO fire a native desktop notification — deliberately NOT a browser window
 * that ambushes them. Entirely best-effort: any failure (no binary, wrong OS,
 * spawn error) is swallowed, because a missed notification must never break a
 * Quest. The terminal inbox remains the source of truth.
 */

import { spawn } from "node:child_process";

/** Quote a string for an AppleScript string literal. */
function osaQuote(s: string): string {
	return `"${s.replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Build the native notification command for a platform, or `undefined` if the
 * platform has none. This is pure, so tests can check the quoting without
 * showing a real notification.
 */
export function buildNotifyCommand(
	title: string,
	message: string,
	platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } | undefined {
	const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
	const t = clip(title, 120);
	const m = clip(message.replace(/\s+/g, " ").trim(), 240);
	if (platform === "darwin") {
		return { cmd: "osascript", args: ["-e", `display notification ${osaQuote(m)} with title ${osaQuote("Guildmaster")} subtitle ${osaQuote(t)}`] };
	}
	if (platform === "linux") return { cmd: "notify-send", args: ["Guildmaster", `${t}\n${m}`] };
	return undefined;
}

/**
 * Desktop notifications are off inside the test runner. `node --test` sets
 * NODE_TEST_CONTEXT in the processes it runs, so test runs never show real
 * notifications. Set GUILDMASTER_DESKTOP_NOTIFY=0 to turn them off anywhere.
 */
export function desktopNotifySuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.NODE_TEST_CONTEXT !== undefined || env.GUILDMASTER_DESKTOP_NOTIFY === "0";
}

/** Fire a native desktop notification. Never throws. */
export function desktopNotify(title: string, message: string): void {
	if (desktopNotifySuppressed()) return;
	try {
		const c = buildNotifyCommand(title, message);
		if (c) spawn(c.cmd, c.args, { stdio: "ignore", detached: true }).unref();
	} catch {
		/* best effort — a missed notification is never fatal */
	}
}
