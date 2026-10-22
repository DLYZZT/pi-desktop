import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { withLockedJsonFile, type JsonRecord } from "../shared/node/locked-json-file";
import type { ProviderRename } from "./provider-renames";

const LEGACY_CURSOR = "_desktopProviderRenameCount";
const record = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
type PendingRename = { at: number; before: string; after: string; events: ProviderRename[] };

function pendingRename(value: unknown): PendingRename | undefined {
  if (value === undefined) return;
  if (
    !record(value) ||
    typeof value.at !== "number" ||
    !Number.isFinite(value.at) ||
    typeof value.before !== "string" ||
    typeof value.after !== "string" ||
    !Array.isArray(value.events) ||
    !value.events.every(
      (event) =>
        record(event) &&
        typeof event.at === "number" &&
        Number.isFinite(event.at) &&
        record(event.names) &&
        Object.values(event.names).every((name) => typeof name === "string"),
    )
  )
    throw new Error("Invalid pending provider rename; configuration was not changed");
  return value as PendingRename;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  return record(value)
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, stable(value[key])]),
      )
    : value;
}

/** Only identity-bearing settings participate, so unrelated edits survive crash recovery. No values are copied into the journal. */
function referenceHash(value: JsonRecord): string {
  const references = {
    defaultProvider: value.defaultProvider,
    enabledModels: value.enabledModels,
    modelThinkingLevels: value.modelThinkingLevels,
    compaction: record(value.compaction) ? value.compaction.modelOverrides : undefined,
    fast: value.fast,
    strong: value.strong,
    classifier: value.classifier,
    legacy: value[LEGACY_CURSOR],
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(references)))
    .digest("hex");
}

type Migrate = (settings: JsonRecord, events: readonly ProviderRename[]) => JsonRecord;
function apply(settings: JsonRecord, events: readonly ProviderRename[], migrate: Migrate): JsonRecord {
  let next = migrate(settings, events);
  if (typeof settings[LEGACY_CURSOR] === "number") {
    next = { ...next };
    delete next[LEGACY_CURSOR];
  }
  return next;
}

/**
 * Write-ahead recovery keeps settings and their progress consistent across failures between file replacements.
 * All migrations take the private journal lock before the target lock, including progress-only retries.
 * The journal stores hashes and rename operations, never API keys or complete settings documents.
 */
export async function migrateSettingsFile(
  agentDir: string,
  filename: string,
  history: readonly ProviderRename[],
  migrate: Migrate,
): Promise<boolean> {
  if (!existsSync(filename) || !history.length) return false;
  const key = path.resolve(filename),
    latest = history.at(-1)!.at;
  let changed = false;
  try {
    await withLockedJsonFile(
      path.join(agentDir, "desktop-provider-renames.json"),
      async (initial, saveState) => {
        let state = initial;
        const persist = async (next: JsonRecord) => {
          await saveState(next);
          state = next;
        };
        const appliedAt = () => {
          const value = record(state.files) ? state.files[key] : undefined;
          return typeof value === "number" && Number.isFinite(value) ? value : undefined;
        };
        const finish = async (at: number) => {
          const pending = { ...(record(state.pending) ? state.pending : {}) };
          delete pending[key];
          const next: JsonRecord = { ...state, files: { ...(record(state.files) ? state.files : {}), [key]: at } };
          delete next.pending;
          await persist(Object.keys(pending).length ? { ...next, pending } : next);
        };
        const pending = pendingRename(record(state.pending) ? state.pending[key] : undefined);
        if (!pending && (appliedAt() ?? -Infinity) >= latest) return;
        await withLockedJsonFile(filename, async (initialSettings, saveSettings, initialText) => {
          if (initialText === null) return; // A concurrent deletion must not recreate a user's settings file.
          let settings = initialSettings,
            text = initialText;
          const write = async (next: JsonRecord) => {
            await saveSettings(next, () => {
              if (readFileSync(filename, "utf8") !== text) throw new Error("Settings changed during provider rename");
            });
            changed = true;
            settings = next;
            text = JSON.stringify(next, null, 2) + "\n";
          };
          if (pending) {
            const hash = referenceHash(settings);
            if (hash === pending.after)
              changed = true; // Also refresh callers that still hold the old settings in memory.
            else if (hash === pending.before) {
              const next = apply(settings, pending.events, migrate);
              if (referenceHash(next) !== pending.after)
                throw new Error("Pending provider rename does not match its recovery record");
              await write(next);
            } else throw new Error("Settings references changed during provider rename; automatic replay was skipped");
            await finish(pending.at);
          }
          if ((appliedAt() ?? -Infinity) >= latest) return;
          const legacy = typeof settings[LEGACY_CURSOR] === "number" ? settings[LEGACY_CURSOR] : undefined;
          const since =
            appliedAt() ?? (legacy === undefined ? statSync(filename).mtimeMs : (history[legacy - 1]?.at ?? 0));
          const events = history.filter((event) => event.at > since);
          const next = apply(settings, events, migrate);
          if (next !== settings) {
            // Persist intent before replacing settings. If this fails, leave the target byte-for-byte untouched.
            await persist({
              ...state,
              pending: {
                ...(record(state.pending) ? state.pending : {}),
                [key]: {
                  at: latest,
                  before: referenceHash(settings),
                  after: referenceHash(next),
                  events,
                },
              },
            });
            await write(next);
          }
          await finish(latest);
        });
      },
      undefined,
      { allowEmpty: true },
    );
  } catch (error) {
    if (!changed) throw error;
    // The durable intent remains for the next call/process. Do not report an already committed write as unchanged.
    console.warn(
      `[pi-desktop] provider rename applied for ${filename}; progress recovery is pending: ${(error as Error).message}`,
    );
  }
  return changed;
}
