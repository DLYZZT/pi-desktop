import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BrowserProfileManager,
  DEFAULT_BROWSER_PROFILE_ID,
  partitionForProfile,
  persistentPartitionDirectory,
} from "./browser-profile-manager.ts";

function fakeSession() {
  const calls = [];
  return {
    calls,
    clearStorageData: async (options) => calls.push(["clearStorageData", options]),
    clearCache: async () => calls.push(["clearCache"]),
    closeAllConnections: async () => calls.push(["closeAllConnections"]),
    setProxy: async (options) => calls.push(["setProxy", options]),
  };
}

function managerAt(root, sessions, options = {}) {
  let generatedId = 0;
  return new BrowserProfileManager({
    userDataDir: root,
    launchId: options.launchId ?? "launch-one",
    createId: options.createId ?? (() => `profile-${++generatedId}`),
    now: options.now ?? (() => new Date("2026-07-21T12:00:00.000Z")),
    fromPartition(partition) {
      const session = fakeSession();
      sessions.push({ partition, session });
      return session;
    },
    configureSession(profile, session) {
      session.calls.push(["configure", profile.id]);
    },
    removePartitionDirectory: options.removePartitionDirectory,
  });
}

test("profiles use isolated persistent, temporary, and unsafe partitions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-profile-"));
  try {
    const sessions = [];
    const manager = managerAt(root, sessions);
    const persistent = manager.create({ name: "Signed in", mode: "persistent" });
    const ephemeral = manager.create({ name: "Scratch", mode: "ephemeral" });
    const unsafe = manager.create({ name: "Lab", mode: "unsafe" });

    manager.getSession(DEFAULT_BROWSER_PROFILE_ID);
    manager.getSession(persistent.id);
    manager.getSession(ephemeral.id);
    manager.getSession(unsafe.id);

    assert.deepEqual(
      sessions.map((entry) => entry.partition),
      [
        "pi-browser-launch-one-temporary",
        `persist:pi-browser-${persistent.id}`,
        `pi-browser-launch-one-${ephemeral.id}`,
        `pi-browser-unsafe-launch-one-${unsafe.id}`,
      ],
    );
    assert.equal(partitionForProfile(persistent, "ignored"), `persist:pi-browser-${persistent.id}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only persistent profile metadata survives relaunch and is private on disk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-profile-"));
  try {
    const first = managerAt(root, [], {
      createId: (() => {
        let id = 0;
        return () => `p-${++id}`;
      })(),
    });
    const persistent = first.create({ name: "Account", mode: "persistent" });
    first.create({ name: "Throwaway", mode: "ephemeral" });
    first.create({ name: "Unsafe", mode: "unsafe" });

    const file = path.join(root, "browser-profiles.json");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const second = managerAt(root, []);
    const profiles = second.list();
    assert.deepEqual(
      profiles.map((profile) => [profile.id, profile.mode]),
      [
        [DEFAULT_BROWSER_PROFILE_ID, "ephemeral"],
        [persistent.id, "persistent"],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile data clearing, proxy changes, and disposal respect profile lifetime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-profile-"));
  try {
    const sessions = [];
    const manager = managerAt(root, sessions);
    const persistent = manager.create({ name: "Account", mode: "persistent" });

    await manager.clearData(DEFAULT_BROWSER_PROFILE_ID, "cookies");
    await manager.applyProxy(persistent.id, { mode: "custom", proxyRules: "http=127.0.0.1:8080" });
    assert.deepEqual(sessions[0].session.calls.at(-1), ["clearStorageData", { storages: ["cookies"] }]);
    assert.deepEqual(sessions[1].session.calls.at(-1), [
      "setProxy",
      { mode: "fixed_servers", proxyRules: "http=127.0.0.1:8080" },
    ]);

    await manager.dispose();
    assert.equal(
      sessions[0].session.calls.some(([name]) => name === "clearCache"),
      true,
    );
    assert.equal(sessions[1].session.calls.filter(([name]) => name === "clearCache").length, 0);
    assert.equal(
      sessions.every(({ session }) => session.calls.some(([name]) => name === "closeAllConnections")),
      true,
    );
    await assert.rejects(manager.delete(DEFAULT_BROWSER_PROFILE_ID), /cannot be changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deleting a persistent profile clears its session and verified partition directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-profile-"));
  try {
    const sessions = [];
    const manager = managerAt(root, sessions);
    const profile = manager.create({ name: "Delete me", mode: "persistent" });
    manager.getSession(profile.id);
    const directory = persistentPartitionDirectory(root, profile);
    fs.mkdirSync(path.join(directory, "Code Cache"), { recursive: true });
    fs.writeFileSync(path.join(directory, "Code Cache", "entry"), "cached");

    await manager.delete(profile.id);

    assert.deepEqual(
      sessions[0].session.calls.slice(-3).map(([name]) => name),
      ["clearStorageData", "clearCache", "closeAllConnections"],
    );
    assert.equal(fs.existsSync(directory), false);
    assert.throws(() => manager.get(profile.id), /not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("locked persistent partitions keep profile metadata and return a retryable error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-profile-"));
  let locked = true;
  try {
    const manager = managerAt(root, [], {
      removePartitionDirectory: async () => {
        if (locked) throw Object.assign(new Error("locked"), { code: "EPERM" });
      },
    });
    const profile = manager.create({ name: "Locked", mode: "persistent" });
    manager.getSession(profile.id);

    await assert.rejects(manager.delete(profile.id), (error) => {
      assert.equal(error.code, "PROFILE_DELETE_RETRY_REQUIRED");
      assert.equal(error.retryable, true);
      assert.equal(error.recovery.remediation, "wait-and-retry-once");
      return true;
    });
    assert.equal(manager.get(profile.id).name, "Locked");

    locked = false;
    await manager.delete(profile.id);
    assert.throws(() => manager.get(profile.id), /not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
