import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Deterministic SIGKILL checkpoints, enabled only by the isolated Electron recovery test runner. */
export async function executionRecoveryCheckpoint(
  stage: "requested" | "settled",
  record: { toolName: string; executionId: string; status: string },
): Promise<void> {
  if (process.env.PI_DESKTOP_EXECUTION_RECOVERY !== "1") return;
  const agentDir = process.env.PI_CODING_AGENT_DIR,
    isolated = process.env.PI_DESKTOP_SMOKE_USER_DATA;
  if (!agentDir || !isolated || !agentDir.startsWith(isolated + path.sep))
    throw new Error("Recovery test settings are not isolated");
  const directory = path.join(agentDir, "execution-recovery"),
    controlPath = path.join(directory, "control.json");
  let control: { stage?: string; tool?: string };
  try {
    control = JSON.parse(await readFile(controlPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (control.stage !== stage || control.tool !== record.toolName) return;
  await writeFile(
    path.join(directory, "checkpoint.json"),
    JSON.stringify({ stage, executionId: record.executionId, status: record.status }),
    { mode: 0o600 },
  );
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      await readFile(controlPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  throw new Error("Recovery test checkpoint was not released");
}
