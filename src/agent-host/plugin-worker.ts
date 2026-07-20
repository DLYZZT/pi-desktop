import path from "node:path";
import { publicToolchainError } from "../shared/toolchains/errors.ts";
import type { PluginWorkerRequest, PluginWorkerResponse } from "./plugin-worker-protocol.ts";
import { PLUGIN_WORKER_RESULT_MARKER } from "./plugin-worker-protocol.ts";
import { applyPluginActionInProcess } from "./plugins-service";

const MAX_REQUEST_BYTES = 64 * 1024;
const VALID_ACTIONS = new Set(["install", "remove", "update", "disable", "enable"]);

function writeResponse(response: PluginWorkerResponse): void {
  const encoded = Buffer.from(JSON.stringify(response), "utf8").toString("base64");
  process.stdout.write(`\n${PLUGIN_WORKER_RESULT_MARKER}${encoded}\n`);
}

function validateRequest(value: unknown): PluginWorkerRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid Plugin worker request");
  const request = value as PluginWorkerRequest;
  const body = request.body;
  if (
    !body ||
    typeof body.cwd !== "string" ||
    !path.isAbsolute(body.cwd) ||
    body.cwd.length > 4_096 ||
    /[\0\r\n]/.test(body.cwd) ||
    !VALID_ACTIONS.has(body.action)
  ) {
    throw new Error("Invalid Plugin worker action");
  }
  if (body.source !== undefined && (typeof body.source !== "string" || body.source.length > 8_192)) {
    throw new Error("Invalid Plugin source");
  }
  if (
    request.npmCommand !== undefined &&
    (!Array.isArray(request.npmCommand) ||
      request.npmCommand.length < 1 ||
      request.npmCommand.length > 16 ||
      request.npmCommand.some(
        (entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 4_096 || /[\0\r\n]/.test(entry),
      ))
  ) {
    throw new Error("Invalid Plugin npm runtime");
  }
  return request;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Plugin worker request exceeds the byte limit");
    chunks.push(chunk);
  }
  const request = validateRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const result = await applyPluginActionInProcess(request.body, request.npmCommand);
  writeResponse({ ok: true, result });
}

void main().catch((error) => {
  writeResponse({ ok: false, error: publicToolchainError(error) });
  process.exitCode = 1;
});
