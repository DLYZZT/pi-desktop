import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { checkArchitecture } from "./architecture-checker.mjs";

function fixture(t, files, policy = {}, compilerOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi architecture "));
  const write = (name, contents) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        baseUrl: ".",
        paths: { "@/*": ["src/renderer/*"], "@shared/*": ["src/shared/*"], "@host/*": ["src/agent-host/*"] },
        ...compilerOptions,
      },
    }),
  );
  for (const [name, contents] of Object.entries(files)) write(name, contents);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, write, run: (nextPolicy = policy) => checkArchitecture({ root, policy: nextPolicy }) };
}

test("Renderer aliases and shared re-exports expose the complete Node capability path", (t) => {
  const entry = fixture(t, {
    "src/renderer/view.ts": 'export {read} from "@shared/barrel";',
    "src/shared/barrel.ts": 'export {read} from "./legacy-server";',
    "src/shared/legacy-server.ts": 'import fs from "node:fs"; export const read = fs.readFileSync;',
  });
  const failures = entry.run().failures;
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /renderer-node: src\/renderer\/view.ts -> src\/shared\/barrel.ts -> src\/shared\/legacy-server.ts -> node:fs/,
  );
});

test("type-only and compiler-erased imports do not become runtime dependencies", (t) => {
  const entry = fixture(t, {
    "src/renderer/view.ts":
      'import type {A} from "@host/value"; import {B} from "@host/value"; export type X = A & B; export {type A} from "@host/value";',
    "src/agent-host/value.ts":
      'import fs from "node:fs"; export type A = {a: string}; export type B = {b: string}; export const read = fs.readFileSync;',
  });
  assert.deepEqual(entry.run().failures, []);
  entry.write(
    "src/renderer/view.ts",
    'import {type A, read} from "@host/value"; export const value: A = {a: String(read)};',
  );
  assert.ok(
    entry.run().failures.some((failure) => failure.includes("layer: src/renderer/view.ts -> src/agent-host/value.ts")),
  );
});

test("shared/node is a boundary even when a helper currently imports no builtins", (t) => {
  const entry = fixture(t, {
    "src/renderer/view.ts": 'export {value} from "@shared/node/helper";',
    "src/shared/node/helper.ts": "export const value = 1;",
  });
  assert.ok(
    entry
      .run()
      .failures.some((failure) => failure.includes("renderer-node") && failure.includes("src/shared/node/helper.ts")),
  );
});

test("ordinary Main and Host code can both import shared Node capabilities", (t) => {
  const entry = fixture(t, {
    "src/main/index.ts": 'export {read} from "@shared/node/helper";',
    "src/agent-host/index.ts": 'export {read} from "@shared/node/helper";',
    "src/shared/node/helper.ts": 'import fs from "node:fs"; export const read = fs.readFileSync;',
  });
  assert.deepEqual(entry.run().failures, []);
});

test("Main/Host and backwards shared dependencies are rejected with resolved paths", (t) => {
  const entry = fixture(t, {
    "src/main/index.ts": 'export {value} from "@host/helper.js";',
    "src/agent-host/helper.ts": 'export const value = 1; export * from "../main/other";',
    "src/main/other.ts": "export const other = 2;",
    "src/shared/node/helper.ts": 'export {value} from "@host/helper";',
  });
  const failures = entry.run().failures.join("\n");
  assert.match(failures, /layer: src\/main\/index.ts -> src\/agent-host\/helper.ts/);
  assert.match(failures, /layer: src\/agent-host\/helper.ts -> src\/main\/other.ts/);
  assert.match(failures, /layer: src\/shared\/node\/helper.ts -> src\/agent-host\/helper.ts/);
});

test("cycles terminate and still reveal a shared Node dependency", (t) => {
  const entry = fixture(t, {
    "src/renderer/view.ts": 'export * from "@shared/a";',
    "src/shared/a.ts": 'export * from "./b";',
    "src/shared/b.ts": 'export * from "./a"; import path from "path"; export const join = path.join;',
  });
  assert.equal(entry.run().failures.filter((failure) => failure.includes("node:path")).length, 1);
});

for (const expression of ['import("node:fs")', 'require("fs")']) {
  test("literal module expression is included: " + expression, (t) => {
    const entry = fixture(t, { "src/renderer/view.ts": "export const value = " + expression + ";" });
    assert.ok(entry.run().failures.some((failure) => failure.includes("renderer-node") && failure.includes("node:fs")));
  });
}

