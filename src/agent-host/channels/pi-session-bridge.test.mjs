import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const mocks = new Map([
  [
    "rpc-manager",
    `
      const startCalls = [];
      const externalCommandCalls = [];
      let rpcSession;

      export function getRpcSession() {
        return rpcSession;
      }

      export function setRpcSession(value) {
        rpcSession = value;
      }

      export async function startRpcSession(sessionId, sessionFile, cwd, toolNames) {
        startCalls.push([sessionId, sessionFile, cwd, toolNames]);
        return {
          realSessionId: sessionId,
          session: {
            sessionId,
            cwd,
            async runExternalTurn() {
              return { finalText: "ok" };
            },
            async runExternalCommand(params) {
              externalCommandCalls.push(params);
            },
          },
        };
      }

      export function getStartCalls() {
        return structuredClone(startCalls);
      }

      export function getExternalCommandCalls() {
        return structuredClone(externalCommandCalls);
      }
    `,
  ],
  [
    "session-reader",
    `
      let sessionPath = null;
      export function setResolvedSessionPath(value) {
        sessionPath = value;
      }
      export async function resolveSessionPath() {
        return sessionPath;
      }
    `,
  ],
  ["file-access", "export function allowFileRoot() {}"],
  [
    "pi-coding-agent",
    `
      export const SessionManager = {
        open() {
          return { getHeader() { return { cwd: "/restored-cwd" }; } };
        },
      };
    `,
  ],
]);

const { PiSessionBridge, getExternalCommandCalls, getStartCalls, setResolvedSessionPath, setRpcSession } =
  await importTestBundle("src/agent-host/channels/pi-session-bridge", {
    stdin: {
      contents: `
      export { PiSessionBridge } from "./pi-session-bridge.ts";
      export {
        getExternalCommandCalls,
        getStartCalls,
        setRpcSession,
      } from "bridge-test-rpc-control";
      export { setResolvedSessionPath } from "bridge-test-session-control";
    `,
      resolveDir: import.meta.dirname,
      sourcefile: "pi-session-bridge-test-entry.ts",
      loader: "ts",
    },
    plugins: [
      {
        name: "pi-session-bridge-mocks",
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/rpc-manager$/ }, () => ({
            path: "rpc-manager",
            namespace: "pi-session-bridge-test",
          }));
          builder.onResolve({ filter: /^bridge-test-rpc-control$/ }, () => ({
            path: "rpc-manager",
            namespace: "pi-session-bridge-test",
          }));
          builder.onResolve({ filter: /^\.\.\/session-reader$/ }, () => ({
            path: "session-reader",
            namespace: "pi-session-bridge-test",
          }));
          builder.onResolve({ filter: /^bridge-test-session-control$/ }, () => ({
            path: "session-reader",
            namespace: "pi-session-bridge-test",
          }));
          builder.onResolve({ filter: /^\.\.\/file-access$/ }, () => ({
            path: "file-access",
            namespace: "pi-session-bridge-test",
          }));
          builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
            path: "pi-coding-agent",
            namespace: "pi-session-bridge-test",
          }));
          builder.onLoad({ filter: /.*/, namespace: "pi-session-bridge-test" }, (args) => ({
            contents: mocks.get(args.path),
            loader: "js",
          }));
        },
      },
    ],
  });

test("restoring a channel session applies the binding tool names", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-session-bridge-tools-"));
  setResolvedSessionPath("/sessions/session-history.jsonl");
  const bridge = new PiSessionBridge(() => {});
  const toolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];

  try {
    await bridge.runCommand(
      {
        id: "binding-one",
        channel: "telegram",
        accountId: "telegram-one",
        peerKind: "dm",
        peerId: "user-one",
        sessionId: "session-history",
        cwd,
        toolNames,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      },
      "reload",
    );

    assert.deepEqual(getStartCalls().at(-1), [
      "session-history",
      "/sessions/session-history.jsonl",
      "/restored-cwd",
      toolNames,
    ]);
    assert.deepEqual(getExternalCommandCalls().at(-1), { command: "reload" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a new dedicated session uses current account defaults instead of the stale binding snapshot", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-session-bridge-new-tools-"));
  setResolvedSessionPath(null);
  const bridge = new PiSessionBridge(() => {});
  const fullTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const binding = {
    id: "binding-stale-tools",
    channel: "weixin",
    accountId: "weixin-one",
    peerKind: "dm",
    peerId: "user-one",
    cwd,
    toolNames: [],
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };

  try {
    await bridge.newSession(binding, fullTools);
    assert.deepEqual(getStartCalls().at(-1).slice(1), ["", cwd, fullTools]);

    await bridge.runTurn(
      binding,
      {
        id: "message-one",
        channel: "weixin",
        accountId: "weixin-one",
        peer: { kind: "dm", id: "user-one" },
        sender: { id: "user-one" },
        text: "hello",
        mentionsBot: false,
        attachments: [],
        timestamp: Date.now(),
      },
      undefined,
      [],
      fullTools,
    );
    assert.deepEqual(getStartCalls().at(-1).slice(1), ["", cwd, fullTools]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tool synchronization updates a live Desktop session without writing through the bridge sidecar", async () => {
  const commands = [];
  const sidecarWrites = [];
  setRpcSession({
    isAlive: () => true,
    async send(command) {
      commands.push(command);
    },
  });
  const bridge = new PiSessionBridge(
    () => {},
    (sessionId, toolNames) => {
      sidecarWrites.push({ sessionId, toolNames: [...toolNames] });
    },
  );
  const fullTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

  try {
    await bridge.syncTools(
      {
        id: "binding-live-tools",
        channel: "weixin",
        accountId: "weixin-one",
        peerKind: "dm",
        peerId: "user-one",
        sessionId: "session-live",
        cwd: "/tmp",
        toolNames: [],
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      },
      fullTools,
    );

    assert.deepEqual(commands, [{ type: "set_tools", toolNames: fullTools }]);
    assert.deepEqual(sidecarWrites, []);
  } finally {
    setRpcSession(undefined);
  }
});

test("tool synchronization persists inactive sessions only in the Desktop sidecar", async () => {
  const sidecarWrites = [];
  setRpcSession(undefined);
  const bridge = new PiSessionBridge(
    () => {},
    (sessionId, toolNames) => {
      sidecarWrites.push({ sessionId, toolNames: [...toolNames] });
    },
  );

  await bridge.syncTools(
    {
      id: "binding-inactive-tools",
      channel: "telegram",
      accountId: "telegram-one",
      peerKind: "dm",
      peerId: "user-one",
      sessionId: "session-inactive",
      cwd: "/tmp",
      toolNames: [],
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    },
    ["read"],
  );

  assert.deepEqual(sidecarWrites, [{ sessionId: "session-inactive", toolNames: ["read"] }]);
});
