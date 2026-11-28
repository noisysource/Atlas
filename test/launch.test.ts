import { describe, expect, it } from "vitest";
import { makeLinePrefixer, managesVoice, pageUrl, parseLaunchArgs, planLaunch, sameServices, serviceNames, voiceServicesOn } from "../src/launch.js";

const state = { atlasUp: false, voiceUp: false, voiceInstalled: true, ollamaUp: true };
const all = { voice: true, open: true };

describe("parseLaunchArgs (#122)", () => {
  it("defaults to voice and opening the page", () => {
    expect(parseLaunchArgs([])).toEqual({ ok: true, value: all });
  });
  it("takes --no-voice and --no-open", () => {
    expect(parseLaunchArgs(["--no-voice", "--no-open"])).toEqual({ ok: true, value: { voice: false, open: false } });
  });
  it("refuses anything else", () => {
    const r = parseLaunchArgs(["--voice=off"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("npm run atlas");
  });
});

describe("planLaunch (#122)", () => {
  it("starts voice when it's installed and not running", () => {
    const p = planLaunch(all, state);
    expect(p).toMatchObject({ alreadyRunning: false, startVoice: true });
    expect(p.notes.join(" ")).toContain("Ollama: up");
  });
  it("doesn't start voice twice, or with --no-voice, or when it isn't set up", () => {
    expect(planLaunch(all, { ...state, voiceUp: true }).startVoice).toBe(false);
    expect(planLaunch({ voice: false, open: true }, state).startVoice).toBe(false);
    const notSetUp = planLaunch(all, { ...state, voiceInstalled: false });
    expect(notSetUp.startVoice).toBe(false);
    expect(notSetUp.notes[0]).toContain("voice:setup");
  });
  it("says how to start Ollama when it doesn't answer", () => {
    expect(planLaunch(all, { ...state, ollamaUp: false }).notes.join(" ")).toContain("ollama serve");
  });
  it("only opens the page when Atlas is already running", () => {
    expect(planLaunch(all, { ...state, atlasUp: true })).toEqual({ alreadyRunning: true, startVoice: false, notes: ["Atlas is already running."] });
  });
});

describe("makeLinePrefixer (#122)", () => {
  it("prefixes whole lines and holds a partial one", () => {
    const p = makeLinePrefixer("[voice]");
    expect(p.push("one\ntw")).toEqual(["[voice] one"]);
    expect(p.push("o\r\nthree")).toEqual(["[voice] two"]);
    expect(p.flush()).toEqual(["[voice] three"]);
    expect(p.flush()).toEqual([]);
  });
});

describe("pageUrl (#122)", () => {
  it("opens 127.0.0.1 for a server on all interfaces", () => {
    expect(pageUrl("0.0.0.0", 8080)).toBe("http://127.0.0.1:8080/");
    expect(pageUrl("127.0.0.1", 8081)).toBe("http://127.0.0.1:8081/");
  });
});

describe("voice services switched in Tools", () => {
  it("are all on unless set to off", () => {
    expect(voiceServicesOn({})).toEqual(["kokoro", "piper", "whisper"]);
    expect(voiceServicesOn({ VOICE_KOKORO: "on", VOICE_PIPER: "off" })).toEqual(["kokoro", "whisper"]);
    expect(voiceServicesOn({ VOICE_KOKORO: "off", VOICE_PIPER: "off", VOICE_WHISPER: "off" })).toEqual([]);
  });
  it("name what starts, and start nothing when every one is off", () => {
    expect(planLaunch(all, state, ["kokoro", "whisper"]).notes[0]).toContain("starting Kokoro and Whisper");
    const none = planLaunch(all, state, []);
    expect(none.startVoice).toBe(false);
    expect(none.notes[0]).toContain("switched off in Tools");
  });
  it("still look after voice when every service starts off, so one can be switched on later", () => {
    expect(managesVoice(all, state)).toBe(true);
    expect(managesVoice(all, { ...state, voiceUp: true })).toBe(false);
    expect(managesVoice({ voice: false, open: true }, state)).toBe(false);
  });
  it("only count as changed when the set is different", () => {
    expect(sameServices(["kokoro", "whisper"], ["kokoro", "whisper"])).toBe(true);
    expect(sameServices(["kokoro", "whisper"], ["whisper"])).toBe(false);
    expect(serviceNames(["kokoro", "piper", "whisper"])).toBe("Kokoro, Piper and Whisper");
  });
});
