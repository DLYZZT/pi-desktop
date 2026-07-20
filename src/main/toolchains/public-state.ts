import type {
  CommandDescriptor,
  ManagedComponentId,
  PublicCapabilityState,
  PublicManagedComponentState,
  PublicToolchainState,
  ToolCandidate,
  ToolCapabilityId,
  ToolPreference,
} from "../../shared/toolchains/types";
import { MANAGED_COMPONENT_IDS, TOOL_CAPABILITY_IDS } from "../../shared/toolchains/types.ts";
import { redactToolPath, type PathRedactionRoot } from "./candidate-normalizer.ts";

const MISSING_REASON: Partial<Record<ToolCapabilityId, PublicCapabilityState["reasonCode"]>> = {
  "shell.bash": "TOOLCHAIN_BASH_REQUIRED",
  "vcs.git": "TOOLCHAIN_GIT_REQUIRED",
  "js.node": "TOOLCHAIN_NODE_REQUIRED",
  "js.npm": "TOOLCHAIN_NODE_REQUIRED",
  "js.npx": "TOOLCHAIN_NODE_REQUIRED",
  "python.interpreter": "TOOLCHAIN_PYTHON_REQUIRED",
  "python.uv": "TOOLCHAIN_UV_REQUIRED",
  "python.uvx": "TOOLCHAIN_UV_REQUIRED",
};

export function commandDescriptorFromCandidate(candidate: ToolCandidate, platform: NodeJS.Platform): CommandDescriptor {
  const isWindowsMsysBash =
    platform === "win32" &&
    candidate.capability === "shell.bash" &&
    (candidate.componentId === "portable-git" || /(?:^|[\\/])git(?:[\\/]|$)/i.test(candidate.executable));
  return {
    capability: candidate.capability,
    provider: candidate.provider,
    executable: candidate.executable,
    argvPrefix: [...(candidate.argvPrefix ?? [])],
    binDir: candidate.binDir,
    componentId: candidate.componentId,
    componentRoot: candidate.componentRoot,
    version: candidate.version,
    cwdSemantics: isWindowsMsysBash ? "msys" : platform === "win32" ? "native" : "posix",
    envPatch: {},
    shellEnvPatch: {},
  };
}

export function selectDefaultCandidates(
  candidates: readonly ToolCandidate[],
  preferences: Readonly<Partial<Record<ToolCapabilityId, ToolPreference>>>,
): Partial<Record<ToolCapabilityId, ToolCandidate>> {
  const selected: Partial<Record<ToolCapabilityId, ToolCandidate>> = {};
  for (const capability of TOOL_CAPABILITY_IDS) {
    const preference = preferences[capability] ?? "auto";
    const candidatesForCapability = candidates.filter(
      (candidate) => candidate.capability === capability && candidate.health === "healthy",
    );
    const match = candidatesForCapability.find((candidate) => {
      if (preference === "auto") return true;
      return candidate.provider === preference;
    });
    if (match) selected[capability] = match;
  }
  return selected;
}

export function emptyPublicComponentState(componentId: ManagedComponentId): PublicManagedComponentState {
  return {
    componentId,
    installed: false,
    health: "missing",
    canInstall: false,
    canRepair: false,
    canRemove: false,
  };
}

export function buildPublicToolchainState(options: {
  revision: number;
  platform: NodeJS.Platform;
  arch: string;
  candidates: readonly ToolCandidate[];
  defaults: Readonly<Partial<Record<ToolCapabilityId, ToolCandidate>>>;
  preferences: Readonly<Partial<Record<ToolCapabilityId, ToolPreference>>>;
  redactionRoots: readonly PathRedactionRoot[];
  scanComplete: boolean;
  stateReadOnly?: boolean;
  components?: Readonly<Partial<Record<ManagedComponentId, PublicManagedComponentState>>>;
  caches?: PublicToolchainState["caches"];
  operations?: PublicToolchainState["operations"];
  lastScanAt?: string;
  lastErrorCode?: PublicToolchainState["lastErrorCode"];
}): PublicToolchainState {
  const capabilities: PublicToolchainState["capabilities"] = {};
  for (const capability of TOOL_CAPABILITY_IDS) {
    const preference = options.preferences[capability] ?? "auto";
    const allCandidates = options.candidates.filter((candidate) => candidate.capability === capability);
    const selected = options.defaults[capability];
    const representative = selected ?? allCandidates[0];
    capabilities[capability] = {
      capability,
      preference,
      provider: selected?.provider ?? representative?.provider,
      version: selected?.version ?? representative?.version,
      pathLabel: representative
        ? redactToolPath(representative.executable, options.redactionRoots, options.platform)
        : undefined,
      health: selected ? "healthy" : (representative?.health ?? "missing"),
      reasonCode: selected ? undefined : (representative?.reasonCode ?? MISSING_REASON[capability]),
      candidates: allCandidates.map((candidate) => ({
        id: candidate.id,
        capability,
        provider: candidate.provider,
        version: candidate.version,
        pathLabel: redactToolPath(candidate.executable, options.redactionRoots, options.platform),
        health: candidate.health,
        reasonCode: candidate.reasonCode,
      })),
    };
  }

  const components: PublicToolchainState["components"] = {};
  for (const componentId of MANAGED_COMPONENT_IDS) {
    components[componentId] = options.components?.[componentId] ?? emptyPublicComponentState(componentId);
  }

  return {
    schemaVersion: 1,
    revision: options.revision,
    platform: options.platform,
    arch: options.arch,
    coreReady: options.scanComplete,
    stateReadOnly: options.stateReadOnly,
    capabilities,
    components,
    caches: options.caches ? structuredClone(options.caches) : {},
    operations: options.operations ? options.operations.map((operation) => structuredClone(operation)) : [],
    lastScanAt: options.lastScanAt,
    lastErrorCode: options.lastErrorCode,
  };
}
