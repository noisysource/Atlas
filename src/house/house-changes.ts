// Changes to the house, after his OK (#166): what the Domotics app changes,
// through the same channels, as Atlas.
//
// - heating: the automation's settings (domotics_config/automation): on/off,
//   pause, warm windows, comfort and day temperatures. The bridge clamps every
//   value to its own limits on top of these checks.
// - warm_by: "warm by HH:MM" (the domoticsWarmBy callable), or cancel it.
// - thermostat: a room's target or mode; heat_pump: on or off. Queued on
//   domotics_commands for the bridge, as the app does away from home.
// - guard: the E13 guard and its early warning (domotics_config/guard).
// - tariff: the electricity prices (domotics_config/tariff).
//
// Each tool only proposes: a card shows what changes from what, and nothing
// is written until he taps "Do it". An OK lasts ten minutes; at most 30
// changes an hour.

import { randomBytes } from "node:crypto";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";
import type { Domotics } from "./domotics.js";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = { type: "string", description: "HH:MM, Lisbon" } as const;
const CARD = "Nothing changes by this call: it shows him a card and the change happens only after his OK, so call it directly instead of asking in words.";

export const HOUSE_HEATING_TOOL: LlmTool = {
  name: "house_heating",
  description: `Change the heating automation's settings: turn it on or off, pause it for some hours or resume it, the warm windows, the comfort temperature (in the windows) or the day minimum. Give only what he changes. ${CARD}`,
  inputSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      pause_hours: { type: "number", description: "Pause it for this many hours (1–72); 0 resumes it" },
      comfort: { type: "number", description: "°C in the warm windows" },
      day_min: { type: "number", description: "°C outside the windows" },
      windows: { type: "array", items: { type: "object", properties: { from: hhmm, to: hhmm }, required: ["from", "to"] }, description: "1–4 warm windows; replaces them all" },
    },
    additionalProperties: false,
  },
};
export const HOUSE_WARM_BY_TOOL: LlmTool = {
  name: "house_warm_by",
  description: `Have the house warm by a time today or tomorrow ("warm by 18:00"), optionally to a temperature, or cancel that request. ${CARD}`,
  inputSchema: { type: "object", properties: { time: hhmm, target: { type: "number", description: "°C, 18–26; leave out for the comfort temperature" }, cancel: { type: "boolean" } }, additionalProperties: false },
};
export const HOUSE_THERMOSTAT_TOOL: LlmTool = {
  name: "house_thermostat",
  description: `Set a room's thermostat: its target temperature, or its mode (auto follows its schedule, manual holds the target). The automation may adjust targets in its windows. ${CARD}`,
  inputSchema: {
    type: "object",
    properties: { room: { type: "string", description: "The room or thermostat, as he says it" }, target: { type: "number", description: "°C, 5–30" }, mode: { type: "string", enum: ["auto", "manual"] } },
    required: ["room"],
    additionalProperties: false,
  },
};
export const HOUSE_HEAT_PUMP_TOOL: LlmTool = {
  name: "house_heat_pump",
  description: `Switch the heat pump on or off. With the automation on, it may switch it back in its windows: say so. ${CARD}`,
  inputSchema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false },
};
export const HOUSE_GUARD_TOOL: LlmTool = {
  name: "house_guard",
  description: `Turn the heat pump's E13 guard on or off, or its early warning. The guard protects the pump: turning it off needs a reason, say it plainly on the card. ${CARD}`,
  inputSchema: { type: "object", properties: { enabled: { type: "boolean" }, early_warning: { type: "boolean" } }, additionalProperties: false },
};
export const HOUSE_TARIFF_TOOL: LlmTool = {
  name: "house_tariff",
  description: `Change the electricity tariff the Energia page prices with: supplier, vazio window, prices (€/kWh sem IVA), contracted power and its daily price, selling price, billing day. Give only what changes. ${CARD}`,
  inputSchema: {
    type: "object",
    properties: {
      supplier: { type: "string" },
      vazio_from: hhmm,
      vazio_to: hhmm,
      price_vazio: { type: "number" },
      price_fora_vazio: { type: "number" },
      power_kva: { type: "number" },
      power_per_day: { type: "number" },
      export_price: { type: "number" },
      billing_day: { type: "integer" },
    },
    additionalProperties: false,
  },
};
export const HOUSE_CHANGE_TOOLS: readonly LlmTool[] = [HOUSE_HEATING_TOOL, HOUSE_WARM_BY_TOOL, HOUSE_THERMOSTAT_TOOL, HOUSE_HEAT_PUMP_TOOL, HOUSE_GUARD_TOOL, HOUSE_TARIFF_TOOL];

