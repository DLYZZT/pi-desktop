import { randomUUID } from "node:crypto";
import {
  bracketedPaste,
  customUiWidth,
  DEFAULT_CUSTOM_UI_VIEWPORT,
  isCustomUiAction,
  MAX_CUSTOM_UI_INPUT,
  normalizeViewport,
  type CustomUiViewport,
} from "../shared/desktop-custom-ui.ts";
import { createDesktopCustomTheme } from "./desktop-custom-theme.ts";

export interface DesktopCustomComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
  dispose?(): void;
  focused?: boolean;
}
export interface DesktopCustomUiFrame {
  id: string;
  lines: string[];
  closed?: true;
  desktopUiVersion: 1;
}
export interface DesktopCustomUiCallbacks {
  frame(frame: DesktopCustomUiFrame): void;
  error(id: string, error: unknown): void;
}
interface ActiveUi {
  id: string;
  options: unknown;
  component?: DesktopCustomComponent;
  focused?: DesktopCustomComponent;
  viewport: CustomUiViewport;
  settled: boolean;
  rendering: boolean;
  timer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  resolve(value: unknown): void;
}

/** One panel per session. A replacement closes its predecessor; no nested-overlay emulation. */
export class DesktopCustomUiBridge {
  readonly theme = createDesktopCustomTheme();
  private active?: ActiveUi;
  private disposed = false;
  private callbacks: DesktopCustomUiCallbacks;

  constructor(callbacks: DesktopCustomUiCallbacks) {
    this.callbacks = callbacks;
  }

  open<T>(factory: unknown, options?: unknown): Promise<T> {
    if (this.disposed || typeof factory !== "function") return Promise.resolve(undefined as T);
    this.closeAll();
    let resolve!: (value: unknown) => void;
    const promise = new Promise<T>((settle) => {
      resolve = (value) => settle(value as T);
    });
    const active: ActiveUi = {
      id: randomUUID(),
      options,
      viewport: { ...DEFAULT_CUSTOM_UI_VIEWPORT },
      settled: false,
      rendering: false,
      abort: new AbortController(),
      resolve,
    };
    this.active = active;
    const tui = this.createEnvironment(active);
    // Install ownership before calling user code: done() may be called synchronously by the factory.
    void Promise.resolve()
      .then(() =>
        active.settled
          ? undefined
          : factory(tui, this.theme, undefined, (value: unknown) => this.finish(active, value)),
      )
      .then((component: unknown) => {
        if (active.settled) {
          this.disposeComponent(active, component);
          return;
        }
        if (
          !component ||
          typeof component !== "object" ||
          typeof (component as DesktopCustomComponent).render !== "function"
        ) {
          this.fail(active, new Error("Custom UI factory must return a component with render(width)"));
          return;
        }
        active.component = component as DesktopCustomComponent;
        this.focus(active, active.component);
        this.render(active);
      })
      .catch((error: unknown) => {
        if (!active.settled) this.fail(active, error);
      });
    return promise;
  }

  input(id: unknown, data: unknown): void {
    const active = this.lookup(id);
    if (!active || !active.component || typeof data !== "string") return;
    if (data.length > MAX_CUSTOM_UI_INPUT + 12) {
      this.report(active.id, new Error("Custom UI input too large"));
      return;
    }
    try {
      active.component.handleInput?.(data);
      this.requestRender(active);
    } catch (error) {
      this.fail(active, error);
    }
  }

  action(id: unknown, action: unknown): void {
    const active = this.lookup(id);
    if (!active || !isCustomUiAction(action)) return;
    if (action.kind === "close") {
      this.finish(active, undefined);
      return;
    }
    if (action.kind === "paste") {
      this.input(id, bracketedPaste(action.text));
      return;
    }
    const viewport = normalizeViewport(action);
    if (viewport.columns === active.viewport.columns && viewport.rows === active.viewport.rows) return;
    active.viewport = viewport;
    try {
      active.component?.invalidate?.();
      this.requestRender(active);
    } catch (error) {
      this.fail(active, error);
    }
  }

  getOwner(): { id: string; signal: AbortSignal } | undefined {
    return this.active && !this.active.settled ? { id: this.active.id, signal: this.active.abort.signal } : undefined;
  }

  closeAll(): void {
    if (this.active) this.finish(this.active, undefined);
  }
  dispose(): void {
    this.disposed = true;
    this.closeAll();
  }

  private lookup(id: unknown): ActiveUi | undefined {
    const active = this.active;
    return typeof id === "string" && active?.id === id && !active.settled ? active : undefined;
  }

  private createEnvironment(active: ActiveUi) {
    return {
      // Layout mode only. ExtensionContext.mode remains "rpc"; this does not claim a real terminal.
      mode: "regular" as const,
      signal: active.abort.signal,
      getViewport: () => ({ ...active.viewport }),
      terminal: {
        get columns() {
          return active.viewport.columns;
        },
        get rows() {
          return active.viewport.rows;
        },
        // Deliberately no write(), raw terminal, overlays, or clipboard escape transport.
      },
      requestRender: () => this.requestRender(active),
      setFocus: (component?: DesktopCustomComponent) => this.focus(active, component),
    };
  }

  private focus(active: ActiveUi, component?: DesktopCustomComponent): void {
    if (active.settled) return;
    if (active.focused && active.focused !== component && "focused" in active.focused) active.focused.focused = false;
    active.focused = component;
    if (component && "focused" in component) component.focused = true;
  }

  private requestRender(active: ActiveUi): void {
    if (active.settled || active.timer || !active.component) return;
    // Streaming, key, and resize bursts share a frame. A component can request another render while rendering.
    active.timer = setTimeout(() => {
      active.timer = undefined;
      this.render(active);
    }, 16);
  }

  private render(active: ActiveUi): void {
    if (active.settled || !active.component || active.rendering) return;
    active.rendering = true;
    try {
      const lines = active.component.render(customUiWidth(active.options, active.viewport));
      if (
        !Array.isArray(lines) ||
        lines.length > 2000 ||
        lines.some((line) => typeof line !== "string") ||
        lines.reduce((total, line) => total + line.length, 0) > 1_000_000
      ) {
        throw new Error("Invalid or oversized custom UI frame");
      }
      if (!active.settled) this.callbacks.frame({ id: active.id, lines, desktopUiVersion: 1 });
    } catch (error) {
      this.fail(active, error);
    } finally {
      active.rendering = false;
    }
  }

  private finish(active: ActiveUi, value: unknown): void {
    if (active.settled) return;
    active.settled = true;
    if (this.active === active) this.active = undefined;
    if (active.timer) clearTimeout(active.timer);
    active.abort.abort();
    this.disposeComponent(active, active.component);
    try {
      this.callbacks.frame({ id: active.id, lines: [], closed: true, desktopUiVersion: 1 });
    } catch (error) {
      this.report(active.id, error);
    } finally {
      active.resolve(value);
    }
  }

  private disposeComponent(active: ActiveUi, value: unknown): void {
    if (!value || typeof value !== "object") return;
    const component = value as DesktopCustomComponent;
    try {
      if ("focused" in component) component.focused = false;
    } catch (error) {
      this.report(active.id, error);
    }
    try {
      component.dispose?.();
    } catch (error) {
      this.report(active.id, error);
    }
  }

  private fail(active: ActiveUi, error: unknown): void {
    this.report(active.id, error);
    this.finish(active, undefined);
  }

  private report(id: string, error: unknown): void {
    try {
      this.callbacks.error(id, error);
    } catch {
      /* Diagnostics must not prevent cleanup. */
    }
  }
}
