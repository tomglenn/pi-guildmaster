/**
 * The Herald's gated Slack reader (mirrors the envoy's gated GitHub shell in gh-tool.ts).
 *
 * This is the ONLY door between a Party and Slack. A Herald guildmate never gets
 * the raw MCP tools (child agents run with `noExtensions: true`, so no `slack_*`
 * tools exist in their session at all). Instead the orchestration injects THIS
 * single custom tool, whose every call is checked against a READ-ONLY allowlist
 * before it is forwarded to Slack:
 *
 *   - read      (slack_read_channel, slack_search_*, slack_read_thread, …) → runs
 *   - anything else (send_message, *_draft, *_canvas, add_reaction, file upload) → refused
 *
 * The Slack MCP server itself is NOT read-only — it exposes message/canvas/file
 * write tools too — so the allowlist here is the security boundary, not the server.
 * A Herald carries messages in; it never writes them back.
 *
 * The actual transport to Slack is injected as a `SlackFetcher`. Child agents
 * cannot reach MCP, but this tool's `execute` runs in the extension host, so the
 * fetcher is supplied at the party boundary (see party-leader.ts / runParty).
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The Slack read tools a Herald may call. Everything not on this list is refused,
 * including every mutating Slack tool (slack_send_message, slack_send_message_draft,
 * slack_create_canvas, slack_update_canvas, slack_add_reaction, slack_get_file_upload_url,
 * slack_complete_file_upload). Keep this list read-only.
 */
export const HERALD_READ_TOOLS: readonly string[] = [
	"slack_read_channel",
	"slack_read_thread",
	"slack_read_user_profile",
	"slack_read_canvas",
	"slack_read_file",
	"slack_read_list",
	"slack_list_channel_members",
	"slack_list_user_channels",
	"slack_search_public",
	"slack_search_channels",
	"slack_search_users",
	"slack_search_emojis",
	"slack_get_reactions",
];

/** True only for Slack tools on the read-only allowlist. */
export function isHeraldReadTool(tool: string): boolean {
	return HERALD_READ_TOOLS.includes(tool);
}

/**
 * Transport that actually forwards a read-only Slack MCP call and returns text.
 * Injected at the party boundary because a child agent's session has no MCP access.
 * Implementations MUST NOT be able to reach a mutating Slack tool — the tool below
 * gates the name before calling, but a fetcher should also be scoped to reads.
 */
export type SlackFetcher = (tool: string, args: Record<string, unknown>) => Promise<string>;

/** A fetcher that is not wired to a transport yet. Fails loudly rather than pretending. */
export const UNBOUND_SLACK_FETCHER: SlackFetcher = async () => {
	throw new Error(
		"Slack transport is not bound in this environment: the Herald has no way to reach the Slack MCP server. " +
			"Bind a SlackFetcher at the party boundary (runParty → createHeraldSlackTool) to enable Slack reads.",
	);
};

export function createHeraldSlackTool(opts: { fetch: SlackFetcher }): ToolDefinition {
	return defineTool({
		name: "slack",
		label: "Slack (read-only)",
		description:
			"Read from Slack as the party's Herald. READ-ONLY: you may call read/search tools " +
			`(${HERALD_READ_TOOLS.join(", ")}). Any attempt to post, reply, react, draft, upload, or edit a ` +
			"canvas is refused — a Herald carries messages in, never out. Pass the Slack tool name and its arguments.",
		parameters: Type.Object({
			tool: Type.String({ description: `The Slack read tool to call, e.g. "slack_read_channel". One of: ${HERALD_READ_TOOLS.join(", ")}.` }),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for the Slack tool (e.g. { channel_id, limit })." })),
		}),
		execute: async (_toolCallId, params) => {
			const tool = params.tool?.trim();
			if (!tool) {
				return { content: [{ type: "text", text: "BLOCKED: no Slack tool named. Nothing called." }], details: {} };
			}
			if (!isHeraldReadTool(tool)) {
				return {
					content: [
						{
							type: "text",
							text:
								`BLOCKED (write-or-unknown): "${tool}" is not a Herald read tool and was not called. ` +
								`A Herald is read-only. Allowed: ${HERALD_READ_TOOLS.join(", ")}.`,
						},
					],
					details: {},
				};
			}
			try {
				const out = await opts.fetch(tool, (params.args as Record<string, unknown>) ?? {});
				return { content: [{ type: "text", text: out.slice(0, 40_000) || "(no output)" }], details: {} };
			} catch (err) {
				const e = err as { message?: string };
				return { content: [{ type: "text", text: `Slack read failed: ${e.message ?? String(err)}` }], details: {} };
			}
		},
	});
}
