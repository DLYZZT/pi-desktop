/**
 * Compatibility fetch + EventSource for migrated components that still call `/api/...`.
 */
import {
  agentCommand,
  agentState,
  call,
  deleteSession,
  exportSession,
  fileIndex,
  fileMeta,
  getHome,
  getSession,
  getSessionContext,
  listFiles,
  listModels,
  listSessions,
  listWorktrees,
  newAgent,
  readFile,
  renameSession,
  subscribe,
  subscribeAgentEvents,
  subscribeAuthLogin,
  subscribeRunning,
  validateCwd,
  defaultCwd,
} from "./api-client";

type Json = unknown;

function jsonResponse(data: Json, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

async function parseBody(init?: RequestInit): Promise<Record<string, unknown>> {
  if (!init?.body) return {};
  if (typeof init.body === "string") {
    try {
      return JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export async function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;

  const path = url.startsWith("http") ? new URL(url).pathname + new URL(url).search : url;
  if (!path.startsWith("/api/")) {
    return fetch(input as RequestInfo, init);
  }

  const method = (init?.method ?? "GET").toUpperCase();
  const u = new URL(path, "http://local");
  const segs = u.pathname
    .replace(/^\/api\//, "")
    .split("/")
    .filter(Boolean);

  try {
    if (segs[0] === "sessions" && segs.length === 1 && method === "GET") {
      return jsonResponse(await listSessions());
    }
    if (segs[0] === "sessions" && segs.length === 2) {
      const id = decodeURIComponent(segs[1]);
      if (method === "GET") {
        const includeState = u.searchParams.has("includeState");
        return jsonResponse(await getSession(id, includeState));
      }
      if (method === "DELETE") {
        await deleteSession(id);
        return jsonResponse({ ok: true });
      }
      if (method === "PATCH" || method === "PUT") {
        const body = await parseBody(init);
        if (typeof body.name === "string") {
          await renameSession(id, body.name);
          return jsonResponse({ ok: true });
        }
        return errorResponse("name is required", 400);
      }
    }
    if (segs[0] === "sessions" && segs[2] === "context" && method === "GET") {
      const id = decodeURIComponent(segs[1]);
      const leafId = u.searchParams.get("leafId") ?? undefined;
      return jsonResponse(await getSessionContext(id, leafId));
    }
    if (segs[0] === "sessions" && segs[2] === "export" && method === "GET") {
      const id = decodeURIComponent(segs[1]);
      const { content, suggestedName } = await exportSession(id);
      if (window.piBridge?.saveFile) {
        const saved = await window.piBridge.saveFile({
          content,
          defaultPath: suggestedName,
        });
        if (saved) await window.piBridge.showItemInFolder(saved);
      }
      return jsonResponse({ ok: true, content });
    }

    if (segs[0] === "agent" && segs[1] === "new" && method === "POST") {
      const body = await parseBody(init);
      const result = await newAgent(body as never);
      return jsonResponse({ success: true, ...result });
    }
    if (segs[0] === "agent" && segs.length === 2 && segs[1] !== "new" && segs[1] !== "running") {
      const id = decodeURIComponent(segs[1]);
      if (method === "GET") return jsonResponse(await agentState(id));
      if (method === "POST") {
        const body = await parseBody(init);
        const data = await agentCommand(id, body);
        return jsonResponse({ success: true, data });
      }
    }

    if (segs[0] === "models" && segs.length === 1 && method === "GET") {
      const cwd = u.searchParams.get("cwd") ?? undefined;
      const d = await listModels(cwd);
      return jsonResponse({
        ...d,
        modelList: d.models,
        models: d.nameMap ? Object.fromEntries(Object.entries(d.nameMap)) : d.models,
      });
    }

    if (segs[0] === "models-config" && segs.length === 1) {
      if (method === "GET") return jsonResponse(await call("modelsConfig.get"));
      if (method === "PUT" || method === "POST") {
        const body = await parseBody(init);
        await call("modelsConfig.set", body as never);
        return jsonResponse({ success: true });
      }
    }
    if (segs[0] === "models-config" && segs[1] === "test" && method === "POST") {
      const body = await parseBody(init);
      return jsonResponse(await call("modelsConfig.test", body as never));
    }

    if (segs[0] === "auth" && segs[1] === "providers" && method === "GET") {
      return jsonResponse(await call("auth.providers"));
    }
    if (segs[0] === "auth" && segs[1] === "all-providers" && method === "GET") {
      return jsonResponse(await call("auth.allProviders"));
    }
    if (segs[0] === "auth" && segs[1] === "logout" && method === "POST") {
      const provider = decodeURIComponent(segs[2] ?? "");
      await call("auth.logout", { provider });
      return jsonResponse({ ok: true });
    }
    if (segs[0] === "auth" && segs[1] === "api-key") {
      const provider = decodeURIComponent(segs[2] ?? "");
      if (method === "PUT" || method === "POST") {
        const body = await parseBody(init);
        await call("auth.setApiKey", {
          provider,
          key: String(body.key ?? body.apiKey ?? ""),
        });
        return jsonResponse({ ok: true });
      }
      if (method === "DELETE") {
        await call("auth.deleteApiKey", { provider });
        return jsonResponse({ ok: true });
      }
    }
    if (segs[0] === "auth" && segs[1] === "login" && method === "POST") {
      const provider = decodeURIComponent(segs[2] ?? "");
      const body = await parseBody(init);
      await call("auth.loginSubmit", {
        provider,
        token: String(body.token ?? ""),
        code: String(body.code ?? ""),
      });
      return jsonResponse({ ok: true });
    }

    if (segs[0] === "skills" && segs.length === 1 && method === "GET") {
      const cwd = u.searchParams.get("cwd") ?? undefined;
      return jsonResponse(await call("skills.list", cwd ? { cwd } : undefined));
    }
    if (segs[0] === "skills" && segs.length === 1 && (method === "PATCH" || method === "POST")) {
      const body = await parseBody(init);
      return jsonResponse(
        await call("skills.set", {
          cwd: String(body.cwd ?? ""),
          filePath: String(body.filePath ?? ""),
          ...(typeof body.disableModelInvocation === "boolean"
            ? { disableModelInvocation: body.disableModelInvocation }
            : {}),
          ...(typeof body.content === "string" ? { content: body.content } : {}),
        }),
      );
    }
    if (segs[0] === "skills" && segs[1] === "search" && method === "POST") {
      const body = await parseBody(init);
      return jsonResponse(await call("skills.search", { query: String(body.query ?? "") }));
    }
    if (segs[0] === "skills" && segs[1] === "install" && method === "POST") {
      const body = await parseBody(init);
      return jsonResponse(await call("skills.install", body as never));
    }

    if (segs[0] === "plugins" && method === "GET") {
      const cwd = u.searchParams.get("cwd") ?? undefined;
      return jsonResponse(await call("plugins.list", cwd ? { cwd } : undefined));
    }
    if (segs[0] === "plugins" && (method === "POST" || method === "PUT" || method === "PATCH")) {
      const body = await parseBody(init);
      const action = String(body.action ?? "");
      if (!["install", "remove", "update", "disable", "enable"].includes(action)) {
        return errorResponse("Invalid plugin action", 400);
      }
      return jsonResponse(
        await call("plugins.set", {
          action: action as "install" | "remove" | "update" | "disable" | "enable",
          cwd: String(body.cwd ?? ""),
          ...(typeof body.source === "string" ? { source: body.source } : {}),
          ...(body.scope === "project" || body.scope === "global" ? { scope: body.scope } : {}),
        }),
      );
    }

    if (segs[0] === "files") {
      const rawPath = "/" + segs.slice(1).map(decodeURIComponent).join("/");
      const filePath = rawPath.match(/^\/[A-Za-z]:\//) ? rawPath.slice(1) : rawPath;
      const type = u.searchParams.get("type") ?? "list";
      const sourceSessionId = u.searchParams.get("sessionId") ?? undefined;
      if (type === "list") return jsonResponse(await listFiles(filePath));
      if (type === "read") {
        const content = await readFile(filePath, sourceSessionId);
        // Image/binary may return base64 — FileViewer text path expects JSON
        return jsonResponse(content);
      }
      if (type === "meta") return jsonResponse(await fileMeta(filePath, sourceSessionId));
      if (type === "preview") {
        return jsonResponse(await call("files.preview", { path: filePath, sourceSessionId }));
      }
      if (type === "download") {
        const content = await call("files.download", { path: filePath, sourceSessionId });
        const binary = atob(content.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Type": content.mime },
        });
      }
    }

    if (segs[0] === "file-index" && method === "GET") {
      // ISSUE-005: pass through Host contract { files, truncated, matches }
      const root = u.searchParams.get("cwd") ?? u.searchParams.get("root") ?? "";
      const query = u.searchParams.get("q") ?? undefined;
      const result = await fileIndex(root, query);
      return jsonResponse(result);
    }

    if (segs[0] === "worktrees" && method === "GET") {
      const cwd = u.searchParams.get("cwd") ?? "";
      return jsonResponse(await listWorktrees(cwd));
    }
    if (segs[0] === "worktrees" && method === "POST") {
      const body = await parseBody(init);
      const result = await call("worktrees.create", {
        projectRoot: String(body.cwd ?? body.projectRoot ?? ""),
        branch: String(body.branch ?? ""),
        cwd: body.cwd as string | undefined,
      });
      // Preserve the legacy route shape consumed by SessionSidebar.
      return jsonResponse(result.worktree);
    }
    if (segs[0] === "worktrees" && method === "DELETE") {
      const body = await parseBody(init);
      await call("worktrees.remove", {
        path: String(body.path ?? ""),
        cwd: body.cwd as string | undefined,
        force: body.force as boolean | undefined,
      });
      return jsonResponse({ success: true });
    }

    if (segs[0] === "git-status" && method === "GET") {
      const cwd = u.searchParams.get("cwd") ?? "";
      return jsonResponse(await call("git.status", { path: cwd }));
    }

    if (segs[0] === "cwd" && segs[1] === "validate" && method === "POST") {
      const body = await parseBody(init);
      const result = await validateCwd(String(body.path ?? body.cwd ?? ""));
      if (!result.ok) return jsonResponse({ error: result.error ?? "Invalid path" }, 400);
      return jsonResponse({ cwd: result.path, ok: true });
    }
    if (segs[0] === "default-cwd" && method === "POST") {
      return jsonResponse(await defaultCwd());
    }
    if (segs[0] === "home" && method === "GET") {
      return jsonResponse(await getHome());
    }

    return errorResponse(`Unmapped API route: ${method} ${u.pathname}`, 404);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const rpc = e as { code?: string; detail?: unknown };
    const status =
      rpc.code === "BAD_REQUEST"
        ? 400
        : rpc.code === "FORBIDDEN"
          ? 403
          : rpc.code === "NOT_FOUND"
            ? 404
            : rpc.code === "CONFLICT"
              ? 409
              : /not found/i.test(msg)
                ? 404
                : /denied|forbidden/i.test(msg)
                  ? 403
                  : 500;
    const detail = rpc.detail && typeof rpc.detail === "object" ? rpc.detail : {};
    return jsonResponse({ error: msg, ...detail, ...(rpc.code ? { code: rpc.code } : {}) }, status);
  }
}

/**
 * EventSource polyfill with named events (connected / change / …).
 */
export class ApiEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState = ApiEventSource.CONNECTING;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;

  private unsub: (() => void) | null = null;
  private named = new Map<string, Set<(ev: Event) => void>>();
  private filePath: string | null = null;
  private closed = false;

  constructor(url: string) {
    void this.connect(url);
  }

  private generation = 0;

  /** ISSUE-008: named listeners only; do NOT also fire onmessage (avoids double open). */
  private dispatchNamed(type: string, data: unknown, alsoOnMessage = false) {
    const me = { data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent;
    this.named.get(type)?.forEach((cb) => {
      try {
        cb(me);
      } catch {
        /* ignore */
      }
    });
    if (alsoOnMessage) this.onmessage?.(me);
  }

  private async connect(url: string) {
    const gen = ++this.generation;
    try {
      const u = new URL(url, "http://local");
      const segs = u.pathname
        .replace(/^\/api\//, "")
        .split("/")
        .filter(Boolean);

      if (segs[0] === "agent" && segs[2] === "events") {
        const sessionId = decodeURIComponent(segs[1]);
        this.unsub = await subscribeAgentEvents(sessionId, (event) => {
          if (this.closed || gen !== this.generation) return;
          this.readyState = ApiEventSource.OPEN;
          // Agent events use onmessage only (useAgentSession)
          this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
        });
        if (this.closed || gen !== this.generation) {
          this.unsub?.();
          return;
        }
        this.readyState = ApiEventSource.OPEN;
        this.onopen?.(new Event("open"));
        this.onmessage?.({ data: JSON.stringify({ type: "connected" }) } as MessageEvent);
        return;
      }

      if (segs[0] === "agent" && segs[1] === "running" && segs[2] === "events") {
        this.unsub = await subscribeRunning((event) => {
          if (this.closed || gen !== this.generation) return;
          this.readyState = ApiEventSource.OPEN;
          this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
        });
        if (this.closed || gen !== this.generation) {
          this.unsub?.();
          return;
        }
        this.readyState = ApiEventSource.OPEN;
        this.onopen?.(new Event("open"));
        return;
      }

      if (segs[0] === "auth" && segs[1] === "login") {
        const provider = decodeURIComponent(segs[2] ?? "");
        this.unsub = await subscribeAuthLogin(provider, (event) => {
          if (this.closed || gen !== this.generation) return;
          this.readyState = ApiEventSource.OPEN;
          const type = String((event as { type?: string }).type ?? "message");
          // Single path: onmessage only — ModelsConfig handles openExternal
          this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
          void type;
        });
        if (this.closed || gen !== this.generation) {
          this.unsub?.();
          void call("auth.loginCancel", { provider }).catch(() => {});
          return;
        }
        const result = await call("auth.loginStart", { provider });
        if (!result.started) {
          throw new Error("An OAuth login is already active. Cancel it and try again.");
        }
        if (this.closed || gen !== this.generation) {
          void call("auth.loginCancel", { provider }).catch(() => {});
          return;
        }
        this.readyState = ApiEventSource.OPEN;
        this.onopen?.(new Event("open"));
        return;
      }

      if (segs[0] === "files") {
        const rawPath = "/" + segs.slice(1).map(decodeURIComponent).join("/");
        const filePath = rawPath.match(/^\/[A-Za-z]:\//) ? rawPath.slice(1) : rawPath;
        const sourceSessionId = u.searchParams.get("sessionId") ?? undefined;
        this.filePath = filePath;

        this.unsub = await subscribe("files.changed", filePath, (ev) => {
          if (this.closed || gen !== this.generation) return;
          this.readyState = ApiEventSource.OPEN;
          const eventName = ev.event ?? "change";
          this.dispatchNamed(eventName, {
            mtime: ev.mtime,
            size: ev.size,
            message: ev.message,
            filePath: ev.path,
          });
        });
        if (this.closed || gen !== this.generation) {
          this.unsub?.();
          return;
        }
        await call("files.watchStart", { path: filePath, sourceSessionId });
        if (this.closed || gen !== this.generation) {
          void call("files.watchStop", { path: filePath }).catch(() => {});
          return;
        }
        this.readyState = ApiEventSource.OPEN;
        this.onopen?.(new Event("open"));
        return;
      }

      this.readyState = ApiEventSource.CLOSED;
      this.onerror?.(new Event("error"));
    } catch (error) {
      if (!this.closed) {
        this.readyState = ApiEventSource.CLOSED;
        const message = error instanceof Error ? error.message : String(error);
        this.onerror?.(new ErrorEvent("error", { message }));
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.readyState = ApiEventSource.CLOSED;
    this.unsub?.();
    this.unsub = null;
    // ISSUE-008: cancel OAuth if this was a login stream — best-effort via URL parse is hard;
    // ModelsConfig must call auth.loginCancel. Still stop file watches.
    if (this.filePath) {
      void call("files.watchStop", { path: this.filePath }).catch(() => {});
      this.filePath = null;
    }
  }

  addEventListener(type: string, cb: EventListenerOrEventListenerObject) {
    const fn = typeof cb === "function" ? cb : (cb as EventListenerObject).handleEvent.bind(cb);
    let set = this.named.get(type);
    if (!set) {
      set = new Set();
      this.named.set(type, set);
    }
    set.add(fn as (ev: Event) => void);
  }

  removeEventListener(type: string, cb: EventListenerOrEventListenerObject) {
    const fn = typeof cb === "function" ? cb : (cb as EventListenerObject).handleEvent.bind(cb);
    this.named.get(type)?.delete(fn as (ev: Event) => void);
  }
}

export function installApiShims(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (typeof url === "string" && (url.startsWith("/api/") || url.includes("/api/"))) {
      return apiFetch(input as string, init);
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;

  // @ts-expect-error override for migrated UI
  window.EventSource = ApiEventSource;
}
