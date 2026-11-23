// Picks the answerer for a context. Contexts without one (in M0: kidclub and
// noisysource) get an `unavailable` outcome, "not connected yet", and no
// model call. That's a normal reply, not an error.

import { ok } from "../result.js";
import type { Context, Deps } from "../types.js";

export const notConnectedMessage = (context: Context): string =>
  `${context.name} isn't connected yet, so I can't answer that one.`;

export const makeAnswerRouter = (answerers: Readonly<Record<string, Deps["answer"]>>): Deps["answer"] =>
  async (input) => {
    const answerer = answerers[input.context.id];
    return answerer
      ? answerer(input)
      : ok({ kind: "unavailable", message: notConnectedMessage(input.context) });
  };

/** Why Local didn't answer, for the page (#323). */
export type BrainFallback = { readonly from: "local"; readonly to: "claude" | "google"; readonly why: string };

/**
 * Picks the brain (#88), then the context's answerer. Claude unless "local" or
 * "google" (#248) is asked for and there. #323: when Local is asked for but
 * isn't available (Ollama down, the model missing, or its call failing before
 * any words), Gemini answers if it's set up, otherwise Claude, and
 * `onFallback` says so. The fallback is the cloud brain as it always is: Local
 * mode's lifted limits don't come with it.
 */
export const makeBrainRouter = (routers: {
  readonly claude: Deps["answer"];
  readonly local?: Deps["answer"];
  readonly google?: Deps["answer"];
  /** Undefined when Local can answer; otherwise why not. */
  readonly localReady?: () => Promise<string | undefined>;
  /** #171: questions on Claude that Local can answer as well, sent to Local first. */
  readonly easyToLocal?: (input: Parameters<Deps["answer"]>[0]) => boolean;
}): Deps["answer"] =>
  async (input) => {
    if (input.brain === "google" && routers.google) return routers.google(input);
    // #171: an easy question asked of Claude goes to Local when it's there; if Local then fails before any words, Claude answers after all.
    if ((input.brain ?? "claude") === "claude" && routers.local && routers.easyToLocal?.(input) && (await routers.localReady?.().catch(() => "down")) === undefined) {
      input.onRouted?.({ to: "local", why: "easy question" });
      let spoke = false;
      const onText = input.onText;
      const got = await routers.local({ ...input, brain: "local", easy: true, ...(onText ? { onText: (t: string) => ((spoke = true), onText(t)) } : {}) });
      if (got.ok || spoke || got.error.code === "cancelled" || input.signal?.aborted) return got;
      input.onFallback?.({ from: "local", to: "claude", why: `the local model failed (${got.error.message.slice(0, 80)})` });
      return routers.claude(input);
    }
    if (input.brain !== "local" || !routers.local) return routers.claude(input);
    const to = routers.google ? ("google" as const) : ("claude" as const);
    const instead = (why: string) => {
      input.onFallback?.({ from: "local", to, why });
      return (routers.google ?? routers.claude)({ ...input, brain: to });
    };
    const notReady = await routers.localReady?.().catch(() => "Ollama didn't answer");
    if (notReady) return instead(notReady);
    // Its call can still fail: then the cloud answers, but only if no words were shown yet.
    let spoke = false;
    const onText = input.onText;
    const got = await routers.local({ ...input, ...(onText ? { onText: (t: string) => ((spoke = true), onText(t)) } : {}) });
    if (!got.ok && !spoke && got.error.code !== "cancelled" && !input.signal?.aborted) return instead(`the local model failed (${got.error.message.slice(0, 80)})`);
    return got;
  };