type O = Record<string, unknown>;
const obj = (v: unknown): O | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as O) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const half = (v: number): number => Math.round(v * 2) / 2;
const plain = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** What a card does when he taps "Do it". */
type Apply = { readonly kind: "patch"; readonly path: readonly string[]; readonly fields: O } | { readonly kind: "command"; readonly fields: O } | { readonly kind: "call"; readonly name: string; readonly data: O };
export type Change = { readonly label: string; readonly apply: Apply; readonly tool: string };

/** The heating proposal from his words and the current settings. */
export const heatingChange = (input: O, current: O | undefined, now: number): Result<Change, string> => {
  const fields: O = {};
  const said: string[] = [];
  if (typeof input.enabled === "boolean") {
    fields.enabled = input.enabled;
    said.push(`automation ${current?.enabled === true ? "on" : "off"} → ${input.enabled ? "on" : "off"}`);
  }
  if (input.pause_hours !== undefined) {
    if (!inRange(input.pause_hours, 0, 72)) return err("pause_hours is 0 to 72");
    fields.pauseUntil = input.pause_hours === 0 ? null : now + Math.round(input.pause_hours * 3600_000);
    said.push(input.pause_hours === 0 ? "resume (no pause)" : `pause for ${input.pause_hours} h, until ${new Date(Number(fields.pauseUntil)).toISOString().slice(11, 16)} UTC`);
  }
  if (input.comfort !== undefined) {
    if (!inRange(input.comfort, 16, 26)) return err("comfort is 16 to 26 °C");
    fields.comfort = half(input.comfort);
    said.push(`comfort ${String(current?.comfort ?? "?")} → ${String(fields.comfort)} °C`);
  }
  if (input.day_min !== undefined) {
    if (!inRange(input.day_min, 12, 24)) return err("day_min is 12 to 24 °C");
    fields.dayMin = half(input.day_min);
    said.push(`day minimum ${String(current?.dayMin ?? "?")} → ${String(fields.dayMin)} °C`);
  }
  if (input.windows !== undefined) {
    const list = Array.isArray(input.windows) ? input.windows.map(obj) : [];
    if (list.length < 1 || list.length > 4 || !list.every((w) => w && typeof w.from === "string" && typeof w.to === "string" && HHMM.test(w.from) && HHMM.test(w.to) && w.from !== w.to)) return err("windows are 1 to 4 of { from: HH:MM, to: HH:MM }");
    const windows = list.map((w) => ({ from: String(w?.from), to: String(w?.to) }));
    fields.windows = windows;
    fields.warm = windows[0];
    const was = Array.isArray(current?.windows) ? current.windows.map((w) => `${String(obj(w)?.from)}–${String(obj(w)?.to)}`).join(", ") : "?";
    said.push(`warm windows ${was} → ${windows.map((w) => `${w.from}–${w.to}`).join(", ")}`);
  }
  if (said.length === 0) return err("say what to change: enabled, pause_hours, comfort, day_min or windows");
  return ok({ label: `Heating: ${said.join("; ")}`, apply: { kind: "patch", path: ["domotics_config", "automation"], fields }, tool: "house_heating" });
};

export const warmByChange = (input: O): Result<Change, string> => {
  if (input.cancel === true) return ok({ label: "Cancel the warm-by request", apply: { kind: "call", name: "domoticsWarmBy", data: { clear: true, source: "chat" } }, tool: "house_warm_by" });
  if (typeof input.time !== "string" || !HHMM.test(input.time)) return err("time is HH:MM (or cancel: true)");
  if (input.target !== undefined && !inRange(input.target, 18, 26)) return err("target is 18 to 26 °C");
  const target = input.target === undefined ? undefined : half(Number(input.target));
  return ok({
    label: `Warm the house by ${input.time}${target !== undefined ? ` at ${target} °C` : " at the comfort temperature"} (the next time it comes round)`,
    apply: { kind: "call", name: "domoticsWarmBy", data: { time: input.time, ...(target !== undefined ? { target } : {}), source: "chat" } },
    tool: "house_warm_by",
  });
};

/** The Tuya devices in the live state: thermostats (wk) and the heat pump (znrb). */
type Tuya = { id: string; name: string; category: string; status: Map<string, unknown>; online: boolean };
export const tuyaDevices = (state: O | undefined): Tuya[] =>
  (Array.isArray(state?.devices) ? state.devices : []).flatMap((d) => {
    const o = obj(d);
    if (!o || typeof o.id !== "string") return [];
    const status = new Map((Array.isArray(o.status) ? o.status : []).flatMap((s) => (obj(s) && typeof obj(s)?.code === "string" ? [[String(obj(s)?.code), obj(s)?.value] as const] : [])));
    return [{ id: o.id, name: typeof o.name === "string" ? o.name : o.id, category: String(o.category ?? ""), status, online: o.online !== false }];
  });

