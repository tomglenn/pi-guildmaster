/**
 * Native TUI rendering helpers.
 *
 * Guildmaster surfaces information as durable transcript cards (§12) rather than
 * flooding the conversation. Cards are `pi.appendEntry` custom entries (they do
 * NOT enter the LLM context) rendered by a registered entry renderer.
 *
 * This module owns one generic "info card" renderer used by the read-only status
 * commands. Party/Quest live-status widgets are added in later milestones.
 */

import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

export const INFO_CARD_ENTRY = "guildmaster-info";

/** A single line in a card. `color` names a theme foreground colour. */
export interface CardLine {
	text: string;
	color?: ThemeColor;
	bold?: boolean;
	indent?: number;
}

export interface InfoCardData {
	title: string;
	lines: CardLine[];
}

/** Register the info-card entry renderer. Call once during extension load. */
export function registerInfoCard(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(INFO_CARD_ENTRY, (entry, _opts, theme) => {
		const data = entry.data as InfoCardData;
		const container = new Container();
		container.addChild(new Text(theme.fg("toolTitle", theme.bold(`◇ ${data.title}`)), 0, 0));
		for (const line of data.lines) {
			const pad = " ".repeat(Math.max(0, line.indent ?? 0));
			let body = line.bold ? theme.bold(line.text) : line.text;
			if (line.color) body = theme.fg(line.color, body);
			container.addChild(new Text(pad + body, 0, 0));
		}
		return container;
	});
}

/** Append an info card to the transcript. */
export function showCard(pi: ExtensionAPI, data: InfoCardData): void {
	pi.appendEntry(INFO_CARD_ENTRY, data);
}
