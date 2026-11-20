// Data sources (#310): every setting Atlas has, by what it's for, set here
// instead of in .env. Each card shows its source's status (from the galaxy's
// /reach), its switches and fields, and for Google sources a Connect button
// that opens Google's sign-in on this Mac. Save writes data/atlas-settings.json;
// Restart applies it (npm run atlas starts the server again by itself).
// Secrets are never sent to the page: a set one shows as "set", and typing
// replaces it. Everything is set as text.

import { statusOf } from "./tools-tab.js";

/** @typedef {{ key: string, label: string, kind: "toggle" | "secret" | "text" | "number" | "select", hint?: string, options?: string[], placeholder?: string, defaultOn?: boolean }} Field */
/** @typedef {{ id: string, title: string, about: string, node?: string, fields: Field[], connect?: { script: string, flags?: string[] }, command?: string }} Section */

const ACCOUNTS = ["personal", "noisysource", "kidclub", "marisa"];

/** The changes to send: only what differs from what was loaded. Exported for tests. @param {Record<string, unknown>} loaded @param {Record<string, string>} edited */
export const changesOf = (loaded, edited) =>
  Object.fromEntries(
    Object.entries(edited).filter(([k, v]) => {
      const was = loaded[k];
      // A secret: only when something was typed.
      if (was && typeof was === "object") return v !== "";
      return v !== (typeof was === "string" ? was : "");
    }),
  );

/** @param {string} tag @param {string} [className] @param {string} [text] */
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * @param {HTMLElement} root
 * @param {{ nodes: () => import("./brain.js").ReachNode[] }} deps
 */
