/**
 * Shared sanitization utilities for display and label safety.
 *
 * Extracted as a standalone module to avoid import cycles:
 * review-viewer.ts imports ui.ts (showCard), so ui.ts cannot import review-viewer.ts.
 * status.ts and ui.ts both import this module directly.
 * review-viewer.ts also imports this module and re-exports the symbols for backward compat.
 */

// ---------------------------------------------------------------------------
// hasUnsafeChars
// ---------------------------------------------------------------------------

/**
 * Return true if `text` contains characters unsafe to post as a PR review:
 * raw ESC / C0 controls (excl. \n \r \t), C1 controls, bidi override/embedding
 * controls, Unicode tag characters, zero-width non-printing chars (excluding ZWJ),
 * variation selectors (except U+FE0E / U+FE0F), invisible operator/format chars,
 * and Hangul filler codepoints.
 *
 * Does NOT flag U+200D (ZWJ, used in emoji).
 * Does NOT flag U+FE0E / U+FE0F (emoji/text presentation selectors, harmless).
 */
export function hasUnsafeChars(text: string): boolean {
	// C0 controls (except \n, \r, \t), DEL, C1 controls, ESC
	if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u0080-\u009F]/.test(text)) return true;
	// Bidi controls: LRM U+200E, RLM U+200F, ALM U+061C, LRE/RLE/PDF/LRO/RLO U+202A-202E, LRI/RLI/FSI/PDI U+2066-2069
	if (/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/.test(text)) return true;
	// Zero-width non-printing chars (NOT ZWJ U+200D): ZWSP U+200B, ZWNJ U+200C, WJ U+2060, BOM/ZWNBS U+FEFF
	if (/[\u200B\u200C\u2060\uFEFF]/.test(text)) return true;
	// Unicode tag characters U+E0000-U+E007F (surrogate pairs in JS: DB40 DC00 - DB40 DC7F)
	if (/\uDB40[\uDC00-\uDC7F]/.test(text)) return true;

	// --- New ranges (Issue 3) ---

	// Soft hyphen U+00AD (invisible in most renderers)
	if (/\u00AD/.test(text)) return true;
	// Combining grapheme joiner U+034F
	if (/\u034F/.test(text)) return true;
	// Mongolian vowel separator U+180E
	if (/\u180E/.test(text)) return true;
	// Invisible math operators U+2061–U+2064
	if (/[\u2061-\u2064]/.test(text)) return true;
	// Deprecated format characters U+206A–U+206F (inhibit/enable symmetric swapping, etc.)
	if (/[\u206A-\u206F]/.test(text)) return true;
	// Interlinear annotation U+FFF9–U+FFFB
	if (/[\uFFF9-\uFFFB]/.test(text)) return true;
	// Hangul fillers: U+115F, U+1160, U+3164, U+FFA0
	if (/[\u115F\u1160\u3164\uFFA0]/.test(text)) return true;
	// Variation selectors U+FE00–U+FE0D (keep U+FE0E text-VS and U+FE0F emoji-VS)
	if (/[\uFE00-\uFE0D]/.test(text)) return true;
	// Variation Selectors Supplement U+E0100–U+E01EF
	// Surrogate pair range: U+E0100 = DB40 DD00, U+E01EF = DB40 DDEF
	if (/\uDB40[\uDD00-\uDDEF]/.test(text)) return true;

	return false;
}

// ---------------------------------------------------------------------------
// sanitizeForDisplay
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for display in TUI components.
 *
 * Replaces ONLY the unsafe code points with visible placeholders — all following text
 * remains visible (no sequence payload consumption). This is intentional: an
 * unterminated OSC/CSI/etc. must not hide the rest of the document.
 *
 *   - ESC (0x1B) → `\u241B` (␛ symbol); the bytes that follow are NOT consumed
 *   - C0 controls except \n, \t, \r → `\u2408` (BS glyph, generic placeholder)
 *   - DEL (0x7F) → `\u2421` (DEL symbol)
 *   - C1 controls U+0080–U+009F → U+FFFD (replacement character)
 *   - Bidi controls (U+200E, U+200F, U+061C, U+202A–U+202E, U+2066–U+2069) → U+FFFD
 *   - Zero-width non-printing chars (U+200B, U+200C, U+2060, U+FEFF; NOT U+200D ZWJ) → U+FFFD
 *   - Unicode tag chars (U+E0000–U+E007F, surrogate pairs) → U+FFFD
 *   - \r / \r\n → \n (CRLF normalization)
 *   - \t → 4 spaces (layout expansion)
 *   - New (Issue 3): U+00AD, U+034F, U+180E, U+2061–U+2064, U+206A–U+206F,
 *     U+FFF9–U+FFFB, Hangul fillers U+115F/U+1160/U+3164/U+FFA0 → U+FFFD
 *   - New (Issue 3): Variation selectors U+FE00–U+FE0D → U+FFFD (U+FE0E/U+FE0F kept)
 *   - New (Issue 3): Variation Selectors Supplement U+E0100–U+E01EF → U+FFFD
 *
 * The output is safe to pass to wrapTextWithAnsi / truncateToWidth.
 */
