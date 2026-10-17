import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { desktopMcpExtensions, initializeMcpService, getDefaultStore } = await importTestBundle(
  "mcp-powershell-grants",
  {
    packages: "external",
    stdin: {
      resolveDir: import.meta.dirname,
      loader: "ts",
      contents: `
    export {desktopMcpExtensions} from './extensions.ts';
    export {initializeMcpService} from './runtime.ts';
    export {getDefaultStore} from '../session-tool-store.ts';`,
    },
  },
);

test("MCP declaration and approval hooks never persist SDK-only PowerShell as an explicit Windows grant", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-ps-grants-"));
  const previous = {
    PI_DESKTOP_USER_DATA: process.env.PI_DESKTOP_USER_DATA,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.PI_DESKTOP_USER_DATA = root;
  process.env.PI_CODING_AGENT_DIR = root;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let store;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    store = getDefaultStore();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  const service = initializeMcpService({ emit() {} });
  t.after(async () => {
    await service.shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  let attached;
  t.mock.method(service, "attach", async (hooks) => {
    attached = hooks;
  });
  for (const action of ["setDeclarations", "setGrants"]) {
    const handlers = new Map();
    const policy = {
      setMcpAuthorizer() {},
      setMcpPreparation() {},
      setMcpIdentityGuard() {},
      setMcpExecution() {},
      isEmpty: () => false,
      isAllowed: () => false,
      describe: () => [
        { name: "read", active: true },
        { name: "powershell", active: true },
      ],
    };
    const extension = desktopMcpExtensions(policy, () => false).find((extension) => extension.name === "mcp");
    extension.factory({
      registerCommand() {},
      registerTool() {},
      on: (name, handler) => handlers.set(name, handler),
      getActiveTools: () => ["read", "powershell"],
    });
    await handlers.get("session_start")({}, { sessionManager: { getSessionId: () => action, getEntries: () => [] } });
    attached[action](["mcp__fixture__tool"]);
    assert.deepEqual(store.get(action), ["read"], action);
    assert.equal(store.getMcpExecution(action)?.includes("powershell") ?? false, false);
  }
});
