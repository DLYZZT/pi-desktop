#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";
import { WindowsJobProcessBackend } from "../src/agent-host/managed-process/windows-helper-client.ts";
import { applyManagedProcessOwnerIdentity } from "../src/agent-host/managed-process/owner-identity.ts";
import { ManagedProcessReaper, secureWindowsReaperDirectory } from "../src/main/managed-process/reaper.ts";
import {
  resolveWindowsManagedProcessHelper,
  verifyWindowsManagedProcessHelperReplaceable,
} from "../src/shared/windows-managed-process-helper.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log(JSON.stringify({ ok: true, skipped: "Windows x64 only" }));
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = realpathSync.native(await mkdtemp(path.join(tmpdir(), "pi-windows-helper-e2e-")));
const fixture = path.join(fixtureRoot, "Unicode 空格 fixture");
await mkdir(fixture);

function removeFixtureTree(directory) {
  return rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function progress(scenario) {
  console.log(JSON.stringify({ progress: scenario }));
}

function withScenarioTimeout(promise, scenario, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${scenario} timed out after ${timeoutMs} ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForBackendExit(backend, scenario) {
  return withScenarioTimeout(backend.waitForExit(), scenario, 15_000);
}

function processCreationTime(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write([DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds())`;
  const value = Number(
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
  );
  assert.ok(Number.isSafeInteger(value) && value > 0, "process creation time must be available");
  return value;
}

function processHandleCount(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($p.HandleCount)`;
  const value = Number(
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
  );
  assert.ok(Number.isSafeInteger(value) && value > 0, "process handle count must be available");
  return value;
}

function findBash() {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
    "D:\\tools\\w64devkit\\bin\\bash.exe",
  ];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error("A native Windows Bash is required for the helper E2E");
  return realpathSync.native(executable);
}

function findExecutable(name) {
  try {
    return execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .find((value) => value && existsSync(value));
  } catch {
    return undefined;
  }
}

function bashQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function waitForEvent(events, predicate, timeoutMs = 5_000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Windows helper event timed out")), timeoutMs);
    const poll = setInterval(() => {
      const event = events.find(predicate);
      if (!event) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(event);
    }, 20);
    timer.unref();
    poll.unref();
  });
}

function portClosed(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`port ${port} remained open`));
        else setTimeout(probe, 50);
      });
      const closed = () => {
        socket.destroy();
        resolve();
      };
      socket.once("error", closed);
      socket.once("timeout", closed);
    };
    probe();
  });
}

