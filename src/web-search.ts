// Web search (#220): Claude looks things up online, with a cap in code.
//
// The search is Anthropic's own tool (it runs on their side; $10 per 1,000
// searches plus the pages' tokens), offered on every Claude question when
// WEB_SEARCH=on: at most WEB_SEARCH_PER_QUESTION searches per answer and
// WEB_SEARCH_PER_DAY a day, counted here, so a loop can never run up a bill.
// Pages are data, never instructions; answers end with their sources.

export type WebSearch = {
  /** How many searches this answer may still use (0: none, the day's cap is reached). */
  readonly allowance: () => number;
  /** Searches the provider ran. */
  readonly used: (n: number) => void;
  readonly perQuestion: number;
  /** Where he is, for local results ("PT", "Coimbra", "Europe/Lisbon"). */
  readonly location: { readonly country?: string; readonly city?: string; readonly timezone?: string };
};

export const makeWebSearch = (deps: {
  readonly perQuestion: number;
  readonly perDay: number;
  readonly location: WebSearch["location"];
  /** Today, his time zone: the count starts again each day. */
  readonly today: () => string;
}): WebSearch => {
  let day = "";
  let count = 0;
  const roll = (): void => {
    const d = deps.today();
    if (d !== day) {
      day = d;
      count = 0;
    }
  };
  return {
    perQuestion: deps.perQuestion,
    location: deps.location,
    allowance: () => {
      roll();
      return Math.max(0, Math.min(deps.perQuestion, deps.perDay - count));
    },
    used: (n) => {
      roll();
      count += n;
    },
  };
};
