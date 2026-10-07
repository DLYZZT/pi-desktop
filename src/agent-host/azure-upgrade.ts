import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AzureUpgradeReport } from "../contract/types";
import { parseJsonRecord, withLockedJsonFile, type JsonRecord } from "../shared/node/locked-json-file";

export const LEGACY_AZURE_PROVIDER = "azure-openai-responses";
const CURRENT = "azure";
type Kind = "auth" | "models" | "settings" | "mcp";
type Document = { kind: Kind; filename: string; raw: string; value: JsonRecord };
const record = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const renameReference = (value: string) =>
  value.startsWith(LEGACY_AZURE_PROVIDER + "/") ? CURRENT + value.slice(LEGACY_AZURE_PROVIDER.length) : value;

/** Only fields whose schema means provider identity are rewritten; API IDs and arbitrary strings are untouched. */
export function planAzureDocument(
  kind: Kind,
  source: JsonRecord,
): { value: JsonRecord; changed: boolean; issues: string[] } {
  const value = structuredClone(source),
    issues: string[] = [];
  const renameKey = (object: JsonRecord, old: string, next: string, field: string) => {
    if (!Object.hasOwn(object, old) || old === next) return;
    if (Object.hasOwn(object, next) && !isDeepStrictEqual(object[old], object[next])) {
      issues.push(field + ": both Azure keys exist with different values");
      return;
    }
    if (!Object.hasOwn(object, next)) object[next] = object[old];
    delete object[old];
  };
  const remapKeys = (object: unknown, field: string) => {
    if (record(object)) for (const key of Object.keys(object)) renameKey(object, key, renameReference(key), field);
  };
  const remapCompat = (object: unknown) => {
    if (!record(object) || !record(object.compat) || !Array.isArray(object.compat.allowedFallbackModels)) return;
    for (const model of object.compat.allowedFallbackModels)
      if (record(model) && model.provider === LEGACY_AZURE_PROVIDER) model.provider = CURRENT;
  };
  if (kind === "auth") {
    const credential = value[LEGACY_AZURE_PROVIDER];
    if (credential !== undefined && (!record(credential) || !["api_key", "oauth"].includes(String(credential.type))))
      issues.push("auth.json: legacy Azure credential type is not recognized");
    else renameKey(value, LEGACY_AZURE_PROVIDER, CURRENT, "auth.json");
  } else if (kind === "models") {
    if (value.providers !== undefined && !record(value.providers))
      issues.push("models.json providers must be an object");
    if (record(value.providers)) {
      if (Object.hasOwn(value.providers, LEGACY_AZURE_PROVIDER) && !record(value.providers[LEGACY_AZURE_PROVIDER]))
        issues.push("models.json: legacy Azure provider configuration is not an object");
      renameKey(value.providers, LEGACY_AZURE_PROVIDER, CURRENT, "models.json providers");
      for (const provider of Object.values(value.providers)) {
        if (!record(provider)) continue;
        remapCompat(provider);
        if (Array.isArray(provider.models)) provider.models.forEach(remapCompat);
        if (record(provider.modelOverrides)) Object.values(provider.modelOverrides).forEach(remapCompat);
      }
    }
  } else if (kind === "mcp") {
    if (record(value.mcpServers))
      for (const server of Object.values(value.mcpServers))
        if (record(server) && record(server.auth) && server.auth.provider === LEGACY_AZURE_PROVIDER)
          server.auth.provider = CURRENT;
  } else {
    if (
      value.enabledModels !== undefined &&
      (!Array.isArray(value.enabledModels) || value.enabledModels.some((item) => typeof item !== "string"))
    )
      issues.push("enabledModels must be a list of model references");
    if (value.modelThinkingLevels !== undefined && !record(value.modelThinkingLevels))
      issues.push("modelThinkingLevels must be an object");
    if (value.defaultProvider === LEGACY_AZURE_PROVIDER) value.defaultProvider = CURRENT;
    if (Array.isArray(value.enabledModels))
      value.enabledModels = value.enabledModels.map((item) =>
        typeof item === "string" ? renameReference(item) : item,
      );
    remapKeys(value.modelThinkingLevels, "modelThinkingLevels");
    if (record(value.compaction)) {
      if (value.compaction.modelOverrides !== undefined && !record(value.compaction.modelOverrides))
        issues.push("compaction.modelOverrides must be an object");
      remapKeys(value.compaction.modelOverrides, "compaction.modelOverrides");
    }
  }
  return { value, changed: !isDeepStrictEqual(source, value), issues };
}

async function readDocument(filename: string, kind: Kind): Promise<Document | undefined> {
  let raw: string;
  try {
    raw = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error("Configuration exceeds the migration read budget");
  return { filename, kind, raw, value: parseJsonRecord(raw) };
}

async function backupDocument(agentDir: string, document: Document): Promise<string> {
  const directory = path.join(agentDir, "desktop-azure-backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Azure backup location is not a directory");
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const filename = path.join(
    directory,
    `${path.basename(document.filename)}.${hash(document.filename).slice(0, 16)}.${hash(document.raw)}.bak`,
  );
  try {
    const handle = await open(filename, "wx", 0o600);
    try {
      await handle.writeFile(document.raw);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lstat(filename)).isFile()) throw new Error("Azure backup is not a regular file");
    if ((await readFile(filename, "utf8")) !== document.raw) throw error;
    if (process.platform !== "win32") await chmod(filename, 0o600);
  }
  return filename;
}

