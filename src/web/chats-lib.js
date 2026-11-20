// The conversation list's words (#309), pure for tests.

/**
 * How long ago, the way a chat list says it: "now", "8m ago", "3h ago", "yesterday", "Tue", "14 Nov".
 * @param {string} iso @param {number} [now]
 */
export const ago = (iso, now = Date.now()) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2 * 86_400) return "yesterday";
  const d = new Date(t);
  if (s < 7 * 86_400) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
