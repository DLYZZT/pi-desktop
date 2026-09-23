import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import nodeTest from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
// Herdr integration is intentionally macOS/Linux-only until the Windows transport is implemented.
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

test("protocol 20 fixture maps Qwen and redacts session path details", async () => {
  const { __test } = await importTestBundle("src/agent-host/herdr/bridge", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  const fleet = __test.mapFleet(fixture, 3, 9);
  assert.equal(fleet.sourceGeneration, 9);
  assert.equal(fleet.revision, 4);
  assert.equal(fleet.stale, false);
  assert.equal(fleet.panes[0].agent.kind, "qwen");
  assert.equal(fleet.panes[0].agent.state, "working");
  assert.deepEqual(fleet.panes[0].agent.session, { kind: "path", displayValue: "session.json" });
  assert.equal(JSON.stringify(fleet).includes("credential-bearing"), false);
  assert.equal(JSON.stringify(fleet).includes("/private/"), false);
});

test("protocol 20 fixture rejects unknown and legacy protocol snapshots", async () => {
  const { __test } = await importTestBundle("src/agent-host/herdr/bridge-protocol-errors", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  for (const protocol of [14, 19, 21]) {
    assert.throws(
      () => __test.mapFleet({ ...fixture, snapshot: { ...fixture.snapshot, protocol } }, 0),
      (error) => error.code === "HERDR_PROTOCOL_UNSUPPORTED",
    );
  }
});

test("protocol 20 snapshots reject option-like identifiers and bound every collection", async () => {
  const { __test } = await importTestBundle("src/agent-host/herdr/bridge-safe-identifiers", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  const badId = structuredClone(fixture);
  badId.snapshot.panes[0].pane_id = "--session";
  assert.throws(
    () => __test.mapFleet(badId, 0),
    (error) => error.code === "HERDR_SCHEMA_INVALID",
  );

  const tooManyTabs = structuredClone(fixture);
  tooManyTabs.snapshot.tabs = Array.from({ length: 513 }, (_, index) => ({
    workspace_id: "w1",
    tab_id: `w1:t${index}`,
  }));
  assert.throws(
    () => __test.mapFleet(tooManyTabs, 0),
    (error) => error.code === "HERDR_PROTOCOL_LIMIT_EXCEEDED",
  );
});

test("Agent CLI diagnostics use the path-free Main snapshot without probing executables", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-agent-cli-diagnostics", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const bridge = new HerdrBridge(fakeServer());
  __test.applyRuntimeDescriptor(
    runtimeDescriptor(1, {
      agentClis: [
        { kind: "pi", available: true, status: "detected", source: "official", candidateCount: 1 },
        {
          kind: "claude",
          available: false,
          status: "missing-locally",
          candidateCount: 0,
          errorCode: "HERDR_AGENT_BINARY_MISSING",
        },
      ],
    }),
  );
  const diagnostics = (await bridge.getDiagnostics()).agentClis;
  assert.deepEqual(
    diagnostics.find((item) => item.kind === "pi"),
    {
      kind: "pi",
      available: true,
      status: "detected",
      source: "official",
      candidateCount: 1,
    },
  );
  assert.deepEqual(
    diagnostics.find((item) => item.kind === "claude"),
    {
      kind: "claude",
      available: false,
      status: "missing-locally",
      candidateCount: 0,
      errorCode: "HERDR_AGENT_BINARY_MISSING",
    },
  );
  assert.equal(JSON.stringify(diagnostics).includes("path"), false);
  await bridge.shutdown();
});

test("workspace validation rejects non-string labels before checking runtime readiness", async () => {
  const { HerdrBridge } = await importTestBundle("src/agent-host/herdr/bridge-workspace-validation", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const bridge = new HerdrBridge(fakeServer());
  await assert.rejects(
    bridge.createWorkspace("/tmp/project", { label: "unsafe" }),
    (error) => error.code === "HERDR_INVALID_REQUEST" && error.message === "Workspace parameters are invalid.",
  );
  await bridge.shutdown();
});

test("tab create, focus, and rename use the pinned protocol 20 shapes and refresh the fleet", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-tab-actions", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  const requests = [];
  const bridge = new HerdrBridge(fakeServer(), {
    reconnectDelayMs: () => 1,
    createClient: () => ({
      async assertSafeEndpoint() {},
      async request({ method, params }) {
        requests.push({ method, params });
        if (method === "ping") return { type: "pong", version: "0.8.2", protocol: 20 };
        if (method === "session.snapshot") return fixture;
        if (method === "tab.create") {
          return {
            type: "tab_created",
            tab: { workspace_id: "w1", tab_id: "w1:t2" },
            root_pane: { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2" },
          };
        }
        if (method === "tab.focus") {
          return { type: "tab_info", tab: { workspace_id: "w1", tab_id: "w1:t1", label: "1" } };
        }
        if (method === "tab.rename") {
          return { type: "tab_info", tab: { workspace_id: "w1", tab_id: "w1:t1", label: "Primary" } };
        }
        assert.fail(`Unexpected Herdr method: ${method}`);
      },
      subscribe(_subscriptions, _onEvent, _onClose, onReady) {
        globalThis.queueMicrotask(() => onReady?.());
        return () => undefined;
      },
    }),
  });
  __test.applyRuntimeDescriptor(runtimeDescriptor(1));
  await waitFor(() => bridge.getRuntime().status === "ready", "tab action bridge readiness");

  assert.deepEqual(await bridge.createTab("w1", "/tmp/project", "Review", false), {
    workspaceId: "w1",
    tabId: "w1:t2",
    rootPaneId: "w1:p2",
  });
  assert.deepEqual(await bridge.focusTab("w1:t1"), { workspaceId: "w1", tabId: "w1:t1" });
  assert.deepEqual(await bridge.renameTab("w1:t1", "Primary"), {
    workspaceId: "w1",
    tabId: "w1:t1",
    name: "Primary",
  });
  assert.deepEqual(
    requests.filter(({ method }) => method.startsWith("tab.")),
    [
      {
        method: "tab.create",
        params: { workspace_id: "w1", cwd: "/tmp/project", focus: false, label: "Review", env: {} },
      },
      { method: "tab.focus", params: { tab_id: "w1:t1" } },
      { method: "tab.rename", params: { tab_id: "w1:t1", label: "Primary" } },
    ],
  );
  assert.equal(requests.filter(({ method }) => method === "session.snapshot").length, 4);
  await assert.rejects(
    bridge.createTab("missing", "/tmp/project", "Review", false),
    (error) => error.code === "HERDR_INVALID_REQUEST",
  );
  await assert.rejects(bridge.renameTab("w1:t1", "   "), (error) => error.code === "HERDR_INVALID_REQUEST");
  await bridge.shutdown();
});

function runtimeDescriptor(revision, overrides = {}) {
  return {
    revision,
    enabled: true,
    mode: "attach",
    sessionName: "pi-desktop-test",
    autoConnect: true,
    releaseControlOnViewClose: true,
    executable: "/tmp/herdr",
    endpoint: "/tmp/herdr.sock",
    binarySource: "custom",
    version: "0.8.2",
    protocol: 20,
    schemaVersion: 1,
    ...overrides,
  };
}

async function waitFor(predicate, label, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function fakeServer() {
  const emitted = [];
  return {
    emitted,
    emit(type, target, value) {
      emitted.push({ type, target, value });
    },
  };
}

test("auto-connect retries until ready and manual disconnect cancels a pending refresh", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-reconnect", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  let attempts = 0;
  let eventHandler = null;
  const bridge = new HerdrBridge(fakeServer(), {
    reconnectDelayMs: () => 1,
    createClient: () => {
      attempts += 1;
      const attempt = attempts;
      return {
        async assertSafeEndpoint() {
          if (attempt <= 3) throw new Error("socket is not ready yet");
        },
        async request({ method }) {
          return method === "ping" ? { type: "pong", version: "0.8.2", protocol: 20 } : fixture;
        },
        subscribe(_subscriptions, onEvent, _onClose, onReady) {
          eventHandler = onEvent;
          globalThis.queueMicrotask(() => onReady?.());
          return () => undefined;
        },
      };
    },
  });
  __test.applyRuntimeDescriptor(runtimeDescriptor(1));

  await waitFor(() => bridge.getRuntime().status === "ready", "persistent reconnect");
  assert.equal(attempts, 4);
  const readyFleetRevision = bridge.getFleet().revision;
  eventHandler({ type: "event", event: { type: "pane.updated" } });
  await bridge.disconnect(false);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(attempts, 4);
  assert.equal(bridge.getRuntime().status, "unavailable");
  assert.equal(bridge.getFleet().stale, true);
  assert.equal(bridge.getFleet().revision, readyFleetRevision + 1);
  await bridge.shutdown();
});

test("manual disconnect survives descriptor refresh and autoConnect=false probe preserves ready", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-descriptor-state", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  let attempts = 0;
  const bridge = new HerdrBridge(fakeServer(), {
    reconnectDelayMs: () => 1,
    createClient: () => {
      attempts += 1;
      return {
        async assertSafeEndpoint() {},
        async request({ method }) {
          return method === "ping" ? { type: "pong", version: "0.8.2", protocol: 20 } : fixture;
        },
        subscribe(_subscriptions, _onEvent, _onClose, onReady) {
          globalThis.queueMicrotask(() => onReady?.());
          return () => undefined;
        },
      };
    },
  });

  __test.applyRuntimeDescriptor(runtimeDescriptor(1, { autoConnect: false }));
  assert.equal(bridge.getRuntime().status, "unavailable");
  await bridge.connect();
  assert.equal(bridge.getRuntime().status, "ready");
  await assert.rejects(bridge.sendAgentKeys("w1:p1", ["ctrl+x"]), (error) => error.code === "HERDR_INVALID_REQUEST");
  __test.applyRuntimeDescriptor(runtimeDescriptor(2, { autoConnect: false, releaseControlOnViewClose: false }));
  assert.equal(bridge.getRuntime().status, "ready");

  __test.applyRuntimeDescriptor(runtimeDescriptor(3, { autoConnect: true }));
  assert.equal(bridge.getRuntime().status, "ready");
  bridge.disconnect(false);
  __test.applyRuntimeDescriptor(runtimeDescriptor(4, { autoConnect: true, releaseControlOnViewClose: false }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(bridge.getRuntime().status, "unavailable");
  assert.equal(attempts, 1);
  await bridge.shutdown();
});

test("an unrelated descriptor refresh cannot cancel an in-flight manual connection", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-manual-connect-race", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  let releaseEndpoint;
  const endpointBlocked = new Promise((resolve) => {
    releaseEndpoint = resolve;
  });
  const bridge = new HerdrBridge(fakeServer(), {
    createClient: () => ({
      async assertSafeEndpoint() {
        await endpointBlocked;
      },
      async request({ method }) {
        return method === "ping" ? { type: "pong", version: "0.8.2", protocol: 20 } : fixture;
      },
      subscribe(_subscriptions, _onEvent, _onClose, onReady) {
        globalThis.queueMicrotask(() => onReady?.());
        return () => undefined;
      },
    }),
  });
  __test.applyRuntimeDescriptor(runtimeDescriptor(1, { autoConnect: false }));
  const connecting = bridge.connect();
  await waitFor(() => bridge.getRuntime().status === "connecting", "manual connecting state");
  __test.applyRuntimeDescriptor(runtimeDescriptor(2, { autoConnect: false, releaseControlOnViewClose: false }));
  releaseEndpoint();
  await connecting;
  assert.equal(bridge.getRuntime().status, "ready");
  await bridge.shutdown();
});

test("Agent start and input enforce cwd and ownership while local CLI discovery never blocks Herdr", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-agent-semantics", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  const withoutAgent = structuredClone(fixture);
  withoutAgent.snapshot.agents = [];
  delete withoutAgent.snapshot.panes[0].agent_status;
  const requests = [];
  let cwdAllowed = false;
  const bridge = new HerdrBridge(fakeServer(), {
    assertAllowedPath: async (cwd) => {
      if (!cwdAllowed || cwd !== "/tmp/protocol-v20") throw new Error("forbidden");
    },
    createClient: () => ({
      async assertSafeEndpoint() {},
      async request({ method, params }) {
        requests.push({ method, params });
        if (method === "ping") return { type: "pong", version: "0.8.2", protocol: 20 };
        if (method === "session.snapshot") return withoutAgent;
        if (method === "agent.start") return { type: "unexpected" };
        if (method === "agent.prompt") return { type: "unexpected" };
        if (method === "agent.send_keys") return { type: "unexpected" };
        assert.fail(`Unexpected Herdr method: ${method}`);
      },
      subscribe(_subscriptions, _onEvent, _onClose, onReady) {
        globalThis.queueMicrotask(() => onReady?.());
        return () => undefined;
      },
    }),
  });
  __test.applyRuntimeDescriptor(runtimeDescriptor(1));
  await waitFor(() => bridge.getRuntime().status === "ready", "Agent semantics readiness");
  await assert.rejects(bridge.startAgent("w1:p1", "claude"), (error) => error.code === "HERDR_CWD_FORBIDDEN");
  cwdAllowed = true;
  await assert.rejects(bridge.startAgent("w1:p1", "agy"), (error) => error.code === "HERDR_SCHEMA_INVALID");
  assert.deepEqual(
    requests.find(({ method }) => method === "agent.start"),
    {
      method: "agent.start",
      params: { name: "agy", kind: "agy", pane_id: "w1:p1", args: [], timeout_ms: 60_000 },
    },
  );
  await assert.rejects(bridge.promptAgent("w1:p1", "hello"), (error) => error.code === "HERDR_SCHEMA_INVALID");
  await assert.rejects(bridge.sendAgentKeys("w1:p1", ["enter"]), (error) => error.code === "HERDR_SCHEMA_INVALID");
  withoutAgent.snapshot.agents = fixture.snapshot.agents;
  await bridge.refreshSnapshot();
  await assert.rejects(bridge.startAgent("w1:p1", "claude"), (error) => error.code === "HERDR_AGENT_NOT_READY");
  await bridge.shutdown();
});

test("expanded semantic controls validate targets and redact Agent/process diagnostics", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-expanded-controls", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  const requests = [];
  const bridge = new HerdrBridge(fakeServer(), {
    createClient: () => ({
      async assertSafeEndpoint() {},
      async request({ method, params }) {
        requests.push({ method, params });
        if (method === "ping") return { type: "pong", version: "0.8.2", protocol: 20 };
        if (method === "session.snapshot") return fixture;
        if (method === "workspace.focus") return { type: "workspace_info", workspace: fixture.snapshot.workspaces[0] };
        if (method === "workspace.rename") {
          return {
            type: "workspace_info",
            workspace: { ...fixture.snapshot.workspaces[0], label: params.label },
          };
        }
        if (method === "pane.focus") return { type: "pane_info", pane: fixture.snapshot.panes[0] };
        if (method === "pane.rename") {
          return { type: "pane_info", pane: { ...fixture.snapshot.panes[0], label: params.label } };
        }
        if (method === "agent.focus") return { type: "agent_info", agent: fixture.snapshot.agents[0] };
        if (method === "agent.rename") {
          return { type: "agent_info", agent: { ...fixture.snapshot.agents[0], name: params.name } };
        }
        if (method === "agent.explain") {
          return {
            type: "agent_explain",
            explain: {
              evaluated_rules: [
                {
                  id: "blocked_literal",
                  state: "blocked",
                  region: "whole_recent",
                  evidence: { region_preview: "PRIVATE_TERMINAL_OUTPUT" },
                },
              ],
              matched_rule: { id: "blocked_literal", state: "blocked", region: "whole_recent" },
              fallback_reason: "default_known_agent_idle_fallback",
              manifest_source: "bundled",
              manifest_version: "2026.06.10.1",
              visible_blocker: true,
              warning: "/private/credential-bearing/warning",
            },
          };
        }
        if (method === "pane.process_info") {
          return {
            type: "pane_process_info",
            process_info: {
              pane_id: "w1:p1",
              shell_pid: 10,
              foreground_process_group_id: 20,
              foreground_processes: [
                {
                  pid: 20,
                  name: "node",
                  argv0: "/private/bin/qwen",
                  argv: ["qwen", "--token", "PRIVATE_TOKEN"],
                  cmdline: "qwen --token PRIVATE_TOKEN",
                  cwd: "/tmp/protocol-v20",
                },
              ],
              tty: "/private/dev/ttys001",
            },
          };
        }
        if (method === "pane.wait_for_output") {
          return {
            type: "output_matched",
            pane_id: "w1:p1",
            revision: 8,
            matched_line: "READY",
            read: {
              pane_id: "w1:p1",
              workspace_id: "w1",
              tab_id: "w1:t1",
              source: "recent_unwrapped",
              format: "text",
              text: "PRIVATE_SURROUNDING_OUTPUT\nREADY",
              revision: 8,
              truncated: false,
            },
          };
        }
        if (method === "workspace.close" || method === "pane.close") return { type: "ok" };
        assert.fail(`Unexpected Herdr method: ${method}`);
      },
      subscribe(_subscriptions, _onEvent, _onClose, onReady) {
        globalThis.queueMicrotask(() => onReady?.());
        return () => undefined;
      },
    }),
  });
  __test.applyRuntimeDescriptor(
    runtimeDescriptor(1, {
      agentClis: [{ kind: "qwen", available: true, status: "detected", source: "official" }],
    }),
  );
  await waitFor(() => bridge.getRuntime().status === "ready", "expanded controls readiness");

  assert.deepEqual(await bridge.focusWorkspace("w1"), { workspaceId: "w1" });
  assert.deepEqual(await bridge.renameWorkspace("w1", "Review"), { workspaceId: "w1", name: "Review" });
  assert.deepEqual(await bridge.focusPane("w1:p1"), { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" });
  assert.deepEqual(await bridge.renamePane("w1:p1", "Runner"), { paneId: "w1:p1", name: "Runner" });
  assert.deepEqual(await bridge.focusAgent("w1:p1"), { paneId: "w1:p1", agentKind: "qwen" });
  await assert.rejects(bridge.renameAgent("w1:p1", "CU Fake Pi"), (error) => error.code === "HERDR_INVALID_REQUEST");
  assert.deepEqual(await bridge.renameAgent("w1:p1", "reviewer"), {
    paneId: "w1:p1",
    agentKind: "qwen",
    name: "reviewer",
  });
  const explanation = await bridge.explainAgent("w1:p1");
  assert.equal(explanation.cli.available, true);
  assert.deepEqual(explanation.detection.matchedRule, {
    id: "blocked_literal",
    state: "blocked",
    region: "whole_recent",
  });
  assert.doesNotMatch(JSON.stringify(explanation), /PRIVATE|credential-bearing|region_preview|warning/);
  const processInfo = await bridge.getPaneProcessInfo("w1:p1");
  assert.deepEqual(processInfo.foregroundProcesses, [{ name: "node", cwdMatchesPane: true }]);
  assert.doesNotMatch(JSON.stringify(processInfo), /PRIVATE|\/tmp|\/private|argv|cmdline|tty|shell_pid/);
  assert.deepEqual(await bridge.waitForPaneOutput("w1:p1", "READY", 2_000, "output-wait-a"), {
    paneId: "w1:p1",
    matched: true,
    timedOut: false,
    revision: 8,
    matchedLine: "READY",
  });
  assert.deepEqual(await bridge.closeWorkspace("w1"), { workspaceId: "w1", closed: true });
  assert.deepEqual(await bridge.closePane("w1:p1"), {
    paneId: "w1:p1",
    workspaceId: "w1",
    tabId: "w1:t1",
    closed: true,
  });
  assert.deepEqual(await bridge.closeAgent("w1:p1"), {
    paneId: "w1:p1",
    workspaceId: "w1",
    tabId: "w1:t1",
    agentKind: "qwen",
    paneClosed: true,
  });
  assert.deepEqual(requests.find(({ method }) => method === "pane.wait_for_output")?.params, {
    pane_id: "w1:p1",
    source: "recent_unwrapped",
    match: { type: "substring", value: "READY" },
    lines: 1_000,
    strip_ansi: true,
    timeout_ms: 2_000,
  });
  assert.equal(
    requests.filter(({ method }) => method === "pane.close").length,
    2,
    "Agent close must use the reviewed pane.close semantic method",
  );
  await bridge.shutdown();
});

test("an event received during the initial snapshot schedules one trailing refresh", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-snapshot-handshake", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  let eventHandler = null;
  let releaseInitialSnapshot = null;
  let snapshotRequests = 0;
  const bridge = new HerdrBridge(fakeServer(), {
    reconnectDelayMs: () => 1,
    createClient: () => ({
      async assertSafeEndpoint() {},
      async request({ method }) {
        if (method === "ping") return { type: "pong", version: "0.8.2", protocol: 20 };
        snapshotRequests += 1;
        if (snapshotRequests === 1) {
          return new Promise((resolve) => {
            releaseInitialSnapshot = () => resolve(fixture);
          });
        }
        return fixture;
      },
      subscribe(_subscriptions, onEvent, _onClose, onReady) {
        eventHandler = onEvent;
        globalThis.queueMicrotask(() => onReady?.());
        return () => undefined;
      },
    }),
  });
  __test.applyRuntimeDescriptor(runtimeDescriptor(1));
  await waitFor(() => releaseInitialSnapshot, "initial snapshot request");
  eventHandler({ type: "event", event: { type: "pane.updated" } });
  releaseInitialSnapshot();

  await waitFor(() => bridge.getRuntime().status === "ready", "initial ready state");
  await waitFor(() => snapshotRequests === 2, "trailing snapshot refresh");
  assert.equal(bridge.getFleet().revision, 2);
  await bridge.shutdown();
});

test("same-stack subscription readiness and event cannot race ahead of the initial snapshot", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-same-stack-handshake", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  let snapshots = 0;
  const bridge = new HerdrBridge(fakeServer(), {
    createClient: () => ({
      async assertSafeEndpoint() {},
      async request({ method }) {
        if (method === "ping") return { type: "pong", version: "0.8.2", protocol: 20 };
        snapshots += 1;
        if (snapshots === 1) await new Promise((resolve) => setTimeout(resolve, 125));
        return fixture;
      },
      subscribe(_subscriptions, onEvent, _onClose, onReady) {
        onReady?.();
        onEvent({ type: "event", event: { type: "pane.updated" } });
        return () => undefined;
      },
    }),
  });
  __test.applyRuntimeDescriptor(runtimeDescriptor(1));
  await waitFor(() => bridge.getRuntime().status === "ready", "race-free initial handshake");
  await waitFor(() => snapshots === 2, "same-stack trailing refresh");
  assert.equal(bridge.getFleet().revision, 2);
  await bridge.shutdown();
});

test("subscription failure preserves snapshot reads in degraded mode without agent control", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-degraded-subscription", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  let snapshots = 0;
  const bridge = new HerdrBridge(fakeServer(), {
    createClient: () => ({
      async assertSafeEndpoint() {},
      async request({ method }) {
        if (method === "ping") return { type: "pong", version: "0.8.2", protocol: 20 };
        snapshots += 1;
        return fixture;
      },
      subscribe(_subscriptions, _onEvent, onClose) {
        onClose(new Error("event stream unavailable"));
        return () => undefined;
      },
    }),
  });
  __test.applyRuntimeDescriptor(runtimeDescriptor(1, { autoConnect: false }));
  const runtime = await bridge.connect();
  assert.equal(runtime.status, "degraded");
  assert.equal(runtime.capabilities.readOnly, true);
  assert.equal(runtime.capabilities.agentControl, false);
  await bridge.refreshSnapshot();
  assert.equal(snapshots, 2);
  await bridge.shutdown();
});

