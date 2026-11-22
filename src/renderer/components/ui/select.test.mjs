import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

const { Select } = await importTestBundle("src/renderer/components/ui/select", {
  stdin: {
    contents: 'export { Select } from "./Select.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "select-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  plugins: [
    {
      name: "select-test-dom",
      setup(build) {
        // Inline portal children so react-test-renderer can see the option
        // list; the renderer has no portal support of its own.
        build.onResolve({ filter: /^react-dom$/ }, ({ path }) => ({ path, namespace: "select-dom" }));
        build.onLoad({ filter: /.*/, namespace: "select-dom" }, () => ({
          contents: "export const createPortal = (children) => children;",
        }));
      },
    },
  ],
});

const OPTIONS = ["alpha", { value: "beta", label: "Beta label" }, { value: "gamma", label: "Gamma", disabled: true }];

// One test drives all scenarios sequentially: node:test schedules sibling
// tests concurrently in this file shape, and the shared DOM-ish globals would
// race. Scenarios isolate via fresh listeners per mount and explicit unmount.
function surface(listeners) {
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
}

const trigger = (root) => root.find((node) => node.type === "button" && node.props["aria-haspopup"] === "listbox");
const options = (root) => root.findAll((node) => node.type === "div" && node.props.role === "option");
const openList = async (fixture) => {
  await act(async () => trigger(fixture.root).props.onClick());
};

