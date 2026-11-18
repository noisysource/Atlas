import { describe, expect, it } from "vitest";
import { checkFolderPlan, checkListRequest, checkSavePlan, cleanName, makeDriveClient, makeDriveWrites, type DriveClient, type FileBytes } from "../src/drive.js";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { groupsByWords } from "../src/answer/tool-groups.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const message = { id: "m1", date: "", from: "billing@vendor.pt", to: "", cc: "", subject: "Invoice", snippet: "", unread: false };
const bytes = new Uint8Array([1, 2, 3]);
const file: FileBytes = { message, name: "invoice.pdf", mimeType: "application/pdf", size: 3, bytes };

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("checks", () => {
  it("accepts a list request and defaults to the top level", () => {
    expect(checkListRequest({ account: "noisysource" })).toEqual({ ok: true, value: { account: "noisysource", folder: "root", max: 25 } });
  });
  it("refuses odd accounts and folder ids", () => {
    expect(checkListRequest({ account: "x" }).ok).toBe(false);
    expect(checkListRequest({ account: "personal", folder: "a' or 1=1 or '" }).ok).toBe(false);
  });
  it("cleans names", () => {
    expect(cleanName("  a/b\\c\n")).toBe("a b c");
    expect(cleanName("..")).toBeUndefined();
    expect(cleanName("x".repeat(121))).toBeUndefined();
  });
  it("checks folder and save plans", () => {
    expect(checkFolderPlan({ account: "noisysource", name: "Invoices 2026" })).toMatchObject({ ok: true, value: { parent: "root" } });
    expect(checkFolderPlan({ account: "noisysource", name: "" }).ok).toBe(false);
    expect(checkSavePlan({ account: "noisysource", id: "abcdef12", attachment: 1, folder: "folder123" })).toMatchObject({ ok: true, value: { from: { account: "noisysource", attachment: 1 } } });
    expect(checkSavePlan({ account: "noisysource", id: "abcdef12", attachment: 0, folder: "folder123" }).ok).toBe(false);
    expect(checkSavePlan({ account: "noisysource", id: "abcdef12", attachment: 1, folder: "../x" }).ok).toBe(false);
  });
});

