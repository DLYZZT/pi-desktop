import type { DesktopUpdateState, UpdateErrorCode, UpdatePhase } from "../contract/desktop";
import type { UpdateAdapter, UpdateAdapterEventMap } from "./update-adapter";

const DEFAULT_INITIAL_CHECK_DELAY_MS = 60_000;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_JITTER_RATIO = 0.08;
const MAX_RELEASE_NOTES_LENGTH = 12_000;
const MAX_ERROR_DETAIL_LENGTH = 800;

type UpdateOperation = "check" | "download" | "install";
type UpdateLogLevel = "info" | "warn" | "error";

export interface UpdateManagerOptions {
  adapter: UpdateAdapter | null;
  currentVersion: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  automaticChecksEnabled?: boolean;
  initialCheckDelayMs?: number;
  checkIntervalMs?: number;
  jitterRatio?: number;
  random?: () => number;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  prepareToInstall?: () => void | Promise<void>;
  recoverFromInstallFailure?: () => void | Promise<void>;
  log?: (level: UpdateLogLevel, message: string) => void;
}

export interface CheckForUpdatesOptions {
  automatic?: boolean;
}

export class UpdateManagerError extends Error {
  readonly code: UpdateErrorCode;

  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.name = "UpdateManagerError";
    this.code = code;
  }
}

type UpdateDetails = Pick<
  DesktopUpdateState,
  "availableVersion" | "releaseName" | "releaseDate" | "releaseNotes" | "checkedAt"
>;

type ActiveOperation = {
  kind: UpdateOperation;
  promise: Promise<unknown>;
};

const ERROR_MESSAGES: Record<UpdateErrorCode, string> = {
  UPDATE_OFFLINE: "Unable to reach the update service. Check your network and try again.",
  UPDATE_NOT_PUBLISHED: "The update is not available yet. It may still be under release review.",
  UPDATE_METADATA_INVALID: "The update information is invalid or incomplete. The current version was not changed.",
  UPDATE_SIGNATURE_INVALID: "Update signature verification failed. Installation was stopped.",
  UPDATE_DOWNLOAD_FAILED: "The update could not be downloaded. You can keep using this version and retry.",
  UPDATE_BUSY: "Another update operation is already in progress.",
  UPDATE_INVALID_STATE: "The update action is not available in the current state.",
  UPDATE_UNSUPPORTED: "Automatic updates are not supported in this build or on this platform.",
  UPDATE_UNKNOWN: "The update operation failed. You can keep using the current version and retry.",
};

