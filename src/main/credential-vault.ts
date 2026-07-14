import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

type VaultFile = {
  version: 1;
  entries: Record<string, string>;
};

function validateKey(key: string): string {
  const trimmed = key.trim();
  if (!/^channel:(weixin|telegram):[a-z0-9._-]{1,160}$/i.test(trimmed)) {
    throw new Error("Invalid channel credential key");
  }
  return trimmed;
}

export class CredentialVault {
  constructor(private readonly filePath: string) {}

  private read(): VaultFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<VaultFile>;
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
        throw new Error("Invalid credential vault format");
      }
      return { version: 1, entries: parsed.entries };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
      throw error;
    }
  }

  private write(data: VaultFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* best effort on Windows */
    }
  }

  private assertAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS credential encryption is unavailable; channel credentials were not persisted");
    }
  }

  get(key: string): Record<string, unknown> | null {
    this.assertAvailable();
    const encrypted = this.read().entries[validateKey(key)];
    if (!encrypted) return null;
    const plaintext = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid channel credential payload");
    return parsed as Record<string, unknown>;
  }

  set(key: string, value: Record<string, unknown>): void {
    this.assertAvailable();
    const data = this.read();
    const encrypted = safeStorage.encryptString(JSON.stringify(value));
    data.entries[validateKey(key)] = encrypted.toString("base64");
    this.write(data);
  }

  delete(key: string): void {
    const data = this.read();
    delete data.entries[validateKey(key)];
    this.write(data);
  }
}

export function createCredentialRequestHandler(vault: CredentialVault) {
  return async (method: string, params: unknown): Promise<unknown> => {
    const body = (params ?? {}) as { key?: string; value?: Record<string, unknown> };
    if (!body.key) throw new Error("Credential key is required");
    if (method === "channelSecrets.get") return vault.get(body.key);
    if (method === "channelSecrets.set") {
      if (!body.value || typeof body.value !== "object") throw new Error("Credential value is required");
      vault.set(body.key, body.value);
      return { ok: true };
    }
    if (method === "channelSecrets.delete") {
      vault.delete(body.key);
      return { ok: true };
    }
    throw new Error(`Unsupported Host request: ${method}`);
  };
}
