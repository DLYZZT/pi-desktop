import { createAgentSessionServices, getAgentDir, type SessionManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { ensureAzureUpgrade } from "./azure-upgrade";
import { createDesktopModelRuntime } from "./model-credentials";
import { createAutoRoutingExtension } from "./auto-routing";
import { ensureProviderRenameSettings } from "./provider-renames";

export async function createDesktopAgentSessionServices(
  options: NonNullable<Parameters<typeof createAgentSessionServices>[0]>,
  migration: { project?: boolean; sessionManager?: SessionManager } = {},
) {
  const azureUpgrade = await ensureAzureUpgrade({
    agentDir: options.agentDir,
    cwd: migration.project ? options.cwd : undefined,
    projectTrusted: options.settingsManager?.isProjectTrusted() ?? true,
  });
  const agentDir = options.agentDir ?? getAgentDir();
  await ensureProviderRenameSettings(agentDir);
  const modelRuntime =
    options.modelRuntime ??
    (await createDesktopModelRuntime({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      signal: options.modelRuntimeSignal,
    }));
  const sessionManager = migration.sessionManager;
  const services = await createAgentSessionServices({
    ...options,
    modelRuntime,
    resourceLoaderOptions: {
      ...options.resourceLoaderOptions,
      extensionFactories: [
        createAutoRoutingExtension(
          agentDir,
          sessionManager
            ? (provider, model, usage) => {
                sessionManager.appendUsage("auto-routing", provider, model, usage);
              }
            : undefined,
        ),
        ...(options.resourceLoaderOptions?.extensionFactories ?? []),
      ],
    },
  });
  if (await ensureProviderRenameSettings(agentDir, options.cwd, services.settingsManager.isProjectTrusted()))
    await services.settingsManager.reload();
  return { ...services, azureUpgrade, agentDir };
}
