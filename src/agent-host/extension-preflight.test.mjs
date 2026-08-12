import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";

test("a broken provider extension reports diagnostics without blocking a base session", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-extension-preflight-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, "project");
  const agentDir = path.join(base, "agent");
  const sessionDir = path.join(base, "sessions");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(sessionDir);

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "broken-provider",
          factory(pi) {
            pi.registerProvider("broken-provider", { models: [], streamSimple() {} });
          },
        },
      ],
    },
  });

  assert.equal(services.diagnostics.length, 1);
  assert.equal(services.diagnostics[0].type, "error");
  assert.match(services.diagnostics[0].message, /<inline:broken-provider>/);
  assert.match(services.diagnostics[0].message, /"api" is required when registering streamSimple/);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(cwd, sessionDir),
    tools: [],
  });
  assert.ok(session);
  await session.dispose();
});
