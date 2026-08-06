import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserSecretVault } from "./browser-secret-vault.ts";

const codec = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`sealed:${value}`, "utf8"),
  decrypt: (value) => value.toString("utf8").replace(/^sealed:/, ""),
};

test("BrowserSecretVault stores only encrypted values and uses private file permissions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-vault-"));
  try {
    const file = path.join(root, "browser-secrets.json");
    const first = new BrowserSecretVault(file, codec);
    const ref = first.set("Bearer very-secret");
    assert.equal(first.get(ref), "Bearer very-secret");
    assert.equal(fs.readFileSync(file, "utf8").includes("Bearer very-secret"), false);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const second = new BrowserSecretVault(file, codec);
    assert.equal(second.get(ref), "Bearer very-secret");
    second.remove(ref);
    assert.equal(second.get(ref), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("BrowserSecretVault fails closed when secure storage is unavailable or corrupt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-vault-"));
  try {
    const file = path.join(root, "browser-secrets.json");
    fs.writeFileSync(file, "not-json");
    const vault = new BrowserSecretVault(file, { ...codec, isAvailable: () => false });
    assert.throws(() => vault.set("secret"), /unavailable/);
    assert.equal(vault.get("browser-secret-12345678"), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
