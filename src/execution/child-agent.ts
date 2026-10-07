/**
 * Child-agent execution.
 *
 * Everything Guildmaster delegates runs as an isolated in-process Pi session
 * (§7, §15): its own in-memory history, a resource loader with NO extensions
 * (so a child cannot recursively load Guildmaster), a tool allowlist, and its
 * own model/provider (the basis for M4 diversity). Only concise results cross
 * back; the transcript is discarded on dispose.
 *
 * `runSession` is the shared core. `runChildAgent` builds a Guildmate run on top
 * of it (tier-derived tools + system prompt). The Party Leader (orchestration)
 * uses `runSession` directly with a custom `dispatch` tool.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { toolsForTier } from "../capabilities.ts";
import type { Guildmate } from "../roster.ts";

type ResolvedModel = NonNullable<ReturnType<typeof resolveCliModel>["model"]>;

export interface ChildToolCall {
	name: string;
	args: Record<string, unknown>;
}

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ChildAgentResult {
	guildmate: string;
	tier: string;
	model?: string;
	task: string;
	finalText: string;
	toolCalls: ChildToolCall[];
	lastShellResult?: { exitCode?: number; command?: string; id: string };
	usage: ChildUsage;
	stopReason?: string;
	error?: string;
}

// One shared ModelRuntime per process (auth + catalogs). Cheap to reuse.
let cachedRuntime: Promise<ModelRuntime> | undefined;
function getRuntime(): Promise<ModelRuntime> {
	cachedRuntime ??= ModelRuntime.create();
	return cachedRuntime;
}

function zeroUsage(): ChildUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim()) return part.text;
		}
	}
	return "";
}

export function collectUsage(messages: AgentMessage[]): ChildUsage {
	const usage = zeroUsage();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		usage.turns++;
		const u = msg.usage;
		if (!u) continue;
		usage.input += u.input ?? 0;
		usage.output += u.output ?? 0;
		usage.cacheRead += u.cacheRead ?? 0;
		usage.cacheWrite += u.cacheWrite ?? 0;
		usage.cost += u.cost?.total ?? 0;
		usage.contextTokens = u.totalTokens ?? usage.contextTokens;
	}
	return usage;
}

function lastShellResult(messages: AgentMessage[]): ChildAgentResult["lastShellResult"] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "toolResult" || msg.toolName !== "shell") continue;
		const details = msg.details as { exitCode?: number } | undefined;
		let command: string | undefined;
		for (let j = i - 1; j >= 0 && !command; j--) {
			const prior = messages[j];
			if (prior.role === "assistant") for (const part of prior.content) {
				if (part.type === "toolCall" && part.id === msg.toolCallId) command = String((part.arguments as { command?: string }).command ?? "");
			}
		}
		return { exitCode: details?.exitCode, command, id: msg.toolCallId };
	}
	return undefined;
}

function collectToolCalls(messages: AgentMessage[]): ChildToolCall[] {
	const calls: ChildToolCall[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "toolCall") calls.push({ name: part.name, args: (part.arguments as Record<string, unknown>) ?? {} });
		}
	}
	return calls;
}

export interface RunSessionSpec {
	cwd: string;
	systemPrompt?: string;
	/** Resolved model spec ("provider/model[:thinking]"). Undefined => default. */
	modelSpec?: string;
	tools: string[];
	customTools?: ToolDefinition[];
	promptText: string;
	signal?: AbortSignal;
	/** Called on each turn/tool/message event with the live message list. */
	onEvent?: (messages: AgentMessage[]) => void;
	/** Called for EVERY session event (including streaming deltas): a liveness signal. */
	onActivity?: (event: AgentSessionEvent) => void;
}

export interface RunSessionResult {
	messages: AgentMessage[];
	/** Resolved "provider/model" actually used, if known. */
	modelSpec?: string;
	stopReason?: string;
	error?: string;
}

/** Core: run one isolated session to completion. No turn/time budget — a run ends
 * only when the model is done, the caller cancels via `signal`, or a genuine error. */
