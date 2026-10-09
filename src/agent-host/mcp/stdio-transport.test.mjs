import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { McpClient } from "@earendil-works/pi-mcp";
import { importTestBundle } from "#test-bundle";
const { ContainedMcpStdioTransport } = await importTestBundle("contained-mcp-stdio", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "stdio-transport.ts")],
});

test(
  "real MCP stdio runs in owned containment, preserves large raw replies and treats argv as literal",
  { skip: process.platform === "win32" ? "Native Windows Job covered by packaged Windows fixtures" : false },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-stdio-")),
      filename = path.join(root, "fixture.mjs"),
      marker = path.join(root, "MUST_NOT_EXECUTE");
    writeFileSync(
      filename,
      `
    import {createInterface} from 'node:readline';
    process.stderr.write('starting fixture '+process.env.FIXTURE_TOKEN+'\\n');
    for await (const line of createInterface({input:process.stdin})) {
      const request=JSON.parse(line); if (request.id===undefined) continue;
      const result=request.method==='initialize' ? {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
        : request.method==='tools/list' ? {tools:[{name:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}
        : {content:[{type:'text',text:'RAW_'+request.params.arguments.text+'_'+process.argv[2]+'_'+process.env.FIXTURE_TOKEN+'_'+'x'.repeat(131072)}],structuredContent:{original:true}};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
    }
  `,
    );
    const registered = [],
      removed = [],
      stderr = [];
    const context = {
      inventoryRevision: 1,
      resolutionId: "fixture",
      nativeEnv: { PATH: process.env.PATH },
      shellEnv: { PATH: process.env.PATH },
      commands: {},
      summary: [],
    };
    const transport = new ContainedMcpStdioTransport({
      config: { command: process.execPath, args: [filename, `$(touch ${marker}); #`] },
      cwd: root,
      trusted: true,
      env: { FIXTURE_TOKEN: "ORIGINAL_MCP_TOKEN" },
      onStderr: (text) => stderr.push(text),
      runtime: {
        createExecutionContext: async () => context,
        requireFromContext: () => ({ executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" }),
      },
      workerEntryPath: path.join(import.meta.dirname, "../managed-process/worker.ts"),
      workerExecArgv: ["--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"],
      parentCall: async (method, params) => {
        if (method === "managedProcesses.getSettings")
          return { reaperReady: true, capability: { ready: false }, containmentCapability: { ready: true } };
        if (method === "managedProcesses.register") {
          registered.push(params.record);
          return { journalRevision: 1 };
        }
        if (method === "managedProcesses.unregister") {
          removed.push(params);
          return { ok: true };
        }
        throw new Error("Unexpected parent method " + method);
      },
    });
    const client = new McpClient({ name: "fixture", version: "1", requestTimeoutMs: 5000 });
    t.after(async () => {
      await client.close();
      await transport.close();
      rmSync(root, { recursive: true, force: true });
    });
    await client.connect(transport);
    assert.equal((await client.listTools())[0].name, "echo");
    const result = await client.callTool("echo", { text: "原始结果😀" });
    assert.match(result.content[0].text, /RAW_原始结果😀/);
    assert.match(result.content[0].text, /ORIGINAL_MCP_TOKEN/);
    assert.ok(result.content[0].text.length > 131072);
    assert.equal(result.structuredContent.original, true);
    assert.equal(existsSync(marker), false);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].pgid, registered[0].pid);
    await client.close();
    await transport.close();
    assert.equal(removed.length, 1);
    assert.equal(removed[0].nonce, registered[0].nonce);
    assert.equal(
      stderr.some((text) => text.includes("ORIGINAL_MCP_TOKEN")),
      false,
    );
    assert.ok(stderr.some((text) => text.includes("starting fixture [REDACTED]")));
  },
);

test("MCP rejects unavailable native containment even when the managed feature projection is ready", async () => {
  const transport = new ContainedMcpStdioTransport({
    config: { command: process.execPath },
    cwd: process.cwd(),
    trusted: true,
    env: {},
    runtime: { createExecutionContext: async () => ({}) },
    parentCall: async () => ({
      reaperReady: true,
      capability: { ready: true },
      containmentCapability: { ready: false },
    }),
  });
  await assert.rejects(transport.start(), /MCP process containment is not ready/);
  await transport.close();
});
