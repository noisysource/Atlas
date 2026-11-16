// #224: answering a card by voice, the step updating after the answer.

import { describe, expect, it } from "vitest";
import { cardAnswer } from "../src/web/card-lib.js";
import { traceDecided, traceOfPath } from "../src/web/trace-lib.js";

describe("answering a card by voice or typing", () => {
  it("short yes and no, in English and Portuguese, and the card's own words", () => {
    for (const t of ["yes", "Yes.", "ok", "okay, go ahead", "yes please", "sim", "Pode ser", "força", "ok send it", "Send it!"]) expect(cardAnswer(t), t).toBe("yes");
    for (const t of ["no", "No thanks", "not now", "não", "deixa estar", "cancela", "leave it"]) expect(cardAnswer(t), t).toBe("no");
    expect(cardAnswer("Tidy it", { yes: "Tidy it", no: "Leave it" })).toBe("yes");
    expect(cardAnswer("keep as draft", { yes: "Send it", no: "Keep as draft" })).toBe("no");
  });

  it("anything else is a new question", () => {
    for (const t of ["yes, and what's on my calendar tomorrow?", "is the heating on", "what does it say?", "", "maybe"]) expect(cardAnswer(t), t).toBeUndefined();
  });
});

describe("the step after his answer", () => {
  it("waiting turns done, declined or failed", () => {
    const trace = traceOfPath([{ kind: "tool", name: "gmail_tidy", args: "personal", by: "model", ok: true, result: "waiting for your OK", confirm: { id: "abc123abc123", label: "x", kind: "gmail-tidy" } }]);
    expect(trace.calls[0]).toMatchObject({ status: "waiting", confirm: "abc123abc123" });
    expect(traceDecided(trace, "abc123abc123", "done").calls[0]).toMatchObject({ status: "used", result: "done after your OK" });
    expect(traceDecided(trace, "abc123abc123", "declined").calls[0]).toMatchObject({ status: "used", result: "you said no" });
    expect(traceDecided(trace, "abc123abc123", "failed").calls[0]).toMatchObject({ status: "failed" });
    expect(traceDecided(trace, "other", "done")).toEqual(trace);
  });
});
