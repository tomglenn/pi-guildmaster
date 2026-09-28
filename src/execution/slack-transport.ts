/**
 * The concrete Slack transport for the Herald (the binding behind slack-fetch.ts).
 *
 * A child agent's session has no MCP access, and the pi-mcp-adapter does not expose
 * config-installed servers (like Slack) to other extensions in-process. So this
 * transport reaches Slack the same way the adapter itself does, reusing its parts:
 *
 *   1. Read the Slack server config (url + oauth) from the standard mcp.json.
 *   2. Get a valid OAuth access token via the adapter's own token flow (which
 *      refreshes as needed) — imported from its COMPILED js, resolved under the pi
 *      agent dir so there is no hard build-time dependency.
 *   3. Open a short-lived MCP client (official SDK, Streamable HTTP) with that
 *      bearer token and forward the single read call.
 *
 * Everything here is READ-ONLY by construction: the Herald tool gates the tool name
 * against an allowlist before this fetcher is ever called, AND the Slack server as
 * configured excludes every write tool. This is belt and suspenders.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SlackFetcher } from "./slack-tool.ts";

interface SlackServerConfig {
	url: string;
	oauth?: unknown;
	headers?: unknown;
}

/** Locate the Slack MCP server config from the standard mcp.json search paths. */
function loadSlackServerConfig(): SlackServerConfig | undefined {
	const candidates = [
		path.join(homedir(), ".config", "mcp", "mcp.json"),
		path.join(getAgentDir(), "mcp.json"),
		path.join(homedir(), ".agents", "mcp.json"),
	];
	for (const p of candidates) {
		try {
			const parsed = JSON.parse(readFileSync(p, "utf8")) as { mcpServers?: Record<string, SlackServerConfig> };
			const slack = parsed?.mcpServers?.slack;
			if (slack?.url) return slack;
		} catch {
			/* try next candidate */
		}
	}
	return undefined;
}

/** Absolute path to a module inside the pi agent's npm node_modules. */
function agentModule(...segments: string[]): string {
	return pathToFileURL(path.join(getAgentDir(), "npm", "node_modules", ...segments)).href;
}

/** Extract the text blocks from an MCP tool result into a single string. */
function textFromResult(res: unknown): string {
	const content = (res as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
	const text = content
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
	return text || JSON.stringify(res ?? null);
}

/**
 * Build the concrete Slack read fetcher. Dynamic imports keep the pi-mcp-adapter
 * and MCP SDK out of Guildmaster's build graph (they live under the pi agent dir),
 * and let the whole thing fail loudly at call time if the environment lacks them.
 */
export function createSlackMcpFetcher(): SlackFetcher {
	return async (tool, args) => {
		const cfg = loadSlackServerConfig();
		if (!cfg) {
			throw new Error("No Slack MCP server is configured (looked for mcpServers.slack in mcp.json). Install it with the mcp gateway first.");
		}

		// 1) A valid OAuth token (adapter refreshes as needed). Compiled JS, resolved at runtime.
		// biome-ignore lint: dynamic import of a runtime-resolved path is intentional.
		const authFlow: { getValidToken: (name: string, url: string, opts?: unknown) => Promise<{ accessToken?: string } | null> } = await import(
			agentModule("pi-mcp-adapter", "dist", "mcp-auth-flow.js")
		);
		const tokens = await authFlow.getValidToken("slack", cfg.url, { definition: { oauth: cfg.oauth, headers: cfg.headers } });
		if (!tokens?.accessToken) {
			throw new Error("No valid Slack OAuth token available. Authenticate the Slack MCP server (mcp auth) and retry.");
		}

		// 2) Short-lived MCP client over Streamable HTTP with the bearer token.
		// biome-ignore lint: dynamic import of a runtime-resolved path is intentional.
		const sdk: {
			Client: new (info: { name: string; version: string }, opts: { capabilities: Record<string, unknown> }) => {
				connect: (t: unknown) => Promise<void>;
				callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
				close: () => Promise<void>;
			};
			StreamableHTTPClientTransport: new (url: URL, opts: { requestInit: { headers: Record<string, string> } }) => unknown;
		} = await import(agentModule("@modelcontextprotocol", "client", "dist", "index.mjs"));

		const transport = new sdk.StreamableHTTPClientTransport(new URL(cfg.url), {
			requestInit: { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
		});
		const client = new sdk.Client({ name: "guildmaster-herald", version: "0.0.1" }, { capabilities: {} });
		await client.connect(transport);
		try {
			const res = await client.callTool({ name: tool, arguments: args });
			return textFromResult(res);
		} finally {
			await client.close().catch(() => {});
		}
	};
}