test("unsafe endpoints and post-ready protocol-limit violations are terminal until explicit retry", async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-unsafe-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const endpoint = path.join(directory, "not-a-socket");
  writeFileSync(endpoint, "unsafe");

  const unsafeModule = await importTestBundle("src/agent-host/herdr/bridge-unsafe-terminal", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const unsafeBridge = new unsafeModule.HerdrBridge(fakeServer(), { reconnectDelayMs: () => 1 });
  unsafeModule.__test.applyRuntimeDescriptor(runtimeDescriptor(1, { endpoint }));
  await waitFor(() => unsafeBridge.getRuntime().status === "error", "unsafe endpoint error");
  assert.equal(unsafeBridge.getRuntime().error?.code, "HERDR_ENDPOINT_UNSAFE");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(unsafeBridge.getRuntime().status, "error");
  await unsafeBridge.shutdown();

  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-limit-terminal", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  let snapshots = 0;
  let onEvent;
  const bridge = new HerdrBridge(fakeServer(), {
    reconnectDelayMs: () => 1,
    createClient: () => ({
      async assertSafeEndpoint() {},
      async request({ method }) {
        if (method === "ping") return { type: "pong", version: "0.8.2", protocol: 20 };
        snapshots += 1;
        if (snapshots === 1) return fixture;
        return {
          ...fixture,
          snapshot: {
            ...fixture.snapshot,
            tabs: Array.from({ length: 513 }, (_, index) => ({ workspace_id: "w1", tab_id: `w1:t${index}` })),
          },
        };
      },
      subscribe(_subscriptions, event, _onClose, onReady) {
        onEvent = event;
        globalThis.queueMicrotask(() => onReady?.());
        return () => undefined;
      },
    }),
  });
  __test.applyRuntimeDescriptor(runtimeDescriptor(1));
  await waitFor(() => bridge.getRuntime().status === "ready", "ready before limit failure");
  onEvent({ type: "event", event: { type: "pane.updated" } });
  await waitFor(() => bridge.getRuntime().status === "error", "protocol limit error");
  assert.equal(bridge.getRuntime().error?.code, "HERDR_PROTOCOL_LIMIT_EXCEEDED");
  await bridge.shutdown();
});