function portOpen(port, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      progress("identity-uncertain-port-timeout");
      finish(new Error(`port ${port} did not accept a connection within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

function malformedFrame(magic = "PIMP", kind = 8, length = 2, sequence = 1) {
  const frame = Buffer.alloc(16 + (length <= 1024 ? length : 0));
  frame.write(magic, 0, 4, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt16LE(kind, 6);
  frame.writeUInt32LE(length, 8);
  frame.writeUInt32LE(sequence, 12);
  if (length === 2) frame.write("{}", 16, 2, "utf8");
  return frame;
}

function rejectsMalformedHelperInput(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(descriptor.path, ["--reap-stdio-v1"], {
      cwd: path.dirname(descriptor.path),
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("malformed helper input did not fail closed"));
    }, 5_000);
    timer.unref();
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 2);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(bytes);
  });
}

const packagedResourcesPath = process.env.PI_WINDOWS_MANAGED_HELPER_RESOURCES_PATH;
const resolution = resolveWindowsManagedProcessHelper({
  isPackaged: Boolean(packagedResourcesPath),
  resourcesPath: packagedResourcesPath ?? process.resourcesPath ?? root,
  projectRoot: root,
});
assert.equal(resolution.ok, true, "Windows helper must be built and verified");
const descriptor = resolution.descriptor;
const handleLoops = Number(process.env.PI_WINDOWS_HELPER_HANDLE_LOOPS ?? 25);
assert.ok(Number.isSafeInteger(handleLoops) && handleLoops >= 1 && handleLoops <= 1_000);
const ownerDeathMode = process.argv.find((argument) => argument.startsWith("--owner-death-child="))?.split("=")[1];
let mainOwnerSentinel;
if (ownerDeathMode === "main") {
  mainOwnerSentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    mainOwnerSentinel.once("spawn", resolve);
    mainOwnerSentinel.once("error", reject);
  });
}
const startedAt = processCreationTime(process.pid);
Object.defineProperty(process, "getCreationTime", { value: () => startedAt, configurable: true });
const mainOwnerPid = mainOwnerSentinel?.pid ?? process.pid;
const owner = applyManagedProcessOwnerIdentity({
  type: "managed-process-owner:init",
  version: 1,
  mainPid: mainOwnerPid,
  mainStartFingerprint: String(mainOwnerSentinel ? processCreationTime(mainOwnerPid) : startedAt),
  mainImagePath: realpathSync.native(process.execPath),
  hostInstanceId: randomUUID(),
});
const bash = findBash();
const marker = path.join(fixture, "executed.txt");
const childFile = path.join(fixture, "child.mjs");
const rootFile = path.join(fixture, "root.mjs");
const rootExitFile = path.join(fixture, "root-exit.mjs");
const pythonFile = path.join(fixture, "server.py");
const javaFile = path.join(fixture, "PiManagedFixture.java");
const electronFile = path.join(fixture, "electron-main.cjs");
const environmentFile = path.join(fixture, "environment-boundary.mjs");
const dotnetProject = path.join(fixture, "PiManagedFixture.csproj");
const dotnetProgram = path.join(fixture, "Program.cs");
const breakawayProbe = path.join(fixture, "breakaway-probe.ps1");
const emojiFixture = path.join(fixture, "emoji 😀 path");
await mkdir(emojiFixture, { recursive: true });
const emojiFile = path.join(emojiFixture, "emoji 😀 process.mjs");
const longPathFixture = path.join(
  fixture,
  ...Array.from({ length: 7 }, (_, index) => `long-path-segment-${index}-0123456789abcdef`),
);
assert.ok(longPathFixture.length > 260, `long-path fixture must exceed MAX_PATH: ${longPathFixture.length}`);
await mkdir(longPathFixture, { recursive: true });
const longPathFile = path.join(longPathFixture, "long-path.mjs");
await writeFile(
  childFile,
  `import net from "node:net";const server=net.createServer(()=>{});server.listen(0,"127.0.0.1",()=>console.log("CHILD_READY http://127.0.0.1:"+server.address().port+"/"));setInterval(()=>{},1000);`,
);
await writeFile(
  pythonFile,
  `import http.server\nserver=http.server.ThreadingHTTPServer(("127.0.0.1",0),http.server.SimpleHTTPRequestHandler)\nprint(f"PYTHON_READY http://127.0.0.1:{server.server_port}/",flush=True)\nserver.serve_forever()\n`,
);
await writeFile(
  javaFile,
  `public final class PiManagedFixture { public static void main(String[] args) throws Exception { System.out.println("JAVA_READY"); System.out.flush(); for (;;) Thread.sleep(1000); } }\n`,
);
await writeFile(
  electronFile,
  `const{app,BrowserWindow}=require("electron");app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadURL("data:text/html,<title>managed</title>");win.webContents.once("did-finish-load",()=>console.log("ELECTRON_READY"));});app.on("window-all-closed",()=>{});`,
);
await writeFile(
  environmentFile,
  `console.log("ENVIRONMENT_BOUNDARY "+process.env.PI_BOUNDARY_UNICODE+" "+(process.env.ELECTRON_RUN_AS_NODE??"ABSENT"));`,
);
await writeFile(emojiFile, `console.log("EMOJI_PATH_READY");setInterval(()=>{},1000);`);
await writeFile(longPathFile, `console.log("LONG_PATH_READY");setInterval(()=>{},1000);`);
await writeFile(
  breakawayProbe,
  String.raw`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PiBreakawayProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public uint cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public ushort wShowWindow;
    public ushort cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref STARTUPINFO startupInfo,
    out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$startup = New-Object PiBreakawayProbe+STARTUPINFO
$startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
$information = New-Object PiBreakawayProbe+PROCESS_INFORMATION
$application = Join-Path $env:SystemRoot 'System32\cmd.exe'
$command = [Text.StringBuilder]::new('"' + $application + '" /d /s /c "ping -n 30 127.0.0.1 >nul"')
$created = [PiBreakawayProbe]::CreateProcess(
  $application,
  $command,
  [IntPtr]::Zero,
  [IntPtr]::Zero,
  $false,
  0x01000000,
  [IntPtr]::Zero,
  $env:SystemRoot,
  [ref]$startup,
  [ref]$information)
if ($created) {
  [PiBreakawayProbe]::TerminateProcess($information.hProcess, 9) | Out-Null
  [PiBreakawayProbe]::CloseHandle($information.hThread) | Out-Null
  [PiBreakawayProbe]::CloseHandle($information.hProcess) | Out-Null
  Write-Output 'BREAKAWAY_ESCAPED'
  exit 9
}
$code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
Write-Output "BREAKAWAY_BLOCKED:$code"
if ($code -ne 5) { exit 8 }
`,
);
await writeFile(
  rootFile,
  `import{spawn}from"node:child_process";import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(marker)},"executed");const child=spawn(process.execPath,[${JSON.stringify(childFile)}],{detached:true,stdio:["ignore",process.stdout,process.stderr]});console.log("ROOT_READY "+child.pid);process.stdin.on("data",chunk=>console.log("STDIN_ECHO "+chunk.toString().trim()));setInterval(()=>{},1000);`,
);
await writeFile(
  rootExitFile,
  `import{spawn}from"node:child_process";import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(marker)},"executed");const child=spawn(process.execPath,[${JSON.stringify(childFile)}],{detached:true,stdio:["ignore",process.stdout,process.stderr]});child.unref();console.log("ROOT_EXIT "+child.pid);`,
);

function launchInput(runId, entry = rootFile) {
  return {
    processId: `proc-${runId}`,
    runId,
    cwd: fixture,
    command: `${bashQuote(process.execPath)} ${bashQuote(entry)}`,
    shell: { executable: bash, argvPrefix: [], cwdSemantics: "native" },
    context: {
      inventoryRevision: 1,
      resolutionId: runId,
      nativeEnv: { ...process.env },
      shellEnv: { ...process.env },
      commands: {},
      summary: [],
    },
    owner,
  };
}

function launchCommandInput(runId, command, cwd = fixture) {
  return { ...launchInput(runId), command, cwd };
}

async function startBackend(runId, entry = rootFile) {
  await rm(marker, { force: true });
  const backend = new WindowsJobProcessBackend(descriptor);
  const events = [];
  backend.onEvent((event) => events.push(event));
  const prepared = await backend.prepare(launchInput(runId, entry));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(existsSync(marker), false, "target must remain suspended before journal commit");
  await backend.commit(prepared, 1);
  await waitForEvent(events, (event) => event.type === "stdout" && event.bytes.toString().includes("CHILD_READY"));
  const output = Buffer.concat(
    events.filter((event) => event.type === "stdout").map((event) => event.bytes),
  ).toString();
  const url = output.match(/CHILD_READY (http:\/\/127\.0\.0\.1:\d+\/)/u)?.[1];
  assert.ok(url, `child endpoint missing from ${output}`);
  return { backend, events, prepared, port: Number(new URL(url).port) };
}

async function runCommandScenario(runId, command, readyText, cwd = fixture) {
  const backend = new WindowsJobProcessBackend(descriptor);
  const events = [];
  backend.onEvent((event) => events.push(event));
  const prepared = await backend.prepare(launchCommandInput(runId, command, cwd));
  await backend.commit(prepared, 1);
  await waitForEvent(
    events,
    (event) => (event.type === "stdout" || event.type === "stderr") && event.bytes.toString("utf8").includes(readyText),
    15_000,
  );
  await backend.stop("force", "main");
  await waitForBackendExit(backend, `${runId} backend exit`);
}

async function runOwnerDeathScenario(mode) {
  const child = spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), `--owner-death-child=${mode}`],
    {
      cwd: root,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${mode} owner-death child timed out: ${stderr}`));
    }, 20_000);
    const poll = setInterval(() => {
      const line = stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .find((value) => value.startsWith('{"ownerDeathReady"'));
      if (!line) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(JSON.parse(line));
    }, 20);
    timer.unref();
    poll.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(error);
    });
    void exited.then((code) => {
      if (stdout.includes('{"ownerDeathReady"')) return;
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`${mode} owner-death child exited early code=${code}: ${stderr}`));
    });
  });
  if (mode === "host") child.kill();
  const exitCode = await withScenarioTimeout(exited, `${mode} owner-death child exit`, 15_000);
  if (mode === "main") assert.equal(exitCode, 0, `Main owner-death child failed: ${stderr}`);
  await portClosed(ready.port);
  await removeFixtureTree(ready.fixtureRoot);
}

