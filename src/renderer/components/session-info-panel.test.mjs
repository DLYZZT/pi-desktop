import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { SessionInfoPanel, SessionPresentationStore, clipboard } = await importTestBundle("session-info-panel", {
  stdin: {
    contents:
      'export {SessionInfoPanel} from "./SessionInfoPanel.tsx"; export {SessionPresentationStore} from "@/lib/session-presentation-store"; export * as clipboard from "@/lib/clipboard";',
    resolveDir: import.meta.dirname,
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "info-fixture",
      setup(build) {
        build.onResolve({ filter: /^@\/(i18n|lib\/clipboard)$/ }, ({ path }) => ({ path, namespace: "info-test" }));
        build.onLoad({ filter: /.*/, namespace: "info-test" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "@/i18n"
              ? 'const t = (_key, fallback) => fallback; export const useI18n = () => ({t, language: "en-US"});'
              : "let result; export const setResult = next => {result = next;}; export const copyText = async () => await result;",
        }));
      },
    },
  ],
});

async function mount(t) {
  const original = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const store = new SessionPresentationStore(),
    publisher = store.createPublisher();
  const data = (id) => ({
    sessionId: id,
    info: { id, name: id },
    contextUsage: null,
    stats: {
      sessionId: id,
      sessionName: id,
      sessionFile: "/fixture/" + id,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
      cost: 0,
    },
  });
  publisher.activate();
  publisher.update(data("a"));
  let renderer;
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(async () => {
    await unmount();
    publisher.release();
    clipboard.setResult(undefined);
    if (original === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = original;
  });
  await act(async () => {
    renderer = create(
      createElement(SessionInfoPanel, {
        store,
        showChat: true,
        activeTopPanel: "session",
        toggleTopPanel() {},
        rightPanelOpen: false,
        isMobile: false,
      }),
    );
  });
  return {
    get root() {
      return renderer.root;
    },
    unmount,
    async switchSession(id) {
      await act(async () => publisher.update(data(id)));
    },
  };
}

test("copy feedback and a late clipboard failure cannot leak across session selection", async (t) => {
  const fixture = await mount(t),
    old = createDeferred();
  clipboard.setResult(old.promise);
  await act(async () => fixture.root.findByProps({ "aria-label": "Copy session ID" }).props.onClick());
  await fixture.switchSession("b");
  await act(async () => {
    old.reject(new Error("old clipboard failure"));
  });
  assert.equal(fixture.root.findAllByProps({ role: "alert" }).length, 0);
  assert.equal(fixture.root.findAllByProps({ "aria-label": "Copy session ID" }).length, 1);
  const current = createDeferred();
  clipboard.setResult(current.promise);
  await act(async () => fixture.root.findByProps({ "aria-label": "Copy session ID" }).props.onClick());
  await act(async () => {
    current.reject(new Error("current clipboard failure"));
  });
  assert.equal(fixture.root.findAllByProps({ role: "alert" }).length, 1);
});

test("a late clipboard success after panel unmount does not create a feedback timer", async (t) => {
  const fixture = await mount(t),
    pending = createDeferred();
  clipboard.setResult(pending.promise);
  await act(async () => fixture.root.findByProps({ "aria-label": "Copy session ID" }).props.onClick());
  await fixture.unmount();
  let timers = 0;
  t.mock.method(globalThis, "setTimeout", () => {
    timers++;
    return 1;
  });
  await act(async () => {
    pending.resolve();
  });
  assert.equal(timers, 0);
});