export async function runSession(spec: RunSessionSpec): Promise<RunSessionResult> {
	const modelRuntime = await getRuntime();

	let model: ResolvedModel | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	if (spec.modelSpec) {
		const resolved = resolveCliModel({ cliModel: spec.modelSpec, modelRuntime });
		if (resolved.error || !resolved.model) {
			return {
				messages: [],
				modelSpec: spec.modelSpec,
				stopReason: "error",
				error: `Could not resolve model "${spec.modelSpec}": ${resolved.error ?? "not found or not authenticated"}`,
			};
		}
		model = resolved.model;
		thinkingLevel = resolved.thinkingLevel;
	}

	const loader = new DefaultResourceLoader({
		cwd: spec.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: spec.systemPrompt?.trim() || undefined,
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: spec.cwd,
		model: model ?? undefined,
		thinkingLevel,
		tools: spec.tools,
		customTools: spec.customTools,
		sessionManager: SessionManager.inMemory(spec.cwd),
		resourceLoader: loader,
		modelRuntime,
	});

	const usedModelSpec = model ? `${model.provider}/${model.id}` : spec.modelSpec;

	// No turn/time budget: Parties and Consults run to completion. The only early
	// endings are an explicit cancel via `signal` (stopReason "aborted") or a genuine
	// model/transport error. We just relay live events for the progress UI.
	const unsubscribe = session.subscribe((event) => {
		if (spec.onActivity) {
			try {
				spec.onActivity(event);
			} catch {
				/* a liveness hook must never break the session */
			}
		}
		if (event.type === "turn_end" || event.type === "tool_execution_end" || event.type === "message_end") {
			spec.onEvent?.(session.messages);
		}
	});

	const abort = () => void session.abort();
	if (spec.signal) {
		if (spec.signal.aborted) abort();
		else spec.signal.addEventListener("abort", abort, { once: true });
	}

	let caught: unknown;
	try {
		await session.prompt(spec.promptText);
	} catch (err) {
		caught = err;
	} finally {
		spec.signal?.removeEventListener("abort", abort);
		unsubscribe();
	}

	const messages = session.messages.slice();
	session.dispose();

	let stopReason: string | undefined;
	let error: string | undefined;
	for (const msg of messages) {
		if (msg.role === "assistant") {
			if (msg.stopReason) stopReason = msg.stopReason;
			if (msg.errorMessage) error = msg.errorMessage;
		}
	}
	if (caught) {
		error ??= caught instanceof Error ? caught.message : String(caught);
		stopReason ??= "error";
	}

	return { messages, modelSpec: usedModelSpec, stopReason, error };
}

export interface RunChildOptions {
	guildmate: Guildmate;
	task: string;
	modelSpec?: string;
	cwd: string;
	signal?: AbortSignal;
	onUpdate?: (partial: ChildAgentResult) => void;
	onActivity?: () => void;
	/** Extra custom tools (e.g. the envoy's gated shell). */
	customTools?: ToolDefinition[];
	/** Extra tool NAMES to allow alongside the tier's built-ins (the custom tools' names). */
	extraTools?: string[];
}

/**
 * Standing investigative doctrine injected into EVERY dispatched Guildmate, ahead of its
 * persona, on every Quest/Consult and in every session. This is deliberately in code (not a
 * per-persona line or per-project instruction) so it is global and cannot drift or be omitted
 * by a narrow brief. It exists to prevent anchoring: a Guildmate must review the actual work,
 * not the requester's (or the Party Leader's) characterisation of it.
 */
export const INVESTIGATIVE_DOCTRINE = [
	"## Investigative doctrine (applies no matter how the task is worded)",
	"- The task's framing is a CLAIM to verify, not an established fact. If it says \"this PR does X\", \"this is the backend part\", or \"the cause is Y\", confirm it against primary sources (the real diff, files, data) BEFORE building on it — and report plainly if the true scope or nature differs.",
	"- Establish the FULL surface first. For anything under review, enumerate every changed file/area before analysing; for any investigation, map the relevant paths before concluding. Do not confine yourself to the slice the brief emphasises.",
	"- If you examined only part of the surface, say so explicitly and lower your confidence accordingly. A partial examination that reads as confident is a failure.",
	"- Prefer evidence you gathered yourself (files opened, output observed) over the brief's summary. Cite what you actually inspected; flag what you did not. Never assert a commit's author/date/branch, or any fact you could check, without checking it.",
].join("\n");

/** Run a single Guildmate (tier-derived tools + system prompt) and shape a result. */
export async function runChildAgent(options: RunChildOptions): Promise<ChildAgentResult> {
	const { guildmate, task, modelSpec, cwd, signal, onUpdate } = options;
	const base = { guildmate: guildmate.name, tier: guildmate.tier, model: modelSpec, task };

	const shape = (r: RunSessionResult): ChildAgentResult => ({
		...base,
		model: r.modelSpec ?? modelSpec,
		finalText: lastAssistantText(r.messages),
		toolCalls: collectToolCalls(r.messages),
		lastShellResult: lastShellResult(r.messages),
		usage: collectUsage(r.messages),
		stopReason: r.stopReason,
		error: r.error,
	});

	// Prepend the standing doctrine ahead of the persona so it applies to every member,
	// regardless of persona wording or how narrowly the task was briefed.
	const systemPrompt = `${INVESTIGATIVE_DOCTRINE}\n\n${guildmate.systemPrompt}`;

	const result = await runSession({
		cwd,
		systemPrompt,
		modelSpec,
		tools: [...toolsForTier(guildmate.tier), ...(options.extraTools ?? [])],
		customTools: options.customTools,
		promptText: `Task: ${task}`,
		signal,
		onEvent: onUpdate ? (messages) => onUpdate(shape({ messages, modelSpec })) : undefined,
		onActivity: options.onActivity ? () => options.onActivity?.() : undefined,
	});

	return shape(result);
}
