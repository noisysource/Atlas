// Every module the page imports must be on the served list: a missing one is a
// 404 that stops the whole page (#247: costs.js was forgotten).

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEV_FILES, FILES } from "../src/web.js";

describe("the page's files", () => {
  it("every relative import in src/web is served, and every served file exists", async () => {
    const files = (await readdir("src/web")).filter((f) => f.endsWith(".js") || f.endsWith(".html"));
    const served = new Set([...FILES, ...DEV_FILES].map((f) => f.file));
    const missing: string[] = [];
    for (const f of files) {
      const text = await readFile(`src/web/${f}`, "utf8");
      for (const m of text.matchAll(/(?:from|import\(|src=)\s*["']\.?\/([\w.-]+\.(?:js|css|mjs))["']/g)) {
        const name = m[1] ?? "";
        if (!served.has(name)) missing.push(`${f} → ${name}`);
      }
    }
    expect(missing).toEqual([]);
    for (const f of served) expect(files.includes(f) || f.endsWith(".css") || f.endsWith(".webmanifest") || f.endsWith(".svg"), f).toBe(true);
  });
});
