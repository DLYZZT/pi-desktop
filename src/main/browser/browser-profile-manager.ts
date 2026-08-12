import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Session } from "electron";
import type {
  BrowserCreateProfileInput,
  BrowserDataType,
  BrowserProfileInfo,
  BrowserProxySettings,
} from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

const PROFILE_FILE_VERSION = 1 as const;
const MAX_PROFILE_FILE_BYTES = 256 * 1024;
const MAX_PERSISTENT_PROFILES = 16;
export const DEFAULT_BROWSER_PROFILE_ID = "temporary";

type StoredProfile = Omit<BrowserProfileInfo, "persistent" | "proxyMode"> & {
  mode: "persistent";
};

type ProfileFile = {
  version: typeof PROFILE_FILE_VERSION;
  profiles: StoredProfile[];
};

export interface BrowserProfileManagerOptions {
  userDataDir: string;
  fromPartition: (partition: string, options?: { cache: boolean }) => Session;
  configureSession: (profile: BrowserProfileInfo, session: Session) => void;
  now?: () => Date;
  createId?: () => string;
  launchId?: string;
  removePartitionDirectory?: (directory: string) => Promise<void>;
}

export class BrowserProfileManager {
  private readonly profiles = new Map<string, BrowserProfileInfo>();
  private readonly sessions = new Map<string, Session>();
  private readonly filePath: string;
  private readonly fromPartition: BrowserProfileManagerOptions["fromPartition"];
  private readonly configureSession: BrowserProfileManagerOptions["configureSession"];
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly launchId: string;
  private readonly userDataDir: string;
  private readonly removePartitionDirectory: (directory: string) => Promise<void>;

  constructor(options: BrowserProfileManagerOptions) {
    this.userDataDir = path.resolve(options.userDataDir);
    this.filePath = path.join(options.userDataDir, "browser-profiles.json");
    this.fromPartition = options.fromPartition;
    this.configureSession = options.configureSession;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.launchId = sanitizeId(options.launchId ?? randomUUID());
    this.removePartitionDirectory = options.removePartitionDirectory ?? removePersistentPartitionDirectory;
    const now = this.now().toISOString();
    this.profiles.set(DEFAULT_BROWSER_PROFILE_ID, {
      id: DEFAULT_BROWSER_PROFILE_ID,
      name: "Temporary",
      mode: "ephemeral",
      persistent: false,
      createdAt: now,
      lastUsedAt: now,
      proxyMode: "system",
    });
    for (const profile of this.readPersistentProfiles()) {
      this.profiles.set(profile.id, { ...profile, persistent: true, proxyMode: "system" });
    }
  }

  list(): BrowserProfileInfo[] {
    return [...this.profiles.values()]
      .sort((left, right) => {
        if (left.id === DEFAULT_BROWSER_PROFILE_ID) return -1;
        if (right.id === DEFAULT_BROWSER_PROFILE_ID) return 1;
        return left.createdAt.localeCompare(right.createdAt);
      })
      .map((profile) => structuredClone(profile));
  }

  get(profileId: string): BrowserProfileInfo {
    const profile = this.profiles.get(validateProfileId(profileId));
    if (!profile) throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser profile was not found");
    return structuredClone(profile);
  }

