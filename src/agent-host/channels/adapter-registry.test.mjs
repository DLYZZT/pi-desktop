import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { AdapterRegistry, state } = await importTestBundle("lazy-adapter-registry", {
  stdin: {
    contents: 'export { AdapterRegistry } from "./adapter-registry.ts"; export { state } from "adapter-test-state";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  plugins: [
    {
      name: "count-adapter-loads",
      setup(build) {
        build.onResolve({ filter: /^adapter-test-state$/ }, () => ({ path: "state", namespace: "adapter-test" }));
        build.onResolve({ filter: /^\.\/adapters\/.*\/adapter$/ }, ({ path }) => ({ path, namespace: "adapter-test" }));
        build.onLoad({ filter: /.*/, namespace: "adapter-test" }, ({ path }) => {
          if (path === "state") return { contents: "export const state = { loaded: [], created: [], fail: null };" };
          const id = path.split("/")[2];
          const name = `${id[0].toUpperCase()}${id.slice(1)}Adapter`;
          return {
            contents: `
          import { state } from "adapter-test-state";
          state.loaded.push("${id}");
          export class ${name} {
            id = "${id}";
            constructor() {
              state.created.push(this.id);
              if (state.fail === this.id) throw new Error("load failed");
            }
          }
        `,
          };
        });
      },
    },
  ],
});

test("adapters load on demand, share concurrent loads, and preserve registered overrides", async () => {
  const registry = new AdapterRegistry();
  assert.deepEqual(state.loaded, []);
  const [first, second] = await Promise.all([registry.get("weixin"), registry.get("weixin")]);
  assert.equal(first, second);
  assert.equal(await registry.get("weixin"), first);
  assert.deepEqual(state.loaded, ["weixin"]);
  assert.deepEqual(state.created, ["weixin"]);

  const override = { id: "feishu" };
  registry.register(override);
  assert.equal(await registry.get("feishu"), override);
  assert.deepEqual(state.loaded, ["weixin"]);

  const pending = registry.get("telegram");
  const replacement = { id: "telegram" };
  registry.register(replacement);
  assert.equal(await pending, replacement);

  state.fail = "feishu";
  const retry = new AdapterRegistry();
  await assert.rejects(retry.get("feishu"), /load failed/);
  state.fail = null;
  assert.equal((await retry.get("feishu")).id, "feishu");
  await assert.rejects(registry.get("toString"), /unavailable/);
});
