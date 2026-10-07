import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { ensureAzureUpgrade } from "./azure-upgrade";

export async function createDesktopAgentSessionServices(
  options: NonNullable<Parameters<typeof createAgentSessionServices>[0]>,
  migration: { project?: boolean } = {},
) {
  const azureUpgrade = await ensureAzureUpgrade({
    agentDir: options.agentDir,
    cwd: migration.project ? options.cwd : undefined,
    projectTrusted: options.settingsManager?.isProjectTrusted() ?? true,
  });
  const services = await createAgentSessionServices(options);
  return { ...services, azureUpgrade };
}
