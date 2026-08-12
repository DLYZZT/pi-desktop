import assert from "node:assert/strict";
import test from "node:test";

import { MermaidRenderCache } from "./mermaid-renderer.ts";

test("Mermaid SVGs are cached by code, theme, and renderer version", async () => {
  const calls = [];
  let id = 0;
  const cache = new MermaidRenderCache(
    async () => ({
      default: {
        initialize(config) {
          calls.push(["initialize", config.theme]);
        },
        async parse(code) {
          calls.push(["parse", code]);
          return true;
        },
        async render(renderId, code) {
          calls.push(["render", renderId, code]);
          return { svg: `<svg>${code}</svg>` };
        },
      },
    }),
    () => `id-${++id}`,
  );

  const first = await cache.render("graph TD; A-->B", false);
  const previewAgain = await cache.render("graph TD; A-->B", false);
  const dark = await cache.render("graph TD; A-->B", true);

  assert.equal(previewAgain, first);
  assert.equal(dark, first);
  assert.deepEqual(calls, [
    ["initialize", "default"],
    ["parse", "graph TD; A-->B"],
    ["render", "id-1", "graph TD; A-->B"],
    ["initialize", "dark"],
    ["parse", "graph TD; A-->B"],
    ["render", "id-2", "graph TD; A-->B"],
  ]);
});

test("failed Mermaid renders are evicted so corrected runtime state can retry", async () => {
  let attempts = 0;
  const cache = new MermaidRenderCache(async () => ({
    default: {
      initialize() {},
      async parse() {
        attempts += 1;
        return attempts > 1;
      },
      async render() {
        return { svg: "<svg />" };
      },
    },
  }));

  await assert.rejects(cache.render("graph", false), /Invalid Mermaid/);
  assert.equal(await cache.render("graph", false), "<svg />");
  assert.equal(attempts, 2);
});
