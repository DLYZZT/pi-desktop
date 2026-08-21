#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedProcessService } from "../src/agent-host/managed-process/service.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(root, ".pi-managed-workflows-"));
const workerEntry = fileURLToPath(new URL("../src/agent-host/managed-process/worker.ts", import.meta.url));
const viteEntry = path.join(root, "node_modules", "vite", "bin", "vite.js");
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const commandFor = (file, ...args) => [quote(process.execPath), quote(file), ...args.map(quote)].join(" ");
const runtime = {
  async createExecutionContext() {
    return {
      inventoryRevision: 1,
      resolutionId: "managed-workflows",
      nativeEnv: { ...process.env },
      shellEnv: { ...process.env },
      commands: {
        "shell.bash": {
          capability: "shell.bash",
          provider: "system",
          executable: "/bin/bash",
          argvPrefix: [],
          binDir: "/bin",
          cwdSemantics: "native",
          envPatch: {},
        },
      },
      summary: [],
    };
  },
  requireFromContext(_capability, context) {
    return context.commands["shell.bash"];
  },
};

let journalRevision = 0;
const service = new ManagedProcessService(
  { emit() {} },
  {
    platform: process.platform,
    runtime,
    workerEntryPath: workerEntry,
    workerExecArgv: ["--experimental-strip-types"],
    parentCall: async (method) => {
      if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
      if (method === "managedProcesses.register") return { journalRevision: ++journalRevision };
      if (method === "managedProcesses.unregister") return { journalRevision: ++journalRevision, removed: true };
      throw new Error(`unexpected parent call: ${method}`);
    },
  },
);

function endpointPort(url) {
  const port = Number(new URL(url).port);
  assert.ok(Number.isSafeInteger(port) && port > 0, `invalid endpoint: ${url}`);
  return port;
}

async function waitForState(started, accept, timeoutMs = 5_000) {
  let cursor = started.output.nextCursor;
  let latest = started.output;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = service.get(started.process.processId, "workflow-session");
    if (accept(info, latest)) return { info, output: latest };
    latest = await service.wait(
      {
        processId: started.process.processId,
        runId: started.runId,
        cursor,
        timeoutMs: Math.min(1_000, deadline - Date.now()),
      },
      "workflow-session",
    );
    cursor = latest.nextCursor;
  }
  throw new Error(`timed out waiting for ${started.process.label}`);
}

async function stop(started) {
  await service.stop(started.process.processId, started.runId, "graceful", "user", "workflow-session");
}

