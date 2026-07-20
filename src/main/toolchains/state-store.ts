import fs from "node:fs";
import path from "node:path";
import {
  MANAGED_COMPONENT_IDS,
  TOOL_CAPABILITY_IDS,
  TOOL_PREFERENCES,
  type ManagedComponentId,
  type ToolCapabilityId,
  type ToolPreference,
} from "../../shared/toolchains/types.ts";
import type { ToolchainPaths } from "./paths.ts";

export const TOOLCHAIN_STATE_SCHEMA_VERSION = 2 as const;

// Schema 2 builds briefly persisted these report-only JavaScript capabilities.
// Ignore them during migration now that they are no longer part of tool management.
const RETIRED_TOOL_CAPABILITY_IDS = new Set(["js.corepack", "js.pnpm", "js.yarn"]);

export interface ManagedComponentState {
  activeVersion: string;
  platformArch: string;
  installedVersions: string[];
}

export interface ToolchainPersistentState {
  schemaVersion: typeof TOOLCHAIN_STATE_SCHEMA_VERSION;
  revision: number;
  preferences: Partial<Record<ToolCapabilityId, { mode: ToolPreference }>>;
  /** Main-owned selections. Renderer and public state never receive these absolute paths. */
  custom: Partial<Record<ToolCapabilityId, { executable: string }>>;
  managed: Partial<Record<ManagedComponentId, ManagedComponentState>>;
}

export function emptyToolchainState(): ToolchainPersistentState {
  return { schemaVersion: TOOLCHAIN_STATE_SCHEMA_VERSION, revision: 0, preferences: {}, custom: {}, managed: {} };
}

function isSafeVersion(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(value) && !value.includes("..");
}