const pending = new Map<string, Promise<AzureUpgradeReport>>();
const notices = new Map<string, AzureUpgradeReport>();
const revisions = new Map<string, number>();
export function azureUpgradeRevision(agentDir = getAgentDir()): number {
  return revisions.get(agentDir) ?? 0;
}
async function migrate(agentDir: string, cwd?: string, projectTrusted = true): Promise<AzureUpgradeReport> {
  const files: Array<{ filename: string; kind: Kind; project?: boolean }> = [
    { filename: path.join(agentDir, "auth.json"), kind: "auth" },
    { filename: path.join(agentDir, "models.json"), kind: "models" },
    { filename: path.join(agentDir, "settings.json"), kind: "settings" },
    { filename: path.join(agentDir, "mcp.json"), kind: "mcp" },
    ...(cwd && projectTrusted
      ? [{ filename: path.join(cwd, ".pi", "settings.json"), kind: "settings" as const, project: true }]
      : []),
  ];
  const report: AzureUpgradeReport = { status: "unchanged", files: [], backups: [], issues: [] };
  try {
    const snapshots = (await Promise.all(files.map((file) => readDocument(file.filename, file.kind)))).filter(
      (entry): entry is Document => entry !== undefined,
    );
    if (!snapshots.some((document) => document.raw.includes(LEGACY_AZURE_PROVIDER))) return report;
    if (
      !snapshots.some((document) => {
        const plan = planAzureDocument(document.kind, document.value);
        return plan.changed || plan.issues.length;
      })
    )
      return report;
    const current: Document[] = [],
      saves: Array<(value: JsonRecord) => Promise<void>> = [];
    // Lock absent global files too: a concurrent login may create auth.json during preflight.
    const lockedFiles = files.filter(
      (file) => !file.project || snapshots.some((snapshot) => snapshot.filename === file.filename),
    );
    const lock = async (index: number): Promise<void> => {
      const snapshot = lockedFiles[index];
      if (snapshot) {
        await withLockedJsonFile(snapshot.filename, async (value, save) => {
          const fresh = await readDocument(snapshot.filename, snapshot.kind);
          if (!isDeepStrictEqual(value, fresh?.value ?? {}))
            throw new Error("Configuration changed during Azure migration");
          current.push(fresh ?? { ...snapshot, raw: "", value: {} });
          saves.push(save);
          await lock(index + 1);
        });
        return;
      }
      const plans = current.map((document) => planAzureDocument(document.kind, document.value));
      report.issues = plans.flatMap((plan) => plan.issues);
      const auth = current.find((document) => document.kind === "auth")?.value;
      const providers = current.find((document) => document.kind === "models")?.value.providers;
      if (
        auth &&
        record(providers) &&
        ((Object.hasOwn(auth, LEGACY_AZURE_PROVIDER) &&
          !Object.hasOwn(auth, CURRENT) &&
          Object.hasOwn(providers, CURRENT) &&
          !Object.hasOwn(providers, LEGACY_AZURE_PROVIDER)) ||
          (Object.hasOwn(providers, LEGACY_AZURE_PROVIDER) &&
            !Object.hasOwn(providers, CURRENT) &&
            Object.hasOwn(auth, CURRENT) &&
            !Object.hasOwn(auth, LEGACY_AZURE_PROVIDER)))
      )
        report.issues.push(
          "Azure identities are split between auth.json and models.json; confirm their ownership before combining them.",
        );
      if (report.issues.length) {
        report.status = "review";
        return;
      }
      // Capture every original before the first write. Backups are exact bytes, private and immutable.
      for (const [index, plan] of plans.entries())
        if (plan.changed) report.backups.push(await backupDocument(agentDir, current[index]!));
      for (const [index, plan] of plans.entries())
        if (plan.changed) {
          const document = current[index]!;
          if ((await readFile(document.filename, "utf8")) !== document.raw)
            throw new Error("Configuration changed during Azure migration");
          await saves[index]!(plan.value);
          report.files.push(document.filename);
        }
      if (report.files.length) report.status = "migrated";
    };
    await lock(0);
  } catch {
    report.status = "review";
    report.issues.push(
      "Azure migration could not finish safely. Original backups and remaining configuration were preserved; review model settings before choosing a model.",
    );
  }
  return report;
}

/** Serialize migrations in this Host; shared file locks also coordinate credential changes with Pi CLI. */
export async function ensureAzureUpgrade(
  options: { agentDir?: string; cwd?: string; projectTrusted?: boolean } = {},
): Promise<AzureUpgradeReport> {
  const agentDir = options.agentDir ?? getAgentDir(),
    key = agentDir + "\0" + (options.cwd ?? "");
  // Different cwd-bound sessions still share auth.json and models.json.
  const previous = pending.get(agentDir);
  const work = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
    migrate(agentDir, options.cwd, options.projectTrusted),
  );
  pending.set(agentDir, work);
  try {
    const result = await work;
    if (result.files.length) revisions.set(agentDir, (revisions.get(agentDir) ?? 0) + 1);
    if (result.status !== "unchanged") notices.set(key, result);
    else if (notices.get(key)?.status === "review") notices.delete(key);
    return structuredClone(result.status === "unchanged" ? (notices.get(key) ?? result) : result);
  } finally {
    if (pending.get(agentDir) === work) pending.delete(agentDir);
  }
}
