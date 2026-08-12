import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { isTrustedPreloadLocation } from "./preload-location-policy.ts";

test("desktop bridge is exposed only to the packaged UI or exact dev origins", () => {
  assert.equal(isTrustedPreloadLocation("app://bundle/index.html"), true);
  assert.equal(isTrustedPreloadLocation("http://localhost:5173/"), true);
  assert.equal(isTrustedPreloadLocation("http://127.0.0.1:5173/"), true);

  assert.equal(isTrustedPreloadLocation("app://preview/token/index.html"), false);
  assert.equal(isTrustedPreloadLocation("data:text/html,failed"), false);
  assert.equal(isTrustedPreloadLocation("http://localhost:5173.evil.test/"), false);
  assert.equal(isTrustedPreloadLocation("https://localhost:5173/"), false);
  assert.equal(isTrustedPreloadLocation("invalid"), false);
});

test("preload exposes only the canonical piBridge API", () => {
  const preloadSource = fs.readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
  const rendererGlobals = fs.readFileSync(new URL("../renderer/global.d.ts", import.meta.url), "utf8");
  const exposedNames = [...preloadSource.matchAll(/exposeInMainWorld\("([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(exposedNames, ["piBridge"]);
  assert.doesNotMatch(rendererGlobals, /piDesktop/);
});
