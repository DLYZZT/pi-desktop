#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { ManagedProcessService } from "../src/agent-host/managed-process/service.ts";
import { applyManagedProcessOwnerIdentity } from "../src/agent-host/managed-process/owner-identity.ts";
import { resolveWindowsManagedProcessHelper } from "../src/shared/windows-managed-process-helper.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolveFixtureRoot();
const fixture = await mkdtemp(path.join(fixtureRoot, ".pi-managed-workflows-"));
const packagedResourcesPath = process.env.PI_WINDOWS_MANAGED_HELPER_RESOURCES_PATH;
const workerEntry = fileURLToPath(new URL("../src/agent-host/managed-process/worker.ts", import.meta.url));
const viteEntry = path.join(root, "node_modules", "vite", "bin", "vite.js");
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const commandFor = (file, ...args) => [quote(process.execPath), quote(file), ...args.map(quote)].join(" ");
function nativeWindowsBash() {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
    "D:\\tools\\w64devkit\\bin\\bash.exe",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function findExecutable(names) {
  for (const name of names) {
    try {
      const executable = execFileSync(process.platform === "win32" ? "where.exe" : "which", [name], {
        encoding: "utf8",
        windowsHide: true,
      })
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .find((value) => value && existsSync(value));
      if (executable) return executable;
    } catch {
      // Keep probing the fixed interpreter candidates.
    }
  }
  return undefined;
}

function resolveFixtureRoot() {
  const configured = process.env.PI_MANAGED_PROCESS_WORKFLOW_FIXTURE_ROOT;
  if (!configured) return root;
  if (!path.isAbsolute(configured) || !existsSync(configured)) {
    throw new Error("PI_MANAGED_PROCESS_WORKFLOW_FIXTURE_ROOT must point to an existing absolute directory");
  }
  return realpathSync.native(configured);
}

const bashExecutable = process.platform === "win32" ? nativeWindowsBash() : "/bin/bash";
if (!bashExecutable) throw new Error("A native Windows Bash is required for managed process workflows");
let windowsHelper;
if (process.platform === "win32") {
  const script = `$p=Get-Process -Id ${process.pid} -ErrorAction Stop; [Console]::Out.Write([DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds())`;
  const startedAt = Number(
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  Object.defineProperty(process, "getCreationTime", { value: () => startedAt, configurable: true });
  applyManagedProcessOwnerIdentity({
    type: "managed-process-owner:init",
    version: 1,
    mainPid: process.pid,
    mainStartFingerprint: String(startedAt),
    mainImagePath: realpathSync.native(process.execPath),
    hostInstanceId: randomUUID(),
  });
  const resolution = resolveWindowsManagedProcessHelper({
    isPackaged: Boolean(packagedResourcesPath),
    resourcesPath: packagedResourcesPath ?? root,
    projectRoot: root,
  });
  if (!resolution.ok) throw new Error(`Windows helper is unavailable: ${resolution.errorCode}`);
  windowsHelper = resolution.descriptor;
}
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
          executable: bashExecutable,
          argvPrefix: [],
          binDir: path.dirname(bashExecutable),
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
      if (method === "managedProcesses.getSettings")
        return process.platform === "win32"
          ? {
              enabled: true,
              reaperReady: true,
              capability: {
                platform: "win32",
                arch: "x64",
                supported: true,
                ready: true,
                backend: "windows-job",
                helperBuildId: windowsHelper.buildId,
                helperProvenance: windowsHelper.provenance,
              },
              windowsHelper,
            }
          : { enabled: true, reaperReady: true };
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

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(Number.isSafeInteger(port) && port > 0);
  return port;
}

async function waitForPortClosed(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const closed = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      const finishClosed = () => {
        socket.destroy();
        resolve(true);
      };
      socket.once("error", finishClosed);
      socket.once("timeout", finishClosed);
    });
    if (closed) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${port} remained open`);
}

async function fetchEventually(url, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error(`endpoint ${url} did not become ready`);
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

async function stop(started, mode = "graceful") {
  await service.stop(started.process.processId, started.runId, mode, "user", "workflow-session");
}

if (fixture.startsWith("\\\\")) {
  let uncServer;
  try {
    assert.ok(packagedResourcesPath, "UNC acceptance must use the packaged Windows helper");
    const uncWorkspace = path.join(fixture, "UNC Unicode 空格 😀");
    await mkdir(uncWorkspace);
    const markerFile = path.join(uncWorkspace, "marker.txt");
    await writeFile(markerFile, "unc-workspace-ok\n");
    const serverCode = `const{readFileSync}=require("node:fs");const http=require("node:http");const marker=readFileSync("marker.txt","utf8").trim();const s=http.createServer((q,r)=>{r.setHeader("content-type","application/json");r.end(JSON.stringify({cwd:process.cwd(),marker}))});s.listen(0,"127.0.0.1",()=>console.log("UNC_READY http://127.0.0.1:"+s.address().port+"/"));for(const x of ["SIGINT","SIGTERM"])process.on(x,()=>s.close(()=>process.exit(0)));`;
    uncServer = await service.startForAgent("workflow-session", uncWorkspace, true, {
      command: [quote(process.execPath), quote("-e"), quote(serverCode)].join(" "),
      label: "packaged UNC Node service",
      waitFor: { type: "loopback-url", timeoutMs: 5_000 },
    });
    assert.equal(uncServer.state, "ready", JSON.stringify(uncServer.output.records));
    const payload = await (await globalThis.fetch(uncServer.endpoints[0].url)).json();
    assert.equal(payload.marker, "unc-workspace-ok");
    assert.equal(path.win32.normalize(payload.cwd).toLowerCase(), path.win32.normalize(uncWorkspace).toLowerCase());
    const port = endpointPort(uncServer.endpoints[0].url);
    await stop(uncServer, "graceful");
    uncServer = undefined;
    await waitForPortClosed(port);
    process.stdout.write(
      `${JSON.stringify({ ok: true, workspace: "unc", helper: "packaged", scenarios: ["Bash/Node UNC cwd", "Unicode/space/emoji UNC path", "UNC file access", "UNC loopback service", "graceful tree cleanup"] })}\n`,
    );
  } finally {
    if (uncServer) await stop(uncServer).catch(() => undefined);
    await service.stopAll("host");
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  process.exit(0);
}

let frontend;
let api;
let watcher;
let storybook;
let flask;
let fastapi;
const frameworkScenarios = [];
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
  const frontendPort = await reserveLoopbackPort();
  frontend = await service.startForAgent("workflow-session", fixture, true, {
    command: `${commandFor(viteEntry)} --host 127.0.0.1 --port ${frontendPort} --strictPort`,
    label: "React + Three.js Vite",
    waitFor: { type: "loopback-url", timeoutMs: 5_000 },
  });
  assert.equal(frontend.state, "ready", JSON.stringify(frontend.output.records));
  const frontendResponse = await globalThis.fetch(frontend.endpoints[0].url);
  const frontendHtml = await frontendResponse.text();
  assert.match(
    frontendHtml,
    /src\/main\.jsx/,
    JSON.stringify({
      url: frontend.endpoints[0].url,
      status: frontendResponse.status,
      contentType: frontendResponse.headers.get("content-type"),
      html: frontendHtml,
      output: frontend.output.records,
    }),
  );

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
    label: "cold-start wait model",
    waitFor: { type: "loopback-url", timeoutMs: 500 },
  });
  assert.equal(storybook.readiness.state, "timed-out");
  const storybookReady = await waitForState(storybook, (info) => info.endpoints.length > 0, 5_000);
  assert.match(await (await globalThis.fetch(storybookReady.info.endpoints[0].url)).text(), /storybook/);

  await stop(watcher);
  watcher = undefined;
  await stop(storybook);
  storybook = undefined;

  const python = findExecutable(process.platform === "win32" ? ["python.exe"] : ["python3", "python"]);
  if (python) {
    const frameworkModulesAvailable = (() => {
      try {
        execFileSync(python, ["-c", "import flask,fastapi,uvicorn"], { windowsHide: true, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    if (frameworkModulesAvailable) {
      const venv = path.join(fixture, "venv Unicode 环境");
      execFileSync(python, ["-m", "venv", "--system-site-packages", venv], {
        timeout: 60_000,
        windowsHide: true,
        stdio: "ignore",
      });
      const venvPython = path.join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      execFileSync(venvPython, ["-c", "import flask,fastapi,uvicorn"], { windowsHide: true, stdio: "ignore" });

      const flaskFile = path.join(fixture, "flask_fixture.py");
      await writeFile(
        flaskFile,
        `import sys\nfrom flask import Flask\napp=Flask(__name__)\n@app.get("/")\ndef root(): return {"framework":"flask"}\nport=int(sys.argv[1])\nprint(f"FLASK_READY http://127.0.0.1:{port}/",flush=True)\napp.run(host="127.0.0.1",port=port,debug=False,use_reloader=False)\n`,
      );
      const flaskPort = await reserveLoopbackPort();
      flask = await service.startForAgent("workflow-session", fixture, true, {
        command: `${quote(venvPython)} -u ${quote(flaskFile)} ${flaskPort}`,
        label: "Flask venv Unicode path",
        waitFor: { type: "output", contains: "FLASK_READY", timeoutMs: 5_000 },
      });
      assert.deepEqual(await (await fetchEventually(`http://127.0.0.1:${flaskPort}/`)).json(), {
        framework: "flask",
      });
      await stop(flask, "graceful");
      flask = undefined;
      await waitForPortClosed(flaskPort);
      frameworkScenarios.push("Flask venv Unicode graceful");

      const fastapiFile = path.join(fixture, "fastapi_fixture.py");
      await writeFile(
        fastapiFile,
        `import sys\nimport uvicorn\nfrom fastapi import FastAPI\napp=FastAPI()\n@app.get("/")\ndef root(): return {"framework":"fastapi"}\nport=int(sys.argv[1])\nprint(f"FASTAPI_READY http://127.0.0.1:{port}/",flush=True)\nuvicorn.run(app,host="127.0.0.1",port=port,log_level="warning",access_log=False)\n`,
      );
      const fastapiPort = await reserveLoopbackPort();
      fastapi = await service.startForAgent("workflow-session", fixture, true, {
        command: `${quote(venvPython)} -u ${quote(fastapiFile)} ${fastapiPort}`,
        label: "FastAPI venv Unicode path",
        waitFor: { type: "output", contains: "FASTAPI_READY", timeoutMs: 5_000 },
      });
      assert.deepEqual(await (await fetchEventually(`http://127.0.0.1:${fastapiPort}/`)).json(), {
        framework: "fastapi",
      });
      await stop(fastapi, "force");
      fastapi = undefined;
      await waitForPortClosed(fastapiPort);
      frameworkScenarios.push("FastAPI venv Unicode force");
    }
  }

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
    `${JSON.stringify({ ok: true, workspace: fixture.startsWith("\\\\") ? "unc" : "local", helper: packagedResourcesPath ? "packaged" : "development", scenarios: ["React/Vite", "Three.js CDN", "mock API", "watch build", "cold-start wait model", ...frameworkScenarios, "parallel services", "port conflict"] })}\n`,
  );
} finally {
  for (const started of [fastapi, flask, storybook, watcher, api, frontend]) {
    if (started) await stop(started).catch(() => undefined);
  }
  await service.stopAll("host");
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