let frontend;
let api;
let watcher;
let storybook;
try {
  await writeFile(
    path.join(fixture, "index.html"),
    `<!doctype html><html><body><div id="root"></div><button id="wireframe">wireframe</button><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js"}}</script><script type="module" src="/src/main.jsx"></script></body></html>`,
  );
  await writeFile(
    path.join(fixture, "src-main.tmp"),
    `import React from "react";import{createRoot}from"react-dom/client";function App(){return React.createElement("main",null,"React managed fixture")};createRoot(document.getElementById("root")).render(React.createElement(App));import("three").then(()=>console.log("three-loaded"));`,
  );
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await rename(path.join(fixture, "src-main.tmp"), path.join(fixture, "src", "main.jsx"));
  frontend = await service.startForAgent("workflow-session", fixture, true, {
    command: `${commandFor(viteEntry)} --host 127.0.0.1 --port 0 --strictPort`,
    label: "React + Three.js Vite",
    waitFor: { type: "loopback-url", timeoutMs: 5_000 },
  });
  assert.equal(frontend.state, "ready");
  assert.match(await (await globalThis.fetch(frontend.endpoints[0].url)).text(), /src\/main\.jsx/);

  const apiFile = path.join(fixture, "api.mjs");
  await writeFile(
    apiFile,
    `import http from"node:http";const s=http.createServer((q,r)=>{r.setHeader("content-type","application/json");r.end(JSON.stringify({ok:true}))});s.listen(0,"127.0.0.1",()=>console.log("API_READY http://127.0.0.1:"+s.address().port+"/"));process.stdin.on("data",c=>console.log("API_STDIN "+c.toString().trim()));for(const x of ["SIGINT","SIGTERM"])process.on(x,()=>s.close(()=>process.exit(0)));`,
  );
  api = await service.startForAgent("workflow-session", fixture, true, {
    command: commandFor(apiFile),
    label: "mock API",
    waitFor: { type: "loopback-url", timeoutMs: 5_000 },
  });
  assert.deepEqual(await (await globalThis.fetch(api.endpoints[0].url)).json(), { ok: true });
  service.write({ processId: api.process.processId, runId: api.runId, text: "reload" }, "workflow-session");
  const apiStdin = await service.wait(
    {
      processId: api.process.processId,
      runId: api.runId,
      cursor: api.output.nextCursor,
      contains: "API_STDIN reload",
      timeoutMs: 2_000,
    },
    "workflow-session",
  );
  assert.ok(apiStdin.records.some((record) => record.text.includes("API_STDIN reload")));

  const watchedFile = path.join(fixture, "watched.css");
  const watcherFile = path.join(fixture, "watcher.mjs");
  await writeFile(watchedFile, "body{}\n");
  await writeFile(
    watcherFile,
    `import{watch}from"node:fs";const w=watch(${JSON.stringify(watchedFile)},()=>console.log("REBUILD_OK"));console.log("WATCH_READY");for(const x of ["SIGINT","SIGTERM"])process.on(x,()=>{w.close();process.exit(0)});`,
  );
  watcher = await service.startForAgent("workflow-session", fixture, true, {
    command: commandFor(watcherFile),
    label: "watch build",
    kind: "watcher",
    waitFor: { type: "output", contains: "WATCH_READY", timeoutMs: 2_000 },
  });
  await writeFile(watchedFile, "body{color:red}\n");
  const rebuild = await service.wait(
    {
      processId: watcher.process.processId,
      runId: watcher.runId,
      cursor: watcher.output.nextCursor,
      contains: "REBUILD_OK",
      timeoutMs: 2_000,
    },
    "workflow-session",
  );
  assert.ok(rebuild.records.some((record) => record.text.includes("REBUILD_OK")));

  const storybookFile = path.join(fixture, "storybook.mjs");
  await writeFile(
    storybookFile,
    `import http from"node:http";setTimeout(()=>{const s=http.createServer((q,r)=>r.end("storybook"));s.listen(0,"127.0.0.1",()=>console.log("STORYBOOK_READY http://127.0.0.1:"+s.address().port+"/"));for(const x of ["SIGINT","SIGTERM"])process.on(x,()=>s.close(()=>process.exit(0)))},1200);`,
  );
  storybook = await service.startForAgent("workflow-session", fixture, true, {
    command: commandFor(storybookFile),
    label: "Storybook cold start",
    waitFor: { type: "loopback-url", timeoutMs: 500 },
  });
  assert.equal(storybook.readiness.state, "timed-out");
  const storybookReady = await waitForState(storybook, (info) => info.endpoints.length > 0, 5_000);
  assert.match(await (await globalThis.fetch(storybookReady.info.endpoints[0].url)).text(), /storybook/);

  await stop(watcher);
  watcher = undefined;
  await stop(storybook);
  storybook = undefined;

  const conflictFile = path.join(fixture, "conflict.mjs");
  await writeFile(
    conflictFile,
    `import http from"node:http";http.createServer(()=>{}).listen(${endpointPort(api.endpoints[0].url)},"127.0.0.1");`,
  );
  const conflict = await service.startForAgent("workflow-session", fixture, true, {
    command: commandFor(conflictFile),
    label: "port conflict",
  });
  const conflictExit = await waitForState(conflict, (info) => ["failed", "exited"].includes(info.state));
  assert.equal(conflictExit.info.state, "failed");
  assert.equal(service.get(frontend.process.processId).state, "ready");
  assert.equal(service.get(api.process.processId).state, "ready");

  await stop(api);
  api = undefined;
  assert.equal(service.get(frontend.process.processId).state, "ready");
  await stop(frontend);
  frontend = undefined;

  process.stdout.write(
    `${JSON.stringify({ ok: true, scenarios: ["React/Vite", "Three.js CDN", "mock API", "watch build", "Storybook cold start", "parallel services", "port conflict"] })}\n`,
  );
} finally {
  for (const started of [storybook, watcher, api, frontend]) {
    if (started) await stop(started).catch(() => undefined);
  }
  await service.stopAll("host");
  await rm(fixture, { recursive: true, force: true });
}
