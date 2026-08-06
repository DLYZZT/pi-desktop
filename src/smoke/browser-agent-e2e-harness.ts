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
import { resolveRuntimeCatalogPath } from "../main/toolchains/catalog";
import { ToolchainManager } from "../main/toolchains/manager";
import { isExecutionIntent } from "../shared/toolchains/types";

type BrowserAgentFixtureStatus = {
  sessionId: string;
  activeTools: string[];
  isRunning: boolean;
  isStreaming: boolean;
  fauxCallCount: number;
  pendingResponses: number;
  assistantTexts: string[];
  toolResults: string[];
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
  hostManager?.stop();
  hostManager = null;
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
  hostManager = new HostManager(hostEntry);
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
  assert.ok(
    !status.activeTools.includes("browser_execute_javascript"),
    "advanced Browser tool was promptable while Advanced Browser Mode was disabled",
  );
  log("base Browser tools are promptable without an eager grant");

  await hostManager.call("browserAgentE2e.configure", { sessionId, origin: fixtureOrigin });
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

app.on("before-quit", () => hostManager?.stop());
