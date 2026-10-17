import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { AgentShellPreferences, selectSessionShell, DesktopSessionToolStore, applySessionToolCommand } =
  await importTestBundle("agent-shell-settings", {
    packages: "external",
    stdin: {
      resolveDir: import.meta.dirname,
      loader: "ts",
      contents:
        'export {AgentShellPreferences} from "./agent-shell-settings.ts";export {selectSessionShell} from "./session-shell.ts";export {DesktopSessionToolStore} from "./session-tool-store.ts";export {applySessionToolCommand} from "./session-tool-settings.ts";',
    },
  });

test("global shell preferences persist, validate input and remain Windows-only", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-agent-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "shell.json"),
    prefs = new AgentShellPreferences(file, "win32");
  assert.equal(prefs.get().shell, "powershell");
  prefs.set("bash");
  assert.equal(new AgentShellPreferences(file, "win32").get().shell, "bash");
  assert.throws(() => prefs.set("cmd"));
  const posix = new AgentShellPreferences(file, "darwin");
  assert.equal(posix.get().shell, "bash");
  assert.throws(() => posix.set("powershell"));
  writeFileSync(file, "broken");
  assert.throws(() => prefs.get());
});

test("new sessions capture a single shell; reload, no-tools transitions and legacy grants keep their original scope", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-shell-sessions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefs = new AgentShellPreferences(path.join(root, "shell.json"), "win32");
  const file = path.join(root, "session-tools.json");
  const store = new DesktopSessionToolStore(file, "win32");
  const choose = (options) =>
    selectSessionShell({ platform: "win32", readDefault: () => prefs.get().shell, ...options });
  const first = choose({ isNew: true, toolNames: ["read", "bash", "powershell", "edit"] });
  assert.deepEqual(first, { shell: "powershell", toolNames: ["read", "powershell", "edit"] });
  store.set("first", first.toolNames, first.shell);
  prefs.set("bash");
  const second = choose({ isNew: true, toolNames: ["read", "powershell"] });
  assert.deepEqual(second, { shell: "bash", toolNames: ["read", "bash"] });
  const reopened = new DesktopSessionToolStore(file, "win32");
  assert.equal(
    choose({ isNew: false, storedShell: reopened.getShell("first"), toolNames: reopened.get("first") }).shell,
    "powershell",
  );
  assert.deepEqual(choose({ isNew: true, toolNames: [] }), { shell: "bash", toolNames: [] });
  assert.deepEqual(choose({ isNew: true, toolNames: ["read"] }).toolNames, ["read"]);
  const neverRead = () => {
    throw new Error("existing sessions must not read the default");
  };
  const legacy = ["read", "bash", "powershell"];
  assert.deepEqual(
    selectSessionShell({ isNew: false, toolNames: legacy, platform: "win32", readDefault: neverRead }).toolNames,
    legacy,
  );
  assert.deepEqual(selectSessionShell({ isNew: true, platform: "linux", readDefault: neverRead }), {
    shell: undefined,
    toolNames: undefined,
  });
  store.set("first", []);
  assert.equal(store.getShell("first"), "powershell");
  store.set("first", ["read", "bash", "powershell"]);
  assert.deepEqual(store.get("first"), ["read", "powershell"]);
});

test(
  "a permission preset uses the captured shell without expanding no-tools or read-only grants",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-shell-permission-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new DesktopSessionToolStore(path.join(root, "tools.json"), "win32");
    store.set("fixture", [], "powershell");
    let active;
    const context = {
      sessionId: "fixture",
      session: {},
      preferences: store,
      apply: (names) => {
        active = names;
      },
    };
    for (const [requested, expected] of [
      [[], []],
      [["read"], ["read"]],
      [
        ["read", "bash", "powershell"],
        ["read", "powershell"],
      ],
    ]) {
      applySessionToolCommand(context, { type: "set_tools", toolNames: requested });
      assert.deepEqual(active, expected);
      assert.deepEqual(store.get("fixture"), expected);
      assert.equal(store.getShell("fixture"), "powershell");
    }
  },
);
