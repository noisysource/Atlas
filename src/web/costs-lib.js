// The costs panel (#247), the parts that don't touch the page: how amounts
// and counts read.

/**
 * "$0", "<$0.01", "$0.42", "$12.30". USD, as the providers bill.
 * @param {number} usd
 */
export const money = (usd) => (usd === 0 ? "$0" : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

/** "1 call", "12 calls". @param {number} n @param {string} [one] @param {string} [many] */
export const count = (n, one = "call", many = "calls") => `${n} ${n === 1 ? one : many}`;

/**
 * What a row's month cell says: the amount, and for the plan the fee and
 * what its coding tasks would have cost on the API.
 * @param {{ kind: string, usd: { month: number }, calls: { month: number }, fees?: { name: string, usdPerMonth: number }[], apiEquivalentUsd?: number, unpriced: number }} row
 * @returns {string[]}
 */
export const rowNotes = (row) => [
  ...(row.kind === "local" ? ["free: runs on this Mac"] : []),
  ...(row.kind === "plan" && (row.fees ?? []).length === 0 ? ["set your plan's fee: COST_SUBSCRIPTIONS=\"Claude Pro=20\" in .env"] : []),
  ...(row.kind === "plan" ? (row.fees ?? []).map((f) => `${f.name}: ${money(f.usdPerMonth)} a month, fixed`) : []),
  ...(row.kind === "plan" && row.calls.month > 0 ? [`${count(row.calls.month, "coding run", "coding runs")}; ${money(row.apiEquivalentUsd ?? 0)} if paid on the API`] : []),
  ...(row.unpriced > 0 ? [`${count(row.unpriced)} with no known price (counted, not priced)`] : []),
];

/** "820", "12.3k", "1.2M" tokens. @param {number} n */
export const tokens = (n) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`);

/** "820 ms", "3.4 s". @param {number} ms */
export const took = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * #299: the daily bars' geometry, for a chart `w` × `h` (bars from the bottom).
 * @param {{ day: string, usd: number }[]} days @param {number} w @param {number} h
 */
export const dayBars = (days, w, h) => {
  const max = Math.max(...days.map((d) => d.usd), 0);
  const gap = 2;
  const bw = days.length === 0 ? 0 : (w - gap * (days.length - 1)) / days.length;
  return {
    max,
    bars: days.map((d, i) => {
      const bh = max === 0 ? 0 : Math.max(d.usd > 0 ? 2 : 0, (d.usd / max) * h);
      return { day: d.day, usd: d.usd, x: i * (bw + gap), y: h - bh, w: bw, h: bh };
    }),
  };
};
