/**
 * Compatibility fetch for migrated components that still call `/api/...`.
 * Routes those requests over the Host RPC contract.
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

/** Handle a path like `/api/sessions` or full URL ending with that. */
export async function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname + input.search
        : input.url;

  const path = url.startsWith("http") ? new URL(url).pathname + new URL(url).search : url;
  if (!path.startsWith("/api/")) {
    return fetch(input as RequestInfo, init);
  }

  const method = (init?.method ?? "GET").toUpperCase();
  const u = new URL(path, "http://local");
  const segs = u.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);

  try {
    // /api/sessions
    if (segs[0] === "sessions" && segs.length === 1 && method === "GET") {
      return jsonResponse(await listSessions());
    }
    // /api/sessions/:id
    if (segs[0] === "sessions" && segs.length === 2) {
      const id = decodeURIComponent(segs[1]);
      if (method === "GET") {
        const includeState = u.searchParams.has("includeState");
        const data = await getSession(id, includeState);
        return jsonResponse(data);
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
    // /api/sessions/:id/context
    if (segs[0] === "sessions" && segs[2] === "context" && method === "GET") {
      const id = decodeURIComponent(segs[1]);
      const leafId = u.searchParams.get("leafId") ?? undefined;
      return jsonResponse(await getSessionContext(id, leafId));
    }
    // /api/sessions/:id/export
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

    // /api/agent/new
    if (segs[0] === "agent" && segs[1] === "new" && method === "POST") {
      const body = await parseBody(init);
      const result = await newAgent(body as never);
      return jsonResponse({ success: true, ...result });
    }
    // /api/agent/running/events — SSE not via fetch; EventSource polyfill handles it
    // /api/agent/:id
    if (segs[0] === "agent" && segs.length === 2 && segs[1] !== "new" && segs[1] !== "running") {
      const id = decodeURIComponent(segs[1]);
      if (method === "GET") {
        return jsonResponse(await agentState(id));
      }
      if (method === "POST") {
        const body = await parseBody(init);
        const data = await agentCommand(id, body);
        return jsonResponse({ success: true, data });
      }
    }

    // /api/models
    if (segs[0] === "models" && segs.length === 1 && method === "GET") {
      const cwd = u.searchParams.get("cwd") ?? undefined;
      const d = await listModels(cwd);
      return jsonResponse({
        ...d,
        modelList: d.models,
        models: d.nameMap
          ? Object.fromEntries(Object.entries(d.nameMap))
          : d.models,
      });
    }

    // /api/models-config
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

    // /api/auth/*
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
        await call("auth.setApiKey", { provider, key: String(body.key ?? body.apiKey ?? "") });
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

    // /api/skills
    if (segs[0] === "skills" && segs.length === 1 && method === "GET") {
      const cwd = u.searchParams.get("cwd") ?? undefined;
      return jsonResponse(await call("skills.list", cwd ? { cwd } : undefined));
    }
    if (segs[0] === "skills" && segs.length === 1 && (method === "PATCH" || method === "POST")) {
      const body = await parseBody(init);
      return jsonResponse(await call("skills.set", body as never));
    }
    if (segs[0] === "skills" && segs[1] === "search" && method === "POST") {
      const body = await parseBody(init);
      return jsonResponse(await call("skills.search", { query: String(body.query ?? "") }));
    }
    if (segs[0] === "skills" && segs[1] === "install" && method === "POST") {
      const body = await parseBody(init);
      return jsonResponse(await call("skills.install", body as never));
    }

    // /api/plugins
    if (segs[0] === "plugins" && method === "GET") {
      const cwd = u.searchParams.get("cwd") ?? undefined;
      return jsonResponse(await call("plugins.list", cwd ? { cwd } : undefined));
    }
    if (segs[0] === "plugins" && (method === "POST" || method === "PUT" || method === "PATCH")) {
      const body = await parseBody(init);
      return jsonResponse(await call("plugins.set", body as never));
    }

    // /api/files/*
    if (segs[0] === "files") {
      // path is everything after files/ — may be absolute with empty first segment
      const rawPath = "/" + segs.slice(1).map(decodeURIComponent).join("/");
      // Windows: /C:/... style
      const filePath = rawPath.match(/^\/[A-Za-z]:\//)
        ? rawPath.slice(1)
        : rawPath;
      const type = u.searchParams.get("type") ?? "list";
      const sourceSessionId = u.searchParams.get("sessionId") ?? undefined;
      if (type === "list") return jsonResponse(await listFiles(filePath));
      if (type === "read") return jsonResponse(await readFile(filePath, sourceSessionId));
      if (type === "meta") return jsonResponse(await fileMeta(filePath, sourceSessionId));
      if (type === "download") {
        const content = await readFile(filePath, sourceSessionId);
        return new Response(content.content, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
    }

    // /api/file-index
    if (segs[0] === "file-index" && method === "GET") {
      const root = u.searchParams.get("cwd") ?? u.searchParams.get("root") ?? "";
      const query = u.searchParams.get("q") ?? undefined;
      const result = await fileIndex(root, query);
      // Old API returned array or { files }
      return jsonResponse(result.matches ?? result);
    }

    // /api/worktrees
    if (segs[0] === "worktrees" && method === "GET") {
      const cwd = u.searchParams.get("cwd") ?? "";
      const result = await listWorktrees(cwd);
      return jsonResponse(result);
    }
    if (segs[0] === "worktrees" && method === "POST") {
      const body = await parseBody(init);
      const result = await call("worktrees.create", {
        projectRoot: String(body.cwd ?? body.projectRoot ?? ""),
        branch: String(body.branch ?? ""),
        cwd: body.cwd as string | undefined,
      });
      return jsonResponse(result);
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

    // /api/cwd/validate
    if (segs[0] === "cwd" && segs[1] === "validate" && method === "POST") {
      const body = await parseBody(init);
      const result = await validateCwd(String(body.path ?? body.cwd ?? ""));
      if (!result.ok) return jsonResponse({ error: result.error ?? "Invalid path" }, 400);
      return jsonResponse({ cwd: result.path, ok: true });
    }
    // /api/default-cwd
    if (segs[0] === "default-cwd" && method === "POST") {
      return jsonResponse(await defaultCwd());
    }
    // /api/home
    if (segs[0] === "home" && method === "GET") {
      return jsonResponse(await getHome());
    }

    return errorResponse(`Unmapped API route: ${method} ${u.pathname}`, 404);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /not found/i.test(msg) ? 404 : /denied|forbidden/i.test(msg) ? 403 : 500;
    return errorResponse(msg, status);
  }
}

/**
 * Minimal EventSource polyfill for /api SSE endpoints used by the UI.
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
  private closed = false;

  constructor(url: string) {
    void this.connect(url);
  }

  private async connect(url: string) {
    try {
      const u = new URL(url, "http://local");
      const segs = u.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);

      if (segs[0] === "agent" && segs[2] === "events") {
        const sessionId = decodeURIComponent(segs[1]);
        this.unsub = await subscribeAgentEvents(sessionId, (event) => {
          this.readyState = ApiEventSource.OPEN;
          this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
        });
        this.readyState = ApiEventSource.OPEN;
        this.onopen?.(new Event("open"));
        // Emit connected for parity with old SSE
        this.onmessage?.({ data: JSON.stringify({ type: "connected" }) } as MessageEvent);
        return;
      }

      if (segs[0] === "agent" && segs[1] === "running" && segs[2] === "events") {
        this.unsub = await subscribeRunning((event) => {
          this.readyState = ApiEventSource.OPEN;
          this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
        });
        this.readyState = ApiEventSource.OPEN;
        this.onopen?.(new Event("open"));
        return;
      }

      if (segs[0] === "auth" && segs[1] === "login") {
        const provider = decodeURIComponent(segs[2] ?? "");
        this.unsub = await subscribeAuthLogin(provider, (event) => {
          this.readyState = ApiEventSource.OPEN;
          this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
        });
        // Kick off login stream on host (async side effect)
        void call("auth.providers").then(() => {
          // Full OAuth stream wiring is M4; emit placeholder
          this.onmessage?.({
            data: JSON.stringify({
              type: "error",
              message: "OAuth login stream: use M4 auth.login host stream",
            }),
          } as MessageEvent);
        });
        this.readyState = ApiEventSource.OPEN;
        this.onopen?.(new Event("open"));
        return;
      }

      // File watch — emit a single open; periodic poll would be overkill for now
      if (segs[0] === "files") {
        this.readyState = ApiEventSource.OPEN;
        this.onopen?.(new Event("open"));
        return;
      }

      this.readyState = ApiEventSource.CLOSED;
      this.onerror?.(new Event("error"));
    } catch {
      this.readyState = ApiEventSource.CLOSED;
      this.onerror?.(new Event("error"));
    }
  }

  close() {
    this.closed = true;
    this.readyState = ApiEventSource.CLOSED;
    this.unsub?.();
    this.unsub = null;
  }

  addEventListener() {
    /* no-op shim */
  }

  removeEventListener() {
    /* no-op shim */
  }
}

/** Install global fetch + EventSource shims for /api routes. */
export function installApiShims(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (typeof url === "string" && (url.startsWith("/api/") || url.includes("/api/"))) {
      return apiFetch(input as string, init);
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;

  // @ts-expect-error override for migrated UI
  window.EventSource = ApiEventSource;
}
