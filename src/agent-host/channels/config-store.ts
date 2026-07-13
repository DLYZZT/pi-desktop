import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import type { ChannelAccountConfig, ChannelBinding } from "../../shared/channel-types";

type ChannelConfigFile = {
  version: 1;
  accounts: ChannelAccountConfig[];
  bindings: ChannelBinding[];
};

const EMPTY_CONFIG: ChannelConfigFile = { version: 1, accounts: [], bindings: [] };

function atomicWrite(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temp, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* best effort on Windows */
    }
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeAccount(value: ChannelAccountConfig, touchUpdatedAt = false): ChannelAccountConfig {
  const now = new Date().toISOString();
  return {
    id: value.id.trim(),
    channel: "weixin",
    name: value.name?.trim() || "微信",
    enabled: value.enabled !== false,
    ...(value.providerAccountId?.trim() ? { providerAccountId: value.providerAccountId.trim() } : {}),
    ...(value.userId?.trim() ? { userId: value.userId.trim() } : {}),
    ...(value.baseUrl?.trim() ? { baseUrl: value.baseUrl.trim() } : {}),
    dmPolicy: value.dmPolicy ?? "pairing",
    allowFrom: readStringArray(value.allowFrom),
    groupPolicy: value.groupPolicy ?? "disabled",
    groupAllowFrom: readStringArray(value.groupAllowFrom),
    requireMention: value.requireMention !== false,
    ...(value.defaultCwd?.trim() ? { defaultCwd: path.resolve(value.defaultCwd.trim()) } : {}),
    toolNames: readStringArray(value.toolNames),
    createdAt: value.createdAt || now,
    updatedAt: touchUpdatedAt ? now : value.updatedAt || now,
  };
}

function normalizeBinding(value: ChannelBinding): ChannelBinding {
  const now = new Date().toISOString();
  return {
    id: value.id.trim(),
    channel: "weixin",
    accountId: value.accountId.trim(),
    peerKind: value.peerKind === "group" ? "group" : "dm",
    peerId: value.peerId.trim(),
    ...(value.threadId?.trim() ? { threadId: value.threadId.trim() } : {}),
    ...(value.sessionId?.trim() ? { sessionId: value.sessionId.trim() } : {}),
    cwd: path.resolve(value.cwd),
    toolNames: readStringArray(value.toolNames),
    createdAt: value.createdAt || now,
    lastUsedAt: value.lastUsedAt || now,
  };
}

export class ChannelConfigStore {
  private data: ChannelConfigFile;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.read();
  }

  private read(): ChannelConfigFile {
    if (!existsSync(this.filePath)) return structuredClone(EMPTY_CONFIG);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<ChannelConfigFile>;
      // Versionless development snapshots are migrated as v0.
      if (parsed.version !== undefined && parsed.version !== 1) {
        throw new Error(`Unsupported channels config version: ${String(parsed.version)}`);
      }
      const migrated = {
        version: 1 as const,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts.map((account) => normalizeAccount(account)) : [],
        bindings: Array.isArray(parsed.bindings) ? parsed.bindings.map(normalizeBinding) : [],
      };
      if (parsed.version === undefined) atomicWrite(this.filePath, migrated);
      return migrated;
    } catch (error) {
      if (error instanceof SyntaxError) {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        return structuredClone(EMPTY_CONFIG);
      }
      throw error;
    }
  }

  private persist(): void {
    atomicWrite(this.filePath, this.data);
  }

  listAccounts(): ChannelAccountConfig[] {
    return structuredClone(this.data.accounts);
  }

  getAccount(accountId: string): ChannelAccountConfig | undefined {
    const found = this.data.accounts.find((account) => account.id === accountId);
    return found ? structuredClone(found) : undefined;
  }

  upsertAccount(account: ChannelAccountConfig): ChannelAccountConfig {
    const normalized = normalizeAccount(account, true);
    if (!normalized.id) throw new Error("Channel account id is required");
    const index = this.data.accounts.findIndex((item) => item.id === normalized.id);
    if (index >= 0) {
      normalized.createdAt = this.data.accounts[index].createdAt;
      this.data.accounts[index] = normalized;
    } else {
      this.data.accounts.push(normalized);
    }
    this.persist();
    return structuredClone(normalized);
  }

  deleteAccount(accountId: string): void {
    this.data.accounts = this.data.accounts.filter((account) => account.id !== accountId);
    this.data.bindings = this.data.bindings.filter((binding) => binding.accountId !== accountId);
    this.persist();
  }

  listBindings(): ChannelBinding[] {
    return structuredClone(this.data.bindings);
  }

  upsertBinding(binding: ChannelBinding): ChannelBinding {
    const normalized = normalizeBinding(binding);
    if (!normalized.id || !normalized.accountId || !normalized.peerId) throw new Error("Invalid channel binding");
    const index = this.data.bindings.findIndex((item) => item.id === normalized.id);
    if (index >= 0) {
      normalized.createdAt = this.data.bindings[index].createdAt;
      this.data.bindings[index] = normalized;
    } else {
      this.data.bindings.push(normalized);
    }
    this.persist();
    return structuredClone(normalized);
  }

  deleteBinding(bindingId: string): void {
    this.data.bindings = this.data.bindings.filter((binding) => binding.id !== bindingId);
    this.persist();
  }
}

export { atomicWrite };
