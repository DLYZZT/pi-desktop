import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { ProjectPicker } = await importTestBundle("project-picker", {
  stdin: {
    contents: 'export {ProjectPicker} from "./ProjectPicker.tsx";',
    resolveDir: import.meta.dirname,
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "picker-fixture",
      setup(build) {
        build.onResolve({ filter: /^@\/(i18n|lib\/api-client)$/ }, ({ path }) => ({ path, namespace: "picker-test" }));
        build.onLoad({ filter: /.*/, namespace: "picker-test" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "@/i18n"
              ? 'const t = (_key, fallback) => fallback; export const useI18n = () => ({t, language: "en-US"});'
              : `export function call(method, params) {
                   if (method === "system.defaultCwd") return Promise.resolve({ cwd: "/default" });
                   if (method === "system.validateCwd") return Promise.resolve({ ok: true, path: params.path });
                   return Promise.resolve({});
                 }`,
        }));
      },
    },
  ],
});

const session = (id, projectRoot = "/project") => ({
  id,
  name: id,
  cwd: projectRoot,
  projectRoot,
  path: `/${id}`,
  created: "2026-10-01T00:00:00Z",
  modified: "2026-10-01T00:00:00Z",
  messageCount: 1,
  firstMessage: id,
});

async function mount(t, { compact = false, sessions = [session("one")] } = {}) {
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const previous = new Map(
    ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  globalThis.window = {
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: (timer) => clearTimeout(timer),
    piBridge: {
      async selectDirectory() {
        return "/browsed";
      },
    },
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const chosen = [];
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });
  await act(async () => {
    renderer = create(
      createElement(ProjectPicker, {
        selectedCwd: "/project",
        selectedProject: "/project",
        homeDir: "/home",
        allSessions: sessions,
        restoringInitialSession: false,
        setSelectedCwd: (cwd) => chosen.push(cwd),
        compact,
      }),
    );
  });
  const text = (node) => (typeof node === "string" ? node : (node.children?.map(text).join("") ?? ""));
  const click = async (label) => {
    const node = renderer.root.find(
      (node) =>
        typeof node.type === "string" &&
        typeof node.props.onClick === "function" &&
        (node.props["aria-label"] === label || node.props.title === label || text(node) === label),
    );
    await act(async () => {
      void node.props.onClick({ stopPropagation() {}, preventDefault() {} });
    });
  };
  return {
    chosen,
    click,
    renderer,
    /** Buttons carrying a path as their title — the trigger and the list rows. */
    titled: (title) => renderer.root.findAll((node) => node.type === "button" && node.props.title === title),
    byText: (label) => renderer.root.find((node) => node.type === "button" && text(node) === label),
  };
}

test("aggregated mode opens a project without listing the ones the groups already show", async (t) => {
  // Nine session-backed projects also rule out the dropdown's own filter box.
  const sessions = Array.from({ length: 9 }, (_, index) => session(`s${index}`, `/p${index}`));
  const fixture = await mount(t, { compact: true, sessions });
  await fixture.click("Open project…");
  assert.equal(fixture.titled("/project").length, 0);
  assert.equal(fixture.titled("/p3").length, 0);
  assert.equal(
    fixture.renderer.root.findAll((node) => node.type === "input").length,
    0,
    "no project filter without the list",
  );
  // The actions that open a project with no sessions yet stay, with no stray
  // separator above them where the list used to end.
  const useDefault = fixture.byText("Use default directory");
  assert.equal(useDefault.props.style.borderTop, "none");
  assert.ok(fixture.byText("Browse folder…"));
  assert.ok(fixture.byText("Custom path…"));
});

test("the compact dropdown still opens the default directory and a typed path", async (t) => {
  const fixture = await mount(t, { compact: true });
  await fixture.click("Open project…");
  await fixture.click("Use default directory");
  assert.deepEqual(fixture.chosen, ["/default"]);
  await fixture.click("Custom path…");
  const input = fixture.renderer.root.find(
    (node) => node.type === "input" && node.props.placeholder === "/path/to/project",
  );
  await act(async () => input.props.onChange({ target: { value: "  /typed  " } }));
  await act(async () => input.props.onKeyDown({ key: "Enter", preventDefault() {} }));
  assert.deepEqual(fixture.chosen, ["/default", "/typed"]);
});

test("independent mode keeps the project list, its checkmark and the separator", async (t) => {
  const fixture = await mount(t, { compact: false, sessions: [session("one"), session("two", "/other")] });
  await fixture.click("/project");
  // The trigger plus the active project's row share the path as their title.
  assert.equal(fixture.titled("/project").length, 2);
  assert.equal(fixture.titled("/other").length, 1);
  // Only the active row carries the checkmark; other rows keep the spacer.
  assert.equal(fixture.titled("/project")[1].findAll((node) => node.type === "polyline").length, 1);
  assert.equal(fixture.titled("/other")[0].findAll((node) => node.type === "polyline").length, 0);
  assert.equal(fixture.byText("Use default directory").props.style.borderTop, "1px solid var(--border)");
  await fixture.click("/other");
  assert.deepEqual(fixture.chosen, ["/other"]);
});