describe("the Drive client", () => {
  it("lists a folder with GET only", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const client = makeDriveClient({
      accessToken: async () => ok("t"),
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        return json({ files: [{ id: "f1", name: "Invoices", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-01-02T00:00:00Z" }] });
      }) as unknown as typeof fetch,
    });
    const got = await client.list({ account: "noisysource", folder: "root", max: 5 });
    expect(got).toEqual({ ok: true, value: [{ id: "f1", name: "Invoices", mimeType: "application/vnd.google-apps.folder", modified: "2026-01-02" }] });
    expect(calls[0]?.method).toBe("GET");
    expect(new URL(calls[0]?.url ?? "").searchParams.get("q")).toBe("trashed = false and 'root' in parents");
    expect(client.createFolder).toBeUndefined();
  });
  it("reads a Google Doc through export", async () => {
    const urls: string[] = [];
    const client = makeDriveClient({
      accessToken: async () => ok("t"),
      fetch: (async (url: string) => {
        urls.push(url);
        return url.includes("/export") ? new Response("hello doc") : json({ id: "d1", name: "Doc", mimeType: "application/vnd.google-apps.document" });
      }) as unknown as typeof fetch,
    });
    const got = await client.read({ account: "personal", id: "d1d1d1" });
    expect(got).toMatchObject({ ok: true, value: { text: "hello doc" } });
    expect(urls[1]).toContain("mimeType=text%2Fplain");
  });
  it("tells him to reconnect when Drive refuses", async () => {
    const client = makeDriveClient({ accessToken: async () => ok("t"), fetch: (async () => json({}, 403)) as unknown as typeof fetch });
    const got = await client.list({ account: "personal", folder: "root", max: 5 });
    expect(got.ok).toBe(false);
    expect(!got.ok && got.error.message).toContain("drive:connect -- personal");
  });
  it("uploads with a multipart POST, only when writing is on", async () => {
    let seen: { url: string; method?: string; type?: string } | undefined;
    const client = makeDriveClient({
      accessToken: async () => ok("t"),
      write: true,
      fetch: (async (url: string, init?: RequestInit) => {
        seen = { url, method: init?.method, type: (init?.headers as Record<string, string>)["content-type"] };
        return json({ id: "new1", name: "invoice.pdf" });
      }) as unknown as typeof fetch,
    });
    const done = await client.upload?.({ account: "noisysource", folder: "folder123", name: "invoice.pdf", mimeType: "application/pdf", bytes });
    expect(done).toEqual({ ok: true, value: { id: "new1", name: "invoice.pdf" } });
    expect(seen?.method).toBe("POST");
    expect(seen?.type).toMatch(/^multipart\/related; boundary=/);
  });
});

const fakeDrive = (calls: string[]): DriveClient => ({
  list: async () => ok([]),
  peek: async (_a, id) => ok({ id, name: "Invoices", mimeType: "application/vnd.google-apps.folder", modified: "" }),
  read: async () => err({ code: "api", message: "no" }),
  createFolder: async (p) => {
    calls.push(`folder ${p.name}`);
    return ok({ id: "n1", name: p.name });
  },
  upload: async (p) => {
    calls.push(`upload ${p.name} ${p.bytes.length}`);
    return ok({ id: "u1", name: p.name });
  },
});

const writes = (calls: string[], ec = false) =>
  makeDriveWrites({ drive: fakeDrive(calls), attachment: async () => ok(file), isEc: () => false, isEcEmail: () => ec });

describe("writes wait for his OK", () => {
  it("saves an attachment only after yes, and once", async () => {
    const calls: string[] = [];
    const w = writes(calls);
    const p = await w.propose("drive_save_attachment", { account: "noisysource", id: "abcdef12", attachment: 1, folder: "folder123" });
    expect(p.ok && p.value.label).toContain('"invoice.pdf"');
    expect(calls).toEqual([]);
    const id = p.ok ? p.value.id : "";
    expect((await w.decide(id, "yes")).ok).toBe(true);
    expect(calls).toEqual(["upload invoice.pdf 3"]);
    expect((await w.decide(id, "yes")).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
  it("does nothing on no", async () => {
    const calls: string[] = [];
    const w = writes(calls);
    const p = await w.propose("drive_create_folder", { account: "noisysource", name: "2026" });
    await w.decide(p.ok ? p.value.id : "", "no");
    expect(calls).toEqual([]);
  });
  it("creates the folder after yes", async () => {
    const calls: string[] = [];
    const w = writes(calls);
    const p = await w.propose("drive_create_folder", { account: "noisysource", name: "2026", parent: "folder123" });
    expect((await w.decide(p.ok ? p.value.id : "", "yes")).text).toContain("Created the folder");
    expect(calls).toEqual(["folder 2026"]);
  });
  it("never saves EC email", async () => {
    const calls: string[] = [];
    const p = await writes(calls, true).propose("drive_save_attachment", { account: "noisysource", id: "abcdef12", attachment: 1, folder: "root" });
    expect(p.ok).toBe(false);
  });
  it("expires after 30 minutes", async () => {
    let t = 0;
    const calls: string[] = [];
    const w = makeDriveWrites({ drive: fakeDrive(calls), attachment: async () => ok(file), isEc: () => false, isEcEmail: () => false, now: () => t });
    const p = await w.propose("drive_create_folder", { account: "noisysource", name: "2026" });
    t = 31 * 60_000;
    expect((await w.decide(p.ok ? p.value.id : "", "yes")).ok).toBe(false);
    expect(calls).toEqual([]);
  });
  it("proposes saving an attachment on a card through the answerer, changing nothing yet", async () => {
    expect(groupsByWords("save the invoice in my Drive folder")).toEqual(expect.arrayContaining(["drive", "gmail"]));
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "d1", name: "drive_save_attachment", input: { account: "noisysource", id: "abcdef12", attachment: 1, folder: "folder123" } }] },
      { ...common, kind: "text", text: "It needs your OK." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const calls: string[] = [];
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, drive: { client: fakeDrive(calls), writes: writes(calls) }, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "save the invoice in my Drive folder",
      history: [],
      memories: [],
      now: new Date("2026-11-15T23:00:00Z"),
      onStep: (s) => steps.push(s),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["drive_list", "drive_read", "drive_create_folder", "drive_save_attachment"]));
    expect(steps.find((s) => s.kind === "tool" && s.name === "drive_save_attachment")).toMatchObject({ ok: true, confirm: { kind: "drive" } });
    expect(calls).toEqual([]);
  });
  it("refuses writes when the client can't write", async () => {
    const full = fakeDrive([]);
    const readOnly: DriveClient = { list: full.list, peek: full.peek, read: full.read };
    const w = makeDriveWrites({ drive: readOnly, attachment: async () => ok(file), isEc: () => false, isEcEmail: () => false });
    expect((await w.propose("drive_create_folder", { account: "noisysource", name: "x" })).ok).toBe(false);
  });
});
