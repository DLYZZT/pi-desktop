import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const output = path.join(
  import.meta.dirname,
  "../../../../.artifacts/test-modules",
  `quick-weixin-binding-${process.pid}.mjs`,
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: 'export { QuickWeixinBinding } from "./QuickWeixinBinding.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "quick-weixin-binding-test-entry.tsx",
    loader: "tsx",
  },
  outfile: output,
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["react", "react-dom", "react-dom/*"],
  logLevel: "silent",
});

const { QuickWeixinBinding } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

function snapshot(sessionId, connected) {
  const now = new Date().toISOString();
  return {
    accounts: [
      {
        id: "wx-one",
        channel: "weixin",
        name: "My WeChat",
        enabled: true,
        configured: true,
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        groupAllowFrom: [],
        requireMention: true,
        toolNames: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    statuses: [{ channel: "weixin", accountId: "wx-one", state: "running", connected }],
    pairings: [],
    bindings: [
      {
        id: "binding-one",
        channel: "weixin",
        accountId: "wx-one",
        peerKind: "dm",
        peerId: "user-one",
        ...(sessionId ? { sessionId } : {}),
        cwd: "/tmp/channel",
        toolNames: [],
        createdAt: now,
        lastUsedAt: now,
      },
    ],
    activities: [],
  };
}

test("active session header switches from quick bind to connected status", () => {
  const props = { sessionId: "session-one", isMobile: false, onSnapshotChange() {} };
  const unbound = renderToStaticMarkup(
    createElement(QuickWeixinBinding, { ...props, snapshot: snapshot(undefined, true) }),
  );
  assert.match(unbound, /data-testid="channel-quick-bind-button"/);
  assert.match(unbound, /Bind WeChat/);

  const bound = renderToStaticMarkup(
    createElement(QuickWeixinBinding, { ...props, snapshot: snapshot("session-one", true) }),
  );
  assert.match(bound, /data-testid="channel-binding-indicator"/);
  assert.match(bound, /Connected to WeChat/);
});