export const makeSourcesPage = (root, deps) => {
  /** @type {{ sections: Section[], whatsappFields: Field[], values: Record<string, unknown>, whatsapp: Record<string, unknown>, changed: boolean, supervised: boolean } | undefined} */
  let data;
  /** @type {Record<string, string>} */
  let edited = {};
  /** @type {Record<string, string>} */
  let editedWa = {};
  const bar = el("div", "sources-bar");
  const status = el("span", "sources-status", "");
  const save = /** @type {HTMLButtonElement} */ (el("button", "sources-save", "Save"));
  save.type = "button";
  const restart = /** @type {HTMLButtonElement} */ (el("button", "sources-restart", "Restart to apply"));
  restart.type = "button";
  restart.hidden = true;
  bar.append(status, save, restart);

  const dirty = () => Object.keys(changesOf(data?.values ?? {}, edited)).length + Object.keys(changesOf(data?.whatsapp ?? {}, editedWa)).length;
  const showBar = () => {
    const n = dirty();
    save.disabled = n === 0;
    save.textContent = n === 0 ? "Saved" : `Save ${n} change${n === 1 ? "" : "s"}`;
    restart.hidden = !data?.changed;
  };

  /** One field's control. @param {Field} f @param {unknown} value @param {(v: string) => void} set */
  const control = (f, value, set) => {
    const row = el("label", `src-field kind-${f.kind}`);
    const label = el("span", "src-label", f.label);
    if (f.kind === "toggle") {
      const box = /** @type {HTMLInputElement} */ (el("input"));
      box.type = "checkbox";
      box.className = "src-switch";
      // Most switches are off unless "on"; a few are on unless "off".
      box.checked = f.defaultOn ? value !== "off" : value === "on";
      box.addEventListener("change", () => set(f.defaultOn ? (box.checked ? "" : "off") : box.checked ? "on" : ""));
      row.append(box, label);
    } else if (f.kind === "select") {
      const sel = /** @type {HTMLSelectElement} */ (el("select"));
      sel.append(Object.assign(document.createElement("option"), { value: "", textContent: "(default)" }), ...(f.options ?? []).map((o) => Object.assign(document.createElement("option"), { value: o, textContent: o })));
      sel.value = typeof value === "string" ? value : "";
      sel.addEventListener("change", () => set(sel.value));
      row.append(label, sel);
    } else {
      const input = /** @type {HTMLInputElement} */ (el("input"));
      input.type = f.kind === "secret" ? "password" : f.kind === "number" ? "number" : "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      if (f.kind === "secret") input.placeholder = value && typeof value === "object" && /** @type {{ set?: boolean }} */ (value).set ? "set: type to replace" : "not set";
      else {
        input.value = typeof value === "string" ? value : "";
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.addEventListener("input", () => set(input.value));
      row.append(label, input);
    }
    if (f.hint) row.append(el("span", "src-hint", f.hint));
    return row;
  };

  /** The Connect area of a Google source: an account, a button, what the sign-in says. @param {Section} s */
  const connectArea = (s) => {
    const box = el("div", "src-connect");
    const sel = /** @type {HTMLSelectElement} */ (el("select"));
    sel.setAttribute("aria-label", "Account");
    sel.append(...ACCOUNTS.map((a) => Object.assign(document.createElement("option"), { value: a, textContent: a })));
    const go = /** @type {HTMLButtonElement} */ (el("button", "src-connect-go", "Connect an account"));
    go.type = "button";
    const out = el("pre", "src-connect-out");
    out.hidden = true;
    go.addEventListener("click", async () => {
      go.disabled = true;
      out.hidden = false;
      out.textContent = "Opening Google's sign-in in your browser…";
      try {
        const res = await fetch("/settings/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: s.connect?.script, account: sel.value }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? "refused");
        // Follow it until it ends.
        for (let i = 0; i < 400; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const body = await (await fetch("/settings/connect", { cache: "no-store" })).json();
          const c = body?.connect;
          if (!c) break;
          out.textContent = (c.lines ?? []).join("\n");
          if (!c.running) {
            out.textContent += c.code === 0 ? "\n\nConnected. Restart to apply." : "\n\nIt didn't finish.";
            if (c.code === 0 && data) {
              data.changed = true;
              showBar();
            }
            break;
          }
        }
      } catch (e) {
        out.textContent = `Couldn't start it: ${e instanceof Error ? e.message : "error"}.`;
      } finally {
        go.disabled = false;
      }
    });
    box.append(el("span", "src-label", "Accounts"), sel, go, out);
    return box;
  };

  const render = () => {
    const d = data;
    if (!d) return;
    const nodes = deps.nodes();
    const cards = d.sections.map((s) => {
      const card = el("section", "src-card");
      const head = el("div", "src-head");
      head.append(el("h3", "", s.title));
      const node = s.node ? nodes.find((n) => n.id === s.node) : undefined;
      if (node) {
        const st = statusOf(node.status);
        head.append(el("span", `src-status tone-${st.tone}`, st.text));
      }
      card.append(head, el("p", "src-about", s.about));
      const fields = el("div", "src-fields");
      for (const f of s.fields) fields.append(control(f, d.values[f.key], (v) => ((edited[f.key] = v), showBar())));
      card.append(fields);
      if (s.id === "whatsapp") {
        const wa = el("div", "src-fields");
        for (const f of d.whatsappFields) wa.append(control(f, d.whatsapp[f.key], (v) => ((editedWa[f.key] = v), showBar())));
        card.append(wa);
      }
      if (s.connect) card.append(connectArea(s));
      if (s.command) card.append(el("p", "src-hint", `One-time setup in a terminal: ${s.command}`));
      return card;
    });
    root.replaceChildren(el("h2", "page-title", "Data sources"), el("p", "note", "Everything Atlas uses, set here instead of .env. Save, then Restart to apply."), bar, ...cards);
    showBar();
  };

  const load = async () => {
    try {
      const res = await fetch("/settings", { cache: "no-store" });
      if (!res.ok) throw new Error("no settings here");
      data = await res.json();
      edited = {};
      editedWa = {};
      render();
    } catch {
      root.replaceChildren(el("h2", "page-title", "Data sources"), el("p", "note", "Settings can only be changed on this Mac, with Atlas started by npm run atlas."));
    }
  };

  save.addEventListener("click", async () => {
    if (!data) return;
    const env = Object.fromEntries(Object.entries(changesOf(data.values, edited)).map(([k, v]) => [k, v === "" ? null : v]));
    const whatsapp = Object.fromEntries(Object.entries(changesOf(data.whatsapp, editedWa)).map(([k, v]) => [k, v === "" ? null : v]));
    save.disabled = true;
    status.textContent = "Saving…";
    try {
      const res = await fetch("/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ env, whatsapp }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        status.textContent = `Not saved: ${body?.error?.message ?? res.status}`;
        save.disabled = false;
        return;
      }
      status.textContent = "Saved. Restart to apply.";
      await load();
    } catch {
      status.textContent = "Not saved: Atlas didn't answer.";
      save.disabled = false;
    }
  });

  restart.addEventListener("click", async () => {
    restart.disabled = true;
    status.textContent = "Restarting…";
    try {
      const body = await (await fetch("/settings/restart", { method: "POST" })).json();
      if (!body?.ok) {
        status.textContent = body?.text ?? "Couldn't restart.";
        restart.disabled = false;
        return;
      }
      // Wait for it to go, then to come back, and reload the page with the new settings.
      await new Promise((r) => setTimeout(r, 1500));
      for (let i = 0; i < 90; i++) {
        try {
          if ((await fetch("/healthz", { cache: "no-store" })).ok) {
            location.reload();
            return;
          }
        } catch {
          // Still starting.
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      status.textContent = "Atlas didn't come back: look at the terminal.";
    } catch {
      status.textContent = "Couldn't restart.";
    }
    restart.disabled = false;
  });

  return { load, render };
};
