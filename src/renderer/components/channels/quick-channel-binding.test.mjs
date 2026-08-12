import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { QuickChannelBinding } = await importTestBundle("src/renderer/components/channels/quick-channel-binding", {
  stdin: {
    contents: 'export { QuickChannelBinding } from "./QuickChannelBinding.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "quick-channel-binding-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

function snapshot(sessionId, connected, channel = "weixin") {
  const now = new Date().toISOString();
  const accountId = channel === "telegram" ? "tg-one" : channel === "feishu" ? "fs-one" : "wx-one";
  return {
    accounts: [
      {
        id: accountId,
        channel,
        name: channel === "telegram" ? "@pi_bot" : channel === "feishu" ? "Pi Feishu Bot" : "My WeChat",
        enabled: true,
        configured: true,
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        groupIds: [],
        groupAllowFrom: [],
        requireMention: true,
        toolNames: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    statuses: [{ channel, accountId, state: "running", connected }],
    pairings: [],
    bindings: [
      {
        id: "binding-one",
        channel,
        accountId,
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
    createElement(QuickChannelBinding, { ...props, snapshot: snapshot(undefined, true) }),
  );
  assert.match(unbound, /data-testid="channel-quick-bind-button"/);
  assert.match(unbound, /Bind messaging conversation/);

  const bound = renderToStaticMarkup(
    createElement(QuickChannelBinding, { ...props, snapshot: snapshot("session-one", true) }),
  );
  assert.match(bound, /data-testid="channel-binding-indicator"/);
  assert.match(bound, /Connected to WeChat/);

  const telegramBound = renderToStaticMarkup(
    createElement(QuickChannelBinding, { ...props, snapshot: snapshot("session-one", true, "telegram") }),
  );
  assert.match(telegramBound, /Connected to Telegram/);

  const feishuBound = renderToStaticMarkup(
    createElement(QuickChannelBinding, { ...props, snapshot: snapshot("session-one", true, "feishu") }),
  );
  assert.match(feishuBound, /Connected to Feishu \/ Lark/);
});
