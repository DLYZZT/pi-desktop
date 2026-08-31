import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  BrowserHostMethod,
  BrowserHostParams,
  BrowserHostResult,
  BrowserPermissionLevel,
  BrowserCapabilitySnapshot,
} from "../contract/browser";
import { callMain } from "./parent-rpc";
import { BROWSER_CANONICAL_GUIDELINES, browserAgentRuntime } from "./browser-agent-runtime";
export { getBrowserSessionSource, setBrowserSessionSource } from "./session-source";
import { getBrowserSessionSource } from "./session-source";

export const BROWSER_TOOL_PERMISSIONS = {
  browser_open: "read",
  browser_list_tabs: "read",
  browser_navigate: "read",
  browser_snapshot: "read",
  browser_inspect: "read",
  browser_screenshot: "read",
  browser_visual_compare: "read",
  browser_click: "interact",
  browser_click_at: "interact",
  browser_type: "interact",
  browser_press: "interact",
  browser_scroll: "interact",
  browser_wait: "read",
  browser_back: "read",
  browser_forward: "read",
  browser_reload: "read",
  browser_close: "read",
  browser_execute_javascript: "advanced",
  browser_get_cookies: "advanced",
  browser_set_request_header_rules: "advanced",
  browser_set_response_header_rules: "advanced",
  browser_send_cdp_command: "advanced",
  browser_network_list: "advanced",
  browser_network_wait: "advanced",
  browser_network_body: "advanced",
  browser_network_replay: "advanced",
  browser_network_summary: "advanced",
  browser_console_list: "advanced",
  browser_console_wait: "advanced",
  browser_page_code_list: "advanced",
  browser_page_code_get: "advanced",
} as const satisfies Record<string, BrowserPermissionLevel>;

export const BROWSER_TOOL_NAMES = Object.keys(BROWSER_TOOL_PERMISSIONS) as Array<keyof typeof BROWSER_TOOL_PERMISSIONS>;
const BROWSER_TOOL_NAME_SET = new Set<string>(BROWSER_TOOL_NAMES);

export function isBrowserToolName(name: string): boolean {
  return BROWSER_TOOL_NAME_SET.has(name);
}

export function browserToolNamesForPermission(permission: BrowserPermissionLevel): string[] {
  const rank = { none: 0, read: 1, interact: 2, advanced: 3 } as const;
  return BROWSER_TOOL_NAMES.filter((name) => rank[BROWSER_TOOL_PERMISSIONS[name]] <= rank[permission]);
}

export function browserToolNamesForSnapshot(snapshot: BrowserCapabilitySnapshot): string[] {
  if (!snapshot.browserEnabled || !snapshot.automationEnabled) return [];
  return BROWSER_TOOL_NAMES.filter((name) => {
    const required = BROWSER_TOOL_PERMISSIONS[name];
    return required !== "advanced" || snapshot.advancedEnabled;
  });
}

type ToolContext = { sessionManager: { getSessionId(): string } };

async function browserCall<
  M extends Exclude<
    BrowserHostMethod,
    "browser.capabilities" | "browser.requestAuthorization" | "browser.sessionEnded" | "browser.requestRouteBypass"
  >,
