#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedProcessService } from "../src/agent-host/managed-process/service.ts";
import { applyManagedProcessOwnerIdentity } from "../src/agent-host/managed-process/owner-identity.ts";
import { resolveWindowsManagedProcessHelper } from "../src/shared/windows-managed-process-helper.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log(JSON.stringify({ ok: true, skipped: "Windows x64 framework acceptance only" }));
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRoot = requiredDirectory("PI_FRAMEWORK_NODE_ROOT");
const springRoot = requiredDirectory("PI_SPRING_BOOT_FIXTURE");
const java = requiredFile("PI_JAVA_EXECUTABLE");
const dotnet = requiredFile("PI_DOTNET_EXECUTABLE");
const packagedResourcesPath = process.env.PI_WINDOWS_MANAGED_HELPER_RESOURCES_PATH;
const fixture = await mkdtemp(path.join(tmpdir(), "pi-managed-frameworks-"));
const unicodeFixture = path.join(fixture, "框架 Unicode 😀 With Spaces");
await mkdir(unicodeFixture);
const javaUnicodeFixture = path.join(fixture, "Spring Unicode 空格 With Spaces");
await mkdir(javaUnicodeFixture);
const nodeWorkspace = await mkdtemp(path.join(nodeRoot, ".pi-managed-frameworks-"));
const nodeUnicodeFixture = path.join(nodeWorkspace, "框架 Unicode 😀 With Spaces");
await mkdir(nodeUnicodeFixture);

function requiredDirectory(name) {
  const value = process.env[name];
  if (!value || !existsSync(value)) throw new Error(`${name} must point to an existing directory`);
  return realpathSync.native(value);
}

function requiredFile(name) {
  const value = process.env[name];
  if (!value || !existsSync(value)) throw new Error(`${name} must point to an existing file`);
  return realpathSync.native(value);
}

function findBash() {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
    "D:\\tools\\w64devkit\\bin\\bash.exe",
  ];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error("A native Windows Bash is required for framework acceptance");
  return executable;
}

function quote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function processCreationTime(pid) {
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write([DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds())`;
  return Number(
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
}

const bash = findBash();
const ownerStartedAt = processCreationTime(process.pid);
Object.defineProperty(process, "getCreationTime", { value: () => ownerStartedAt, configurable: true });
applyManagedProcessOwnerIdentity({
  type: "managed-process-owner:init",
  version: 1,
  mainPid: process.pid,
  mainStartFingerprint: String(ownerStartedAt),
  mainImagePath: realpathSync.native(process.execPath),
  hostInstanceId: randomUUID(),
});
const resolution = resolveWindowsManagedProcessHelper({
  isPackaged: Boolean(packagedResourcesPath),
  resourcesPath: packagedResourcesPath ?? root,
  projectRoot: root,
});
if (!resolution.ok) throw new Error(`Windows helper is unavailable: ${resolution.errorCode}`);
const windowsHelper = resolution.descriptor;
const workerEntry = fileURLToPath(new URL("../src/agent-host/managed-process/worker.ts", import.meta.url));
const runtime = {
  async createExecutionContext() {
    return {
      inventoryRevision: 1,
      resolutionId: "framework-acceptance",
      nativeEnv: { ...process.env },
      shellEnv: { ...process.env },
      commands: {
        "shell.bash": {
          capability: "shell.bash",
          provider: "system",
          executable: bash,
          argvPrefix: [],
          binDir: path.dirname(bash),
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
    platform: "win32",
    runtime,
    workerEntryPath: workerEntry,
    workerExecArgv: ["--experimental-strip-types"],
    parentCall: async (method) => {
      if (method === "managedProcesses.getSettings") {
        return {
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
        };
      }
      if (method === "managedProcesses.register") return { journalRevision: ++journalRevision };
      if (method === "managedProcesses.unregister") return { journalRevision: ++journalRevision, removed: true };
      throw new Error(`unexpected parent call: ${method}`);
    },
  },
);

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(port > 0);
  return port;
}

async function fetchManaged(started, url, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  try {
    while (Date.now() < deadline) {
      try {
        const response = await globalThis.fetch(url);
        const text = await response.text();
        if (response.ok && accept(text)) return text;
        lastError = new Error(`unexpected HTTP ${response.status}: ${text.slice(0, 200)}`);
      } catch (error) {
        lastError = error;
      }
      const state = service.get(started.process.processId, "framework-session").state;
      if (["exited", "failed", "killed"].includes(state)) throw lastError ?? new Error(`process ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw lastError ?? new Error(`${url} did not become ready`);
  } catch (error) {
    const output = service.read(
      { processId: started.process.processId, runId: started.runId, maxBytes: 128 * 1024 },
      "framework-session",
    );
    const tail = output.records
      .map((record) => `[${record.stream}] ${record.text}`)
      .join("")
      .slice(-12_000);
    throw new Error(`${started.process.label} endpoint failed in state ${output.state}: ${error}\n${tail}`, {
      cause: error,
    });
  }
}

