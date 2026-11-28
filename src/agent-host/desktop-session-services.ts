import { bindSessionNotices } from "./transcript-settings";
import { observeProviderRegistrations } from "./extension-diagnostics";
import { createAgentSessionServices, getAgentDir, type SessionManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { ensureAzureUpgrade } from "./azure-upgrade";
import { createDesktopModelRuntime } from "./model-credentials";
import { createAutoRoutingExtension } from "./auto-routing";
import { ensureProviderRenameSettings } from "./provider-renames";
import { guardSessionCacheWarming } from "./session-cache-warming";

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
  const registration = sessionManager ? observeProviderRegistrations(modelRuntime) : undefined;
  const services = await createAgentSessionServices({
    ...options,
    modelRuntime: registration?.runtime ?? modelRuntime,
    resourceLoaderOptions: {
      ...options.resourceLoaderOptions,
      ...(registration
        ? {
            extensionsOverride: (loaded) =>
              registration.observe(options.resourceLoaderOptions?.extensionsOverride?.(loaded) ?? loaded),
          }
        : {}),
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
  // The Host creates a separate settings manager for each attached session.
  if (sessionManager && !options.settingsManager) {
    guardSessionCacheWarming(services.settingsManager, sessionManager);
    bindSessionNotices(services.settingsManager, options.cwd, agentDir);
  }
  return { ...services, azureUpgrade, agentDir };
}
