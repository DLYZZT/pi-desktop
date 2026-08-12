import fs from "node:fs";
import path from "node:path";
import type { BrowserHeaderRule } from "../../contract/browser.ts";

const VERSION = 2 as const;
const LEGACY_VERSION = 1 as const;
const MAX_FILE_BYTES = 1024 * 1024;

type RuleFile = {
  version: typeof VERSION;
  request: Record<string, BrowserHeaderRule[]>;
  response: Record<string, BrowserHeaderRule[]>;
};

export class BrowserHeaderRuleStore {
  private readonly filePath: string;
  private value: RuleFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.value = this.read();
  }

  get(profileId: string, direction: "request" | "response"): BrowserHeaderRule[] {
    return structuredClone(this.value[direction][profileId] ?? []);
  }

  set(profileId: string, direction: "request" | "response", rules: BrowserHeaderRule[]): void {
    this.value[direction][profileId] = rules.map((rule) => ({
      ...structuredClone(rule),
      source: "local",
      ownerSessionId: undefined,
    }));
    this.persist();
  }

  hasSecretRef(secretRef: string): boolean {
    return (
      [...Object.values(this.value.request), ...Object.values(this.value.response)] as BrowserHeaderRule[][]
    ).some((rules) => rules.some((rule) => rule.secretRef === secretRef));
  }

  clearProfile(profileId: string): void {
    delete this.value.request[profileId];
    delete this.value.response[profileId];
    this.persist();
  }

  clear(): void {
    this.value = emptyFile();
    this.persist();
  }

  private read(): RuleFile {
    try {
      const stat = fs.statSync(this.filePath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return emptyFile();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as {
        version?: number;
        request?: unknown;
        response?: unknown;
      };
      if (
        (parsed.version !== VERSION && parsed.version !== LEGACY_VERSION) ||
        !isRecord(parsed.request) ||
        !isRecord(parsed.response)
      )
        return emptyFile();
      return {
        version: VERSION,
        request: filterRuleRecord(parsed.request),
        response: filterRuleRecord(parsed.response),
      };
    } catch {
      return emptyFile();
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(this.value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

function emptyFile(): RuleFile {
  return { version: VERSION, request: {}, response: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function filterRuleRecord(value: Record<string, unknown>): Record<string, BrowserHeaderRule[]> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([profileId, rules]) => {
      if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(profileId) || !Array.isArray(rules)) return [];
      const safe = rules.slice(0, 100).filter((rule): rule is BrowserHeaderRule => {
        if (!rule || typeof rule !== "object") return false;
        const candidate = rule as Partial<BrowserHeaderRule>;
        return (
          candidate.profileId === profileId &&
          typeof candidate.id === "string" &&
          typeof candidate.header === "string" &&
          typeof candidate.urlPattern === "string"
        );
      });
      return [
        [
          profileId,
          safe
            .filter((rule) => rule.source !== "agent")
            .map((rule) => ({ ...rule, source: "local" as const, ownerSessionId: undefined })),
        ],
      ];
    }),
  );
}