  create(input: BrowserCreateProfileInput): BrowserProfileInfo {
    const name = validateProfileName(input.name);
    if (input.mode === "persistent") {
      const count = [...this.profiles.values()].filter((profile) => profile.mode === "persistent").length;
      if (count >= MAX_PERSISTENT_PROFILES) {
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Maximum persistent Browser profiles reached");
      }
    }
    let id = "";
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = sanitizeId(this.createId());
      if (!this.profiles.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new BrowserError("INVALID_BROWSER_REQUEST", "Could not allocate a unique Browser profile id");
    const now = this.now().toISOString();
    const profile: BrowserProfileInfo = {
      id,
      name,
      mode: input.mode,
      persistent: input.mode === "persistent",
      createdAt: now,
      lastUsedAt: now,
      proxyMode: "system",
    };
    this.profiles.set(id, profile);
    this.persistProfiles();
    return structuredClone(profile);
  }

  rename(profileId: string, name: string): BrowserProfileInfo {
    const profile = this.requireMutableProfile(profileId);
    profile.name = validateProfileName(name);
    this.persistProfiles();
    return structuredClone(profile);
  }

  async delete(profileId: string): Promise<void> {
    const profile = this.requireMutableProfile(profileId);
    const session = this.sessions.get(profile.id);
    try {
      if (session) {
        await session.clearStorageData();
        await session.clearCache();
        await session.closeAllConnections();
        this.sessions.delete(profile.id);
      }
      if (profile.persistent) {
        await this.removePartitionDirectory(persistentPartitionDirectory(this.userDataDir, profile));
      }
    } catch (error) {
      throw new BrowserError("PROFILE_DELETE_RETRY_REQUIRED", "Browser profile data is still in use; retry deletion", {
        retryable: true,
        recovery: { retryAfterMs: 250 },
        details: { profileId: profile.id },
        cause: error,
      });
    }
    this.profiles.delete(profile.id);
    this.persistProfiles();
  }

  getSession(profileId: string): Session {
    const profile = this.profiles.get(validateProfileId(profileId));
    if (!profile) throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser profile was not found");
    const existing = this.sessions.get(profile.id);
    if (existing) return existing;
    const partition = partitionForProfile(profile, this.launchId);
    const created = this.fromPartition(partition, { cache: true });
    this.configureSession(structuredClone(profile), created);
    this.sessions.set(profile.id, created);
    profile.lastUsedAt = this.now().toISOString();
    if (profile.persistent) this.persistProfiles();
    return created;
  }

  getProfileIdForSession(target: Session): string | undefined {
    for (const [profileId, session] of this.sessions) {
      if (session === target) return profileId;
    }
    return undefined;
  }

  getPartition(profileId: string): string {
    return partitionForProfile(this.get(profileId), this.launchId);
  }

  async clearData(profileId: string, dataType: BrowserDataType): Promise<void> {
    const session = this.getSession(profileId);
    if (dataType === "cache") {
      await session.clearCache();
      return;
    }
    if (dataType === "all") {
      await session.clearStorageData();
      await session.clearCache();
      await session.closeAllConnections();
      return;
    }
    const storage = storageType(dataType);
    await session.clearStorageData({ storages: [storage] });
    if (dataType === "service-workers") await session.closeAllConnections();
  }

  async applyProxy(profileId: string, proxy: BrowserProxySettings): Promise<void> {
    const profile = this.profiles.get(validateProfileId(profileId));
    if (!profile) throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser profile was not found");
    const session = this.getSession(profile.id);
    if (proxy.mode === "system") await session.setProxy({ mode: "system" });
    else if (proxy.mode === "direct") await session.setProxy({ mode: "direct" });
    else {
      if (!proxy.proxyRules) throw new BrowserError("INVALID_BROWSER_REQUEST", "Custom proxy rules are missing");
      await session.setProxy({
        mode: "fixed_servers",
        proxyRules: proxy.proxyRules,
        ...(proxy.proxyBypassRules ? { proxyBypassRules: proxy.proxyBypassRules } : {}),
      });
    }
    profile.proxyMode = proxy.mode;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.allSettled(
      sessions.map(async ([profileId, session]) => {
        const profile = this.profiles.get(profileId);
        if (profile && !profile.persistent) {
          await session.clearStorageData();
          await session.clearCache();
        }
        await session.closeAllConnections();
      }),
    );
  }

  private requireMutableProfile(profileId: string): BrowserProfileInfo {
    const id = validateProfileId(profileId);
    if (id === DEFAULT_BROWSER_PROFILE_ID) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "The default temporary profile cannot be changed");
    }
    const profile = this.profiles.get(id);
    if (!profile) throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser profile was not found");
    return profile;
  }

  private readPersistentProfiles(): StoredProfile[] {
    try {
      const stats = fs.statSync(this.filePath);
      if (!stats.isFile() || stats.size > MAX_PROFILE_FILE_BYTES) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<ProfileFile>;
      if (parsed.version !== PROFILE_FILE_VERSION || !Array.isArray(parsed.profiles)) return [];
      const unique = new Set<string>();
      const profiles: StoredProfile[] = [];
      for (const candidate of parsed.profiles.slice(0, MAX_PERSISTENT_PROFILES)) {
        if (!candidate || typeof candidate !== "object" || candidate.mode !== "persistent") continue;
        try {
          const id = validateProfileId(candidate.id);
          if (id === DEFAULT_BROWSER_PROFILE_ID || unique.has(id)) continue;
          unique.add(id);
          profiles.push({
            id,
            name: validateProfileName(candidate.name),
            mode: "persistent",
            createdAt: validateIsoDate(candidate.createdAt),
            lastUsedAt: validateIsoDate(candidate.lastUsedAt),
          });
        } catch {
          // Skip individual corrupt records while keeping other profiles available.
        }
      }
      return profiles;
    } catch {
      return [];
    }
  }

  private persistProfiles(): void {
    const profiles: StoredProfile[] = [...this.profiles.values()]
      .filter((profile): profile is BrowserProfileInfo & { mode: "persistent" } => profile.mode === "persistent")
      .map(({ id, name, mode, createdAt, lastUsedAt }) => ({ id, name, mode, createdAt, lastUsedAt }));
    const data: ProfileFile = { version: PROFILE_FILE_VERSION, profiles };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Best effort on Windows.
      }
    } finally {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Best effort cleanup.
      }
    }
  }
}

export function partitionForProfile(profile: BrowserProfileInfo, launchId: string): string {
  const id = validateProfileId(profile.id);
  if (profile.mode === "persistent") return `persist:pi-browser-${id}`;
  if (profile.mode === "unsafe") return `pi-browser-unsafe-${sanitizeId(launchId)}-${id}`;
  return `pi-browser-${sanitizeId(launchId)}-${id}`;
}

export function persistentPartitionDirectory(userDataDir: string, profile: BrowserProfileInfo): string {
  if (profile.mode !== "persistent") {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Only persistent Browser profiles have disk partitions");
  }
  const partition = partitionForProfile(profile, "unused");
  const partitionName = partition.slice("persist:".length);
  const partitionsRoot = path.resolve(userDataDir, "Partitions");
  const target = path.resolve(partitionsRoot, partitionName);
  if (path.dirname(target) !== partitionsRoot || path.basename(target) !== partitionName) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser profile partition path is invalid");
  }
  return target;
}

async function removePersistentPartitionDirectory(directory: string): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Persistent Browser partition is not a regular directory");
  }
  await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 0 });
}

function storageType(
  type: Exclude<BrowserDataType, "all" | "cache">,
): "cookies" | "localstorage" | "indexdb" | "serviceworkers" {
  if (type === "local-storage") return "localstorage";
  if (type === "indexed-db") return "indexdb";
  if (type === "service-workers") return "serviceworkers";
  return "cookies";
}

function validateProfileId(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser profile id is invalid");
  }
  return value;
}

function sanitizeId(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 96);
  return sanitized || randomUUID().replaceAll("-", "");
}

function validateProfileName(value: string): string {
  if (typeof value !== "string") throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser profile name is invalid");
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || /[\0\r\n]/.test(normalized)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser profile name is invalid");
  }
  return normalized;
}

function validateIsoDate(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid date");
  return new Date(value).toISOString();
}