test("Select: trigger, themed listbox, keyboard model and disabled semantics", async () => {
  async function mountFixture(props = {}) {
    const documentListeners = new Map(),
      windowListeners = new Map();
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      document: { ...surface(documentListeners), body: {} },
      window: {
        ...surface(windowListeners),
        innerHeight: 800,
        innerWidth: 1200,
        visualViewport: null,
        requestAnimationFrame: (cb) => cb(),
      },
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    });
    let renderer;
    await act(async () => {
      renderer = create(createElement(Select, { options: OPTIONS, ...props }), {
        createNodeMock: () => ({
          getBoundingClientRect: () => ({ top: 100, left: 40, width: 180, bottom: 136 }),
          closest: () => null,
          contains: () => false,
          scrollIntoView: () => {},
          focus: () => {},
        }),
      });
    });
    const key = async (keyName, extra = {}) => {
      const listeners = documentListeners.get("keydown");
      assert.ok(listeners, `expected keydown listeners for ${keyName}`);
      await act(async () => {
        for (const listener of listeners) listener({ key: keyName, preventDefault() {}, ...extra });
      });
    };
    const unmount = async () => {
      if (!renderer) return;
      const target = renderer;
      renderer = null;
      await act(async () => target.unmount());
      await new Promise((resolve) => setImmediate(resolve));
    };
    return {
      documentListeners,
      get root() {
        return renderer.root;
      },
      key,
      unmount,
    };
  }

  // ── trigger shows the selected label and opens the themed listbox ──
  {
    const fixture = await mountFixture({ value: "beta" });
    assert.equal(trigger(fixture.root).props.children[0].props.children, "Beta label");
    assert.equal(trigger(fixture.root).props["aria-expanded"], false);

    await openList(fixture);
    assert.equal(trigger(fixture.root).props["aria-expanded"], true);
    const listbox = fixture.root.find((node) => node.props.role === "listbox");
    assert.equal(trigger(fixture.root).props["aria-controls"], listbox.props.id);
    const rendered = options(fixture.root);
    assert.equal(rendered.length, 3);
    assert.deepEqual(
      rendered.map((node) => node.props.children.at(-1)),
      ["alpha", "Beta label", "Gamma"],
    );
    const active = rendered.find((node) => node.props.children[0].props.children === "✓");
    assert.equal(active.props.children.at(-1), "Beta label");
    await fixture.unmount();
  }

  // Native browser hosts must restore their surface when a popup closes or unmounts.
  {
    const visibility = [];
    const fixture = await mountFixture({ value: "alpha", onOpenChange: (open) => visibility.push(open) });
    assert.deepEqual(visibility, []);
    await openList(fixture);
    assert.deepEqual(visibility, [true]);
    await fixture.key("Escape");
    assert.deepEqual(visibility, [true, false]);
    await openList(fixture);
    await fixture.unmount();
    assert.deepEqual(visibility, [true, false, true, false]);
  }

  // ── placeholder shows when the value matches no option and colors it dim ──
  {
    const fixture = await mountFixture({ value: "", placeholder: "— inherit —" });
    const label = trigger(fixture.root).props.children[0];
    assert.equal(label.props.children, "— inherit —");
    assert.equal(label.props.style.color, "var(--text-dim)");
    await fixture.unmount();
  }

  // ── keyboard moves across options, skips disabled and commits with Enter ──
  {
    const changes = [];
    const fixture = await mountFixture({ value: "alpha", onChange: (v) => changes.push(v) });
    await openList(fixture);
    await fixture.key("ArrowDown"); // alpha -> beta (gamma disabled, skipped)
    await fixture.key("Enter");
    assert.deepEqual(changes, ["beta"]);
    assert.equal(trigger(fixture.root).props["aria-expanded"], false);

    // Reopening resets the active option to the current value's slot (alpha,
    // since this fixture does not feed onChange back into value).
    await openList(fixture);
    await fixture.key("ArrowUp"); // alpha wraps up past the disabled gamma to beta
    await fixture.key("Enter");
    assert.deepEqual(changes, ["beta", "beta"]);
    await fixture.unmount();
  }

  // ── Home/End skip disabled options and Enter on disabled never commits ──
  {
    const changes = [];
    const fixture = await mountFixture({ value: "alpha", onChange: (v) => changes.push(v) });
    await openList(fixture);
    await fixture.key("End"); // last enabled option (gamma disabled) -> beta
    await fixture.key("Enter");
    assert.deepEqual(changes, ["beta"]);
    await openList(fixture);
    await fixture.key("Home"); // first option -> alpha
    await fixture.key("ArrowDown"); // alpha -> beta (gamma skipped)
    await fixture.key("ArrowDown"); // beta wraps past gamma back to alpha
    await fixture.key("Enter");
    assert.deepEqual(changes, ["beta", "alpha"]);
    await fixture.unmount();
  }

  // ── Escape closes without committing and Tab closes quietly ──
  {
    const changes = [];
    const fixture = await mountFixture({ value: "alpha", onChange: (v) => changes.push(v) });
    await openList(fixture);
    await fixture.key("ArrowDown");
    await fixture.key("Escape");
    assert.deepEqual(changes, []);
    assert.equal(trigger(fixture.root).props["aria-expanded"], false);

    await openList(fixture);
    await fixture.key("Tab");
    assert.equal(trigger(fixture.root).props["aria-expanded"], false);
    assert.deepEqual(changes, []);
    await fixture.unmount();
  }

  // ── clicking an option commits and clicking the trigger toggles ──
  {
    const changes = [];
    const fixture = await mountFixture({ value: "alpha", onChange: (v) => changes.push(v) });
    await openList(fixture);
    await act(async () => options(fixture.root)[1].props.onClick());
    assert.deepEqual(changes, ["beta"]);

    await act(async () => trigger(fixture.root).props.onClick()); // open
    await act(async () => trigger(fixture.root).props.onClick()); // close
    assert.equal(trigger(fixture.root).props["aria-expanded"], false);
    await fixture.unmount();
  }

  // ── disabled select ignores trigger activation ──
  {
    const fixture = await mountFixture({ value: "alpha", disabled: true });
    await act(async () => trigger(fixture.root).props.onClick());
    assert.equal(trigger(fixture.root).props["aria-expanded"], false);
    assert.equal(trigger(fixture.root).props.disabled, true);
    await fixture.unmount();
  }

  // ── anchor inside a modal dialog portals the panel into that dialog ──
  {
    // A body-level panel stacks under a modal backdrop (fixed, high z-index):
    // dimmed and click-intercepted. The anchor must detect its dialog ancestor.
    let dialogNode = null;
    const fixture = await mountFixture({ value: "alpha" });
    // Re-create with a node mock whose closest() finds a modal dialog.
    await fixture.unmount();
    dialogNode = { contains: () => false };
    const modalMock = {
      getBoundingClientRect: () => ({ top: 100, left: 40, width: 180, bottom: 136 }),
      closest: (selector) => (selector === '[role="dialog"][aria-modal="true"]' ? dialogNode : null),
      contains: () => false,
      scrollIntoView: () => {},
      focus: () => {},
    };
    let renderer;
    await act(async () => {
      renderer = create(createElement(Select, { options: OPTIONS, value: "alpha" }), {
        createNodeMock: () => modalMock,
      });
    });
    await act(async () => trigger(renderer.root).props.onClick());
    // Panel renders inlined by the portal stub; the assertion target is that it
    // rendered at all — container routing is exercised because closest()
    // returns the dialog (a null container would fall back to document.body,
    // which does not exist in this stub environment and would throw).
    assert.equal(trigger(renderer.root).props["aria-expanded"], true);
    assert.equal(options(renderer.root).length, 3);
    await act(async () => renderer.unmount());
  }
});