>(
  method: M,
  params: Omit<BrowserHostParams<M>, "sessionId" | "capabilityLeaseId" | "policyRevision" | "requestId">,
  ctx: ToolContext,
  runtimeParams?: Record<string, unknown>,
): Promise<BrowserHostResult<M>> {
  const sessionId = ctx.sessionManager.getSessionId();
  const requestId = randomUUID();
  const source = getBrowserSessionSource(ctx.sessionManager);
  if (source === "unknown") throw new Error("CAPABILITY_DISABLED: Session source is unavailable");
  let capabilities = await callMain<BrowserHostResult<"browser.capabilities">>("browser.capabilities", { sessionId });
  const required = requiredPermissionForHostMethod(method);
  if (!capabilities.lease || permissionRank(capabilities.lease.permission) < permissionRank(required)) {
    await callMain<BrowserHostResult<"browser.requestAuthorization">>(
      "browser.requestAuthorization",
      {
        sessionId,
        source,
        targetMethod: method,
        requestId,
      },
      70_000,
    );
    // Refresh from the revisioned capability channel after the user decision.
    // The original target method is still invoked exactly once below.
    capabilities = await callMain<BrowserHostResult<"browser.capabilities">>("browser.capabilities", { sessionId });
  }
  if (!capabilities.lease) throw new Error("CAPABILITY_DISABLED: Browser authorization did not issue a lease");
  const request = {
    ...params,
    sessionId,
    capabilityLeaseId: capabilities.lease.id,
    policyRevision: capabilities.snapshot.revision,
    requestId,
  } as BrowserHostParams<M>;
  const policyRequest = {
    ...(request as unknown as Record<string, unknown>),
    ...(runtimeParams ?? {}),
  };
  for (;;) {
    const attempt = browserAgentRuntime.beforeCall(sessionId, method, policyRequest, capabilities.snapshot.revision);
    try {
      const result = await callMain<BrowserHostResult<M>>(
        method,
        request,
        method === "browser.wait" ||
          method === "browser.networkWait" ||
          method === "browser.consoleWait" ||
          method === "browser.executeJavaScript"
          ? 125_000
          : 35_000,
      );
      browserAgentRuntime.afterSuccess(sessionId, attempt.attemptKey, result, method, policyRequest);
      return result;
    } catch (error) {
      browserAgentRuntime.afterError(sessionId, attempt.attemptKey, policyRequest, error);
      if (!browserAgentRuntime.canAutoRetry(error, method, attempt.attemptNumber)) throw error;
      const delay = browserAgentRuntime.retryAfterMs(error);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function textResult(value: unknown, sessionId?: string) {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "null");
  if (sessionId) browserAgentRuntime.recordResultText(sessionId, text.length);
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    details: undefined,
  };
}

function tool(
  name: keyof typeof BROWSER_TOOL_PERMISSIONS,
  description: string,
  parameters: ReturnType<typeof Type.Object>,
  method: Exclude<
    BrowserHostMethod,
    "browser.capabilities" | "browser.requestAuthorization" | "browser.sessionEnded" | "browser.requestRouteBypass"
  >,
  project: (input: Record<string, unknown>) => Record<string, unknown> = (input) => input,
): ToolDefinition {
  return defineTool({
    name,
    label: name.replaceAll("_", " "),
    description,
    promptSnippet: `${name}: ${description}`,
    promptGuidelines: [...BROWSER_CANONICAL_GUIDELINES],
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const result = await browserCall(method as never, project(input as Record<string, unknown>) as never, ctx);
      return textResult(result, ctx.sessionManager.getSessionId());
    },
  });
}

function permissionRank(permission: BrowserPermissionLevel): number {
  return { none: 0, read: 1, interact: 2, advanced: 3 }[permission];
}

function requiredPermissionForHostMethod(
  method: Exclude<
    BrowserHostMethod,
    "browser.capabilities" | "browser.requestAuthorization" | "browser.sessionEnded" | "browser.requestRouteBypass"
  >,
): Exclude<BrowserPermissionLevel, "none"> {
  if (
    method === "browser.click" ||
    method === "browser.clickAt" ||
    method === "browser.type" ||
    method === "browser.press" ||
    method === "browser.scroll"
  ) {
    return "interact";
  }
  if (
    method === "browser.executeJavaScript" ||
    method === "browser.getCookies" ||
    method === "browser.setCookies" ||
    method === "browser.setRequestHeaderRules" ||
    method === "browser.setResponseHeaderRules" ||
    method === "browser.sendCdpCommand" ||
    method === "browser.networkList" ||
    method === "browser.networkWait" ||
    method === "browser.networkBody" ||
    method === "browser.networkReplay" ||
    method === "browser.networkSummary" ||
    method === "browser.consoleList" ||
    method === "browser.consoleWait" ||
    method === "browser.pageCodeList" ||
    method === "browser.pageCodeGet"
  ) {
    return "advanced";
  }
  return "read";
}

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const tabId = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern: uuidPattern,
  description: "Full Browser tab UUID; copy it exactly and never abbreviate it",
});
const snapshotId = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern: uuidPattern,
  description: "Full snapshot UUID from the most recent browser_snapshot result",
});
const elementRef = Type.String({
  minLength: 2,
  maxLength: 32,
  pattern: "^e[1-9][0-9]*$",
  description: "Element ref from the most recent browser_snapshot result",
});
const snapshotGeneration = Type.Integer({
  minimum: 0,
  description: "Generation from the same browser_snapshot result as snapshotId and ref",
});
const url = Type.String({ minLength: 1, maxLength: 8192, description: "Absolute http(s) URL" });