test("high-frequency events keep one snapshot in flight and one trailing refresh", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-event-burst", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", "session-snapshot-v20.json"), "utf8"),
  );
  let eventHandler = null;
  let snapshotRequests = 0;
  let concurrentSnapshots = 0;
  let maxConcurrentSnapshots = 0;
  let releaseRefresh = null;
  const bridge = new HerdrBridge(fakeServer(), {
    reconnectDelayMs: () => 1,
    createClient: () => ({
      async assertSafeEndpoint() {},
      async request({ method }) {
        if (method === "ping") return { type: "pong", version: "0.8.2", protocol: 20 };
        snapshotRequests += 1;
        concurrentSnapshots += 1;
        maxConcurrentSnapshots = Math.max(maxConcurrentSnapshots, concurrentSnapshots);
        if (snapshotRequests === 1) {
          concurrentSnapshots -= 1;
          return fixture;
        }
        if (snapshotRequests === 2) {
          await new Promise((resolve) => {
            releaseRefresh = resolve;
          });
        }
        concurrentSnapshots -= 1;
        return fixture;
      },
      subscribe(_subscriptions, onEvent, _onClose, onReady) {
        eventHandler = onEvent;
        globalThis.queueMicrotask(() => onReady?.());
        return () => undefined;
      },
    }),
  });
  __test.applyRuntimeDescriptor(runtimeDescriptor(1));
  await waitFor(() => bridge.getRuntime().status === "ready", "initial ready state");

  eventHandler({ type: "event", event: { type: "pane.updated" } });
  await waitFor(() => releaseRefresh, "first debounced refresh");
  for (let index = 0; index < 100; index += 1) {
    eventHandler({ type: "event", event: { type: "pane.updated" } });
  }
  assert.equal(snapshotRequests, 2);
  assert.equal(maxConcurrentSnapshots, 1);
  releaseRefresh();
  await waitFor(() => snapshotRequests === 3, "single trailing refresh");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(snapshotRequests, 3);
  assert.equal(maxConcurrentSnapshots, 1);
  await bridge.shutdown();
});

test("server and executable version mismatch fails closed as incompatible", async () => {
  const { HerdrBridge, __test } = await importTestBundle("src/agent-host/herdr/bridge-version-mismatch", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/bridge.ts"],
  });
  const bridge = new HerdrBridge(fakeServer(), {
    reconnectDelayMs: () => 1,
    createClient: () => ({
      async assertSafeEndpoint() {},
      async request() {
        return { type: "pong", version: "0.8.3", protocol: 20 };
      },
      subscribe() {
        assert.fail("version mismatch must fail before subscribing");
      },
    }),
  });

  __test.applyRuntimeDescriptor(runtimeDescriptor(1));
  await waitFor(() => bridge.getRuntime().status === "incompatible", "incompatible version state");
  assert.equal(bridge.getRuntime().error?.code, "HERDR_VERSION_UNSUPPORTED");
  await bridge.shutdown();
});
