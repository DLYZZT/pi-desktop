import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { TerminalDock, testApi } = await importTestBundle("terminal-dock-windows-snapshot", {
  stdin: {
    contents: 'export { TerminalDock } from "./TerminalDock.tsx"; export * as testApi from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    sourcefile: "terminal-dock-test-entry.ts",
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "stub-terminal-ui",
      setup(build) {
        const modules = new Map([
          [
            "@/lib/api-client",
            `
            const calls = [];
            export function getCalls() { return calls; }
            export async function call(method, params) {
              calls.push({ method, params });
              if (method === "herdr.pane.read") return { text: "AGENT_READY\\n", truncated: false };
              throw new Error("Unexpected RPC: " + method);
            }
            export async function subscribe() { return () => {}; }
          `,
          ],
          [
            "@/hooks/useHerdrRuntime",
            `
            export function useHerdrRuntime() { return { runtime: {
              status: "ready", releaseControlOnViewClose: true,
              capabilities: { readOnly: true, terminalObserve: false, terminalControl: false }
            } }; }
          `,
          ],
          [
            "@/hooks/useHerdrFleet",
            `
            const fleet = { stale: false, panes: [{ id: "pane-a", alive: true }] };
            const refresh = async () => {};
            export function useHerdrFleet() { return { fleet, refresh }; }
          `,
          ],
          ["@/i18n", "const t = (_key, fallback) => fallback; export function useI18n() { return { t }; }"],
          ["@/lib/clipboard", "export async function copyText() {}"],
          ["@xterm/xterm", "export class Terminal {}"],
          ["@xterm/addon-fit", "export class FitAddon {}"],
          ["@xterm/xterm/css/xterm.css", ""],
        ]);
        build.onResolve({ filter: /^(?:@\/|@xterm\/)/ }, (args) =>
          modules.has(args.path) ? { path: args.path, namespace: "terminal-dock-stub" } : undefined,
        );
        build.onLoad({ filter: /.*/, namespace: "terminal-dock-stub" }, (args) => ({
          contents: modules.get(args.path),
          loader: "js",
        }));
      },
    },
  ],
});

after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

test("Windows terminal displays pane text without opening an unsupported terminal stream", async () => {
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(TerminalDock, {
        pane: { id: "pane-a", title: "Agent", alive: true },
        visible: true,
        expanded: false,
        onToggleExpanded() {},
        onPaneUnavailable() {},
      }),
    );
  });
  const calls = testApi.getCalls();
  assert.ok(calls.some((entry) => entry.method === "herdr.pane.read" && entry.params.paneId === "pane-a"));
  assert.equal(
    calls.some((entry) => entry.method === "herdr.terminal.open"),
    false,
  );
  assert.equal(renderer.root.findByType("pre").children.join(""), "AGENT_READY\n");
  assert.equal(
    renderer.root.findAllByType("button").some((button) => button.children.join("") === "Take control"),
    false,
  );
  await act(async () => renderer.unmount());
});
