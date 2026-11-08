import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { downloadReleaseAsset, githubReleaseAsset } from "./ci-downloads.mjs";

const root = path.resolve(import.meta.dirname, "..");
const url = "https://github.com/example/runtime/releases/download/v1.2.3/runtime-linux-x64.zip";
const data = Buffer.from("verified release artifact");
const hash = createHash("sha256").update(data).digest("hex");
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-ci-download-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, destination: path.join(directory, "cached.zip") };
}
function outputFile(args) {
  return args[args.indexOf("--output") + 1];
}

test("CI release downloads accept only fixed GitHub asset identities", () => {
  assert.deepEqual(githubReleaseAsset(url), { repo: "example/runtime", tag: "v1.2.3", name: "runtime-linux-x64.zip" });
  for (const bad of [
    url.replace("https:", "http:"),
    url.replace("github.com", "github.com.evil.invalid"),
    url + "?token=secret",
    url + "#fragment",
    url.replace("runtime-linux-x64.zip", "*.zip"),
    url.replace("runtime-linux-x64.zip", "%2fescape"),
    "https://github.com/example/runtime/releases/latest",
  ])
    assert.throws(() => githubReleaseAsset(bad));
});

test("CI download retries a failed transfer, verifies bytes and reuses only a valid cache", async (t) => {
  const f = fixture(t),
    sleeps = [];
  let calls = 0;
  await downloadReleaseAsset(url, f.destination, hash, data.length, {
    runGh: async (args) => {
      calls++;
      assert.deepEqual(args.slice(0, 7), [
        "release",
        "download",
        "v1.2.3",
        "--repo",
        "github.com/example/runtime",
        "--pattern",
        "runtime-linux-x64.zip",
      ]);
      if (calls === 1) {
        writeFileSync(outputFile(args), "partial");
        throw Object.assign(new Error("network"), { stderr: "HTTP 504" });
      }
      assert.equal(existsSync(outputFile(args)), false);
      writeFileSync(outputFile(args), data);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.deepEqual(readFileSync(f.destination), data);
  assert.deepEqual(readdirSync(f.directory), ["cached.zip"]);
  await downloadReleaseAsset(url, f.destination, hash, data.length, {
    runGh: async () => assert.fail("valid cache must not download"),
  });
});

for (const corruption of ["hash", "size"]) {
  test(`CI download rejects ${corruption} corruption without replacing the previous file`, async (t) => {
    const f = fixture(t);
    writeFileSync(f.destination, "previous");
    let calls = 0;
    await assert.rejects(
      downloadReleaseAsset(url, f.destination, hash, corruption === "size" ? data.length + 1 : data.length, {
        runGh: async (args) => {
          calls++;
          writeFileSync(outputFile(args), corruption === "hash" ? Buffer.alloc(data.length) : data);
        },
        sleep: async () => assert.fail("integrity failure is not retried"),
      }),
      /integrity verification/,
    );
    assert.equal(calls, 1);
    assert.equal(readFileSync(f.destination, "utf8"), "previous");
    assert.deepEqual(readdirSync(f.directory), ["cached.zip"]);
  });
}

test("CI release failures are bounded and do not expose response URLs or credentials", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(
    downloadReleaseAsset(url, f.destination, hash, data.length, {
      runGh: async () => {
        calls++;
        throw Object.assign(new Error("failed"), { stderr: "HTTP 504 https://asset.invalid/?token=PRIVATE_FIXTURE" });
      },
      sleep: async () => {},
    }),
    (error) => {
      assert.match(error.message, /504/);
      assert.doesNotMatch(error.message, /PRIVATE_FIXTURE|asset.invalid/);
      return true;
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(readdirSync(f.directory), []);
  await assert.rejects(downloadReleaseAsset(url, f.destination, "", data.length), /pinned SHA-256/);
});

test("CI uses the API route for installs and packaging without exposing its token to tests", () => {
  const workflow = parse(readFileSync(path.join(root, ".github/workflows/build-desktop.yml"), "utf8"));
  for (const id of ["test-platforms", "quality", "package"]) {
    const steps = workflow.jobs[id].steps;
    const install = steps.find((step) => step.run === "node scripts/ci-downloads.mjs electron");
    assert.ok(install, id);
    assert.equal(install.if, undefined);
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.run?.includes("ci-downloads.mjs")) assert.equal(step.env?.GH_TOKEN, "${{ github.token }}");
      if (
        step.run?.includes("npm run smoke") ||
        step.run?.includes("npm run verify") ||
        step.run?.includes("npm run test:")
      )
        assert.equal(step.env?.GH_TOKEN, undefined, step.name);
    }
  }
  const packaging = workflow.jobs.package.steps.find((step) => step.name === "Package ${{ matrix.name }}");
  assert.ok(packaging.run.includes("ci-downloads.mjs builder"));
  assert.ok(!packaging.run.includes("electronDist"));
  assert.ok(packaging.run.includes("--publish never"));
});

test("tag release downloads retain verification, forced macOS signing and notarization", () => {
  const workflow = parse(readFileSync(path.join(root, ".github/workflows/build-desktop.yml"), "utf8"));
  const mac = workflow.jobs["release-macos"];
  const index = (name) => {
    const found = mac.steps.findIndex((step) => step.name === name);
    assert.ok(found >= 0, name);
    return found;
  };
  const electron = index("Install verified Electron runtime");
  const tools = index("Prepare verified macOS bundled tools");
  const verify = index("Run full verification before signing");
  const sign = index("Build, sign, and notarize macOS");
  assert.ok(electron < tools && tools < verify && verify < sign);
  assert.equal(mac.steps[electron].run, "node scripts/ci-downloads.mjs electron");
  for (const arch of ["arm64", "x64"])
    assert.ok(mac.steps[tools].run.includes(`ci-downloads.mjs tools darwin-${arch}`));
  assert.equal(mac.steps[verify].run, "npm run verify");
  assert.equal(mac.steps[verify].env, undefined);
  assert.equal(mac.steps[sign].env.CSC_IDENTITY_AUTO_DISCOVERY, "true");
  for (const flag of ["--mac dmg zip", "--arm64", "--x64", "-c.forceCodeSigning=true", "-c.mac.notarize=true"])
    assert.ok(mac.steps[sign].run.includes(flag), flag);
  for (const id of ["release-macos", "release-windows", "release-linux"]) {
    const build = workflow.jobs[id].steps.find((step) => step.run?.includes("ci-downloads.mjs builder"));
    assert.ok(build, id);
    assert.ok(build.run.includes("--publish never"), id);
    assert.ok(!build.run.includes("electronDist"), id);
    assert.equal(build.env.GH_TOKEN, "${{ github.token }}");
  }
});
