// The universe behind the page: its pace follows Atlas, and the sky stays small.

import { describe, expect, it } from "vitest";
import { PACE, makeSky, paceOf, seeded } from "../src/web/universe.js";

describe("the universe", () => {
  it("photons drift slowly while you type, faster while Atlas speaks", () => {
    expect(paceOf({ phase: "idle" })).toBe(PACE.idle);
    expect(paceOf({})).toBe(PACE.idle);
    expect(paceOf({ phase: "speaking" })).toBeGreaterThan(paceOf({ phase: "thinking" }));
    expect(paceOf({ phase: "thinking" })).toBeGreaterThan(paceOf({ phase: "idle" }));
    expect(paceOf({ phase: "something new" })).toBe(PACE.idle);
  });

  it("the same sky on every load, and never too many points", () => {
    const a = makeSky(1440, 900, seeded(7));
    const b = makeSky(1440, 900, seeded(7));
    expect(a.stars[0]).toEqual(b.stars[0]);
    expect(a.stars.length).toBeGreaterThan(100);
    const huge = makeSky(7680, 4320, seeded(7));
    expect(huge.stars.length).toBeLessThanOrEqual(320);
    expect(huge.photons.length).toBeLessThanOrEqual(90);
  });
});
