// The house (#166, #211), as a connector (#168): its state right now, its
// history and settings, the blinds, the lights, and changes to the heating,
// through Atlas's own domotics user. A change shows a card and waits for his
// OK; a small undoable one (ASK_SMALL off) or any undoable one in Local mode
// is done at once, with Undo. Moved out of bare.ts unchanged.

import { blindsForBrain, HOUSE_BLINDS_TOOL, type Blinds } from "../house/blinds.js";
import { HOUSE_CHANGE_TOOLS, type HouseChanges } from "../house/house-changes.js";
import { checkRange, HOUSE_CLIMATE_TOOL, HOUSE_ENERGY_TOOL, HOUSE_INCIDENTS_TOOL, HOUSE_READ_TOOLS, HOUSE_SETTINGS_TOOL, type readHouse } from "../house/house-data.js";
import { HOUSE_NOW_TOOL, HOUSE_STATE_PATH, houseForBrain, houseSummary } from "../house/house.js";
import { HOUSE_LIGHTS_TOOL, lightsForBrain, type Lights } from "../house/lights.js";
import type { DbReader } from "../gcloud/firestore.js";
import type { LlmTool } from "../llm/types.js";
import { err, type Result } from "../result.js";
import { AUTO_SAY, type Connector } from "./types.js";

export type HouseDeps = {
  readonly db: Pick<DbReader, "get">;
  readonly env: string;
  readonly timeZone: string;
  readonly blinds?: Blinds;
  readonly lights?: Lights;
  /** #166: energy, climate, incidents and settings, as Atlas's domotics user. */
  readonly read?: ReturnType<typeof readHouse>;
  /** #166: heating, warm-by, thermostats, the heat pump, the guard and the tariff, after his OK. */
  readonly changes?: HouseChanges;
};

/** What the brain is told about the house, by what Atlas can do there. */
export const housePrompt = (d: HouseDeps): string =>
  d.blinds || d.changes
    ? "You can see the house right now with house_now: what the heating automation is doing and why, today's plan, room and outdoor temperatures, each thermostat, the heat pump, solar, battery, grid and consumption, and where each blind is. Answer from it in plain words; quote the automation's reason when he asks why. You can move the blinds with house_blinds and switch or dim the lights with house_lights: each shows him a card and nothing changes until his OK, so call them directly when he asks (\"close the blinds in the living room\", \"abre as persianas\", \"turn off the kitchen lights\", \"apaga as luzes da sala\")." +
      (d.changes
        ? " You also see the electricity over any days, in kWh and euros (house_energy), a day's climate per room and the heat pump's hours (house_climate), the heat pump's faults and switching (house_incidents) and the settings (house_settings). You can change the heating automation (house_heating: on/off, pause, warm windows, comfort, day minimum), ask for the house warm by a time (house_warm_by), set a room's thermostat (house_thermostat), switch the heat pump (house_heat_pump), the E13 guard (house_guard) and the tariff (house_tariff): each one is a card, nothing changes until his OK. Read the settings first when a change depends on them. Dates are Lisbon days; work out the range from today."
        : " The heating can't be changed from here: say so if he asks.")
    : "You can see the house right now, read-only, with house_now: what the heating automation is doing and why, today's plan, room and outdoor temperatures, each thermostat, the heat pump, solar, battery, grid and consumption. Answer from it in plain words; quote the automation's reason when he asks why. You can't change anything in the house yet: say so if he asks, and that it's coming with an OK step.";

const houseTools = (d: HouseDeps): readonly LlmTool[] => [HOUSE_NOW_TOOL, ...(d.blinds ? [HOUSE_BLINDS_TOOL] : []), ...(d.lights ? [HOUSE_LIGHTS_TOOL] : []), ...(d.read ? HOUSE_READ_TOOLS : []), ...(d.changes ? HOUSE_CHANGE_TOOLS : [])];

const inputOf = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});