export function sanitizeForDisplay(text: string): string {
	let result = "";
	let i = 0;
	const len = text.length;

	while (i < len) {
		const cp = text.codePointAt(i)!;

		// ESC (0x1B): replace with visible placeholder only — do NOT consume the sequence.
		// Keeping bytes after ESC visible ensures unterminated OSC/CSI doesn't hide content.
		if (cp === 0x1B) {
			result += "\u241B"; // ␛
			i++;
			continue;
		}

		// DEL (0x7F)
		if (cp === 0x7F) {
			result += "\u2421"; // ␡
			i++;
			continue;
		}

		// C1 controls U+0080–U+009F (BMP, 1 code unit in JS)
		if (cp >= 0x80 && cp <= 0x9F) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// C0 controls except \n (0x0A) and \t (0x09) and \r (0x0D — normalized below)
		if (cp < 0x20 && cp !== 0x0A && cp !== 0x09 && cp !== 0x0D) {
			result += "\u2408"; // BS glyph — generic visible placeholder
			i++;
			continue;
		}

		// \r: normalize to \n
		if (cp === 0x0D) {
			if (i + 1 < len && text.charCodeAt(i + 1) === 0x0A) i++; // CRLF → LF
			result += "\n";
			i++;
			continue;
		}

		// \t → 4 spaces
		if (cp === 0x09) {
			result += "    ";
			i++;
			continue;
		}

		// Bidi controls: U+200E (LRM), U+200F (RLM), U+061C (ALM),
		// U+202A-202E (LRE, RLE, PDF, LRO, RLO), U+2066-2069 (LRI, RLI, FSI, PDI)
		if (cp === 0x200E || cp === 0x200F || cp === 0x061C ||
			(cp >= 0x202A && cp <= 0x202E) ||
			(cp >= 0x2066 && cp <= 0x2069)) {
			result += "\uFFFD";
			i++; // all BMP, 1 code unit
			continue;
		}

		// Zero-width non-printing chars (NOT U+200D ZWJ used in emoji):
		// ZWSP U+200B, ZWNJ U+200C, WJ U+2060, BOM/ZWNBS U+FEFF
		if (cp === 0x200B || cp === 0x200C || cp === 0x2060 || cp === 0xFEFF) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// Unicode tag characters U+E0000-E007F (surrogate pairs in JS strings)
		if (cp >= 0xE0000 && cp <= 0xE007F) {
			result += "\uFFFD";
			i += 2; // surrogate pair = 2 JS code units
			continue;
		}

		// --- New ranges (Issue 3) ---

		// Soft hyphen U+00AD
		if (cp === 0x00AD) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// Combining grapheme joiner U+034F
		if (cp === 0x034F) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// Mongolian vowel separator U+180E
		if (cp === 0x180E) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// Invisible math operators U+2061–U+2064
		if (cp >= 0x2061 && cp <= 0x2064) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// Deprecated format characters U+206A–U+206F
		if (cp >= 0x206A && cp <= 0x206F) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// Interlinear annotation U+FFF9–U+FFFB
		if (cp >= 0xFFF9 && cp <= 0xFFFB) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// Hangul fillers: U+115F, U+1160, U+3164, U+FFA0
		if (cp === 0x115F || cp === 0x1160 || cp === 0x3164 || cp === 0xFFA0) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// Variation selectors U+FE00–U+FE0D (keep U+FE0E text-VS and U+FE0F emoji-VS)
		if (cp >= 0xFE00 && cp <= 0xFE0D) {
			result += "\uFFFD";
			i++;
			continue;
		}

		// Variation Selectors Supplement U+E0100–U+E01EF (surrogate pairs in JS)
		if (cp >= 0xE0100 && cp <= 0xE01EF) {
			result += "\uFFFD";
			i += 2; // surrogate pair
			continue;
		}

		// Ordinary character (BMP: 1 code unit; supplementary: 2 code units).
		// Issue 2 fix: for supplementary chars, append BOTH code units (the full surrogate pair).
		if (cp > 0xFFFF) {
			result += text[i] + text[i + 1]; // full surrogate pair
			i += 2;
		} else {
			result += text[i];
			i++;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// sanitizeForLabel
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use as a single-line label (notify, card title, select option).
 * Replaces unsafe control bytes with visible placeholders and collapses line breaks to spaces.
 */
export function sanitizeForLabel(str: string): string {
	return sanitizeForDisplay(str).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}