export const thermostatChange = (input: O, state: O | undefined): Result<Change, string> => {
  const all = tuyaDevices(state).filter((d) => d.category === "wk");
  if (all.length === 0) return err("no thermostats in the house's state (is the bridge reporting?)");
  const q = plain(typeof input.room === "string" ? input.room : "")
    .replace(/\b(the|o|a|do|da|de|room|quarto de|thermostat|termostato)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const found = all.filter((d) => q !== "" && (plain(d.name).includes(q) || q.split(" ").every((w) => plain(d.name).includes(w))));
  if (found.length !== 1) return err(`${found.length === 0 ? "no thermostat matches" : "more than one thermostat matches"} "${String(input.room ?? "")}". The thermostats are: ${all.map((d) => d.name).join(", ")}`);
  const t = found[0] as Tuya;
  const nowTarget = num(t.status.get("temp_set"));
  const commands: { code: string; value: unknown }[] = [];
  const said: string[] = [];
  if (input.target !== undefined) {
    if (!inRange(input.target, 5, 30)) return err("target is 5 to 30 °C");
    commands.push({ code: "temp_set", value: Math.round(half(input.target) * 10) });
    said.push(`target ${nowTarget !== undefined ? `${nowTarget / 10} → ` : ""}${half(input.target)} °C`);
  }
  if (input.mode !== undefined) {
    if (input.mode !== "auto" && input.mode !== "manual") return err('mode is "auto" or "manual"');
    commands.push({ code: "mode", value: input.mode });
    said.push(`mode ${String(t.status.get("mode") ?? "?")} → ${input.mode}`);
  }
  if (commands.length === 0) return err("say a target or a mode");
  return ok({ label: `${t.name}: ${said.join("; ")}${t.online ? "" : " (it's offline now)"}`, apply: { kind: "command", fields: { deviceId: t.id, commands } }, tool: "house_thermostat" });
};

export const heatPumpChange = (input: O, state: O | undefined, automationOn: boolean): Result<Change, string> => {
  if (typeof input.on !== "boolean") return err("on is true or false");
  const pump = tuyaDevices(state).find((d) => d.category === "znrb");
  if (!pump) return err("no heat pump in the house's state (is the bridge reporting?)");
  const now = pump.status.get("switch");
  return ok({
    label: `Heat pump (${pump.name}): ${now === true ? "on" : now === false ? "off" : "?"} → ${input.on ? "on" : "off"}${automationOn ? " (the automation is on and may switch it back in its windows)" : ""}`,
    apply: { kind: "command", fields: { deviceId: pump.id, commands: [{ code: "switch", value: input.on }] } },
    tool: "house_heat_pump",
  });
};

export const guardChange = (input: O, current: O | undefined): Result<Change, string> => {
  const fields: O = {};
  const said: string[] = [];
  if (typeof input.enabled === "boolean") {
    fields.enabled = input.enabled;
    said.push(`guard ${current?.enabled === true ? "on" : "off"} → ${input.enabled ? "on" : "off"}${input.enabled ? "" : " (the pump loses its E13 protection)"}`);
  }
  if (typeof input.early_warning === "boolean") {
    fields.preempt = input.early_warning;
    said.push(`early warning ${current?.preempt === false ? "off" : "on"} → ${input.early_warning ? "on" : "off"}`);
  }
  if (said.length === 0) return err("say enabled or early_warning");
  return ok({ label: `E13 guard: ${said.join("; ")}`, apply: { kind: "patch", path: ["domotics_config", "guard"], fields }, tool: "house_guard" });
};

const TARIFF_FIELDS: readonly { readonly key: string; readonly field: string; readonly check: (v: unknown) => boolean; readonly unit: string }[] = [
  { key: "supplier", field: "supplier", check: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 60, unit: "" },
  { key: "vazio_from", field: "vazioFrom", check: (v) => typeof v === "string" && HHMM.test(v), unit: "" },
  { key: "vazio_to", field: "vazioTo", check: (v) => typeof v === "string" && HHMM.test(v), unit: "" },
  { key: "price_vazio", field: "priceVazio", check: (v) => inRange(v, 0, 1), unit: " €/kWh" },
  { key: "price_fora_vazio", field: "priceForaVazio", check: (v) => inRange(v, 0, 1), unit: " €/kWh" },
  { key: "power_kva", field: "powerKva", check: (v) => inRange(v, 1, 41.4), unit: " kVA" },
  { key: "power_per_day", field: "powerPerDay", check: (v) => inRange(v, 0, 5), unit: " €/day" },
  { key: "export_price", field: "exportPrice", check: (v) => inRange(v, 0, 1), unit: " €/kWh" },
  { key: "billing_day", field: "billingDay", check: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 28, unit: "" },
];

export const tariffChange = (input: O, current: O | undefined): Result<Change, string> => {
  const fields: O = {};
  const said: string[] = [];
  for (const f of TARIFF_FIELDS) {
    if (input[f.key] === undefined) continue;
    if (!f.check(input[f.key])) return err(`${f.key} isn't a valid value`);
    fields[f.field] = typeof input[f.key] === "string" ? String(input[f.key]).trim() : input[f.key];
    said.push(`${f.key.replace(/_/g, " ")} ${current?.[f.field] !== undefined ? `${String(current[f.field])} → ` : ""}${String(fields[f.field])}${f.unit}`);
  }
  if (said.length === 0) return err("say which tariff values change");
  return ok({ label: `Tariff: ${said.join("; ")}`, apply: { kind: "patch", path: ["domotics_config", "tariff"], fields }, tool: "house_tariff" });
};

export type HouseChanges = {
  readonly propose: (tool: string, input: unknown, signal?: AbortSignal) => Promise<Result<{ readonly id: string; readonly label: string }, string>>;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
};

export const HOUSE_CHANGES_PER_HOUR = 30;

export const makeHouseChanges = (deps: { readonly domotics: Domotics; readonly now?: () => number; readonly newId?: () => string; readonly log?: Logger; readonly perHour?: number }): HouseChanges => {
  const d = deps.domotics;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const cap = deps.perHour ?? HOUSE_CHANGES_PER_HOUR;
  const done: number[] = [];
  const pending = new Map<string, { change: Change; until: number }>();

  const fieldsOf = async (path: readonly string[], signal?: AbortSignal): Promise<Result<O | undefined, string>> => {
    const got = await d.get(path, signal);
    return got.ok ? ok(got.value?.fields) : err(got.error.message);
  };

  const build = async (tool: string, i: O, signal?: AbortSignal): Promise<Result<Change, string>> => {
    if (tool === "house_warm_by") return warmByChange(i);
    if (tool === "house_heating") {
      const cur = await fieldsOf(["domotics_config", "automation"], signal);
      return cur.ok ? heatingChange(i, cur.value, now()) : cur;
    }
    if (tool === "house_guard") {
      const cur = await fieldsOf(["domotics_config", "guard"], signal);
      return cur.ok ? guardChange(i, cur.value) : cur;
    }
    if (tool === "house_tariff") {
      const cur = await fieldsOf(["domotics_config", "tariff"], signal);
      return cur.ok ? tariffChange(i, cur.value) : cur;
    }
    const state = await fieldsOf(["domotics_state", "tuya"], signal);
    if (!state.ok) return state;
    if (tool === "house_thermostat") return thermostatChange(i, state.value);
    if (tool === "house_heat_pump") {
      const auto = await fieldsOf(["domotics_config", "automation"], signal);
      return heatPumpChange(i, state.value, auto.ok && auto.value?.enabled === true);
    }
    return err("not a house change");
  };

  return {
    propose: async (tool, input, signal) => {
      const built = await build(tool, obj(input) ?? {}, signal);
      if (!built.ok) return built;
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const id = newId();
      pending.set(id, { change: built.value, until: now() + 10 * 60_000 });
      return ok({ id, label: built.value.label });
    },
    decide: async (id, decision) => {
      const got = pending.get(id);
      pending.delete(id);
      if (!got || got.until <= now()) return { ok: false, text: "That request has expired or was already answered, so nothing changed. Ask again." };
      if (decision === "no") return { ok: true, text: "Okay, I've left the house as it is." };
      while (done.length > 0 && (done[0] ?? 0) <= now() - 3600_000) done.shift();
      if (done.length >= cap) return { ok: false, text: `I've changed the house ${cap} times this hour, which is my limit, so nothing changed. Use the Domotics app, or try later.` };
      done.push(now());
      const a = got.change.apply;
      const result =
        a.kind === "patch"
          ? await d.patch(a.path, a.fields)
          : a.kind === "command"
            ? await d.add("domotics_commands", a.fields)
            : await d.call(a.name, a.data);
      if (!result.ok) {
        deps.log?.warn("house change failed", { tool: got.change.tool, code: result.error.code });
        return { ok: false, text: `Nothing changed: ${result.error.message}.` };
      }
      deps.log?.info("house changed", { tool: got.change.tool });
      const queued = a.kind === "command" ? " The bridge picks it up within a few seconds." : "";
      return { ok: true, text: `Done: ${got.change.label}.${queued}`, tool: got.change.tool };
    },
  };
};

