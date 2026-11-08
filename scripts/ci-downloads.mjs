#!/usr/bin/env node
/** CI-only release downloads: official GitHub API transport, original pinned hashes and installers. */
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolvePackageFile, assertSuccessfulSpawn } from "./process-utils.mjs";

const root = path.resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

export function githubReleaseAsset(value) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/download\/([^/]+)\/([^/]+)$/u);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    throw new Error("Expected a fixed GitHub release asset URL");
  const tag = decodeURIComponent(match[3]),
    name = decodeURIComponent(match[4]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/u.test(tag) || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(name))
    throw new Error("Release tag and asset must be literal names");
  return { repo: `${match[1]}/${match[2]}`, tag, name };
}

async function verifiedFile(file, sha256, bytes) {
  try {
    const info = await stat(file);
    if (!info.isFile() || (bytes !== undefined && info.size !== bytes)) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === sha256;
  } catch {
    return false;
  }
}

async function runGh(args) {
  await execFileAsync("gh", args, { timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true });
}

export async function downloadReleaseAsset(url, destination, sha256, bytes, options = {}) {
  const asset = githubReleaseAsset(url);
  if (!/^[a-f0-9]{64}$/u.test(sha256 ?? "") || (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes <= 0)))
    throw new Error("A pinned SHA-256 and a valid optional size are required");
  if (await verifiedFile(destination, sha256, bytes)) return destination;
  const run = options.runGh ?? runGh,
    sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // gh release download uses the release asset API, not the failing github.com/download redirect.
        await run([
          "release",
          "download",
          asset.tag,
          "--repo",
          `github.com/${asset.repo}`,
          "--pattern",
          asset.name,
          "--output",
          temporary,
          "--clobber",
        ]);
        break;
      } catch (error) {
        await rm(temporary, { force: true });
        if (attempt === 3) {
          const status = /HTTP\s+(\d{3})/iu.exec(error.stderr ?? "")?.[1] ?? error.code ?? "unknown";
          throw new Error(`Release download failed for ${asset.repo}/${asset.name} (${status})`, { cause: error });
        }
        await sleep(attempt * 2000);
      }
    }
    if (!(await verifiedFile(temporary, sha256, bytes)))
      throw new Error(`Release asset failed pinned integrity verification: ${asset.name}`);
    await rename(temporary, destination);
    console.log(`[ci-downloads] verified ${asset.name}`);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}

function readJson(projectRoot, relative) {
  return JSON.parse(readFileSync(path.join(projectRoot, relative), "utf8"));
}

function runNode(projectRoot, args) {
  const hook = pathToFileURL(path.join(projectRoot, "scripts/ci-github-fetch.mjs")).href;
  assertSuccessfulSpawn(
    spawnSync(process.execPath, ["--import", hook, ...args], {
      cwd: projectRoot,
      env: { ...process.env, PI_CI_GITHUB_ASSETS: "1" },
      stdio: "inherit",
    }),
    "CI artifact preparation",
  );
}

export async function prepareCiDownloads(args, projectRoot = root) {
  const [mode, ...values] = args;
  if (mode === "electron" && values.length === 0) {
    runNode(projectRoot, [resolvePackageFile(projectRoot, "electron", "install.js")]);
    return;
  }
  if (mode === "builder" && values.length > 0) {
    runNode(projectRoot, [resolvePackageFile(projectRoot, "electron-builder", "out/cli/cli.js"), ...values]);
    return;
  }
  if (mode === "tools" && values.length === 1) {
    runNode(projectRoot, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      "scripts/prepare-bundled-tools.mjs",
      "--target",
      values[0],
    ]);
    return;
  }
  if (mode === "herdr-fixture" && values.length === 0) {
    if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV || process.platform === "win32")
      throw new Error("Herdr fixture requires a macOS/Linux Actions runner");
    const target = `${process.platform}-${process.arch}`;
    const herdr = readJson(projectRoot, "build/herdr/runtime-catalog.json");
    const artifact = herdr.artifacts[target];
    if (!artifact) throw new Error(`Missing Herdr for ${target}`);
    const destination = path.join(process.env.RUNNER_TEMP, `herdr-v${herdr.version}`);
    await downloadReleaseAsset(artifact.url, destination, artifact.sha256, artifact.downloadBytes);
    await chmod(destination, 0o700);
    await appendFile(process.env.GITHUB_ENV, `HERDR_E2E_BINARY=${destination}\n`);
    return;
  }
  if (mode === "asset" && (values.length === 3 || values.length === 4))
    return downloadReleaseAsset(
      values[0],
      path.resolve(values[1]),
      values[2],
      values[3] === undefined ? undefined : Number(values[3]),
    );
  throw new Error(
    "Usage: ci-downloads.mjs electron | builder <args> | tools <target> | herdr-fixture | asset <url> <file> <sha256> [bytes]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareCiDownloads(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
