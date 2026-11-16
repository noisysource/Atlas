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
