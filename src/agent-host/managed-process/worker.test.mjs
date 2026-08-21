import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function waitFor(predicate, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(message));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

test(
  "worker strips its Electron bootstrap flag and does not load login profiles",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-managed-worker-env-"));
    await writeFile(path.join(directory, ".bash_profile"), "export PI_MANAGED_LOGIN_PROFILE=loaded\n", "utf8");
    const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const worker = spawn(process.execPath, ["--experimental-strip-types", workerEntry], {
      cwd: directory,
      env: { ...process.env, HOME: directory, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    worker.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    try {
      const closed = new Promise((resolve) => worker.once("close", resolve));
      worker.send({
        type: "bootstrap",
        processId: "proc-env",
        runId: "run-env",
        cwd: directory,
        command:
          'printf \'electron=%s profile=%s\\n\' "${ELECTRON_RUN_AS_NODE-unset}" "${PI_MANAGED_LOGIN_PROFILE-unset}"',
        shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
      });
      await closed;
      assert.equal(stdout, "electron=unset profile=unset\n");
    } finally {
      if (worker.pid && exists(worker.pid)) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  },
);

test(
  "worker keeps a POSIX process group leased, forwards stdin/output, and reaps descendants",
  { skip: process.platform === "win32", timeout: 15_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-managed-worker-"));
    const descendantFile = path.join(directory, "descendant.pid");
    const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const appScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify("setInterval(() => {}, 1000)")}], { stdio: "ignore" });`,
      `fs.writeFileSync(${JSON.stringify(descendantFile)}, String(descendant.pid));`,
      'console.log("READY http://127.0.0.1:43821/");',
      'process.stdin.on("data", (chunk) => process.stdout.write(`echo:${chunk}`));',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(appScript)}`;
    const worker = spawn(process.execPath, ["--experimental-strip-types", workerEntry], {
      cwd: directory,
      env: { ...process.env, PI_DESKTOP_MANAGED_PROCESS: "1" },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let descendantPid;
    worker.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    try {
      const started = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker start timed out")), 5_000);
        worker.on("message", (message) => {
          if (message?.type !== "started") return;
          clearTimeout(timer);
          resolve(message);
        });
      });
      worker.send({
        type: "bootstrap",
        processId: "proc-test",
        runId: "run-test",
        cwd: directory,
        command,
        shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
      });
      await started;
      await waitFor(() => stdout.includes("READY http://127.0.0.1:43821/"), 5_000, "readiness output missing");
      descendantPid = Number(await readFile(descendantFile, "utf8"));
      assert.equal(exists(descendantPid), true);

      worker.send({ type: "stdin", text: "hello", appendNewline: true, close: false });
      await waitFor(() => stdout.includes("echo:hello"), 2_000, "stdin was not forwarded");

      const closed = new Promise((resolve) => worker.once("close", resolve));
      worker.send({ type: "stop", mode: "graceful", source: "user" });
      await closed;
      await waitFor(() => !exists(descendantPid), 2_000, "descendant survived managed group stop");
      assert.equal(exists(worker.pid), false);
    } finally {
      if (worker.pid && exists(worker.pid)) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
      if (descendantPid && exists(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  },
);

test(
  "worker lease disconnect cleans the process group without a Host stop message",
  { skip: process.platform === "win32", timeout: 15_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-managed-lease-"));
    const descendantFile = path.join(directory, "descendant.pid");
    const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const appScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify("setInterval(() => {}, 1000)")}], { stdio: "ignore" });`,
      `fs.writeFileSync(${JSON.stringify(descendantFile)}, String(descendant.pid));`,
      'console.log("LEASE_READY");',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const worker = spawn(process.execPath, ["--experimental-strip-types", workerEntry], {
      cwd: directory,
      env: { ...process.env },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let descendantPid;
    worker.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    try {
      worker.send({
        type: "bootstrap",
        processId: "proc-lease",
        runId: "run-lease",
        cwd: directory,
        command: `${shellQuote(process.execPath)} -e ${shellQuote(appScript)}`,
        shell: { executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" },
      });
      await waitFor(() => stdout.includes("LEASE_READY"), 5_000, "lease fixture did not start");
      descendantPid = Number(await readFile(descendantFile, "utf8"));
      worker.disconnect();
      await waitFor(() => !exists(worker.pid), 8_000, "worker survived lease disconnect");
      await waitFor(() => !exists(descendantPid), 2_000, "lease disconnect left a descendant running");
    } finally {
      if (worker.pid && exists(worker.pid)) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
      if (descendantPid && exists(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  },
);
