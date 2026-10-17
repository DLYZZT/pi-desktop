import { readFileSync } from "node:fs";
import path from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import type { ModelsConfigIssue } from "../contract/types.ts";
import { RpcError } from "../contract/types.ts";

let validator: ReturnType<typeof Compile> | undefined;

/** Match Pi's models.json syntax: BOM, line comments and trailing commas, without altering strings. */
export function parseModelsConfig(text: string): Record<string, unknown> {
  const json = text
    .replace(/^\uFEFF/u, "")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? match);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    // JSON parser excerpts can contain API keys. Never forward them to the UI or logs.
    throw new RpcError({ code: "PARSE_ERROR", message: "models.json contains invalid JSON" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RpcError({ code: "PARSE_ERROR", message: "models.json must contain a JSON object" });
  return value as Record<string, unknown>;
}

/** Read the published schema from the installed SDK; diagnostics contain field paths, never values. */
export function inspectModelsConfig(config: unknown): ModelsConfigIssue[] {
  validator ??= Compile(
    JSON.parse(readFileSync(path.join(getPackageDir(), "schemas", "models.schema.json"), "utf8")) as TSchema,
  );
  return validator.Errors(config).map(({ instancePath, message }) => ({ path: instancePath || "/", message }));
}

export function preflightModelsConfig(filename: string): ModelsConfigIssue[] {
  let raw: string;
  try {
    raw = readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return inspectModelsConfig(parseModelsConfig(raw));
}
