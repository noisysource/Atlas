// Tools as plug-ins (#168): one core, and connectors that can be swapped per
// person or per country. A connector is a provider for a capability: Vendus
// gives "invoices" in Portugal; somewhere else another invoicing app would
// give the same group with its own tools. The core (bare.ts) knows the groups
// and how to offer, route and check tools; it doesn't know the providers.
//
// What every connector says about itself, in one place:
//   - which group (capability) it provides, and where it applies (countries)
//   - its tools, as the brain sees them
//   - its lines for the system prompt
//   - how it runs a call: code checks the input, builds every request, and
//     says what the brain may read; the brain never reaches the service
//   - its galaxy node, and how it's set up (the Tools page and a script)
//
// Pure types. A connector is built from plain dependencies (a reader, a time
// zone), so a test gives it fakes and the app gives it the real service.

import type { LlmTool, LlmToolCall, LlmToolResult } from "../llm/types.js";
import type { ToolGroup } from "../answer/tool-groups.js";
import type { Logger, PathStep } from "../types.js";

/** What a call gets from the core: the time, the question's abort signal, where to show its step. */
export type ConnectorCall = {
  readonly call: LlmToolCall;
  readonly now: Date;
  readonly signal?: AbortSignal;
  readonly onStep?: (step: PathStep) => void;
  /** What a long call is doing right now, shown live in place of "Thinking…" (never kept). */
  readonly onProgress?: (text: string) => void;
  readonly log?: Logger;
  /** ASK_SMALL off: small, undoable changes (a light, a blind, one thermostat) are done at once, with Undo. */
  readonly autoSmall?: boolean;
  /** #312: Local mode: every undoable change is done at once; what reaches others or production still asks. */
  readonly local?: boolean;
};

/** What the brain is told when a change is done at once, without a card. */
export const AUTO_SAY = (label: string): string => `The app is doing this now, without a card (small and undoable): ${label}. Say in one short sentence what you're doing; don't ask for an OK, and don't claim it worked: the app says so.`;

export type Connector = {
  /** Its own id: "vendus". One folder under src/connectors/ per connector. */
  readonly id: string;
  /** The capability it provides; another connector can provide the same one elsewhere. */
  readonly group: ToolGroup;
  /** Where it applies (ISO country codes); none means anywhere. */
  readonly countries?: readonly string[];
  /** Its tools, in the order they're offered. */
  readonly tools: readonly LlmTool[];
  /** What the brain is told about it, when its tools can be offered. */
  readonly prompt: readonly string[];
  /** Runs one of its tools. Never throws: a failure is a result the brain reads. */
  readonly run: (c: ConnectorCall) => Promise<LlmToolResult>;
  /** The galaxy node that shows it (GET /reach). */
  readonly node?: string;
  /** The same connector with some of it switched off on the galaxy (e.g. "house.control"). */
  readonly narrow?: (off: ReadonlySet<string>) => Connector;
};

/** The connector that owns a tool, if any. */
export const connectorOf = (connectors: readonly Connector[], tool: string): Connector | undefined => connectors.find((c) => c.tools.some((t) => t.name === tool));

/** The connectors for a country: those for anywhere, and those for it. */
export const forCountry = (connectors: readonly Connector[], country: string): readonly Connector[] =>
  connectors.filter((c) => !c.countries || c.countries.length === 0 || c.countries.includes(country.toUpperCase()));

/** Two connectors may not offer the same tool: the second one is a mistake in the wiring. */
export const checkConnectors = (connectors: readonly Connector[]): readonly string[] => {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const c of connectors)
    for (const t of c.tools) {
      const other = seen.get(t.name);
      if (other) problems.push(`${t.name} is offered by both ${other} and ${c.id}`);
      else seen.set(t.name, c.id);
    }
  return problems;
};
