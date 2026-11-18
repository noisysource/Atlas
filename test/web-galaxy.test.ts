// The galaxy (the Noisy Source look) and the star pulsing with Atlas's voice.

import { describe, expect, it } from "vitest";
import { GALAXY, MAX_DRIFT, NODES, driftOf, driftsOf, galaxyDust, galaxyLine, galaxyPosition, recentUses, withUse } from "../src/web/brain-lib.js";
import { levelOf } from "../src/web/voice-level.js";

describe("the galaxy", () => {
  it("every tool has a place: Atlas's own parts near the core, the rest out on the two arms", () => {
    for (const n of NODES) expect(GALAXY[n.id]).toBeDefined();
    const core = NODES.filter((n) => GALAXY[n.id].arm === "core").map((n) => n.id);
    expect(core.sort()).toEqual(["memory", "profile", "skills"]);
    for (const n of NODES) {
      const g = GALAXY[n.id];
      if (g.arm !== "core") expect(g.r).toBeGreaterThan(0.5);
      const p = galaxyPosition(n.id);
      expect(p.left).toBeGreaterThan(2);
      expect(p.left).toBeLessThan(98);
      expect(p.top).toBeGreaterThan(2);
      expect(p.top).toBeLessThan(98);
    }
    expect(GALAXY.house.arm).toBe("life");
    expect(GALAXY.github.arm).toBe("work");
  });

  it("no two tools crowd each other", () => {
    const at = NODES.map((n) => galaxyPosition(n.id));
    for (let i = 0; i < at.length; i++)
      for (let j = i + 1; j < at.length; j++) {
        const a = at[i];
        const b = at[j];
        if (a && b) expect(Math.hypot(a.left - b.left, a.top - b.top)).toBeGreaterThan(12);
      }
  });

  it("a beam runs from the star towards its tool; a failed one stops short", () => {
    const ok = galaxyLine("house", "reaching");
    const failed = galaxyLine("house", "failed");
    const at = galaxyPosition("house");
    expect(failed.length).toBeLessThan(ok.length);
    expect(Math.hypot(ok.end.left - at.left, ok.end.top - at.top)).toBeLessThan(5);
  });

  it("the haze is the same every time, and stays inside the stage", () => {
    expect(galaxyDust(50)).toEqual(galaxyDust(50));
    for (const d of galaxyDust(300)) {
      expect(d.left).toBeGreaterThanOrEqual(0);
      expect(d.left).toBeLessThanOrEqual(100);
      expect(d.alpha).toBeGreaterThan(0);
    }
  });
});

describe("the star's pulse", () => {
  it("silence is 0, speech fills the range, never above 1", () => {
    expect(levelOf(new Uint8Array(512).fill(128))).toBe(0);
    expect(levelOf([])).toBe(0);
    const speech = Array.from({ length: 512 }, (_, i) => 128 + Math.round(30 * Math.sin(i / 3)));
    expect(levelOf(speech)).toBeGreaterThan(0.4);
    const loud = Array.from({ length: 512 }, (_, i) => (i % 2 ? 0 : 255));
    expect(levelOf(loud)).toBe(1);
  });
});

describe("tool drift (#282)", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 18);

  it("no use, no drift; more use drifts closer, smoothly, and never past 15%", () => {
    expect(driftOf(0)).toBe(0);
    let last = 0;
    for (const n of [1, 2, 5, 10, 30, 100]) {
      const d = driftOf(n);
      expect(d).toBeGreaterThan(last);
      expect(d).toBeLessThanOrEqual(MAX_DRIFT);
      last = d;
    }
    expect(driftOf(10_000)).toBeLessThanOrEqual(MAX_DRIFT);
    expect(driftOf(1)).toBeLessThan(0.02);
  });

  it("only the last 30 days count", () => {
    const uses = { house: [now - 31 * DAY, now - 29 * DAY, now - DAY], web: [now + DAY] };
    expect(recentUses(uses, now)).toEqual({ house: [now - 29 * DAY, now - DAY] });
    expect(withUse(uses, "gmail", now).gmail).toEqual([now]);
  });

  it("a used tool sits closer to the star, along the same direction; Atlas's own parts stay", () => {
    const far = galaxyPosition("house");
    const near = galaxyPosition("house", MAX_DRIFT);
    expect(Math.hypot(near.left - 50, near.top - 50)).toBeCloseTo(Math.hypot(far.left - 50, far.top - 50) * 0.85, 0);
    expect(galaxyPosition("house", 5)).toEqual(near);
    expect(galaxyLine("house", "used", MAX_DRIFT).length).toBeLessThan(galaxyLine("house", "used").length);
    const drifts = driftsOf({ memory: [now], house: [now] }, now);
    expect(drifts.memory).toBeUndefined();
    expect(drifts.house).toBeGreaterThan(0);
  });

  it("even fully drifted, no two tools crowd each other", () => {
    const at = NODES.map((n) => galaxyPosition(n.id, GALAXY[n.id].arm === "core" ? 0 : MAX_DRIFT));
    for (let i = 0; i < at.length; i++)
      for (let j = i + 1; j < at.length; j++) {
        const a = at[i];
        const b = at[j];
        if (a && b) expect(Math.hypot(a.left - b.left, a.top - b.top)).toBeGreaterThan(9);
      }
  });
});
