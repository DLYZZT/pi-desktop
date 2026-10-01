import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
const { desktopMcpExtensions, sessionOrchestrationExtensions, initializeMcpService, SessionToolPolicy } =
  await importTestBundle("mcp-builtin-loading", {
    packages: "external",
    stdin: {
      contents:
        'export {desktopMcpExtensions} from "./extensions.ts"; export {sessionOrchestrationExtensions} from "../session-orchestration.ts"; export {initializeMcpService} from "./runtime.ts"; export {SessionToolPolicy} from "../session-tool-policy.ts";',
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
  });

for (const replacement of [false, true])
  test(`Desktop MCP factories respect ${replacement ? "third-party replacement" : "shared builtin disable selectors"}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-builtins-"));
    const mcp = initializeMcpService({ emit() {} });
    t.after(async () => {
      await mcp.shutdown();
      rmSync(root, { recursive: true, force: true });
    });
    const factories = [
      ...sessionOrchestrationExtensions(),
      ...desktopMcpExtensions(new SessionToolPolicy({}, []), () => false),
    ];
    if (replacement)
      factories.push({
        name: "other-mcp",
        factory: (pi) => pi.registerCommand("mcp", { description: "Third-party manager", handler: async () => {} }),
      });
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory({
        cacheWarming: "off",
        extensions: replacement ? [] : ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search"],
      }),
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: factories,
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    assert.equal(
      loaded.extensions.some((extension) => extension.path === "builtin:mcp"),
      false,
    );
    if (!replacement) {
      assert.equal(
        loaded.extensions.some((extension) => extension.path === "builtin:codemode"),
        false,
      );
      assert.equal(
        loaded.extensions.some((extension) => extension.path === "builtin:tool-search"),
        false,
      );
    } else {
      assert.ok(loaded.extensions.some((extension) => extension.commands.has("mcp")));
    }
    const manager = SessionManager.inMemory(root);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model: services.modelRuntime.getModel("anthropic", "claude-sonnet-5-5"),
    });
    t.after(() => session.dispose());
    await session.bindExtensions({ mode: "rpc" });
    assert.equal(mcp.panel(manager.getSessionId()).inactiveReason, replacement ? "replaced" : "disabled");
    assert.deepEqual(mcp.snapshot("unopened"), []);
  });
