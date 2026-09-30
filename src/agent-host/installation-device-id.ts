import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseJsonRecord, withLockedJsonFile } from "../shared/node/locked-json-file";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Global settings only. Never uses a session/project SettingsManager snapshot. */
export async function ensureInstallationDeviceId(agentDir = getAgentDir(), signal?: AbortSignal): Promise<string> {
  const filename = path.join(agentDir, "settings.json");
  return withLockedJsonFile(
    filename,
    async (settings, save) => {
      let deviceId = settings.deviceId;
      if (deviceId !== undefined && (typeof deviceId !== "string" || !UUID.test(deviceId))) {
        throw new Error("Global settings contain an invalid installation device ID");
      }
      if (deviceId === undefined) {
        deviceId = randomUUID();
        await save({ ...settings, deviceId });
      }
      const persisted = parseJsonRecord(await readFile(filename, "utf8")).deviceId;
      if (persisted !== deviceId) throw new Error("Installation device ID persistence could not be verified");
      return deviceId as string;
    },
    signal,
  );
}