export function createBrowserToolDefinitions(): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    tool(
      "browser_open",
      "Open a URL in a managed Pi Desktop Browser tab. Advanced mode returns only the count of saved experiences for that site, never their source.",
      Type.Object({
        url,
        profileId: Type.Optional(Type.String({ maxLength: 128 })),
        activate: Type.Optional(Type.Boolean()),
      }),
      "browser.open",
    ),
    tool("browser_list_tabs", "List Browser tabs owned by this Agent session.", Type.Object({}), "browser.listTabs"),
    tool(
      "browser_navigate",
      "Navigate an owned Browser tab to a URL.",
      Type.Object({ tabId, url }),
      "browser.navigate",
    ),
    tool(
      "browser_snapshot",
      "Compatibility tool for a standalone page snapshot. Prefer browser_inspect for the first observation and refresh after stale refs.",
      Type.Object({
        tabId,
        maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
        maxTextChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 200000 })),
      }),
      "browser.snapshot",
    ),
    defineTool({
      name: "browser_inspect",
      label: "browser inspect",
      description:
        "Atomically inspect owned tabs with compact page text and element refs. The default has no screenshot; enable one only for visual evidence. Reuse sinceInspectionId for subsequent checks on the same page.",
      promptSnippet: "browser_inspect: compact page state first, then reuse sinceInspectionId for deltas",
      promptGuidelines: [...BROWSER_CANONICAL_GUIDELINES],
      parameters: Type.Object({
        tabId: Type.Optional(tabId),
        sinceInspectionId: Type.Optional(
          Type.String({
            minLength: 36,
            maxLength: 36,
            pattern: uuidPattern,
            description: "Full inspection UUID from the previous browser_inspect result",
          }),
        ),
        maxNodes: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 1000, description: "Visible interactive nodes; defaults to 100" }),
        ),
        maxTextChars: Type.Optional(
          Type.Integer({ minimum: 250, maximum: 60000, description: "Visible page text; defaults to 8000 characters" }),
        ),
        screenshot: Type.Optional(
          Type.Object(
            {
              enabled: Type.Boolean(),
              format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
              quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            },
            { description: "Disabled by default; enable only when the task needs visual evidence" },
          ),
        ),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const result = await browserCall("browser.inspect", input as never, ctx);
        const { screenshot, ...metadata } = result;
        const text = JSON.stringify(metadata);
        browserAgentRuntime.recordResultText(ctx.sessionManager.getSessionId(), text.length);
        return {
          content: [
            { type: "text", text },
            ...(screenshot ? [{ type: "image" as const, data: screenshot.base64, mimeType: screenshot.mime }] : []),
          ],
          details: undefined,
        };
      },
    }),
    defineTool({
      name: "browser_screenshot",
      label: "browser screenshot",
      description:
        "Capture an owned Browser tab in viewport, bounded full-page, or latest-snapshot element mode. Prefer inspect deltas unless a dedicated image is necessary.",
      promptSnippet: "browser_screenshot: capture viewport, bounded full page, or one element",
      promptGuidelines: [...BROWSER_CANONICAL_GUIDELINES],
      parameters: Type.Object({
        tabId,
        mode: Type.Optional(Type.Union([Type.Literal("viewport"), Type.Literal("full-page"), Type.Literal("element")])),
        format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
        quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        snapshotId: Type.Optional(snapshotId),
        ref: Type.Optional(elementRef),
        generation: Type.Optional(snapshotGeneration),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const result = await browserCall("browser.screenshot", input as never, ctx);
        const text = `Screenshot of Browser tab ${result.tabId} (${result.width}×${result.height}, ${result.mode}, generation ${result.generation})`;
        browserAgentRuntime.recordResultText(ctx.sessionManager.getSessionId(), text.length);
        return {
          content: [
            { type: "text", text },
            { type: "image", data: result.base64, mimeType: result.mime },
          ],
          details: undefined,
        };
      },
    }),
    defineTool({
      name: "browser_visual_compare",
      label: "browser visual compare",
      description:
        "Compare two owned Browser captures with the same viewport/full-page/element parameters and return bounded pixel-difference evidence.",
      promptSnippet: "browser_visual_compare: compare two managed Browser captures",
      promptGuidelines: [...BROWSER_CANONICAL_GUIDELINES],
      parameters: Type.Object({
        left: visualCompareTarget(),
        right: visualCompareTarget(),
        mode: Type.Optional(Type.Union([Type.Literal("viewport"), Type.Literal("full-page"), Type.Literal("element")])),
        threshold: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
        includeDiff: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const result = await browserCall("browser.visualCompare", input as never, ctx);
        const { diff, ...metadata } = result;
        const text = JSON.stringify(metadata, null, 2);
        browserAgentRuntime.recordResultText(ctx.sessionManager.getSessionId(), text.length);
        return {
          content: [
            { type: "text", text },
            ...(diff ? [{ type: "image" as const, data: diff.base64, mimeType: diff.mime }] : []),
          ],
          details: undefined,
        };
      },
    }),
    tool(
      "browser_click",
      "Click an element reference from the latest Browser snapshot. Returns whether the click stayed on the page, navigated the current tab, opened a new tab, or encountered a load failure.",
      Type.Object({
        tabId,
        ref: elementRef,
        snapshotId,
        generation: snapshotGeneration,
        button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])),
        clickCount: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
        modifiers: inputModifiers(),
      }),
      "browser.click",
    ),
    tool(
      "browser_click_at",
      "Click viewport coordinates through Chromium's trusted input pipeline. Use for Canvas or challenge controls only when a fresh screenshot makes the target unambiguous.",
      Type.Object({
        tabId,
        x: Type.Number({ minimum: 0 }),
        y: Type.Number({ minimum: 0 }),
        button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])),
        clickCount: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
        modifiers: inputModifiers(),
      }),
      "browser.clickAt",
    ),
    tool(
      "browser_type",
      "Focus an element reference and enter text; optionally submit with Enter.",
      Type.Object({
        tabId,
        ref: elementRef,
        snapshotId,
        generation: snapshotGeneration,
        text: Type.String({ maxLength: 65536 }),
        submit: Type.Optional(Type.Boolean()),
      }),
      "browser.type",
    ),
    tool(
      "browser_press",
      "Send an allowed keyboard key to an owned Browser tab.",
      Type.Object({ tabId, key: Type.String({ maxLength: 16 }), modifiers: inputModifiers() }),
      "browser.press",
    ),
    tool(
      "browser_scroll",
      "Scroll an owned Browser tab using Chromium wheel input.",
      Type.Object({
        tabId,
        deltaX: Type.Optional(Type.Integer({ minimum: -100000, maximum: 100000 })),
        deltaY: Type.Integer({ minimum: -100000, maximum: 100000 }),
        x: Type.Optional(Type.Integer({ minimum: 0 })),
        y: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      "browser.scroll",
    ),
    tool(
      "browser_wait",
      "Wait for page load, network quiet, a selector, or visible text.",
      Type.Object({
        tabId,
        timeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 120000 })),
        condition: Type.Optional(
          Type.Union([
            Type.Literal("load"),
            Type.Literal("network-idle"),
            Type.Literal("selector"),
            Type.Literal("text"),
          ]),
        ),
        value: Type.Optional(Type.String({ maxLength: 4096 })),
      }),
      "browser.wait",
    ),
    tool("browser_back", "Go back in an owned Browser tab.", Type.Object({ tabId }), "browser.back"),
    tool("browser_forward", "Go forward in an owned Browser tab.", Type.Object({ tabId }), "browser.forward"),
    tool("browser_reload", "Reload an owned Browser tab.", Type.Object({ tabId }), "browser.reload"),
    tool("browser_close", "Close an owned Browser tab.", Type.Object({ tabId }), "browser.close"),
    defineTool({
      name: "browser_execute_javascript",
      label: "browser execute javascript",
      description:
        "Advanced Browser Mode: execute JavaScript only after browser_inspect on this tab and after applicable Console/network tools. Declare explore for diagnosis or verify with an expected assertion.",
      promptSnippet:
        "browser_execute_javascript: Use after same-tab inspection; declare intent=explore or intent=verify with expected.",
      promptGuidelines: [...BROWSER_CANONICAL_GUIDELINES],
      parameters: Type.Object({
        tabId,
        source: Type.String({ maxLength: 262144 }),
        intent: Type.Union([Type.Literal("explore"), Type.Literal("verify")]),
        expected: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 120000 })),
        world: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("isolated")])),
        awaitPromise: Type.Optional(Type.Boolean()),
        returnByValue: Type.Optional(Type.Boolean()),
        purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        remember: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const runtimeInput = input as Record<string, unknown>;
        const { intent: _intent, expected: _expected, ...mainInput } = runtimeInput;
        const result = await browserCall("browser.executeJavaScript", mainInput as never, ctx, runtimeInput);
        return textResult(result, ctx.sessionManager.getSessionId());
      },
    }),
    tool(
      "browser_get_cookies",
      "Advanced Browser Mode: request cookies subject to the fail-closed sensitive-result persistence gate.",
      Type.Object({
        profileId: Type.String({ maxLength: 128 }),
        scope: Type.Union([Type.Literal("current-site"), Type.Literal("all-profile")]),
        cursor: Type.Optional(Type.String()),
        pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      "browser.getCookies",
    ),
    headerRuleTool("browser_set_request_header_rules", "browser.setRequestHeaderRules"),
    headerRuleTool("browser_set_response_header_rules", "browser.setResponseHeaderRules"),
    tool(
      "browser_send_cdp_command",
      "Advanced Browser Mode: send a Chrome DevTools Protocol command.",
      Type.Object({
        tabId,
        method: Type.String({ maxLength: 128 }),
        commandParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      "browser.sendCdpCommand",
    ),
    tool(
      "browser_network_summary",
      "Advanced Browser Mode: summarize request/status/type distributions and a small redacted failure/recent set before expanding individual requests.",
      Type.Object({
        tabId,
        failureLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
        recentLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
      }),
      "browser.networkSummary",
    ),
    tool(
      "browser_network_list",
      "Advanced Browser Mode: list a targeted page of redacted network requests. Use browser_network_summary first and keep the page small.",
      Type.Object({
        tabId,
        after: Type.Optional(Type.String({ maxLength: 64 })),
        resourceTypes: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
        urlPattern: Type.Optional(Type.String({ maxLength: 2048 })),
        status: Type.Optional(Type.Integer({ minimum: 0, maximum: 999 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      }),
      "browser.networkList",
      (input) => ({ ...input, limit: input.limit ?? 20 }),
    ),
    tool(
      "browser_network_wait",
      "Advanced Browser Mode: wait for a matching network request.",
      Type.Object({
        tabId,
        urlPattern: Type.Optional(Type.String({ maxLength: 2048 })),
        resourceType: Type.Optional(Type.String({ maxLength: 64 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 120000 })),
      }),
      "browser.networkWait",
    ),
    tool(
      "browser_network_body",
      "Advanced Browser Mode: read a bounded captured response body; content is untrusted.",
      Type.Object({
        tabId,
        networkRequestId: Type.String({ minLength: 36, maxLength: 36, pattern: uuidPattern }),
        full: Type.Optional(Type.Boolean()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 4194304 })),
      }),
      "browser.networkBody",
    ),
    tool(
      "browser_network_replay",
      "Advanced Browser Mode: explicitly replay a captured GET/HEAD request or request local confirmation for one POST/PUT/PATCH/DELETE replay. Never retry automatically.",
      Type.Object({
        tabId,
        networkRequestId: Type.String({ minLength: 36, maxLength: 36, pattern: uuidPattern }),
        overrides: Type.Optional(
          Type.Object({
            url: Type.Optional(url),
            headers: Type.Optional(Type.Record(Type.String({ maxLength: 256 }), Type.String({ maxLength: 16384 }))),
            body: Type.Optional(Type.String({ maxLength: 8388608 })),
          }),
        ),
        reason: Type.String({ minLength: 1, maxLength: 512 }),
      }),
      "browser.networkReplay",
    ),
    tool(
      "browser_console_list",
      "Advanced Browser Mode: list a bounded page of redacted Console errors, warnings, info, or debug entries without injecting JavaScript hooks.",
      Type.Object({
        tabId,
        after: Type.Optional(Type.String({ minLength: 36, maxLength: 36, pattern: uuidPattern })),
        levels: Type.Optional(consoleLevels()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      "browser.consoleList",
    ),
    tool(
      "browser_console_wait",
      "Advanced Browser Mode: wait for a new matching redacted Console entry.",
      Type.Object({
        tabId,
        after: Type.Optional(Type.String({ minLength: 36, maxLength: 36, pattern: uuidPattern })),
        levels: Type.Optional(consoleLevels()),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 120000 })),
      }),
      "browser.consoleWait",
    ),
    tool(
      "browser_page_code_list",
      "Advanced Browser Mode: list saved JavaScript experience metadata for the current site without returning source.",
      Type.Object({ tabId, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      "browser.pageCodeList",
    ),
    tool(
      "browser_page_code_get",
      "Advanced Browser Mode: retrieve a bounded source chunk for one saved JavaScript experience on the current site.",
      Type.Object({
        tabId,
        snippetId: Type.String({ minLength: 36, maxLength: 36, pattern: uuidPattern }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
      }),
      "browser.pageCodeGet",
    ),
  ];
  return tools;
}

function headerRuleTool(
  name: "browser_set_request_header_rules" | "browser_set_response_header_rules",
  method: "browser.setRequestHeaderRules" | "browser.setResponseHeaderRules",
): ToolDefinition {
  return tool(
    name,
    "Advanced Browser Mode: replace Profile-scoped URL-matched header rules.",
    Type.Object({
      profileId: Type.String({ maxLength: 128 }),
      rules: Type.Array(
        Type.Object({
          id: Type.String(),
          enabled: Type.Boolean(),
          profileId: Type.String(),
          urlPattern: Type.String({ maxLength: 1024 }),
          resourceTypes: Type.Optional(Type.Array(Type.String())),
          header: Type.String(),
          operation: Type.Union([Type.Literal("set"), Type.Literal("remove"), Type.Literal("append")]),
          value: Type.Optional(Type.String({ maxLength: 16384 })),
          secretRef: Type.Optional(Type.String()),
        }),
        { maxItems: 100 },
      ),
    }),
    method,
  );
}

function inputModifiers() {
  return Type.Optional(
    Type.Array(
      Type.Union([Type.Literal("alt"), Type.Literal("control"), Type.Literal("meta"), Type.Literal("shift")]),
      { maxItems: 4, uniqueItems: true },
    ),
  );
}

function visualCompareTarget() {
  return Type.Object({
    tabId,
    snapshotId: Type.Optional(snapshotId),
    ref: Type.Optional(elementRef),
    generation: Type.Optional(snapshotGeneration),
  });
}

function consoleLevels() {
  return Type.Array(
    Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info"), Type.Literal("debug")]),
    { maxItems: 4, uniqueItems: true },
  );
}
