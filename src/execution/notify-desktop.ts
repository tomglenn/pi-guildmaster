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

/** Fire a native desktop notification. Never throws. */
export function desktopNotify(title: string, message: string): void {
	try {
		const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
		const t = clip(title, 120);
		const m = clip(message.replace(/\s+/g, " ").trim(), 240);
		if (process.platform === "darwin") {
			const script = `display notification ${osaQuote(m)} with title ${osaQuote("Guildmaster")} subtitle ${osaQuote(t)}`;
			spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();
		} else if (process.platform === "linux") {
			spawn("notify-send", ["Guildmaster", `${t}\n${m}`], { stdio: "ignore", detached: true }).unref();
		}
	} catch {
		/* best effort — a missed notification is never fatal */
	}
}
