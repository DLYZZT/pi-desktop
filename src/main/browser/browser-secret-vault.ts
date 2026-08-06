import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserError } from "./browser-error.ts";

const VAULT_VERSION = 1 as const;
const MAX_VAULT_BYTES = 2 * 1024 * 1024;

type VaultFile = {
  version: typeof VAULT_VERSION;
  secrets: Record<string, string>;
};

export interface BrowserSecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class BrowserSecretVault {
  private readonly filePath: string;
  private readonly codec: BrowserSecretCodec;
  private readonly secrets = new Map<string, string>();

  constructor(filePath: string, codec: BrowserSecretCodec) {
    this.filePath = filePath;
    this.codec = codec;
    this.load();
  }

  isAvailable(): boolean {
    return this.codec.isAvailable();
  }

  set(value: string, existingRef?: string): string {
    if (!this.codec.isAvailable()) {
      throw new BrowserError("CAPABILITY_DISABLED", "Secure Browser secret storage is unavailable");
    }
    if (typeof value !== "string" || !value || value.length > 64 * 1024 || /\0/.test(value)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser secret is invalid");
    }
    const ref = existingRef ? validateSecretRef(existingRef) : `browser-secret-${randomUUID()}`;
    const encrypted = this.codec.encrypt(value).toString("base64");
    this.secrets.set(ref, encrypted);
    this.persist();
    return ref;
  }

  get(ref: string): string | undefined {
    const encrypted = this.secrets.get(validateSecretRef(ref));
    if (!encrypted || !this.codec.isAvailable()) return undefined;
    try {
      return this.codec.decrypt(Buffer.from(encrypted, "base64"));
    } catch {
      return undefined;
    }
  }

  has(ref: string): boolean {
    return this.secrets.has(validateSecretRef(ref));
  }

  remove(ref: string): void {
    if (this.secrets.delete(validateSecretRef(ref))) this.persist();
  }

  clear(): void {
    this.secrets.clear();
    this.persist();
  }

  private load(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (!stat.isFile() || stat.size > MAX_VAULT_BYTES) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<VaultFile>;
      if (parsed.version !== VAULT_VERSION || !parsed.secrets || typeof parsed.secrets !== "object") return;
      for (const [ref, encrypted] of Object.entries(parsed.secrets)) {
        try {
          validateSecretRef(ref);
          if (typeof encrypted === "string" && encrypted.length <= 128 * 1024) this.secrets.set(ref, encrypted);
        } catch {
          // Ignore corrupt entries without exposing or deleting the remaining vault.
        }
      }
    } catch {
      // Missing or corrupt vault fails closed.
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const data: VaultFile = { version: VAULT_VERSION, secrets: Object.fromEntries(this.secrets) };
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

function validateSecretRef(value: string): string {
  if (typeof value !== "string" || !/^browser-secret-[a-z0-9-]{8,80}$/i.test(value)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser secret reference is invalid");
  }
  return value;
}