test("non-literal imports and missing runtime modules cannot silently disappear", (t) => {
  const entry = fixture(t, {
    "src/renderer/view.ts": 'const name = "./unknown"; export const value = import(name); export * from "./missing";',
  });
  const failures = entry.run().failures.join("\n");
  assert.match(failures, /non-literal runtime import/);
  assert.match(failures, /unresolved runtime import .\/missing/);
});

test("relative and package CSS assets resolve without allowing missing assets", (t) => {
  const entry = fixture(t, {
    "src/renderer/view.ts": 'import "./view.css"; import "theme/theme.css"; export const value = 1;',
    "src/renderer/view.css": ".view {color: red}",
    "node_modules/theme/package.json": '{"name":"theme","exports":{"./theme.css":"./theme.css"}}',
    "node_modules/theme/theme.css": ".theme {color: blue}",
  });
  assert.deepEqual(entry.run().failures, []);
  fs.rmSync(path.join(entry.root, "src/renderer/view.css"));
  assert.ok(entry.run().failures.some((failure) => failure.includes("unresolved runtime import ./view.css")));
});

test("realpath resolution prevents symlinked imports from disguising the Main layer", (t) => {
  const entry = fixture(
    t,
    {
      "src/renderer/view.ts": 'export {value} from "@shared/linked/helper";',
      "src/main/helper.ts": "export const value = 1;",
    },
    {},
    { preserveSymlinks: true },
  );
  fs.mkdirSync(path.join(entry.root, "src/shared"), { recursive: true });
  fs.symlinkSync(path.join(entry.root, "src/main"), path.join(entry.root, "src/shared/linked"), "junction");
  assert.ok(
    entry.run().failures.some((failure) => failure.includes("layer: src/renderer/view.ts -> src/main/helper.ts")),
  );
});

test("a Renderer entry symlink cannot change its execution layer to Main", (t) => {
  const entry = fixture(t, { "src/main/helper.ts": "export const value = 1;" });
  fs.mkdirSync(path.join(entry.root, "src/renderer"), { recursive: true });
  // A directory junction works on Windows without developer-mode file symlinks.
  fs.symlinkSync(path.join(entry.root, "src/main"), path.join(entry.root, "src/renderer/linked"), "junction");
  entry.write("src/renderer/index.ts", 'export {value} from "./linked/helper";');
  assert.ok(entry.run().failures.some((failure) => failure.includes("src/main/helper.ts")));
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(entry.root, "src/main/helper.ts"), path.join(entry.root, "src/renderer/entry.ts"));
    assert.ok(
      entry.run().failures.some((failure) => failure.includes("layer: src/renderer/entry.ts -> src/main/helper.ts")),
    );
  }
});

test("runtime imports cannot use declaration files as a false safe endpoint", (t) => {
  const entry = fixture(t, {
    "src/renderer/view.ts": 'export {run} from "@shared/only-types";',
    "src/shared/only-types.d.ts": "export declare function run(): void;",
  });
  assert.ok(entry.run().failures.some((failure) => failure.includes("resolves only to a declaration")));
});

test("an entire Renderer directory symlink retains Renderer boundary checks", (t) => {
  const entry = fixture(t, { "src/main/helper.ts": "export const value = 1;" });
  fs.symlinkSync(path.join(entry.root, "src/main"), path.join(entry.root, "src/renderer"), "junction");
  assert.ok(
    entry.run().failures.some((failure) => failure.includes("layer: src/renderer/helper.ts -> src/main/helper.ts")),
  );
});

test("Renderer cannot load the Electron package but explicit bridge types are allowed", (t) => {
  const entry = fixture(t, {
    "src/renderer/view.ts": 'import {app} from "electron"; export const value = app;',
    "node_modules/electron/package.json": '{"name":"electron","types":"index.d.ts"}',
    "node_modules/electron/index.d.ts": "export const app: unknown;",
  });
  assert.ok(entry.run().failures.some((failure) => failure.includes("renderer-node") && failure.includes("electron")));
  entry.write("src/renderer/view.ts", 'import type {app} from "electron"; export type App = typeof app;');
  assert.deepEqual(entry.run().failures, []);
});