export const houseConnector = (d: HouseDeps): Connector => ({
  id: "house",
  group: "house",
  tools: houseTools(d),
  prompt: [housePrompt(d)],
  node: "house",
  // "house.control" off on the galaxy: the blinds can't be moved (as before).
  narrow: (off) => (off.has("house.control") && d.blinds ? houseConnector({ ...d, blinds: undefined }) : houseConnector(d)),
  run: async ({ call, now, signal, onStep, log, autoSmall, local }) => {
    if (call.name === HOUSE_NOW_TOOL.name) {
      const got = await d.db.get({ env: d.env, path: [...HOUSE_STATE_PATH] }, signal);
      if (!got.ok) {
        log?.warn("house read failed", { code: got.error.code });
        onStep?.({ kind: "tool", name: call.name, args: d.env, by: "model", ok: false, error: got.error.code });
        return { callId: call.id, content: `The house: ${got.error.message}. Say so plainly; don't guess.`, isError: true };
      }
      const fields = got.value?.fields;
      // The blinds too, when Atlas can see them; a failure there doesn't hide the rest.
      const blinds = d.blinds ? await d.blinds.list(signal) : undefined;
      const extra = blinds === undefined ? [] : blinds.ok ? [blindsForBrain(blinds.value)] : [`The blinds: ${blinds.error.message}.`];
      // #211: and which lights are on (the same Netatmo read, cached).
      const lights = d.lights ? await d.lights.list(signal) : undefined;
      if (lights) extra.push(lights.ok ? lightsForBrain(lights.value) : `The lights: ${lights.error.message}.`);
      onStep?.({ kind: "tool", name: call.name, args: d.env, by: "model", ok: true, result: houseSummary(fields, now) });
      return { callId: call.id, content: houseForBrain(fields, now, d.timeZone, extra, d.blinds !== undefined) };
    }
    if (d.blinds && call.name === HOUSE_BLINDS_TOOL.name) {
      const input = inputOf(call.input);
      const asked = Array.isArray(input.blinds) ? input.blinds.filter((b): b is string => typeof b === "string").slice(0, 20).map((b) => b.slice(0, 80)) : [];
      const proposed = await d.blinds.propose(asked, input.position, signal);
      if (!proposed.ok) {
        onStep?.({ kind: "tool", name: call.name, args: asked.join(", "), by: "model", ok: false, error: `refused: ${proposed.error.slice(0, 60)}` });
        return { callId: call.id, content: `Not proposed: ${proposed.error}. Tell him plainly, or ask which blinds he means.`, isError: true };
      }
      if (autoSmall || local) {
        onStep?.({ kind: "tool", name: call.name, args: asked.join(", "), by: "model", ok: true, result: "doing it now", confirm: { id: proposed.value.id, label: proposed.value.label, kind: "house", auto: true } });
        return { callId: call.id, content: AUTO_SAY(proposed.value.label) };
      }
      onStep?.({ kind: "tool", name: call.name, args: asked.join(", "), by: "model", ok: true, result: "waiting for your OK", confirm: { id: proposed.value.id, label: proposed.value.label, kind: "house" } });
      return { callId: call.id, content: `Not moved yet: the app is asking him "Move them" / "Leave them" for: ${proposed.value.label}. Say in one sentence that it needs his OK. Never say they've moved.` };
    }
    // #166: the house's history and settings, read as Atlas.
    if (d.read && HOUSE_READ_TOOLS.some((t) => t.name === call.name)) {
      const input = inputOf(call.input);
      const read = d.read;
      let got: Result<string, string>;
      let args = "";
      if (call.name === HOUSE_ENERGY_TOOL.name) {
        const range = checkRange(input);
        if (!range.ok) return { callId: call.id, content: `Refused: ${range.error}.`, isError: true };
        args = `${range.value.from}..${range.value.to}`;
        got = await read.energy(range.value.from, range.value.to, signal);
      } else if (call.name === HOUSE_CLIMATE_TOOL.name) {
        const date = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : "";
        if (date === "") return { callId: call.id, content: "Refused: date is YYYY-MM-DD.", isError: true };
        args = date;
        got = await read.climate(date, signal);
      } else if (call.name === HOUSE_INCIDENTS_TOOL.name) {
        const days = typeof input.days === "number" && Number.isInteger(input.days) && input.days >= 1 && input.days <= 60 ? input.days : 7;
        args = `${days} days`;
        got = await read.incidents(days, now, signal);
      } else if (call.name === HOUSE_SETTINGS_TOOL.name) {
        got = await read.settings(signal);
      } else got = err("unknown");
      if (!got.ok) {
        onStep?.({ kind: "tool", name: call.name, args, by: "model", ok: false, error: got.error.slice(0, 80) });
        return { callId: call.id, content: `The house: ${got.error}. Say so plainly; don't guess.`, isError: true };
      }
      onStep?.({ kind: "tool", name: call.name, args, by: "model", ok: true, result: "read" });
      return { callId: call.id, content: got.value };
    }
    // #166: a change to the house, proposed on a card; nothing changes until his OK.
    if (d.changes && HOUSE_CHANGE_TOOLS.some((t) => t.name === call.name)) {
      const proposed = await d.changes.propose(call.name, call.input, signal);
      if (!proposed.ok) {
        onStep?.({ kind: "tool", name: call.name, args: "", by: "model", ok: false, error: `refused: ${proposed.error.slice(0, 60)}` });
        return { callId: call.id, content: `Not proposed: ${proposed.error}. Tell him plainly, or ask what he means.`, isError: true };
      }
      if ((autoSmall && call.name === "house_thermostat") || local) {
        onStep?.({ kind: "tool", name: call.name, args: "", by: "model", ok: true, result: "doing it now", confirm: { id: proposed.value.id, label: proposed.value.label, kind: "house-change", auto: true } });
        return { callId: call.id, content: AUTO_SAY(proposed.value.label) };
      }
      onStep?.({ kind: "tool", name: call.name, args: "", by: "model", ok: true, result: "waiting for your OK", confirm: { id: proposed.value.id, label: proposed.value.label, kind: "house-change" } });
      return { callId: call.id, content: `Not changed yet: the app is asking him "Do it" / "Leave it" for: ${proposed.value.label}. Say in one sentence that it needs his OK. Never say it's done.` };
    }
    if (d.lights && call.name === HOUSE_LIGHTS_TOOL.name) {
      const input = inputOf(call.input);
      const asked = Array.isArray(input.lights) ? input.lights.filter((b): b is string => typeof b === "string").slice(0, 30).map((b) => b.slice(0, 80)) : [];
      const proposed = await d.lights.propose(asked, input.action, signal);
      if (!proposed.ok) {
        onStep?.({ kind: "tool", name: call.name, args: asked.join(", "), by: "model", ok: false, error: `refused: ${proposed.error.slice(0, 60)}` });
        return { callId: call.id, content: `Not proposed: ${proposed.error}. Tell him plainly, or ask which lights he means.`, isError: true };
      }
      if (autoSmall || local) {
        onStep?.({ kind: "tool", name: call.name, args: asked.join(", "), by: "model", ok: true, result: "doing it now", confirm: { id: proposed.value.id, label: proposed.value.label, kind: "lights", auto: true } });
        return { callId: call.id, content: AUTO_SAY(proposed.value.label) };
      }
      onStep?.({ kind: "tool", name: call.name, args: asked.join(", "), by: "model", ok: true, result: "waiting for your OK", confirm: { id: proposed.value.id, label: proposed.value.label, kind: "lights" } });
      return { callId: call.id, content: `Not changed yet: the app is asking him "Do it" / "Leave them" for: ${proposed.value.label}. Say in one sentence that it needs his OK. Never say they've changed.` };
    }
    return { callId: call.id, content: `Refused: ${call.name} isn't one of the house's tools here.`, isError: true };
  },
});