export function parseToolchainState(value: unknown): ToolchainPersistentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid toolchain state root");
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== TOOLCHAIN_STATE_SCHEMA_VERSION) throw new Error("Unsupported toolchain state schema");
  if (!Number.isSafeInteger(root.revision) || (root.revision as number) < 0) {
    throw new Error("Invalid toolchain state revision");
  }

  const preferences: ToolchainPersistentState["preferences"] = {};
  if (!root.preferences || typeof root.preferences !== "object" || Array.isArray(root.preferences)) {
    throw new Error("Invalid toolchain preferences");
  }
  for (const [capability, entry] of Object.entries(root.preferences as Record<string, unknown>)) {
    if (!(TOOL_CAPABILITY_IDS as readonly string[]).includes(capability)) {
      if (RETIRED_TOOL_CAPABILITY_IDS.has(capability)) continue;
      throw new Error("Unknown toolchain preference");
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid toolchain preference");
    const mode = (entry as { mode?: unknown }).mode;
    if (!(TOOL_PREFERENCES as readonly unknown[]).includes(mode)) throw new Error("Invalid toolchain preference mode");
    preferences[capability as ToolCapabilityId] = { mode: mode as ToolPreference };
  }

  const custom: ToolchainPersistentState["custom"] = {};
  if (root.custom !== undefined && (!root.custom || typeof root.custom !== "object" || Array.isArray(root.custom))) {
    throw new Error("Invalid custom toolchain state");
  }
  for (const [capability, entry] of Object.entries((root.custom ?? {}) as Record<string, unknown>)) {
    if (!(TOOL_CAPABILITY_IDS as readonly string[]).includes(capability)) {
      if (RETIRED_TOOL_CAPABILITY_IDS.has(capability)) continue;
      throw new Error("Unknown custom capability");
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid custom tool entry");
    const executable = (entry as { executable?: unknown }).executable;
    if (
      typeof executable !== "string" ||
      executable.length === 0 ||
      executable.length > 4_096 ||
      /[\0\r\n]/.test(executable) ||
      (!path.posix.isAbsolute(executable) && !path.win32.isAbsolute(executable))
    ) {
      throw new Error("Invalid custom tool path");
    }
    custom[capability as ToolCapabilityId] = { executable };
  }

  const managed: ToolchainPersistentState["managed"] = {};
  if (!root.managed || typeof root.managed !== "object" || Array.isArray(root.managed)) {
    throw new Error("Invalid managed toolchain state");
  }
  for (const [componentId, entry] of Object.entries(root.managed as Record<string, unknown>)) {
    if (!(MANAGED_COMPONENT_IDS as readonly string[]).includes(componentId))
      throw new Error("Unknown managed component");
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid managed component state");
    const component = entry as Record<string, unknown>;
    if (!isSafeVersion(component.activeVersion) || typeof component.platformArch !== "string") {
      throw new Error("Invalid managed component activation");
    }
    if (
      !Array.isArray(component.installedVersions) ||
      component.installedVersions.length > 32 ||
      component.installedVersions.some((version) => !isSafeVersion(version))
    ) {
      throw new Error("Invalid managed component versions");
    }
    managed[componentId as ManagedComponentId] = {
      activeVersion: component.activeVersion,
      platformArch: component.platformArch,
      installedVersions: [...new Set(component.installedVersions as string[])],
    };
  }

  return {
    schemaVersion: TOOLCHAIN_STATE_SCHEMA_VERSION,
    revision: root.revision as number,
    preferences,
    custom,
    managed,
  };
}

export class ToolchainStateStore {
  private readonly paths: Pick<ToolchainPaths, "root" | "stateFile" | "stateBackupFile">;
  private compatibilityReadOnly = false;

  constructor(paths: Pick<ToolchainPaths, "root" | "stateFile" | "stateBackupFile">) {
    this.paths = paths;
  }

  load(): ToolchainPersistentState {
    for (const filePath of [this.paths.stateFile, this.paths.stateBackupFile]) {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        if (hasFutureSchema(value)) {
          this.compatibilityReadOnly = true;
          return emptyToolchainState();
        }
        const parsed = parseToolchainState(value);
        this.compatibilityReadOnly = false;
        return parsed;
      } catch {
        // Try the backup before falling back to an empty, recoverable state.
      }
    }
    this.compatibilityReadOnly = false;
    return emptyToolchainState();
  }

  save(state: ToolchainPersistentState): void {
    if (this.compatibilityReadOnly || this.primaryHasFutureSchema()) {
      this.compatibilityReadOnly = true;
      throw new Error("Toolchain state was written by a newer Pi Desktop and is read-only in this version");
    }
    const parsed = parseToolchainState(state);
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.paths.root, `.state-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      if (fs.existsSync(this.paths.stateFile)) fs.copyFileSync(this.paths.stateFile, this.paths.stateBackupFile);
      fs.renameSync(temporary, this.paths.stateFile);
      try {
        fs.chmodSync(this.paths.stateFile, 0o600);
      } catch {
        // Windows ACLs do not map directly to POSIX modes.
      }
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Best-effort temporary cleanup.
      }
      throw error;
    }
  }

  update(mutator: (draft: ToolchainPersistentState) => void): ToolchainPersistentState {
    const current = this.load();
    if (this.compatibilityReadOnly) {
      throw new Error("Toolchain state was written by a newer Pi Desktop and is read-only in this version");
    }
    const draft = structuredClone(current);
    mutator(draft);
    draft.revision = current.revision + 1;
    this.save(draft);
    return draft;
  }

  isCompatibilityReadOnly(): boolean {
    return this.compatibilityReadOnly || this.primaryHasFutureSchema();
  }

  private primaryHasFutureSchema(): boolean {
    try {
      return hasFutureSchema(JSON.parse(fs.readFileSync(this.paths.stateFile, "utf8")) as unknown);
    } catch {
      return false;
    }
  }
}

function hasFutureSchema(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  return typeof schemaVersion === "number" && schemaVersion > TOOLCHAIN_STATE_SCHEMA_VERSION;
}
