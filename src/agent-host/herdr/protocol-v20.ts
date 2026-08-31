import { HerdrBridgeError } from "./errors";

/** All upstream method names used by Pi Desktop's Herdr protocol 20 adapter. */
export const HERDR_V20_METHODS = {
  ping: "ping",
  snapshot: "session.snapshot",
  eventsSubscribe: "events.subscribe",
  workspaceCreate: "workspace.create",
  tabCreate: "tab.create",
  tabFocus: "tab.focus",
  tabRename: "tab.rename",
  paneSplit: "pane.split",
  paneRead: "pane.read",
  agentStart: "agent.start",
  agentPrompt: "agent.prompt",
  agentSendKeys: "agent.send_keys",
  agentWait: "agent.wait",
} as const;

export type HerdrV20Method = (typeof HERDR_V20_METHODS)[keyof typeof HERDR_V20_METHODS];

export const HERDR_V20_EVENT_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
] as const;

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stringField(value: JsonRecord, name: string, max = 4_096): string {
  const field = value[name];
  if (typeof field !== "string" || !field || field.length > max || /[\0\r\n]/.test(field)) {
    throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", `Herdr field ${name} is invalid.`);
  }
  return field;
}

export function optionalStringField(value: JsonRecord, name: string, max = 4_096): string | undefined {
  const field = value[name];
  if (field === undefined || field === null) return undefined;
  if (typeof field !== "string" || field.length > max || /[\0\r\n]/.test(field)) {
    throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", `Herdr field ${name} is invalid.`);
  }
  return field;
}

export function numberField(value: JsonRecord, name: string): number {
  const field = value[name];
  if (!Number.isSafeInteger(field) || Number(field) < 0) {
    throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", `Herdr field ${name} is invalid.`);
  }
  return Number(field);
}
