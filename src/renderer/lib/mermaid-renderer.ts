import { APP_SANS_FONT_FAMILY } from "../../shared/font-stack.ts";

const MERMAID_RENDER_VERSION = 2;
const MAX_MERMAID_CACHE_ENTRIES = 64;

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  parse: (code: string, options: { suppressErrors: true }) => Promise<unknown>;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

type MermaidLoader = () => Promise<{ default: MermaidApi }>;

export function mermaidCacheKey(code: string, isDark: boolean): string {
  return `${MERMAID_RENDER_VERSION}\0${isDark ? "dark" : "light"}\0${code}`;
}

export class MermaidRenderCache {
  private readonly cache = new Map<string, Promise<string>>();
  private queue: Promise<void> = Promise.resolve();
  private readonly load: MermaidLoader;
  private readonly createId: () => string;
  private mermaidPromise: Promise<MermaidApi> | null = null;
  private initializedTheme: "dark" | "default" | null = null;

  constructor(load: MermaidLoader, createId: () => string = createMermaidId) {
    this.load = load;
    this.createId = createId;
  }

  render(code: string, isDark: boolean): Promise<string> {
    const key = mermaidCacheKey(code, isDark);
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.delete(key);
      this.cache.set(key, existing);
      return existing;
    }

    const task = this.queue.then(async () => {
      const mermaid = await this.getMermaid();
      const theme = isDark ? "dark" : "default";
      if (this.initializedTheme !== theme) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme,
          fontFamily: APP_SANS_FONT_FAMILY,
        });
        this.initializedTheme = theme;
      }
      const parsed = await mermaid.parse(code, { suppressErrors: true });
      if (!parsed) throw new Error("Invalid Mermaid diagram");
      return (await mermaid.render(this.createId(), code)).svg;
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    this.cache.set(key, task);
    void task.catch(() => {
      if (this.cache.get(key) === task) this.cache.delete(key);
    });
    while (this.cache.size > MAX_MERMAID_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return task;
  }

  private getMermaid(): Promise<MermaidApi> {
    this.mermaidPromise ??= this.load().then(({ default: mermaid }) => mermaid);
    return this.mermaidPromise;
  }
}

const appMermaidRenderer = new MermaidRenderCache(() => import("mermaid"));

export function renderMermaidSvg(code: string, isDark: boolean): Promise<string> {
  return appMermaidRenderer.render(code, isDark);
}

function createMermaidId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `mermaid-${crypto.randomUUID()}`
    : `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
