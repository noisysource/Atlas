// The galaxy (the Noisy Source look) and the star pulsing with Atlas's voice.

import { describe, expect, it } from "vitest";
import { GALAXY, NODES, galaxyDust, galaxyLine, galaxyPosition } from "../src/web/brain-lib.js";
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