if (ownerDeathMode === "host" || ownerDeathMode === "main") {
  const owned = await startBackend(`owner-death-${ownerDeathMode}`);
  console.log(JSON.stringify({ ownerDeathReady: ownerDeathMode, port: owned.port, fixtureRoot }));
  if (ownerDeathMode === "main") {
    mainOwnerSentinel.kill();
    await waitForBackendExit(owned.backend, "main owner-death backend exit");
    await portClosed(owned.port);
    await removeFixtureTree(fixtureRoot);
    process.exit(0);
  }
  await new Promise(() => undefined);
}

let acceptanceError;
let cleanupError;
try {
  progress("active-helper-file-lock");
  const lockingBackend = new WindowsJobProcessBackend(descriptor);
  const lockingPrepared = await lockingBackend.prepare(launchCommandInput("active-helper-file-lock", ":"));
  assert.equal(lockingPrepared.reaper.platform, "win32");
  assert.equal(
    verifyWindowsManagedProcessHelperReplaceable(descriptor),
    false,
    "an active owner helper must pin its executable against replacement",
  );
  await lockingBackend.dispose();
  await waitForBackendExit(lockingBackend, "active helper lock backend exit");
  assert.equal(
    verifyWindowsManagedProcessHelperReplaceable(descriptor),
    true,
    "the helper must become replaceable after owner exit",
  );

  progress("journal-and-path-security");
  const secureJournalDirectory = path.join(fixture, "secure-journal");
  assert.equal(
    await secureWindowsReaperDirectory(secureJournalDirectory, descriptor, (message) =>
      console.error(`[journal-security] ${message}`),
    ),
    true,
  );
  const aclScript = [
    `$acl=([System.IO.DirectoryInfo]::new(${JSON.stringify(secureJournalDirectory)})).GetAccessControl()`,
    "$rules=@($acl.Access|ForEach-Object{[pscustomobject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;rights=$_.FileSystemRights.ToString();type=$_.AccessControlType.ToString();inherited=$_.IsInherited}})",
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "[Console]::Out.Write(([pscustomobject]@{protected=$acl.AreAccessRulesProtected;me=$me;rules=$rules}|ConvertTo-Json -Compress -Depth 4))",
  ].join(";");
  const acl = JSON.parse(
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclScript], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  assert.equal(acl.protected, true);
  assert.deepEqual(acl.rules.map((rule) => rule.sid).sort(), ["S-1-5-18", acl.me].sort());
  assert.ok(acl.rules.every((rule) => rule.type === "Allow" && rule.inherited === false));
  const junctionTarget = path.join(fixture, "junction-target");
  const junctionPath = path.join(fixture, "journal-junction");
  await secureWindowsReaperDirectory(junctionTarget, descriptor);
  await symlink(junctionTarget, junctionPath, "junction");
  assert.equal(await secureWindowsReaperDirectory(junctionPath, descriptor), false);
  const cwdJunction = path.join(fixture, "cwd-junction");
  await symlink(junctionTarget, cwdJunction, "junction");
  await assert.rejects(
    new WindowsJobProcessBackend(descriptor).prepare(launchCommandInput("cwd-reparse", ":", cwdJunction)),
    /TARGET_CREATE_FAILED/u,
  );
  const shellJunction = path.join(fixture, "shell-junction");
  await symlink(path.dirname(bash), shellJunction, "junction");
  const shellReparseInput = launchCommandInput("shell-reparse", ":");
  shellReparseInput.shell = {
    ...shellReparseInput.shell,
    executable: path.join(shellJunction, path.basename(bash)),
  };
  await assert.rejects(new WindowsJobProcessBackend(descriptor).prepare(shellReparseInput), /TARGET_CREATE_FAILED/u);
  await rejectsMalformedHelperInput(malformedFrame("NOPE"));
  await rejectsMalformedHelperInput(malformedFrame("PIMP", 1, 512 * 1024 + 1));
  await rejectsMalformedHelperInput(malformedFrame("PIMP", 8, 2, 2));

  const exactEnvironment = Object.fromEntries(
    Array.from({ length: 4_090 }, (_, index) => [`PI_BOUNDARY_${index.toString().padStart(4, "0")}`, "x"]),
  );
  assert.ok(process.env.SystemRoot && process.env.WINDIR, "Windows system environment must be available");
  exactEnvironment.SystemRoot = process.env.SystemRoot;
  exactEnvironment.WINDIR = process.env.WINDIR;
  exactEnvironment.PI_BOUNDARY_UNICODE = "值😀";
  exactEnvironment.eLeCtRoN_rUn_As_NoDe = "1";
  const environmentInput = launchCommandInput(
    "environment-4096",
    `${bashQuote(process.execPath)} ${bashQuote(environmentFile)}`,
  );
  environmentInput.context.shellEnv = exactEnvironment;
  const environmentBackend = new WindowsJobProcessBackend(descriptor);
  const environmentEvents = [];
  environmentBackend.onEvent((event) => environmentEvents.push(event));
  const environmentPrepared = await environmentBackend.prepare(environmentInput);
  await environmentBackend.commit(environmentPrepared, 1);
  await waitForEvent(
    environmentEvents,
    (event) => event.type === "stdout" && event.bytes.toString("utf8").includes("ENVIRONMENT_BOUNDARY 值😀 ABSENT"),
  );
  await environmentBackend.waitForExit();

  const oversizedEnvironmentInput = structuredClone(environmentInput);
  oversizedEnvironmentInput.runId = "environment-4097";
  oversizedEnvironmentInput.processId = "proc-environment-4097";
  oversizedEnvironmentInput.context.shellEnv.PI_BOUNDARY_OVERFLOW = "x";
  await assert.rejects(
    new WindowsJobProcessBackend(descriptor).prepare(oversizedEnvironmentInput),
    /4096 entry limit/u,
  );

  const oversizedMetadataInput = launchCommandInput("metadata-overflow", ":");
  oversizedMetadataInput.shell.argvPrefix = Array.from({ length: 8 }, () => '"'.repeat(4_096));
  await assert.rejects(
    new WindowsJobProcessBackend(descriptor).prepare(oversizedMetadataInput),
    /metadata exceeds 32 KiB/u,
  );

  progress(`handle-leak-${handleLoops}-loops`);
  const handlesBefore = processHandleCount(process.pid);
  for (let index = 0; index < handleLoops; index += 1) {
    const backend = new WindowsJobProcessBackend(descriptor);
    const prepared = await backend.prepare(launchCommandInput(`handle-${index}`, ":"));
    await backend.commit(prepared, 1);
    await backend.waitForExit();
    await backend.dispose();
  }
  const handlesAfter = processHandleCount(process.pid);
  assert.ok(
    handlesAfter <= handlesBefore + 16,
    `helper lifecycle leaked handles: before=${handlesBefore} after=${handlesAfter}`,
  );

  progress("graceful-stop");
  const graceful = await startBackend("graceful");
  graceful.backend.write({ text: "hello", appendNewline: true, close: false });
  await waitForEvent(
    graceful.events,
    (event) => event.type === "stdout" && event.bytes.toString().includes("STDIN_ECHO hello"),
  );
  await graceful.backend.stop("graceful", "user");
  await waitForBackendExit(graceful.backend, "graceful backend exit");
  await portClosed(graceful.port);
  assert.ok(graceful.events.some((event) => event.type === "stopping" && event.phase === "interrupt"));

  progress("helper-crash-and-invalid-control");
  const crashed = await startBackend("helper-crash");
  crashed.backend.child.kill();
  await waitForBackendExit(crashed.backend, "crashed helper exit");
  await portClosed(crashed.port);

  const invalidControl = await startBackend("invalid-control-after-start");
  invalidControl.backend.child.stdin.write(malformedFrame("NOPE"));
  await waitForBackendExit(invalidControl.backend, "invalid-control helper exit");
  await portClosed(invalidControl.port);

  progress("breakaway-probe");
  const powershell = findExecutable("powershell.exe");
  assert.ok(powershell, "Windows PowerShell is required for the breakaway containment probe");
  const breakaway = new WindowsJobProcessBackend(descriptor);
  const breakawayEvents = [];
  breakaway.onEvent((event) => breakawayEvents.push(event));
  const breakawayPrepared = await breakaway.prepare(
    launchCommandInput(
      "breakaway-probe",
      `${bashQuote(powershell)} -NoLogo -NoProfile -NonInteractive -File ${bashQuote(breakawayProbe)}`,
    ),
  );
  await breakaway.commit(breakawayPrepared, 1);
  await Promise.race([
    waitForEvent(
      breakawayEvents,
      (event) => event.type === "stdout" && event.bytes.toString("utf8").includes("BREAKAWAY_BLOCKED:5"),
      15_000,
    ),
    waitForBackendExit(breakaway, "breakaway probe early exit").then(() => {
      const output = breakawayEvents
        .filter((event) => event.type === "stdout" || event.type === "stderr")
        .map((event) => event.bytes.toString("utf8"))
        .join("");
      throw new Error(`breakaway probe exited without the expected denial: ${output}`);
    }),
  ]);
  await waitForBackendExit(breakaway, "breakaway probe exit");
  assert.equal(
    breakawayEvents.some(
      (event) =>
        (event.type === "stdout" || event.type === "stderr") &&
        event.bytes.toString("utf8").includes("BREAKAWAY_ESCAPED"),
    ),
    false,
  );

  progress("owner-death");
  await runOwnerDeathScenario("host");
  await runOwnerDeathScenario("main");

  progress("root-exit-and-identity");
  const orphaned = await startBackend("root-exit", rootExitFile);
  progress("root-exit-ready");
  await waitForBackendExit(orphaned.backend, "root-exit backend exit");
  await portClosed(orphaned.port);
  progress("root-exit-closed");

  const uncertain = await startBackend("identity-uncertain");
  progress("identity-uncertain-ready");
  const uncertainReaper = new ManagedProcessReaper(path.join(fixture, "uncertain.json"), {
    platform: "win32",
    windowsHelper: descriptor,
  });
  assert.equal((await uncertainReaper.initialize()).ready, true);
  progress("identity-uncertain-initialized");
  uncertainReaper.register({
    ...uncertain.prepared.reaper,
    helperStartFingerprint: `${uncertain.prepared.reaper.helperStartFingerprint}-mismatch`,
  });
  const uncertainStatus = await withScenarioTimeout(uncertainReaper.reapAll(), "identity-uncertain reaper", 15_000);
  console.log(JSON.stringify({ progress: "identity-uncertain-reaped", status: uncertainStatus }));
  assert.equal(uncertainStatus.ready, false);
  assert.equal(uncertainStatus.errorCode, "IDENTITY_UNCERTAIN");
  assert.equal(uncertainStatus.records, 1);
  progress("identity-uncertain-port-probe");
  await portOpen(uncertain.port);
  progress("identity-uncertain-target-confirmed");
  await uncertain.backend.stop("force", "main");
  await waitForBackendExit(uncertain.backend, "identity-uncertain backend exit");
  await portClosed(uncertain.port);
  progress("identity-uncertain-closed");

  progress("runtime-matrix");
  const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  assert.equal(existsSync(electron), true, "Electron runtime must exist for the GUI containment scenario");
  await runCommandScenario("electron-gui", `${bashQuote(electron)} ${bashQuote(electronFile)}`, "ELECTRON_READY");
  await runCommandScenario(
    "emoji-path",
    `${bashQuote(process.execPath)} ${bashQuote(emojiFile)}`,
    "EMOJI_PATH_READY",
    emojiFixture,
  );
  await runCommandScenario("long-path", `${bashQuote(process.execPath)} ${bashQuote(longPathFile)}`, "LONG_PATH_READY");

  const ping = findExecutable("ping.exe");
  if (ping) await runCommandScenario("ping-continuous", `${bashQuote(ping)} -t 127.0.0.1`, "TTL=");

  const nmap = findExecutable("nmap.exe");
  if (nmap) {
    const localFixture = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end();
    });
    await new Promise((resolve, reject) => {
      localFixture.once("error", reject);
      localFixture.listen(0, "127.0.0.1", resolve);
    });
    const localPort = localFixture.address().port;
    try {
      await runCommandScenario("nmap-loopback", `${bashQuote(nmap)} -sT -Pn -p ${localPort} 127.0.0.1`, "Nmap done:");
    } finally {
      await new Promise((resolve) => localFixture.close(resolve));
    }
  }

  const python = findExecutable("python.exe");
  if (python) {
    await runCommandScenario("python", `${bashQuote(python)} -u ${bashQuote(pythonFile)}`, "PYTHON_READY");
  }

  const javac = findExecutable("javac.exe");
  const java = findExecutable("java.exe");
  if (javac && java) {
    execFileSync(javac, [javaFile], { cwd: fixture, windowsHide: true });
    await runCommandScenario("java", `${bashQuote(java)} -cp ${bashQuote(fixture)} PiManagedFixture`, "JAVA_READY");
  }

  const dotnet = findExecutable("dotnet.exe");
  let dotnetWatch = false;
  if (dotnet) {
    const sdkVersion = execFileSync(dotnet, ["--list-sdks"], { encoding: "utf8", windowsHide: true })
      .trim()
      .match(/^(\d+)\./u)?.[1];
    if (sdkVersion) {
      await writeFile(
        dotnetProject,
        `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net${sdkVersion}.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>`,
      );
      await writeFile(
        dotnetProgram,
        `var builder=WebApplication.CreateBuilder(args);builder.WebHost.UseUrls("http://127.0.0.1:0");var app=builder.Build();app.MapGet("/",()=>"ok");app.Lifetime.ApplicationStarted.Register(()=>Console.WriteLine("DOTNET_WATCH_READY"));app.Run();`,
      );
      await runCommandScenario(
        "dotnet-watch",
        `${bashQuote(dotnet)} watch --non-interactive --project ${bashQuote(dotnetProject)} run --no-launch-profile`,
        "DOTNET_WATCH_READY",
      );
      dotnetWatch = true;
    }
  }

  progress("reaper");
  const reaped = await startBackend("reaper");
  const journal = path.join(fixture, "reaper.json");
  const reaper = new ManagedProcessReaper(journal, {
    platform: "win32",
    windowsHelper: descriptor,
    log: (message) => console.error(`[reaper] ${message}`),
  });
  assert.equal((await reaper.initialize()).ready, true);
  reaper.register(reaped.prepared.reaper);
  const status = await withScenarioTimeout(reaper.reapAll(), "final reaper", 15_000);
  assert.equal(status.ready, true, JSON.stringify(status));
  assert.equal(status.records, 0);
  await waitForBackendExit(reaped.backend, "reaped backend exit");
  await portClosed(reaped.port);

  const markerContents = await readFile(marker, "utf8");
  assert.equal(markerContents, "executed");
  console.log(
    JSON.stringify({
      ok: true,
      scenarios: [
        "two-phase",
        "active-helper-file-lock",
        "journal-protected-dacl",
        "journal-junction-rejected",
        "cwd-reparse-rejected",
        "shell-reparse-rejected",
        "malformed-frame-rejected",
        "oversized-frame-rejected-before-allocation",
        "frame-replay-rejected",
        "environment-4096-unicode-boundary",
        "environment-4097-rejected-before-target",
        "metadata-overflow-rejected-before-target",
        "query-confirms-empty-without-completion-consumption",
        `handle-leak-${handleLoops}-loops`,
        "stdin",
        "graceful-stop",
        "job-tree",
        "root-exit-tree",
        "helper-crash",
        "invalid-control-after-start-reaps-tree",
        "create-breakaway-from-job-rejected",
        "host-owner-death",
        "main-owner-death",
        "reaper",
        "reaper-identity-fail-closed",
        "electron-gui-tree",
        "unicode-space-path",
        "emoji-path",
        "long-file-path-over-260",
        ...(ping ? ["ping-continuous"] : []),
        ...(nmap ? ["nmap-loopback-limited"] : []),
        ...(python ? ["python-http"] : []),
        ...(javac && java ? ["java-runtime"] : []),
        ...(dotnetWatch ? ["dotnet-watch"] : []),
      ],
      helperBuildId: descriptor.buildId,
    }),
  );
} catch (error) {
  acceptanceError = error;
} finally {
  progress("cleanup");
  try {
    await removeFixtureTree(fixtureRoot);
  } catch (error) {
    cleanupError = error;
    if (acceptanceError) console.error(`[cleanup] ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (acceptanceError) throw acceptanceError;
if (cleanupError) throw cleanupError;
