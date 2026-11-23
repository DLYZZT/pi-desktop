import assert from "node:assert/strict";
import test from "node:test";
import { selectDefaultCandidates } from "./public-state.ts";

function candidate(capability, provider, executable) {
  return {
    id: `${provider}:${executable}`,
    capability,
    provider,
    discovery: "test",
    executable,
    binDir: "/tools",
    health: "healthy",
    rank: 1,
  };
}

test("auto prefers the Pi-managed adb once it is installed", () => {
  const system = candidate("android.adb", "system", "/usr/bin/adb");
  const managed = candidate("android.adb", "managed", "/home/pi/toolchains/platform-tools/adb");
  const selected = selectDefaultCandidates([system, managed], {});
  assert.equal(selected["android.adb"]?.provider, "managed");
});

test("explicit adb selections still override auto, and explicit system preference is respected", () => {
  const custom = candidate("android.adb", "custom", "/opt/custom/adb");
  const system = candidate("android.adb", "system", "/usr/bin/adb");
  const managed = candidate("android.adb", "managed", "/home/pi/toolchains/platform-tools/adb");
  const candidates = [system, managed, custom];
  assert.equal(selectDefaultCandidates(candidates, {})["android.adb"]?.provider, "custom");
  assert.equal(selectDefaultCandidates(candidates, { "android.adb": "system" })["android.adb"]?.provider, "system");
});

test("other capabilities keep the documented provider order", () => {
  const system = candidate("search.rg", "system", "/usr/bin/rg");
  const managed = candidate("search.rg", "managed", "/home/pi/toolchains/ripgrep/rg");
  const selected = selectDefaultCandidates([system, managed], {});
  assert.equal(selected["search.rg"]?.provider, "system");
});