async function portClosed(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const closed = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      const done = () => {
        socket.destroy();
        resolve(true);
      };
      socket.once("error", done);
      socket.once("timeout", done);
    });
    if (closed) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`port ${port} remained open`);
}

async function start(label, cwd, command, readyText, ownerCwd = unicodeFixture, readyTimeoutMs = 10_000) {
  return service.startForAgent("framework-session", ownerCwd, true, {
    command,
    cwd,
    label,
    waitFor: { type: "output", contains: readyText, timeoutMs: readyTimeoutMs },
  });
}

async function stop(started, mode = "graceful") {
  await service.stop(started.process.processId, started.runId, mode, "user", "framework-session");
}

const scenarios = [];
let active;
try {
  const sharedNodeModules = path.join(nodeRoot, "node_modules");
  const nextBin = path.join(sharedNodeModules, "next", "dist", "bin", "next");
  const storybookBin = path.join(sharedNodeModules, "storybook", "dist", "bin", "dispatcher.js");
  assert.ok(existsSync(nextBin), "Next CLI is missing from PI_FRAMEWORK_NODE_ROOT");
  assert.ok(existsSync(storybookBin), "Storybook CLI is missing from PI_FRAMEWORK_NODE_ROOT");

  const nextApp = path.join(nodeUnicodeFixture, "next-app");
  await mkdir(path.join(nextApp, "app"), { recursive: true });
  await writeFile(path.join(nextApp, "package.json"), JSON.stringify({ private: true }, null, 2));
  await writeFile(
    path.join(nextApp, "app", "layout.jsx"),
    `export default function Layout({children}){return <html><body>{children}</body></html>}\n`,
  );
  const nextPage = path.join(nextApp, "app", "page.jsx");
  await writeFile(nextPage, `export default function Page(){return <main>NEXT_MANAGED_V1</main>}\n`);
  const nextPort = await reservePort();
  active = await start(
    "Next dev real fixture",
    nextApp,
    `${quote(process.execPath)} ${quote(nextBin)} dev --hostname 127.0.0.1 --port ${nextPort}`,
    "Ready",
    nodeUnicodeFixture,
  );
  await fetchManaged(active, `http://127.0.0.1:${nextPort}/`, (text) => text.includes("NEXT_MANAGED_V1"), 120_000);
  await writeFile(nextPage, `export default function Page(){return <main>NEXT_MANAGED_V2</main>}\n`);
  await fetchManaged(active, `http://127.0.0.1:${nextPort}/`, (text) => text.includes("NEXT_MANAGED_V2"), 60_000);
  await stop(active);
  active = undefined;
  await portClosed(nextPort);
  scenarios.push("Next dev HMR tree stop");

  const storybookApp = path.join(nodeUnicodeFixture, "storybook-app");
  await mkdir(path.join(storybookApp, ".storybook"), { recursive: true });
  await mkdir(path.join(storybookApp, "src"), { recursive: true });
  await writeFile(path.join(storybookApp, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  await writeFile(
    path.join(storybookApp, ".storybook", "main.mjs"),
    `export default {stories:["../src/**/*.stories.jsx"],framework:{name:"@storybook/react-vite",options:{}}};\n`,
  );
  await writeFile(
    path.join(storybookApp, "src", "Managed.stories.jsx"),
    `import React from "react";export default {title:"Acceptance/Managed"};export const Ready={render:()=>React.createElement("main",null,"STORYBOOK_MANAGED_READY")};\n`,
  );
  const storybookPort = await reservePort();
  active = await start(
    "Storybook real cold start",
    storybookApp,
    `${quote(process.execPath)} ${quote(storybookBin)} dev --ci --no-open --host 127.0.0.1 --port ${storybookPort}`,
    "Storybook",
    nodeUnicodeFixture,
  );
  await fetchManaged(active, `http://127.0.0.1:${storybookPort}/`, (text) => /storybook/i.test(text), 180_000);
  await stop(active);
  active = undefined;
  await portClosed(storybookPort);
  scenarios.push("Storybook real cold start stop");

  const springApp = path.join(javaUnicodeFixture, "spring-app");
  await cp(springRoot, springApp, { recursive: true });
  const springPort = await reservePort();
  const springProperties = path.join(springApp, "src", "main", "resources", "application.properties");
  await mkdir(path.dirname(springProperties), { recursive: true });
  await writeFile(springProperties, `server.address=127.0.0.1\nserver.port=${springPort}\n`);
  const springController = path.join(
    springApp,
    "src",
    "main",
    "java",
    "com",
    "example",
    "fixture",
    "ManagedController.java",
  );
  await writeFile(
    springController,
    `package com.example.fixture;import org.springframework.web.bind.annotation.GetMapping;import org.springframework.web.bind.annotation.RestController;@RestController public class ManagedController{@GetMapping("/") public String root(){return "SPRING_MANAGED_READY";}}\n`,
  );
  const mavenUserHome = path.resolve(
    process.env.PI_MAVEN_USER_HOME ?? path.join(root, ".artifacts", "maven-user-home-3.9.16"),
  );
  await mkdir(mavenUserHome, { recursive: true });
  const springJar = "target/fixture-0.0.1-SNAPSHOT.jar";
  active = await start(
    "Spring Boot mvnw.cmd",
    springApp,
    `MAVEN_USER_HOME=${quote(mavenUserHome)} ${quote(path.join(springApp, "mvnw.cmd"))} -q -DskipTests package && ${quote(java)} -jar ${quote(springJar)}`,
    "Started",
    javaUnicodeFixture,
    240_000,
  );
  await fetchManaged(
    active,
    `http://127.0.0.1:${springPort}/`,
    (text) => text.includes("SPRING_MANAGED_READY"),
    240_000,
  );
  await stop(active);
  active = undefined;
  await portClosed(springPort);
  scenarios.push("Spring Boot mvnw.cmd JVM tree stop");

  const dotnetApp = path.join(unicodeFixture, "dotnet-watch-app");
  await mkdir(dotnetApp, { recursive: true });
  const dotnetProject = path.join(dotnetApp, "ManagedWatch.csproj");
  await writeFile(
    dotnetProject,
    `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>\n`,
  );
  const dotnetProgram = path.join(dotnetApp, "Program.cs");
  const dotnetPort = await reservePort();
  const dotnetSource = (marker) =>
    `var builder=WebApplication.CreateBuilder(args);builder.WebHost.UseUrls("http://127.0.0.1:${dotnetPort}");var app=builder.Build();app.MapGet("/",()=>"${marker}");app.Lifetime.ApplicationStarted.Register(()=>Console.WriteLine("DOTNET_WATCH_READY http://127.0.0.1:${dotnetPort}/"));app.Run();\n`;
  await writeFile(dotnetProgram, dotnetSource("DOTNET_MANAGED_V1"));
  execFileSync(dotnet, ["restore", dotnetProject, "--nologo"], {
    cwd: dotnetApp,
    timeout: 240_000,
    windowsHide: true,
    stdio: "inherit",
  });
  active = await start(
    ".NET watch non-TTY restart",
    dotnetApp,
    `DOTNET_USE_POLLING_FILE_WATCHER=1 ${quote(dotnet)} watch --non-interactive --no-hot-reload --project ${quote(dotnetProject)} run --no-launch-profile`,
    "DOTNET_WATCH_READY",
  );
  await fetchManaged(active, `http://127.0.0.1:${dotnetPort}/`, (text) => text.includes("DOTNET_MANAGED_V1"), 120_000);
  await writeFile(dotnetProgram, dotnetSource("DOTNET_MANAGED_V2"));
  await fetchManaged(active, `http://127.0.0.1:${dotnetPort}/`, (text) => text.includes("DOTNET_MANAGED_V2"), 180_000);
  await stop(active);
  active = undefined;
  await portClosed(dotnetPort);
  scenarios.push(".NET watch non-TTY restart stop");

  console.log(JSON.stringify({ ok: true, scenarios, helperBuildId: windowsHelper.buildId }));
} finally {
  if (active) await stop(active, "force").catch(() => undefined);
  await service.stopAll("host").catch(() => undefined);
  const cleanupOptions = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
  await rm(fixture, cleanupOptions);
  await rm(nodeWorkspace, cleanupOptions);
}
