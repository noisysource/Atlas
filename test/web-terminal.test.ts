// #195: the chat as a terminal.

import { describe, expect, it } from "vitest";
import { atEnd, clock, conversationText, inlineMarks } from "../src/web/terminal-lib.js";

describe("the terminal chat", () => {
  it("keeps following only while you're at the end", () => {
    expect(atEnd(900, 100, 1000)).toBe(true);
    expect(atEnd(850, 100, 1000)).toBe(true);
    // Scrolled up to read something: new text doesn't pull you down.
    expect(atEnd(400, 100, 1000)).toBe(false);
  });

  it("copies the whole conversation as plain text", () => {
    expect(
      conversationText([
        { kind: "user", time: "18:02", text: "Is the heating on? " },
        { kind: "answer", time: "18:02", text: "Yes, warming up for 19:00." },
        { kind: "answer", text: "  " },
        { kind: "error", time: "18:03", text: "I can't reach Jarvis." },
      ]),
    ).toBe("[18:02] Renato: Is the heating on?\n\n[18:02] Jarvis: Yes, warming up for 19:00.\n\n[18:03] Jarvis (error): I can't reach Jarvis.");
    expect(clock(new Date(2026, 10, 15, 8, 5))).toBe("08:05");
  });

  it("shows **bold** and `code` as marks, never as HTML", () => {
    expect(inlineMarks("DONE. I added a **Tasks** section to `README.md` <b>x</b>")).toEqual([
      { kind: "text", text: "DONE. I added a " },
      { kind: "bold", text: "Tasks" },
      { kind: "text", text: " section to " },
      { kind: "code", text: "README.md" },
      { kind: "text", text: " <b>x</b>" },
    ]);
    expect(inlineMarks("2 * 3 and a lone ` stay")).toEqual([{ kind: "text", text: "2 * 3 and a lone ` stay" }]);
  });
});
