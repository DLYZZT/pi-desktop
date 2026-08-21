import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import type { BrowserCapabilitySnapshot } from "../contract/browser";
import type { BrowserAgentAuthorizationRequest, BrowserEvent } from "../contract/browser";
import { BrowserError } from "../main/browser/browser-error";
import { BrowserService } from "../main/browser/browser-service";
import { HostManager, type HostStatus } from "../main/host-manager";
import { ManagedProcessReaper } from "../main/managed-process/reaper";
import { resolveRuntimeCatalogPath } from "../main/toolchains/catalog";
import { ToolchainManager } from "../main/toolchains/manager";
import { isExecutionIntent } from "../shared/toolchains/types";

type BrowserAgentFixtureStatus = {
  sessionId: string;
  sessionFile?: string;
  activeTools: string[];
  isRunning: boolean;
  isStreaming: boolean;
  fauxCallCount: number;
  pendingResponses: number;
  assistantTexts: string[];
  toolResults: string[];
  toolResultTexts: string[];
  browserMetrics: {
    callCount: number;
    screenshotCount: number;
    javascriptCount: number;
    resultTextChars: number;
    blockedRetries: number;
    blockedBypasses: number;
    replanIssued: boolean;
    budgetExhausted: boolean;
  };
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-agent-e2e-"));
const projectRoot = path.join(root, "project");
const browserDataRoot = path.join(root, "browser-data");
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(browserDataRoot, { recursive: true });
app.setPath("userData", path.join(root, "user-data"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "sessions");
process.env.PI_OFFLINE = "1";

const hostEntryValue = process.env.PI_BROWSER_AGENT_E2E_HOST_ENTRY;
assert.ok(hostEntryValue && path.isAbsolute(hostEntryValue), "PI_BROWSER_AGENT_E2E_HOST_ENTRY must be absolute");
const hostEntry = hostEntryValue;
assert.ok(fs.existsSync(hostEntry), `Browser Agent E2E Host entry is missing: ${hostEntry}`);

let mainWindow: BrowserWindow | null = null;
let fixtureServer: http.Server | null = null;
let browserService: BrowserService | null = null;
let hostManager: HostManager | null = null;
let managedProcessReaper: ManagedProcessReaper | null = null;
let finishing = false;

function log(message: string): void {
  console.log(`[browser-agent-e2e] ${message}`);
}

async function waitFor<T>(
  label: string,
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastValue = await read();
      if (accept(lastValue)) return lastValue;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = lastError instanceof Error ? lastError.message : JSON.stringify(lastValue);
  throw new Error(`Timed out waiting for ${label}: ${detail ?? "no value"}`);
}

async function startFixtureServer(): Promise<string> {
  fixtureServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><meta charset="utf-8"><title>Agent Browser Fixture</title></head>
        <body>
          <button id="agent-action">Run Agent action</button>
          <div id="output">ready</div>
          <script>
            document.getElementById("agent-action").onclick = () => {
              document.getElementById("output").textContent = "clicked-by-agent";
            };
          </script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer!.once("error", reject);
    fixtureServer!.listen(0, "127.0.0.1", resolve);
  });
  const address = fixtureServer.address();
  if (!address || typeof address === "string") throw new Error("Browser Agent fixture server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function closeFixtureServer(): Promise<void> {
  const current = fixtureServer;
  fixtureServer = null;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

async function finish(exitCode: number, error?: unknown): Promise<void> {
  if (finishing) return;
  finishing = true;
  if (error) console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  await hostManager?.stop().catch(() => undefined);
  hostManager = null;
  await managedProcessReaper?.reapAll().catch(() => undefined);
  managedProcessReaper = null;
  await browserService?.dispose().catch(() => undefined);
  browserService = null;
  await closeFixtureServer().catch(() => undefined);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
  fs.rmSync(root, { recursive: true, force: true });
  app.exit(exitCode);
}

async function run(): Promise<void> {
  const fixtureOrigin = await startFixtureServer();
  const managedFixturePath = path.join(projectRoot, "managed-e2e-fixture.mjs");
  fs.writeFileSync(
    managedFixturePath,
    `import http from "node:http";
const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>managed-e2e</title><main>managed-e2e-ready</main>");
});
server.listen(0, "127.0.0.1", () => console.log("MANAGED_READY http://127.0.0.1:" + server.address().port + "/"));
process.stdin.on("data", (chunk) => {
  console.error("STDIN_PENDING");
  setTimeout(() => console.log("STDIN " + chunk.toString().trim()), 500);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
`,
    { mode: 0o600 },
  );
  const managedCommand = `'${process.execPath.replaceAll("'", `'"'"'`)}' managed-e2e-fixture.mjs`;
  mainWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await mainWindow.loadURL("data:text/html,<title>Browser Agent E2E Host Window</title>");
  mainWindow.show();
  await new Promise((resolve) => setTimeout(resolve, 250));

  let latestBrowserSnapshot: BrowserCapabilitySnapshot | null = null;
  const authorizationRequests: BrowserAgentAuthorizationRequest[] = [];
  let routeBypassRequests = 0;
  browserService = new BrowserService({
    userDataDir: browserDataRoot,
    getWindow: () => mainWindow,
    confirm: async () => true,
    confirmSensitiveAction: async () => true,
    confirmExternalProtocol: async () => false,
    confirmPrivateNetwork: async () => true,
    confirmRouteBypass: async () => {
      routeBypassRequests += 1;
      return false;
    },
    emit: (event: BrowserEvent) => {
      if (event.type === "agent-authorization-request") authorizationRequests.push(event.request);
    },
    onCapabilitySnapshot: (snapshot) => {
      latestBrowserSnapshot = snapshot;
      hostManager?.setBrowserCapabilitySnapshot(snapshot);
    },
  });
  browserService.updateSettings({
    enabled: true,
    navigation: { allowHttp: true, allowPrivateNetwork: true },
    automation: { enabled: true },
  });
  latestBrowserSnapshot = browserService.getCapabilitySnapshot();

  const toolchainManager = new ToolchainManager({
    homeDir: app.getPath("home"),
    tempRoot: root,
    userDataRoot: app.getPath("userData"),
    resourcesRoot: process.resourcesPath,
    catalogPath: resolveRuntimeCatalogPath({
      isPackaged: false,
      resourcesRoot: process.resourcesPath,
    }),
  });
  await toolchainManager.initialize();

  const browserCalls = new Map<string, number>();
  managedProcessReaper = new ManagedProcessReaper(path.join(app.getPath("userData"), "managed-process-reaper.json"));
  assert.equal((await managedProcessReaper.initialize()).ready, true, "managed process reaper did not initialize");
  hostManager = new HostManager(hostEntry);
  hostManager.setBeforeRestartHandler(async () => {
    await managedProcessReaper!.reapAll();
  });
  hostManager.setToolchainSnapshot(toolchainManager.getSnapshot());
  hostManager.setBrowserCapabilitySnapshot(latestBrowserSnapshot);
  hostManager.setRequestHandler(async (method, params) => {
    if (method === "toolchain.getSnapshot") return toolchainManager.getSnapshot();
    if (method === "toolchain.resolve") {
      const body = (params ?? {}) as { cwd?: unknown; intent?: unknown; trusted?: unknown };
      if (
        typeof body.cwd !== "string" ||
        !path.isAbsolute(body.cwd) ||
        body.cwd.length > 4_096 ||
        /[\0\r\n]/.test(body.cwd) ||
        !isExecutionIntent(body.intent) ||
        typeof body.trusted !== "boolean"
      ) {
        throw new Error("Invalid Browser Agent E2E toolchain request");
      }
      return toolchainManager.resolveForProject(body.cwd, { intent: body.intent, trusted: body.trusted });
    }
    if (method === "managedProcesses.getSettings") {
      return { enabled: true, reaperReady: managedProcessReaper!.status().ready, platform: process.platform };
    }
    if (method === "managedProcesses.register") {
      return managedProcessReaper!.register((params as { record?: unknown } | undefined)?.record);
    }
    if (method === "managedProcesses.unregister") return managedProcessReaper!.unregister(params);
    if (method.startsWith("browser.")) {
      browserCalls.set(method, (browserCalls.get(method) ?? 0) + 1);
      try {
        return await browserService!.handleHostRequest(method, params);
      } catch (error) {
        if (error instanceof BrowserError) {
          log(`${method} rejected with ${error.code}: ${error.message}`);
          throw error;
        }
        throw error;
      }
    }
    throw new Error(`Unsupported Browser Agent E2E Host request: ${method}`);
  });

  const hostStatuses: Array<{ status: HostStatus; detail?: string }> = [];
  hostManager.setStatusListener((status, detail) => hostStatuses.push({ status, detail }));
  hostManager.start();
  await waitFor(
    "real Agent Host readiness",
    () => hostManager!.getStatus(),
    (status) => status === "ready",
  );
  await waitFor(
    "initial Browser capability acknowledgement",
    () => hostManager!.getBrowserAckRevision(),
    (revision) => revision >= latestBrowserSnapshot!.revision,
  );
  log("real Agent Host ready and Browser policy synchronized");

  const created = await hostManager.call<{ sessionId: string }>(
    "agent.new",
    { cwd: projectRoot, type: "ensure_session" },
    30_000,
  );
  assert.ok(created.sessionId, "agent.new did not return a session ID");
  const sessionId = created.sessionId;

  let status = await hostManager.call<BrowserAgentFixtureStatus>("browserAgentE2e.status", { sessionId });
  assert.ok(status.activeTools.includes("browser_open"), "read Browser tool was not promptable");
  assert.ok(status.activeTools.includes("browser_click"), "interactive Browser tool was not promptable");
  assert.ok(status.activeTools.includes("process_start"), "managed process start tool was not promptable");
  assert.ok(status.activeTools.includes("process_stop"), "managed process stop tool was not promptable");
  assert.ok(
    !status.activeTools.includes("browser_execute_javascript"),
    "advanced Browser tool was promptable while Advanced Browser Mode was disabled",
  );
  log("base Browser tools are promptable without an eager grant");

  await hostManager.call("browserAgentE2e.configure", { sessionId, origin: fixtureOrigin, managedCommand });
  const readCommand = hostManager.call(
    "agent.command",
    { sessionId, command: { type: "prompt", message: "Open and inspect the local Browser fixture." } },
    45_000,
  );
  const readAuthorization = await waitFor(
    "read authorization preflight",
    () => authorizationRequests.find((request) => request.minimumPermission === "read"),
    (request) => !!request,
  );
  assert.equal(browserService.listTabs(sessionId).length, 0, "authorization preflight created a Browser tab");
  assert.equal(browserCalls.get("browser.open") ?? 0, 0, "browser.open executed before authorization");
  browserService.respondAgentAuthorization(readAuthorization!.id, "allow-session");
  await readCommand;
  status = await waitFor(
    "Agent read flow completion",
    () => hostManager!.call<BrowserAgentFixtureStatus>("browserAgentE2e.status", { sessionId }),
    (value) =>
      value.fauxCallCount >= 3 &&
      !value.isRunning &&
      !value.isStreaming &&
      value.assistantTexts.some((text) => text.startsWith("read-complete:")),
  );
  assert.ok(status.toolResults.includes("browser_open"), "Agent did not execute browser_open");
  assert.ok(status.toolResults.includes("browser_inspect"), "Agent did not execute browser_inspect");
  const readMetrics = { ...status.browserMetrics };
  const ownedTabs = browserService.listTabs(sessionId);
  assert.equal(ownedTabs.length, 1, "Agent Browser tab ownership was not preserved");
  assert.ok(ownedTabs[0]?.url.startsWith(fixtureOrigin), "Agent Browser tab did not load the fixture origin");
  browserService.setBounds({ tabId: ownedTabs[0]!.id, rect: { x: 0, y: 0, width: 800, height: 600 } });
  browserService.setSurfaceVisible({ tabId: ownedTabs[0]!.id, visible: true });
  log("Agent executed browser_open → browser_inspect through Main");

  const interactCommand = hostManager.call(
    "agent.command",
    { sessionId, command: { type: "prompt", message: "Click the fixture action and verify its result." } },
    45_000,
  );
  const interactAuthorization = await waitFor(
    "interact authorization preflight",
    () => authorizationRequests.find((request) => request.minimumPermission === "interact"),
    (request) => !!request,
  );
  assert.equal(browserCalls.get("browser.click") ?? 0, 0, "browser.click executed before interact authorization");
  await new Promise((resolve) => setTimeout(resolve, 250));
  browserService.respondAgentAuthorization(interactAuthorization!.id, "allow-session");
  await interactCommand;
  status = await waitFor(
    "Agent interactive flow completion",
    () => hostManager!.call<BrowserAgentFixtureStatus>("browserAgentE2e.status", { sessionId }),
    (value) =>
      value.fauxCallCount >= 6 &&
      !value.isRunning &&
      !value.isStreaming &&
      value.assistantTexts.includes("interact-complete:assertion=browser_click:clicked"),
  );
  assert.ok(status.toolResults.includes("browser_click"), "Agent did not execute browser_click");
  const interactMetrics = { ...status.browserMetrics };
  assert.equal(browserCalls.get("browser.open"), 1, "unexpected browser.open Parent RPC count");
  assert.equal(browserCalls.get("browser.inspect"), 2, "unexpected browser.inspect Parent RPC count");
  assert.equal(browserCalls.get("browser.snapshot") ?? 0, 0, "Agent bypassed the inspect-first path");
  assert.equal(browserCalls.get("browser.click"), 1, "unexpected browser.click Parent RPC count");
  assert.equal(browserCalls.get("browser.wait") ?? 0, 0, "unexpected browser.wait Parent RPC count");
  assert.equal(browserCalls.get("browser.requestAuthorization"), 2, "unexpected authorization preflight count");
  assert.ok((browserCalls.get("browser.capabilities") ?? 0) >= 6, "Browser tools bypassed capability leases");
  log("Agent executed the authorized browser_click exactly once");

  const bypassCommand = hostManager.call(
    "agent.command",
    {
      sessionId,
      command: {
        type: "prompt",
        message: "Try the denied local-file Browser route, but do not bypass Browser policy without approval.",
      },
    },
    45_000,
  );
  await bypassCommand;
  status = await waitFor(
    "Agent Browser route bypass guard completion",
    () => hostManager!.call<BrowserAgentFixtureStatus>("browserAgentE2e.status", { sessionId }),
    (value) =>
      value.fauxCallCount >= 9 &&
      !value.isRunning &&
      !value.isStreaming &&
      value.assistantTexts.includes("bypass-complete:blocked-before-exec"),
  );
  assert.ok(status.toolResults.includes("bash"), "bypass fixture did not reach the guarded Bash tool");
  assert.equal(routeBypassRequests, 1, "same-target Browser route bypass did not ask the local user exactly once");
  assert.equal(
    fs.existsSync(path.join(projectRoot, "browser-bypass-marker")),
    false,
    "denied Browser route bypass executed a shell side effect",
  );
  assert.equal(browserCalls.get("browser.requestRouteBypass"), 1);
  assert.equal(status.browserMetrics.blockedBypasses, 1);
  const totalFixtureCalls = readMetrics.callCount + interactMetrics.callCount + status.browserMetrics.callCount;
  const totalFixtureScreenshots =
    readMetrics.screenshotCount + interactMetrics.screenshotCount + status.browserMetrics.screenshotCount;
  const totalFixtureResultChars =
    readMetrics.resultTextChars + interactMetrics.resultTextChars + status.browserMetrics.resultTextChars;
  assert.ok(totalFixtureCalls <= 45, `Phase 9 fixture used ${totalFixtureCalls} Browser calls`);
  assert.ok(totalFixtureScreenshots <= 8, `Phase 9 fixture used ${totalFixtureScreenshots} screenshots`);
  assert.ok(totalFixtureResultChars <= 80_000, `Phase 9 fixture returned ${totalFixtureResultChars} text chars`);
  log(
    `Phase 9 efficiency calls=${totalFixtureCalls} screenshots=${totalFixtureScreenshots} resultChars=${totalFixtureResultChars}`,
  );

  await hostManager.call(
    "agent.command",
    {
      sessionId,
      command: {
        type: "prompt",
        message:
          "Start the local development fixture, inspect it in Browser, exercise stdin and logs, then restart it.",
      },
    },
    60_000,
  );
  status = await waitFor(
    "managed process Agent flow completion",
    () => hostManager!.call<BrowserAgentFixtureStatus>("browserAgentE2e.status", { sessionId }),
    (value) =>
      !value.isRunning &&
      !value.isStreaming &&
      value.assistantTexts.includes("managed-complete:process+logs+browser+stdin+restart"),
  );
  for (const toolName of [
    "process_start",
    "process_write",
    "process_wait",
    "process_restart",
    "browser_open",
    "browser_inspect",
  ]) {
    assert.ok(status.toolResults.includes(toolName), `managed Agent flow did not execute ${toolName}`);
  }
  assert.ok(
    status.toolResults.filter((toolName) => toolName === "process_wait").length >= 2,
    "managed Agent flow did not continue process_wait after unrelated output",
  );
  const activeSnapshot = await hostManager.call<{
    processes: Array<{ processId: string; runId: string; generation: number; state: string }>;
  }>("processes.list", { includeExited: true });
  const activeManaged = activeSnapshot.processes.find(
    (process) => process.generation === 2 && ["running", "ready"].includes(process.state),
  );
  assert.ok(activeManaged, "Agent restart did not leave the second managed generation visible to the UI API");
  await hostManager.call("processes.stop", {
    processId: activeManaged!.processId,
    runId: activeManaged!.runId,
    mode: "graceful",
  });
  await hostManager.call("browserAgentE2e.configureManagedFollowup", {
    sessionId,
    phase: "barrier",
    processId: activeManaged!.processId,
    runId: activeManaged!.runId,
  });
  await hostManager.call(
    "agent.command",
    { sessionId, command: { type: "prompt", message: "Continue the managed process after the user stop." } },
    30_000,
  );
  status = await waitFor(
    "user stop barrier",
    () => hostManager!.call<BrowserAgentFixtureStatus>("browserAgentE2e.status", { sessionId }),
    (value) => value.assistantTexts.includes("managed-user-stop-barrier-observed"),
  );
  assert.ok(
    status.toolResultTexts.some((value) => value.includes("PROCESS_USER_STOPPED")),
    "Agent did not receive the structured user stop barrier",
  );

  const userRestarted = await hostManager.call<{ processId: string; runId: string; generation: number }>(
    "processes.restart",
    { processId: activeManaged!.processId, runId: activeManaged!.runId },
    30_000,
  );
  assert.equal(userRestarted.generation, 3, "user restart did not clear the stop barrier");
  await hostManager.call("browserAgentE2e.configureManagedFollowup", {
    sessionId,
    phase: "stop",
    processId: userRestarted.processId,
    runId: userRestarted.runId,
  });
  await hostManager.call(
    "agent.command",
    { sessionId, command: { type: "prompt", message: "Stop the user-restarted managed fixture." } },
    30_000,
  );
  status = await waitFor(
    "Agent managed stop",
    () => hostManager!.call<BrowserAgentFixtureStatus>("browserAgentE2e.status", { sessionId }),
    (value) => value.assistantTexts.includes("managed-agent-stop-complete"),
  );
  assert.ok(status.toolResults.includes("process_stop"), "Agent did not execute process_stop");
  assert.equal(managedProcessReaper.status().records, 0, "normal managed stop left a reaper journal record");

  assert.ok(status.sessionFile && fs.existsSync(status.sessionFile), "Agent session file was unavailable");
  const persistedSession = fs.readFileSync(status.sessionFile!, "utf8");
  assert.equal(persistedSession.includes("managed-e2e-fixture.mjs"), false, "raw process command entered JSONL");
  assert.equal(persistedSession.includes("electron-input"), false, "managed stdin or output entered JSONL");
  assert.match(persistedSession, /Managed process tool result omitted from disk history/);
  log("Agent managed process tools, UI control, Browser evidence, stop barrier and JSONL redaction passed");

  browserService.revokeSession(sessionId);
  await waitFor(
    "revocation acknowledgement",
    () => hostManager!.getBrowserAckRevision(),
    (revision) => revision >= latestBrowserSnapshot!.revision,
  );
  status = await waitFor(
    "Browser promptable tools after revocation",
    () => hostManager!.call<BrowserAgentFixtureStatus>("browserAgentE2e.status", { sessionId }),
    (value) => value.activeTools.includes("browser_open") && value.activeTools.includes("browser_click"),
  );
  assert.equal(browserService.getCapabilitySnapshot().sessionPermissions[sessionId], undefined);
  assert.ok(!hostStatuses.some(({ status: value }) => value === "crashed"), "Agent Host crashed during the E2E flow");
  log("revocation removed the runtime grant while keeping base tools promptable");
  log("PASS real Agent → Host → Main → Electron Browser end-to-end");
}

void app.whenReady().then(
  () =>
    run().then(
      () => finish(0),
      (error) => finish(1, error),
    ),
  (error) => finish(1, error),
);

app.on("before-quit", () => void hostManager?.stop());