function cloneState(state: DesktopUpdateState): DesktopUpdateState {
  return {
    ...state,
    error: state.error ? { ...state.error } : undefined,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove credentials and machine-specific paths before writing updater errors to logs. */
export function redactUpdateError(value: unknown): string {
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);

  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    text = text.replace(new RegExp(escapeRegExp(home), "gi"), "[LOCAL_PATH]");
  }

  text = text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[AUTH_REDACTED]")
    .replace(/\b(?:gh[opusr]_)[A-Za-z0-9_]{12,}\b/gi, "[TOKEN_REDACTED]")
    .replace(
      /\b(authorization|proxy-authorization|token|password|secret|api[-_]?key)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/([?&](?:access_token|auth|key|password|secret|token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Z]:\\Users\\[^\\\s"']+(?:\\[^\s"']*)?/gi, "[LOCAL_PATH]")
    .replace(/\/(?:Users|home)\/[^/\s"']+(?:\/[^\s"']*)?/g, "[LOCAL_PATH]")
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, "[CACHE_PATH]")
    .replace(/\/tmp\/[^\s"']+/g, "[CACHE_PATH]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL_REDACTED]")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > MAX_ERROR_DETAIL_LENGTH) {
    return `${text.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`;
  }
  return text || "No error detail was provided";
}

function classifyUpdateError(error: unknown, context?: UpdateOperation): UpdateErrorCode {
  if (error instanceof UpdateManagerError) return error.code;
  const errorCode =
    error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  const text =
    `${errorCode} ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`.toLowerCase();

  if (/signature|code signing|publisher|not trusted|err_updater_invalid_signature/.test(text)) {
    return "UPDATE_SIGNATURE_INVALID";
  }
  if (
    /enetunreach|enotfound|eai_again|econnreset|econnrefused|etimedout|err_name_not_resolved|err_internet_disconnected|err_connection_reset|network|offline|internet disconnected/.test(
      text,
    )
  ) {
    return "UPDATE_OFFLINE";
  }
  if (/\b404\b|not found|no published (?:release|version)|latest(?:-mac)?\.yml.*missing/.test(text)) {
    return "UPDATE_NOT_PUBLISHED";
  }
  if (/yaml|metadata|sha-?512|checksum|parse|semver|invalid version|update info|latest(?:-mac)?\.yml/.test(text)) {
    return "UPDATE_METADATA_INVALID";
  }
  if (context === "download" || /download|blockmap/.test(text)) {
    return "UPDATE_DOWNLOAD_FAILED";
  }
  return "UPDATE_UNKNOWN";
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1]?.toLowerCase() === "x";
      const parsed = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff ? String.fromCodePoint(parsed) : match;
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

function plainText(value: string, maxLength = MAX_RELEASE_NOTES_LENGTH): string | undefined {
  const decoded = decodeHtmlEntities(value);
  const result = decoded
    .replace(/<\s*(script|style|iframe|object)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!result) return undefined;
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}

function releaseNotesToText(
  notes: Parameters<UpdateAdapterEventMap["update-available"]>[0]["releaseNotes"],
): string | undefined {
  if (typeof notes === "string") return plainText(notes);
  if (!Array.isArray(notes)) return undefined;
  const entries = notes.flatMap((entry) => {
    const note = plainText(entry.note ?? "");
    if (!note) return [];
    const version = plainText(entry.version, 80);
    return [version ? `${version}\n${note}` : note];
  });
  return plainText(entries.join("\n\n"));
}

function safeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function finiteNonNegative(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function unrefTimer(timer: unknown): void {
  if (!timer || typeof timer !== "object") return;
  const candidate = timer as { unref?: () => void };
  candidate.unref?.();
}

export class UpdateManager {
  private readonly adapter: UpdateAdapter | null;
  private readonly enabled: boolean;
  private readonly currentVersion: string;
  private readonly initialCheckDelayMs: number;
  private readonly checkIntervalMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly prepareToInstall: () => void | Promise<void>;
  private readonly recoverFromInstallFailure: () => void | Promise<void>;
  private readonly log: (level: UpdateLogLevel, message: string) => void;
  private readonly listeners = new Set<(state: DesktopUpdateState) => void>();
  private readonly removeAdapterListeners: Array<() => void> = [];

  private state: DesktopUpdateState;
  private details: UpdateDetails = {};
  private activeOperation: ActiveOperation | null = null;
  private automaticTimer: unknown = null;
  private automaticChecksStarted = false;
  private disposed = false;
  private runningSessionCount = 0;
  private downloadEventReceived = false;
  private downloadPromiseSettled = false;
  private installLifecyclePrepared = false;
  private installRecoveryPromise: Promise<void> | null = null;

  constructor(options: UpdateManagerOptions) {
    const platform = options.platform ?? process.platform;
    const supportedPlatform = platform === "darwin" || platform === "win32";
    const explicitlyEnabledForDevelopment = process.env.PI_DESKTOP_TEST_UPDATER === "1";

    this.adapter = options.adapter;
    this.enabled = Boolean(
      options.adapter && supportedPlatform && (options.isPackaged || explicitlyEnabledForDevelopment),
    );
    this.currentVersion = options.currentVersion;
    this.initialCheckDelayMs = Math.max(0, options.initialCheckDelayMs ?? DEFAULT_INITIAL_CHECK_DELAY_MS);
    this.checkIntervalMs = Math.max(1, options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
    this.jitterRatio = Math.min(0.5, Math.max(0, options.jitterRatio ?? DEFAULT_JITTER_RATIO));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.prepareToInstall = options.prepareToInstall ?? (() => undefined);
    this.recoverFromInstallFailure = options.recoverFromInstallFailure ?? (() => undefined);
    this.log = options.log ?? (() => undefined);

    this.state = {
      phase: this.enabled ? "idle" : "disabled",
      currentVersion: this.currentVersion,
      automaticChecksEnabled: options.automaticChecksEnabled ?? true,
      installBlockedByActiveSessions: false,
      canRetry: false,
    };

    if (this.enabled && this.adapter) this.bindAdapterEvents(this.adapter);
  }

  getState(): DesktopUpdateState {
    return cloneState(this.state);
  }

  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  setRunningSessionCount(count: number): void {
    if (this.disposed) return;
    const nextCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (nextCount === this.runningSessionCount) return;
    this.runningSessionCount = nextCount;
    this.state = {
      ...this.state,
      installBlockedByActiveSessions: this.runningSessionCount > 0,
    };
    this.emitState();
  }

  checkForUpdates(options: CheckForUpdatesOptions = {}): Promise<DesktopUpdateState> {
    const unavailable = this.requireEnabled();
    if (unavailable) return Promise.reject(unavailable);

    const active = this.reuseOrReject<DesktopUpdateState>("check");
    if (active) return active;
    if (!this.isPhase("idle", "up-to-date", "error")) {
      return Promise.reject(this.invalidState("check for updates"));
    }

    this.details = {};
    this.transition("checking");
    this.log("info", `checking for updates (${options.automatic ? "automatic" : "manual"})`);

    return this.trackOperation("check", async () => {
      try {
        await this.adapter!.checkForUpdates();
      } catch (error) {
        if (this.state.phase !== "error") this.recordAdapterError(error, "check");
      }
      return this.getState();
    });
  }

  downloadUpdate(): Promise<DesktopUpdateState> {
    const unavailable = this.requireEnabled();
    if (unavailable) return Promise.reject(unavailable);

    const active = this.reuseOrReject<DesktopUpdateState>("download");
    if (active) return active;
    if (this.state.phase !== "available") {
      return Promise.reject(this.invalidState("download an update"));
    }

    this.transition("downloading", { percent: 0, transferred: 0 });
    this.downloadEventReceived = false;
    this.downloadPromiseSettled = false;
    this.log("info", `downloading update ${this.details.availableVersion ?? "(unknown version)"}`);

    return this.trackOperation("download", async () => {
      try {
        await this.adapter!.downloadUpdate();
        this.downloadPromiseSettled = true;
        if (this.downloadEventReceived && this.state.phase === "downloading") {
          this.finishDownloadedUpdate();
        }
      } catch (error) {
        if (this.state.phase !== "error") this.recordAdapterError(error, "download");
      }
      return this.getState();
    });
  }

  installUpdate(): Promise<void> {
    const unavailable = this.requireEnabled();
    if (unavailable) return Promise.reject(unavailable);

    const active = this.reuseOrReject<void>("install");
    if (active) return active;
    if (this.state.phase !== "downloaded") {
      return Promise.reject(this.invalidState("install an update"));
    }
    if (this.runningSessionCount > 0) {
      return Promise.reject(
        new UpdateManagerError(
          "UPDATE_BUSY",
          "Active agent sessions must finish before the downloaded update can be installed.",
        ),
      );
    }

    return this.trackOperation("install", async () => {
      this.transition("installing");
      this.log("info", `installing update ${this.details.availableVersion ?? "(unknown version)"}`);
      try {
        this.installLifecyclePrepared = true;
        await this.prepareToInstall();
        this.adapter!.quitAndInstall(false, true);
      } catch (error) {
        if (this.state.phase !== "error") this.recordAdapterError(error, "install");
        await this.recoverInstallLifecycle();
        const code = this.state.error?.code ?? classifyUpdateError(error, "install");
        throw new UpdateManagerError(code, ERROR_MESSAGES[code]);
      }
    });
  }

  setAutomaticChecksEnabled(enabled: boolean): DesktopUpdateState {
    if (this.disposed) return this.getState();
    this.state = { ...this.state, automaticChecksEnabled: enabled };
    this.emitState();
    if (enabled) {
      if (this.automaticChecksStarted) this.scheduleAutomaticCheck(this.initialCheckDelayMs);
    } else {
      this.cancelAutomaticTimer();
    }
    return this.getState();
  }

  startAutomaticChecks(): void {
    if (this.disposed || this.automaticChecksStarted) return;
    this.automaticChecksStarted = true;
    if (this.enabled && this.state.automaticChecksEnabled) {
      this.scheduleAutomaticCheck(this.initialCheckDelayMs);
    }
  }

  stopAutomaticChecks(): void {
    this.automaticChecksStarted = false;
    this.cancelAutomaticTimer();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAutomaticChecks();
    for (const remove of this.removeAdapterListeners.splice(0)) remove();
    this.listeners.clear();
  }

  private bindAdapterEvents(adapter: UpdateAdapter): void {
    this.removeAdapterListeners.push(
      adapter.on("checking-for-update", () => {
        if (this.disposed) return;
        this.details = {};
        this.transition("checking");
      }),
      adapter.on("update-not-available", () => {
        if (this.disposed) return;
        this.details = { checkedAt: this.now().toISOString() };
        this.transition("up-to-date");
        this.log("info", "application is up to date");
      }),
      adapter.on("update-available", (info) => {
        if (this.disposed) return;
        this.details = {
          availableVersion: plainText(info.version, 80),
          releaseName: info.releaseName ? plainText(info.releaseName, 300) : undefined,
          releaseDate: safeDate(info.releaseDate),
          releaseNotes: releaseNotesToText(info.releaseNotes),
          checkedAt: this.now().toISOString(),
        };
        this.transition("available");
        this.log("info", `update available: ${this.details.availableVersion ?? "unknown"}`);
      }),
      adapter.on("download-progress", (progress) => {
        if (this.disposed || this.state.phase !== "downloading") return;
        const percent = finiteNonNegative(progress.percent);
        this.transition("downloading", {
          percent: percent === undefined ? undefined : Math.min(100, percent),
          bytesPerSecond: finiteNonNegative(progress.bytesPerSecond),
          transferred: finiteNonNegative(progress.transferred),
          total: finiteNonNegative(progress.total),
        });
      }),
      adapter.on("update-downloaded", (info) => {
        if (this.disposed || !this.isPhase("available", "downloading")) return;
        this.details = {
          ...this.details,
          availableVersion: plainText(info.version, 80) ?? this.details.availableVersion,
          releaseName: info.releaseName ? plainText(info.releaseName, 300) : this.details.releaseName,
          releaseDate: safeDate(info.releaseDate) ?? this.details.releaseDate,
          releaseNotes: releaseNotesToText(info.releaseNotes) ?? this.details.releaseNotes,
        };
        this.downloadEventReceived = true;
        if (this.activeOperation?.kind !== "download" || this.downloadPromiseSettled) {
          this.finishDownloadedUpdate();
        }
      }),
      adapter.on("error", (error, message) => {
        if (this.disposed) return;
        const detail = message ? `${error.message}; ${message}` : error;
        const operation =
          this.activeOperation?.kind ??
          (this.state.phase === "installing" && this.installLifecyclePrepared ? "install" : undefined);
        this.recordAdapterError(detail, operation);
        if (operation === "install") void this.recoverInstallLifecycle();
      }),
    );
  }

  private transition(
    phase: UpdatePhase,
    patch: Partial<Pick<DesktopUpdateState, "percent" | "bytesPerSecond" | "transferred" | "total">> = {},
  ): void {
    if (this.disposed) return;
    const retainDetails =
      phase === "available" || phase === "downloading" || phase === "downloaded" || phase === "installing";
    this.state = {
      phase,
      currentVersion: this.currentVersion,
      automaticChecksEnabled: this.state.automaticChecksEnabled,
      installBlockedByActiveSessions: this.runningSessionCount > 0,
      canRetry: false,
      ...(retainDetails ? this.details : phase === "up-to-date" ? { checkedAt: this.details.checkedAt } : {}),
      ...patch,
    };
    this.emitState();
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(cloneState(state));
      } catch (error) {
        this.log("warn", `update state listener failed: ${redactUpdateError(error)}`);
      }
    }
  }

  private finishDownloadedUpdate(): void {
    if (this.disposed || !this.isPhase("available", "downloading")) return;
    this.transition("downloaded", { percent: 100 });
    this.log("info", `update downloaded: ${this.details.availableVersion ?? "unknown"}`);
  }

  private recoverInstallLifecycle(): Promise<void> {
    if (this.installRecoveryPromise) return this.installRecoveryPromise;
    if (!this.installLifecyclePrepared) return Promise.resolve();
    this.installLifecyclePrepared = false;
    const recovery = Promise.resolve()
      .then(() => this.recoverFromInstallFailure())
      .catch((error) => {
        this.log("error", `updater install recovery failed: ${redactUpdateError(error)}`);
      })
      .finally(() => {
        if (this.installRecoveryPromise === recovery) this.installRecoveryPromise = null;
      });
    this.installRecoveryPromise = recovery;
    return recovery;
  }

  private recordAdapterError(error: unknown, context?: UpdateOperation): void {
    const code = classifyUpdateError(error, context);
    const message = ERROR_MESSAGES[code];
    const detail = redactUpdateError(error);
    const duplicate = this.state.phase === "error" && this.state.error?.code === code;
    if (duplicate) return;
    this.state = {
      phase: "error",
      currentVersion: this.currentVersion,
      automaticChecksEnabled: this.state.automaticChecksEnabled,
      installBlockedByActiveSessions: this.runningSessionCount > 0,
      canRetry: code !== "UPDATE_SIGNATURE_INVALID" && code !== "UPDATE_UNSUPPORTED",
      error: { code, message },
    };
    this.emitState();
    this.log("error", `updater ${code}: ${detail}`);
  }

  private requireEnabled(): UpdateManagerError | null {
    if (this.enabled && this.adapter && !this.disposed) return null;
    return new UpdateManagerError("UPDATE_UNSUPPORTED", ERROR_MESSAGES.UPDATE_UNSUPPORTED);
  }

  private invalidState(action: string): UpdateManagerError {
    return new UpdateManagerError(
      "UPDATE_INVALID_STATE",
      `${ERROR_MESSAGES.UPDATE_INVALID_STATE} Cannot ${action} while phase is ${this.state.phase}.`,
    );
  }

  private isPhase(...phases: UpdatePhase[]): boolean {
    return phases.includes(this.state.phase);
  }

  private reuseOrReject<Result>(kind: UpdateOperation): Promise<Result> | null {
    if (!this.activeOperation) return null;
    if (this.activeOperation.kind === kind) return this.activeOperation.promise as Promise<Result>;
    return Promise.reject(new UpdateManagerError("UPDATE_BUSY", ERROR_MESSAGES.UPDATE_BUSY));
  }

  private trackOperation<Result>(kind: UpdateOperation, run: () => Promise<Result>): Promise<Result> {
    let resolveOperation: (value: Result | PromiseLike<Result>) => void = () => undefined;
    let rejectOperation: (reason?: unknown) => void = () => undefined;
    const promise = new Promise<Result>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.activeOperation = { kind, promise };
    let result: Promise<Result>;
    try {
      result = run();
    } catch (error) {
      rejectOperation(error);
      result = Promise.reject(error);
    }
    void result.then(resolveOperation, rejectOperation);
    void promise.then(
      () => {
        if (this.activeOperation?.promise === promise) this.activeOperation = null;
      },
      () => {
        if (this.activeOperation?.promise === promise) this.activeOperation = null;
      },
    );
    return promise;
  }

  private scheduleAutomaticCheck(delayMs: number): void {
    if (
      this.disposed ||
      !this.automaticChecksStarted ||
      !this.enabled ||
      !this.state.automaticChecksEnabled ||
      this.automaticTimer !== null
    ) {
      return;
    }
    this.automaticTimer = this.setTimer(() => {
      this.automaticTimer = null;
      const scheduleNext = () => {
        if (!this.disposed && this.automaticChecksStarted && this.state.automaticChecksEnabled) {
          const jitter = (this.random() * 2 - 1) * this.jitterRatio;
          this.scheduleAutomaticCheck(Math.round(this.checkIntervalMs * (1 + jitter)));
        }
      };
      if (!this.isPhase("idle", "up-to-date", "error")) {
        this.log("info", `automatic update check skipped while phase is ${this.state.phase}`);
        scheduleNext();
        return;
      }
      const check = this.checkForUpdates({ automatic: true });
      void check
        .catch((error) => {
          this.log("warn", `automatic update check was skipped: ${redactUpdateError(error)}`);
        })
        .finally(scheduleNext);
    }, delayMs);
    unrefTimer(this.automaticTimer);
  }

  private cancelAutomaticTimer(): void {
    if (this.automaticTimer === null) return;
    this.clearTimer(this.automaticTimer);
    this.automaticTimer = null;
  }
}

export function createUpdateManager(options: UpdateManagerOptions): UpdateManager {
  return new UpdateManager(options);
}
