import path from "node:path";
import { getAgentDir, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { RpcError } from "../contract/types";
import {
  noticeKeys,
  type NoticeKey,
  type NoticeSettingsStatus,
  type NoticePreferences,
} from "../shared/transcript-notices";

type NoticeScope = { agentDir?: string; sessionTrusted?: boolean; reportErrors?: boolean };
function openSettings(cwd: string | undefined, { agentDir = getAgentDir(), sessionTrusted }: NoticeScope) {
  if (cwd !== undefined && (typeof cwd !== "string" || !path.isAbsolute(cwd)))
    throw new RpcError({ code: "BAD_REQUEST", message: "Expected an absolute project directory" });
  const global = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  if (!cwd || sessionTrusted === false) return global;
  const policy = global.getDefaultProjectTrust();
  const trusted =
    new ProjectTrustStore(agentDir).get(cwd) ?? (policy === "always" || (policy === "ask" && sessionTrusted === true));
  return trusted ? SettingsManager.create(cwd, agentDir, { projectTrusted: true }) : global;
}

export function readNoticeSettings(cwd?: string, scope: NoticeScope = {}): NoticeSettingsStatus {
  return noticeSnapshot(openSettings(cwd, scope), scope.reportErrors === true).status;
}

interface NoticeSnapshot {
  status: NoticeSettingsStatus;
  global?: Partial<NoticePreferences>;
  project?: Partial<NoticePreferences>;
}

function noticeSnapshot(
  settings: SettingsManager,
  reportGlobalError: boolean,
  previous?: NoticeSnapshot,
): NoticeSnapshot {
  const errors = settings.drainErrors();
  if (reportGlobalError && errors.some((error) => error.scope === "global"))
    throw new RpcError({ code: "INTERNAL", message: "Global Pi notice settings could not be read" });
  // Like SDK reload, retain each scope's last good values on a parse/read error.
  // A denied project is never loaded, so it cannot carry its old overrides into this view.
  const saved =
    (errors.some((error) => error.scope === "global") ? previous?.global : undefined) ??
    settings.getGlobalSettings().notices;
  const overrides =
    (errors.some((error) => error.scope === "project") && settings.isProjectTrusted()
      ? previous?.project
      : undefined) ?? settings.getProjectSettings().notices;
  const global = {} as NoticePreferences,
    project: Partial<NoticePreferences> = {};
  for (const key of noticeKeys) {
    global[key] = saved?.[key] === true;
    if (typeof overrides?.[key] === "boolean") project[key] = overrides[key];
  }
  const effective = settings.getNotices();
  return {
    global: saved,
    project: overrides,
    status: {
      global,
      project,
      ...(errors.some((error) => error.scope === "project") ? { projectLoadFailed: true as const } : {}),
      effective: Object.fromEntries(
        noticeKeys.map((key) => [
          key,
          errors.length && previous ? (project[key] ?? global[key]) : effective[key] === true,
        ]),
      ) as NoticePreferences,
    },
  };
}

export async function writeNoticeSetting(key: NoticeKey, shown: boolean, cwd?: string, scope: NoticeScope = {}) {
  if (!noticeKeys.includes(key) || typeof shown !== "boolean")
    throw new RpcError({ code: "BAD_REQUEST", message: "Invalid transcript notice setting" });
  const settings = openSettings(cwd, scope);
  if (settings.drainErrors().some((error) => error.scope === "global"))
    throw new RpcError({ code: "INTERNAL", message: "Global Pi notice settings could not be read" });
  settings.setNotice(key, shown);
  await settings.flush();
  // The global write is committed. A concurrent edit that breaks the project file may
  // change its effective override, but cannot turn a successful global save into a failure.
  const { status } = noticeSnapshot(openSettings(cwd, scope), true);
  if (settings.drainErrors().some((error) => error.scope === "global") || status.global[key] !== shown)
    throw new RpcError({ code: "INTERNAL", message: "Transcript notice setting could not be saved" });
  return status;
}

export function historyNoticePreferences(cwd?: string, live?: SettingsManager) {
  const project = cwd && path.isAbsolute(cwd) ? cwd : undefined;
  const registered = live && sessionViews.get(live);
  if (live && registered && registered.cwd === project) return live.getNotices();
  return readNoticeSettings(project, { sessionTrusted: registered ? undefined : live?.isProjectTrusted?.() }).effective;
}

type LiveSession = {
  readonly sessionId: string;
  readonly cwd: string;
  isAlive(): boolean;
  readonly inner: { settingsManager: SettingsManager };
};

// Pi's applyOverrides only changes the effective object; any subsequent SDK setter rebuilds it.
// Keep Desktop's committed notice view independent of unrelated SDK saves. Only the public notice
// readers and explicit notice changes need this overlay. Synchronization itself makes no file writes.
const sessionViews = new WeakMap<SettingsManager, { cwd: string | undefined; refresh: () => void }>();

export function bindSessionNotices(settings: SettingsManager, cwd: string | undefined, agentDir = getAgentDir()): void {
  const bound = sessionViews.get(settings);
  if (bound) return bound.refresh();

  let trust = settings.isProjectTrusted();
  const read = (previous?: NoticeSnapshot) =>
    noticeSnapshot(openSettings(cwd, { agentDir, sessionTrusted: settings.isProjectTrusted() }), false, previous);
  let view = read();
  let local: Partial<NoticePreferences> | undefined;
  function refresh() {
    view = read(view);
    local = undefined;
    trust = settings.isProjectTrusted();
  }
  function checkTrust() {
    if (trust !== settings.isProjectTrusted()) refresh();
  }

  const getAll = settings.getSettings.bind(settings);
  const set = settings.setNotice.bind(settings);
  const apply = settings.applyOverrides.bind(settings);
  const reload = settings.reload.bind(settings);
  settings.getNotices = () => {
    checkTrust();
    return { ...view.status.effective, ...local };
  };
  settings.getSettings = () => {
    const value = getAll();
    checkTrust();
    if (view.global || view.project || local)
      value.notices = structuredClone({ ...view.global, ...view.project, ...local });
    else delete value.notices;
    return value;
  };
  settings.setNotice = (key, shown) => {
    set(key, shown);
    checkTrust();
    local = undefined;
    (view.global ??= {})[key] = shown;
    view.status.global[key] = shown;
    view.status.effective[key] = view.status.project[key] ?? shown;
  };
  settings.applyOverrides = (overrides) => {
    apply(overrides);
    if (!overrides.notices) return;
    checkTrust();
    for (const key of noticeKeys) {
      const value = overrides.notices[key];
      if (typeof value === "boolean") (local ??= {})[key] = value;
    }
  };
  settings.reload = async () => {
    await reload();
    refresh();
  };
  sessionViews.set(settings, { cwd, refresh });
}

export function applyLiveNoticeSettings(sessions: Iterable<LiveSession>) {
  for (const session of sessions) {
    if (!session.isAlive()) continue;
    try {
      bindSessionNotices(session.inner.settingsManager, session.cwd || undefined);
    } catch (error) {
      console.warn(
        `[pi-desktop] notice settings refresh failed for ${session.sessionId}: ${error instanceof Error ? error.name : "UnknownError"}`,
      );
    }
  }
}