test("existing budgets block growth and cannot become obsolete or unused silently", (t) => {
  const module = "src/renderer/Existing.tsx";
  const lines = (count) =>
    Array.from({ length: count }, (_, i) => "export const value" + i + " = " + i + ";").join("\n");
  const policy = { lineLimit: 10, budgets: { [module]: { maxLines: 12, reason: "existing UI" } } };
  const entry = fixture(t, { [module]: lines(12) }, policy);
  assert.deepEqual(entry.run().failures, []);
  entry.write(module, lines(13));
  assert.ok(entry.run().failures.some((failure) => failure.includes("exceeds baseline 12")));
  entry.write(module, lines(2));
  assert.ok(entry.run().failures.some((failure) => failure.includes("remove the obsolete")));
  assert.ok(
    entry
      .run({ ...policy, budgets: { "src/renderer/missing.tsx": policy.budgets[module] } })
      .failures.some((failure) => failure.includes("Unused structure baseline")),
  );
});

test("new ordinary modules use the default limit rather than inheriting an old directory exemption", (t) => {
  const entry = fixture(
    t,
    {
      "src/renderer/New.tsx": Array.from({ length: 5 }, (_, i) => "export const n" + i + " = " + i + ";").join("\n"),
    },
    { lineLimit: 4 },
  );
  assert.ok(entry.run().failures.some((failure) => failure.includes("exceeds new-module limit 4")));
});

test("data exemptions allow literal dictionaries but reject executable initializers and getters", (t) => {
  const file = "src/renderer/dictionary.ts";
  const entry = fixture(
    t,
    {
      [file]: 'export const en = {\n a: "one",\n b: "two",\n};\nexport const dictionaries = {en};',
    },
    { lineLimit: 2, dataModules: { [file]: { baselineLines: 5, reason: "translation data" } } },
  );
  // Use explicit properties: shorthand can hide executable bindings.
  entry.write(file, 'export const en = {\n a: "one",\n b: "two",\n};\nexport const dictionaries = {en: en};');
  assert.deepEqual(entry.run().failures, []);
  for (const source of ['export const en = {a: (() => "one")()};', 'export const en = {get a() {return "one"}};']) {
    entry.write(file, source);
    assert.ok(
      entry.run().failures.some((failure) => failure.includes("data-only exemption contains executable logic")),
    );
  }
});

test("exceptions require exact used edges, a reason and a removal condition", (t) => {
  const entry = fixture(t, {
    "src/main/index.ts": 'export {value} from "@host/helper";',
    "src/agent-host/helper.ts": "export const value = 1;",
  });
  const exception = {
    rule: "layer",
    from: "src/main/index.ts",
    to: "src/agent-host/helper.ts",
    reason: "legacy fixture",
    removeWhen: "the helper moves to shared",
  };
  assert.deepEqual(entry.run({ exceptions: [exception] }).failures, []);
  for (const invalid of [
    { ...exception, from: "src/main/*" },
    { ...exception, removeWhen: "" },
    { ...exception, to: "src/agent-host/unused.ts" },
  ])
    assert.ok(entry.run({ exceptions: [invalid] }).failures.length > 0);
  assert.ok(
    entry.run({ exceptions: [exception, exception] }).failures.some((failure) => failure.includes("Duplicate")),
  );
});

test("empty extraction and syntax errors cannot pass the architecture check", (t) => {
  const entry = fixture(t, {});
  assert.ok(entry.run().failures.some((failure) => failure.includes("No runtime source")));
  entry.write("src/renderer/view.ts", 'import { from "broken');
  assert.ok(entry.run().failures.length > 0);
});

test("the CLI succeeds for valid code and exits nonzero for a boundary violation", (t) => {
  const entry = fixture(t, { "src/renderer/view.ts": "export const value = 1;" });
  for (const script of ["check-architecture.mjs", "architecture-checker.mjs"]) {
    entry.write("scripts/" + script, fs.readFileSync(new URL(script, import.meta.url), "utf8"));
  }
  entry.write("scripts/architecture-policy.mjs", "export const architecturePolicy = {};");
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(entry.root, "node_modules"),
    "junction",
  );
  const run = () =>
    spawnSync(process.execPath, [path.join(entry.root, "scripts/check-architecture.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
      shell: false,
    });
  assert.equal(run().status, 0);
  entry.write("src/renderer/view.ts", 'export const value = import("node:fs");');
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /renderer-node/);
});
