// The chat as a terminal (#195): pure helpers, tested without a page.

/** Within this many pixels of the end counts as "at the end": the view keeps following. */
export const FOLLOW_SLACK = 64;

/**
 * Whether a scroll position is at (or near) the end, so new text should keep it there.
 * @param {number} top scrollTop @param {number} height clientHeight @param {number} total scrollHeight
 */
export const atEnd = (top, height, total, slack = FOLLOW_SLACK) => total - (top + height) <= slack;

/** "18:02", local time. @param {Date} d */
export const clock = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Who said a line, by the message's kind. @param {string} kind */
export const speaker = (kind) => (kind === "user" ? "Renato" : kind === "error" ? "Jarvis (error)" : kind === "handoff" ? "Jarvis (handoff)" : "Jarvis");

/**
 * The whole conversation as plain text, ready to paste.
 * @param {readonly { kind: string, time?: string, text: string }[]} lines
 */
export const conversationText = (lines) =>
  lines
    .filter((l) => l.text.trim() !== "")
    .map((l) => `${l.time ? `[${l.time}] ` : ""}${speaker(l.kind)}: ${l.text.trim()}`)
    .join("\n\n");

/**
 * **bold** and `code` in a short text, as segments to set as text (never as HTML).
 * Anything unmatched stays as it was written.
 * @param {string} text
 * @returns {{ kind: "text" | "bold" | "code", text: string }[]}
 */
export const inlineMarks = (text) => {
  /** @type {{ kind: "text" | "bold" | "code", text: string }[]} */
  const out = [];
  const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    out.push(m[1] !== undefined ? { kind: "bold", text: m[1] } : { kind: "code", text: m[2] ?? "" });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
};
