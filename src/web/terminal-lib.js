// The chat as a terminal (#195): pure helpers, tested without a page.

/** Within this many pixels of the end counts as "at the end": the view keeps following. */
export const FOLLOW_SLACK = 64;

/**
 * Whether a scroll position is at (or near) the end, so new text should keep it there.
 * @param {number} top scrollTop @param {number} height clientHeight @param {number} total scrollHeight
 */
export const atEnd = (top, height, total, slack = FOLLOW_SLACK) => total - (top + height) <= slack;

/**
 * #298: whether the view keeps following new text after a scroll, the way
 * OpenJarvis does it. Any move up, away from the end, stops it at once (so a
 * reply never pulls you back while you read); it starts again only when you
 * are back at the very end. A move down that isn't at the end changes nothing.
 * Less than a pixel up (a trackpad's bounce settling) isn't a move up.
 * @param {{ following: boolean, lastTop: number, top: number, height: number, total: number }} s
 * @returns {boolean}
 */
export const keepsFollowing = ({ following, lastTop, top, height, total }) => {
  const distance = total - (top + height);
  const up = lastTop - top >= 1;
  if (up && distance >= 1) return false;
  if (!up && distance < 2) return true;
  return following;
};

/** "18:02", local time. @param {Date} d */
export const clock = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Who said a line, by the message's kind. @param {string} kind */
export const speaker = (kind) => (kind === "user" ? "Renato" : kind === "error" ? "Atlas (error)" : kind === "handoff" ? "Atlas (handoff)" : "Atlas");

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
