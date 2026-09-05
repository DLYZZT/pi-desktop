import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const runtimePackages =
  /^@earendil-works\/(?:pi-(?:ai|coding-agent|server|agent-core|client|protocol|telemetry|tui)|chord)$/;

/** Resolve from each importer's location, including nested shrinkwrap packages and ASAR hoisting. */
export function validatePiPackageGraph({ readPackage, exists, version }) {
  const seen = new Map();
  function resolvePackage(from, name) {
    let current = from;
    for (;;) {
      const candidate = `${current ? `${current}/` : ""}node_modules/${name}`;
      if (exists(`${candidate}/package.json`)) return candidate;
      if (!current) throw new Error(`Pi runtime dependency is missing: ${name}`);
      const index = current.lastIndexOf("/node_modules/");
      current = index < 0 ? "" : current.slice(0, index);
    }
  }
  function visit(root) {
    if (seen.has(root)) return;
    const manifest = readPackage(`${root}/package.json`);
    if (manifest.version !== version) throw new Error(`Pi runtime version mismatch: ${manifest.name}`);
    const main = manifest.exports?.["."]?.import ?? manifest.main;
    if (typeof main !== "string" || !exists(path.posix.normalize(`${root}/${main}`))) {
      throw new Error(`Pi runtime entry is missing: ${manifest.name}`);
    }
    seen.set(root, manifest.version);
    for (const name of Object.keys(manifest.dependencies ?? {}).filter((name) => runtimePackages.test(name))) {
      visit(resolvePackage(root, name));
    }
    if (manifest.name === "@earendil-works/pi-coding-agent") {
      // 0.85.0 has an undeclared static server import through main.js.
      if (version === "0.85.0") visit(resolvePackage(root, "@earendil-works/pi-server"));
      for (const entry of [
        manifest.bin?.pi,
        manifest.exports?.["./rpc-entry"]?.import,
        manifest.exports?.["./client"]?.import,
      ]) {
        if (typeof entry !== "string" || !exists(path.posix.normalize(`${root}/${entry}`))) {
          throw new Error("Pi coding-agent CLI/RPC/client entry is missing");
        }
      }
    }
  }
  for (const name of ["pi-ai", "pi-coding-agent", "pi-telemetry"]) visit(resolvePackage("", `@earendil-works/${name}`));
  return seen;
}

export function probePiRuntime(root, cliPath, version) {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-runtime-probe-"));
  try {
    const env = {};
    for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      HOME: fixture,
      USERPROFILE: fixture,
      TMPDIR: fixture,
      TMP: fixture,
      TEMP: fixture,
      PI_CODING_AGENT_DIR: path.join(fixture, "agent"),
      PI_CODING_AGENT_SESSION_DIR: path.join(fixture, "sessions"),
      PI_OFFLINE: "1",
    });
    const run = (args) => {
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        shell: false,
      });
      if (result.error || result.signal || result.status !== 0) {
        const missing = result.stderr?.match(/Cannot find package '([^']+)'/)?.[1];
        throw new Error(
          `Pi runtime probe failed (${result.error?.code ?? result.signal ?? result.status}${missing ? `; missing ${missing}` : ""})`,
        );
      }
      return result.stdout.trim();
    };
    run(["--input-type=module", "--eval", 'await import("@earendil-works/pi-coding-agent")']);
    if (run([cliPath, "--version"]) !== version) throw new Error("Pi CLI version mismatch");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
