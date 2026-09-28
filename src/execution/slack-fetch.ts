/**
 * Binding point for the Herald's Slack transport.
 *
 * A Quest party runs in the extension host, but a child agent's session has no MCP
 * access (noExtensions: true), so the Herald's gated `slack` tool cannot call the
 * Slack MCP server directly. The extension binds a concrete SlackFetcher here at
 * startup (index.ts), and the Quest layer reads it back via getSlackFetcher().
 *
 * Until a transport is bound, getSlackFetcher() returns UNBOUND_SLACK_FETCHER,
 * which fails loudly rather than pretending Slack was reachable. This keeps the
 * whole Herald path type-safe and wired end-to-end; lighting it up is a matter of
 * binding a real fetcher (e.g. one that forwards read-only calls to the Slack MCP
 * server) — the one remaining transport seam.
 */

import { type SlackFetcher, UNBOUND_SLACK_FETCHER } from "./slack-tool.ts";

let bound: SlackFetcher | undefined;

/** Bind the concrete Slack transport (called once from the extension boundary). */
export function bindSlackFetcher(fetcher: SlackFetcher): void {
	bound = fetcher;
}

/** The bound Slack transport, or a loudly-failing stub when none is bound yet. */
export function getSlackFetcher(): SlackFetcher {
	return bound ?? UNBOUND_SLACK_FETCHER;
}

/** True once a real transport has been bound. */
export function isSlackBound(): boolean {
	return bound !== undefined;
}
