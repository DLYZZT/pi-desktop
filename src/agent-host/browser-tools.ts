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
import { BROWSER_DEVICE_LIMITS, BROWSER_DEVICE_PRESETS } from "../contract/browser-device";
import { callMain } from "./parent-rpc";
import { BROWSER_CANONICAL_GUIDELINES, browserAgentRuntime } from "./browser-agent-runtime";
export { getBrowserSessionSource, setBrowserSessionSource } from "./session-source";
import { getBrowserSessionSource } from "./session-source";

export const BROWSER_TOOL_PERMISSIONS = {
  browser_tab: "read",
  browser_device: "interact",
  browser_inspect: "read",
  browser_read: "read",
  browser_screenshot: "read",
  browser_pointer: "interact",
  browser_input: "interact",
  browser_wait: "read",
  browser_request_user_help: "read",
  browser_upload: "interact",
  browser_downloads: "read",
  browser_batch: "read",
  browser_js: "advanced",
  browser_get_cookies: "advanced",
  browser_header_rules: "advanced",
  browser_send_cdp_command: "advanced",
  browser_network: "advanced",
  browser_console: "advanced",
  browser_clipboard: "advanced",
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
    if (required !== "advanced") return true;
    if (!snapshot.advancedEnabled) return false;
    // The merged JavaScript tool exposes execute/list/get; it stays hidden
    // until the Agent-JavaScript switch is on.
    if (name === "browser_js") return snapshot.agentJavaScriptEnabled === true;
    return true;
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
      const result = await callMain<BrowserHostResult<M>>(method, request, callTimeoutMs(method, params));
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
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ReturnType<typeof textResult>>,
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
      return execute(input as Record<string, unknown>, ctx);
    },
  });
}

function permissionRank(permission: BrowserPermissionLevel): number {
  return { none: 0, read: 1, interact: 2, advanced: 3 }[permission];
}

function callTimeoutMs(
  method: Exclude<
    BrowserHostMethod,
    "browser.capabilities" | "browser.requestAuthorization" | "browser.sessionEnded" | "browser.requestRouteBypass"
  >,
  params: Record<string, unknown>,
): number {
  if (method === "browser.requestUserHelp") {
    const requested = typeof params.timeoutMs === "number" ? params.timeoutMs : 5 * 60_000;
    return Math.min(30 * 60_000 + 15_000, requested + 15_000);
  }
  if (
    method === "browser.wait" ||
    method === "browser.networkWait" ||
    method === "browser.consoleWait" ||
    method === "browser.executeJavaScript" ||
    method === "browser.downloadWait" ||
    method === "browser.uploadFiles" ||
    method === "browser.batch"
  ) {
    return 125_000;
  }
  return 35_000;
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
    method === "browser.hover" ||
    method === "browser.drag" ||
    method === "browser.select" ||
    method === "browser.scroll" ||
    method === "browser.setDeviceMode" ||
    method === "browser.uploadFiles"
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
    method === "browser.pageCodeGet" ||
    method === "browser.clipboard"
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
  description: "Full snapshot UUID from the most recent browser_inspect result",
});
const elementRef = Type.String({
  minLength: 2,
  maxLength: 32,
  pattern: "^e[1-9][0-9]*$",
  description: "Element ref from the most recent browser_inspect result",
});
const snapshotGeneration = Type.Integer({
  minimum: 0,
  description: "Generation from the same browser_inspect result as snapshotId and ref",
});
const url = Type.String({
  minLength: 1,
  maxLength: 8192,
  description: "Absolute http(s) URL; browser_tab open accepts https or a bare host",
});

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`INVALID_BROWSER_REQUEST: ${name} is required for this action`);
  return value;
}

function requireTab(value: unknown): string {
  return requireValue(typeof value === "string" ? value : undefined, "tabId");
}

function deviceModeSchema() {
  const { minSize, maxSize, minDpr, maxDpr } = BROWSER_DEVICE_LIMITS;
  const orientation = Type.Optional(Type.Union([Type.Literal("portrait"), Type.Literal("landscape")]));
  const touch = Type.Optional(Type.Boolean());
  return Type.Union([
    Type.Object({ mode: Type.Literal("desktop") }),
    Type.Object({ mode: Type.Literal("rotate") }),
    Type.Object({
      mode: Type.Literal("preset"),
      presetId: Type.Union(Object.keys(BROWSER_DEVICE_PRESETS).map((id) => Type.Literal(id))),
      orientation,
      touch,
    }),
    Type.Object({
      mode: Type.Literal("custom"),
      width: Type.Integer({ minimum: minSize, maximum: maxSize }),
      height: Type.Integer({ minimum: minSize, maximum: maxSize }),
      dpr: Type.Number({ minimum: minDpr, maximum: maxDpr }),
      orientation,
      touch,
    }),
  ]);
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

export function createBrowserToolDefinitions(): ToolDefinition[] {
  return [
    tool(
      "browser_tab",
      "Manage owned tabs. Actions: open, list, navigate, back, forward, reload, close.",
      Type.Object({
        action: Type.Union([
          Type.Literal("open"),
          Type.Literal("list"),
          Type.Literal("navigate"),
          Type.Literal("back"),
          Type.Literal("forward"),
          Type.Literal("reload"),
          Type.Literal("close"),
        ]),
        tabId: Type.Optional(tabId),
        url: Type.Optional(url),
        profileId: Type.Optional(Type.String({ maxLength: 128 })),
        activate: Type.Optional(Type.Boolean()),
      }),
      async (input, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const action = input.action;
        if (action === "open") {
          const result = await browserCall(
            "browser.open",
            {
              url: requireValue(input.url as string | undefined, "url"),
              ...(input.profileId === undefined ? {} : { profileId: input.profileId as string }),
              ...(input.activate === undefined ? {} : { activate: input.activate as boolean }),
            },
            ctx,
          );
          return textResult(result, sessionId);
        }
        if (action === "list") return textResult(await browserCall("browser.listTabs", {}, ctx), sessionId);
        if (action === "navigate") {
          return textResult(
            await browserCall(
              "browser.navigate",
              { tabId: requireTab(input.tabId), url: requireValue(input.url as string | undefined, "url") },
              ctx,
            ),
            sessionId,
          );
        }
        if (action === "back" || action === "forward" || action === "reload") {
          const method =
            action === "back" ? "browser.back" : action === "forward" ? "browser.forward" : "browser.reload";
          return textResult(await browserCall(method, { tabId: requireTab(input.tabId) }, ctx), sessionId);
        }
        if (action === "close") {
          return textResult(await browserCall("browser.close", { tabId: requireTab(input.tabId) }, ctx), sessionId);
        }
        throw new Error("INVALID_BROWSER_REQUEST: tab action is invalid");
      },
    ),
    tool(
      "browser_device",
      "Change an owned tab's device preview without reloading: desktop, phone preset, custom CSS size/DPR, rotate, or touch.",
      Type.Object({ tabId, device: deviceModeSchema() }),
      async (input, ctx) =>
        textResult(
          await browserCall(
            "browser.setDeviceMode",
            { tabId: requireTab(input.tabId), device: input.device as never },
            ctx,
          ),
          ctx.sessionManager.getSessionId(),
        ),
    ),
    defineTool({
      name: "browser_inspect",
      label: "browser inspect",
      description:
        "Atomically inspect owned tabs with compact page text and element refs. The default has no screenshot; enable one only for visual evidence. Reuse sinceInspectionId for deltas.",
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
    tool(
      "browser_read",
      "Read a page as structured content: article text, tables, links, or form fields. Prefer this over parsing flattened body text.",
      Type.Object({
        tabId,
        mode: Type.Union([
          Type.Literal("article"),
          Type.Literal("tables"),
          Type.Literal("links"),
          Type.Literal("forms"),
        ]),
        maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 60_000 })),
        maxRows: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      }),
      async (input, ctx) =>
        textResult(
          await browserCall(
            "browser.read",
            {
              tabId: requireTab(input.tabId),
              mode: input.mode as "article" | "tables" | "links" | "forms",
              ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars as number }),
              ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows as number }),
            },
            ctx,
          ),
          ctx.sessionManager.getSessionId(),
        ),
    ),
    defineTool({
      name: "browser_screenshot",
      label: "browser screenshot",
      description:
        "Capture an owned tab (viewport, bounded full page, or element) or compare two captures. Prefer inspect deltas unless a dedicated image is necessary.",
      promptSnippet: "browser_screenshot: capture an owned tab or compare two captures",
      promptGuidelines: [...BROWSER_CANONICAL_GUIDELINES],
      parameters: Type.Object({
        action: Type.Union([Type.Literal("capture"), Type.Literal("compare")]),
        tabId: Type.Optional(tabId),
        mode: Type.Optional(Type.Union([Type.Literal("viewport"), Type.Literal("full-page"), Type.Literal("element")])),
        format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
        quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        snapshotId: Type.Optional(snapshotId),
        ref: Type.Optional(elementRef),
        generation: Type.Optional(snapshotGeneration),
        left: Type.Optional(visualCompareTarget()),
        right: Type.Optional(visualCompareTarget()),
        threshold: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
        includeDiff: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        if (input.action === "compare") {
          const result = await browserCall(
            "browser.visualCompare",
            {
              left: requireValue(input.left, "left"),
              right: requireValue(input.right, "right"),
              ...(input.mode === undefined ? {} : { mode: input.mode }),
              ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
              ...(input.includeDiff === undefined ? {} : { includeDiff: input.includeDiff }),
            } as never,
            ctx,
          );
          const { diff, ...metadata } = result;
          const text = JSON.stringify(metadata, null, 2);
          browserAgentRuntime.recordResultText(sessionId, text.length);
          return {
            content: [
              { type: "text" as const, text },
              ...(diff ? [{ type: "image" as const, data: diff.base64, mimeType: diff.mime }] : []),
            ],
            details: undefined,
          };
        }
        const result = await browserCall(
          "browser.screenshot",
          {
            tabId: requireTab(input.tabId),
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.format === undefined ? {} : { format: input.format }),
            ...(input.quality === undefined ? {} : { quality: input.quality }),
            ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
            ...(input.ref === undefined ? {} : { ref: input.ref }),
            ...(input.generation === undefined ? {} : { generation: input.generation }),
          } as never,
          ctx,
        );
        const text = `Screenshot of Browser tab ${result.tabId} (${result.width}×${result.height}, ${result.mode}, generation ${result.generation})`;
        browserAgentRuntime.recordResultText(sessionId, text.length);
        return {
          content: [
            { type: "text" as const, text },
            { type: "image" as const, data: result.base64, mimeType: result.mime },
          ],
          details: undefined,
        };
      },
    }),
    tool(
      "browser_pointer",
      "Pointer and wheel actions on an owned tab. Actions: click, clickAt, hover, drag, scroll.",
      Type.Object({
        action: Type.Union([
          Type.Literal("click"),
          Type.Literal("clickAt"),
          Type.Literal("hover"),
          Type.Literal("drag"),
          Type.Literal("scroll"),
        ]),
        tabId,
        ref: Type.Optional(elementRef),
        snapshotId: Type.Optional(snapshotId),
        generation: Type.Optional(snapshotGeneration),
        fromRef: Type.Optional(elementRef),
        toRef: Type.Optional(elementRef),
        x: Type.Optional(Type.Number({ minimum: 0 })),
        y: Type.Optional(Type.Number({ minimum: 0 })),
        deltaX: Type.Optional(Type.Integer({ minimum: -100000, maximum: 100000 })),
        deltaY: Type.Optional(Type.Integer({ minimum: -100000, maximum: 100000 })),
        button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])),
        clickCount: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
        modifiers: inputModifiers(),
        steps: Type.Optional(Type.Integer({ minimum: 2, maximum: 50 })),
      }),
      async (input, ctx) => {
        const tab = requireTab(input.tabId);
        let result: unknown;
        if (input.action === "click") {
          result = await browserCall(
            "browser.click",
            {
              tabId: tab,
              ref: requireValue(input.ref as string | undefined, "ref"),
              snapshotId: requireValue(input.snapshotId as string | undefined, "snapshotId"),
              generation: requireValue(input.generation as number | undefined, "generation"),
              ...(input.button === undefined ? {} : { button: input.button }),
              ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount }),
              ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
            } as never,
            ctx,
          );
        } else if (input.action === "clickAt") {
          result = await browserCall(
            "browser.clickAt",
            {
              tabId: tab,
              x: requireValue(input.x as number | undefined, "x"),
              y: requireValue(input.y as number | undefined, "y"),
              ...(input.button === undefined ? {} : { button: input.button }),
              ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount }),
              ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
            } as never,
            ctx,
          );
        } else if (input.action === "hover") {
          result = await browserCall(
            "browser.hover",
            {
              tabId: tab,
              ref: requireValue(input.ref as string | undefined, "ref"),
              snapshotId: requireValue(input.snapshotId as string | undefined, "snapshotId"),
              generation: requireValue(input.generation as number | undefined, "generation"),
            } as never,
            ctx,
          );
        } else if (input.action === "drag") {
          result = await browserCall(
            "browser.drag",
            {
              tabId: tab,
              fromRef: requireValue(input.fromRef as string | undefined, "fromRef"),
              toRef: requireValue(input.toRef as string | undefined, "toRef"),
              snapshotId: requireValue(input.snapshotId as string | undefined, "snapshotId"),
              generation: requireValue(input.generation as number | undefined, "generation"),
              ...(input.steps === undefined ? {} : { steps: input.steps }),
            } as never,
            ctx,
          );
        } else {
          result = await browserCall(
            "browser.scroll",
            {
              tabId: tab,
              deltaY: requireValue(input.deltaY as number | undefined, "deltaY"),
              ...(input.deltaX === undefined ? {} : { deltaX: input.deltaX }),
              ...(input.x === undefined ? {} : { x: Math.round(input.x as number) }),
              ...(input.y === undefined ? {} : { y: Math.round(input.y as number) }),
            } as never,
            ctx,
          );
        }
        return textResult(result, ctx.sessionManager.getSessionId());
      },
    ),
    tool(
      "browser_input",
      "Text and keyboard actions on an owned tab. Actions: type, press, select.",
      Type.Object({
        action: Type.Union([Type.Literal("type"), Type.Literal("press"), Type.Literal("select")]),
        tabId,
        ref: Type.Optional(elementRef),
        snapshotId: Type.Optional(snapshotId),
        generation: Type.Optional(snapshotGeneration),
        text: Type.Optional(Type.String({ maxLength: 65536 })),
        submit: Type.Optional(Type.Boolean()),
        key: Type.Optional(Type.String({ maxLength: 16 })),
        modifiers: inputModifiers(),
        value: Type.Optional(Type.String({ maxLength: 4096 })),
        label: Type.Optional(Type.String({ maxLength: 4096 })),
        index: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      }),
      async (input, ctx) => {
        const tab = requireTab(input.tabId);
        let result: unknown;
        if (input.action === "type") {
          result = await browserCall(
            "browser.type",
            {
              tabId: tab,
              ref: requireValue(input.ref as string | undefined, "ref"),
              snapshotId: requireValue(input.snapshotId as string | undefined, "snapshotId"),
              generation: requireValue(input.generation as number | undefined, "generation"),
              text: requireValue(input.text as string | undefined, "text"),
              ...(input.submit === undefined ? {} : { submit: input.submit }),
            } as never,
            ctx,
          );
        } else if (input.action === "press") {
          result = await browserCall(
            "browser.press",
            {
              tabId: tab,
              key: requireValue(input.key as string | undefined, "key"),
              ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
            } as never,
            ctx,
          );
        } else {
          result = await browserCall(
            "browser.select",
            {
              tabId: tab,
              ref: requireValue(input.ref as string | undefined, "ref"),
              snapshotId: requireValue(input.snapshotId as string | undefined, "snapshotId"),
              generation: requireValue(input.generation as number | undefined, "generation"),
              ...(input.value === undefined ? {} : { value: input.value }),
              ...(input.label === undefined ? {} : { label: input.label }),
              ...(input.index === undefined ? {} : { index: input.index }),
            } as never,
            ctx,
          );
        }
        return textResult(result, ctx.sessionManager.getSessionId());
      },
    ),
    tool(
      "browser_wait",
      "Wait for page load, network quiet, DOM stability, an actionable element, a selector, or visible text.",
      Type.Object({
        tabId,
        timeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 120000 })),
        condition: Type.Optional(
          Type.Union([
            Type.Literal("load"),
            Type.Literal("network-idle"),
            Type.Literal("dom-stable"),
            Type.Literal("selector"),
            Type.Literal("text"),
            Type.Literal("actionable"),
          ]),
        ),
        value: Type.Optional(Type.String({ maxLength: 4096 })),
        ref: Type.Optional(elementRef),
        snapshotId: Type.Optional(snapshotId),
        generation: Type.Optional(snapshotGeneration),
      }),
      async (input, ctx) =>
        textResult(await browserCall("browser.wait", input as never, ctx), ctx.sessionManager.getSessionId()),
    ),
    defineTool({
      name: "browser_request_user_help",
      label: "browser request user help",
      description:
        "Pause and ask the local user to complete a step only a human can do: login, captcha, two-factor code, or consent. Use after browser_inspect reports a blocker. The result includes a fresh inspection when the user finishes.",
      promptSnippet:
        "browser_request_user_help: pause for a human on login, captcha, 2FA, or consent; re-inspect after the user finishes",
      promptGuidelines: [...BROWSER_CANONICAL_GUIDELINES],
      parameters: Type.Object({
        tabId,
        kind: Type.Union([
          Type.Literal("login"),
          Type.Literal("captcha"),
          Type.Literal("two-factor"),
          Type.Literal("consent"),
          Type.Literal("agent-request"),
        ]),
        message: Type.String({ minLength: 1, maxLength: 2_000 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 1_800_000 })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const result = await browserCall("browser.requestUserHelp", input as never, ctx);
        const { inspection, ...metadata } = result;
        const text = JSON.stringify(metadata);
        browserAgentRuntime.recordResultText(ctx.sessionManager.getSessionId(), text.length);
        return {
          content: [
            { type: "text" as const, text },
            ...(inspection ? [{ type: "text" as const, text: JSON.stringify(inspection) }] : []),
            ...(inspection?.screenshot
              ? [
                  {
                    type: "image" as const,
                    data: inspection.screenshot.base64,
                    mimeType: inspection.screenshot.mime,
                  },
                ]
              : []),
          ],
          details: undefined,
        };
      },
    }),
    tool(
      "browser_upload",
      "Upload local files to a file input from the latest snapshot after the user approves the file list. Paths must be absolute regular files.",
      Type.Object({
        tabId,
        ref: elementRef,
        snapshotId,
        generation: snapshotGeneration,
        paths: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { minItems: 1, maxItems: 20 }),
      }),
      async (input, ctx) =>
        textResult(
          await browserCall(
            "browser.uploadFiles",
            {
              tabId: requireTab(input.tabId),
              ref: input.ref as string,
              snapshotId: input.snapshotId as string,
              generation: input.generation as number,
              paths: input.paths as string[],
            },
            ctx,
          ),
          ctx.sessionManager.getSessionId(),
        ),
    ),
    tool(
      "browser_downloads",
      "List or wait for Browser downloads owned by this Agent session. Actions: list, wait.",
      Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("wait")]),
        tabId: Type.Optional(tabId),
        downloadId: Type.Optional(Type.String({ minLength: 36, maxLength: 36, pattern: uuidPattern })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
      }),
      async (input, ctx) => {
        const params = {
          ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
          ...(input.downloadId === undefined ? {} : { downloadId: input.downloadId }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        };
        const result =
          input.action === "list"
            ? await browserCall("browser.downloadList", params as never, ctx)
            : await browserCall("browser.downloadWait", params as never, ctx);
        return textResult(result, ctx.sessionManager.getSessionId());
      },
    ),
    tool(
      "browser_batch",
      "Run up to 8 read-only observations (inspect, snapshot, screenshot, read) across owned tabs in parallel. Use for comparing several pages without serial round trips.",
      Type.Object({
        operations: Type.Array(
          Type.Object({
            tabId,
            method: Type.Union([
              Type.Literal("inspect"),
              Type.Literal("snapshot"),
              Type.Literal("screenshot"),
              Type.Literal("read"),
            ]),
            params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          }),
          { minItems: 1, maxItems: 8 },
        ),
      }),
      async (input, ctx) =>
        textResult(
          await browserCall("browser.batch", { operations: input.operations } as never, ctx),
          ctx.sessionManager.getSessionId(),
        ),
    ),
    tool(
      "browser_js",
      "Advanced Browser Mode JavaScript. Actions: execute (intent=explore|verify), list saved experiences, get one saved experience chunk.",
      Type.Object({
        action: Type.Union([Type.Literal("execute"), Type.Literal("list"), Type.Literal("get")]),
        tabId,
        source: Type.Optional(Type.String({ maxLength: 262144 })),
        intent: Type.Optional(Type.Union([Type.Literal("explore"), Type.Literal("verify")])),
        expected: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 120000 })),
        world: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("isolated")])),
        awaitPromise: Type.Optional(Type.Boolean()),
        returnByValue: Type.Optional(Type.Boolean()),
        purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        remember: Type.Optional(Type.Boolean()),
        snippetId: Type.Optional(Type.String({ minLength: 36, maxLength: 36, pattern: uuidPattern })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      async (input, ctx) => {
        const tab = requireTab(input.tabId);
        let result: unknown;
        if (input.action === "execute") {
          if (input.intent === undefined) throw new Error("INVALID_BROWSER_REQUEST: intent is required for execute");
          const runtimeInput = input;
          result = await browserCall(
            "browser.executeJavaScript",
            {
              tabId: tab,
              source: requireValue(input.source as string | undefined, "source"),
              intent: input.intent,
              ...(input.expected === undefined ? {} : { expected: input.expected }),
              ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
              ...(input.world === undefined ? {} : { world: input.world }),
              ...(input.awaitPromise === undefined ? {} : { awaitPromise: input.awaitPromise }),
              ...(input.returnByValue === undefined ? {} : { returnByValue: input.returnByValue }),
              ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
              ...(input.remember === undefined ? {} : { remember: input.remember }),
            } as never,
            ctx,
            runtimeInput,
          );
        } else if (input.action === "list") {
          result = await browserCall(
            "browser.pageCodeList",
            { tabId: tab, ...(input.limit === undefined ? {} : { limit: input.limit }) } as never,
            ctx,
          );
        } else {
          result = await browserCall(
            "browser.pageCodeGet",
            {
              tabId: tab,
              snippetId: requireValue(input.snippetId as string | undefined, "snippetId"),
              ...(input.offset === undefined ? {} : { offset: input.offset }),
              ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
            } as never,
            ctx,
          );
        }
        return textResult(result, ctx.sessionManager.getSessionId());
      },
    ),
    tool(
      "browser_get_cookies",
      "Advanced Browser Mode: request cookies subject to the fail-closed sensitive-result persistence gate.",
      Type.Object({
        profileId: Type.String({ maxLength: 128 }),
        scope: Type.Union([Type.Literal("current-site"), Type.Literal("all-profile")]),
        cursor: Type.Optional(Type.String()),
        pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      async (input, ctx) =>
        textResult(await browserCall("browser.getCookies", input as never, ctx), ctx.sessionManager.getSessionId()),
    ),
    tool(
      "browser_header_rules",
      "Advanced Browser Mode: replace Profile-scoped URL-matched request or response header rules.",
      Type.Object({
        direction: Type.Union([Type.Literal("request"), Type.Literal("response")]),
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
      async (input, ctx) => {
        const method =
          input.direction === "request" ? "browser.setRequestHeaderRules" : "browser.setResponseHeaderRules";
        return textResult(
          await browserCall(method as never, { profileId: input.profileId, rules: input.rules } as never, ctx),
          ctx.sessionManager.getSessionId(),
        );
      },
    ),
    tool(
      "browser_send_cdp_command",
      "Advanced Browser Mode: send a Chrome DevTools Protocol command.",
      Type.Object({
        tabId,
        method: Type.String({ maxLength: 128 }),
        commandParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      async (input, ctx) =>
        textResult(
          await browserCall(
            "browser.sendCdpCommand",
            {
              tabId: requireTab(input.tabId),
              method: input.method as string,
              ...(input.commandParams === undefined ? {} : { commandParams: input.commandParams }),
            } as never,
            ctx,
          ),
          ctx.sessionManager.getSessionId(),
        ),
    ),
    tool(
      "browser_network",
      "Advanced Browser Mode network evidence. Actions: summary, list, wait, body, replay.",
      Type.Object({
        action: Type.Union([
          Type.Literal("summary"),
          Type.Literal("list"),
          Type.Literal("wait"),
          Type.Literal("body"),
          Type.Literal("replay"),
        ]),
        tabId,
        failureLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
        recentLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
        after: Type.Optional(Type.String({ maxLength: 64 })),
        resourceTypes: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
        urlPattern: Type.Optional(Type.String({ maxLength: 2048 })),
        resourceType: Type.Optional(Type.String({ maxLength: 64 })),
        status: Type.Optional(Type.Integer({ minimum: 0, maximum: 999 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        networkRequestId: Type.Optional(Type.String({ minLength: 36, maxLength: 36, pattern: uuidPattern })),
        full: Type.Optional(Type.Boolean()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 4194304 })),
        overrides: Type.Optional(
          Type.Object({
            url: Type.Optional(url),
            headers: Type.Optional(Type.Record(Type.String({ maxLength: 256 }), Type.String({ maxLength: 16384 }))),
            body: Type.Optional(Type.String({ maxLength: 8388608 })),
          }),
        ),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      }),
      async (input, ctx) => {
        const tab = requireTab(input.tabId);
        let result: unknown;
        if (input.action === "summary") {
          result = await browserCall(
            "browser.networkSummary",
            {
              tabId: tab,
              ...(input.failureLimit === undefined ? {} : { failureLimit: input.failureLimit }),
              ...(input.recentLimit === undefined ? {} : { recentLimit: input.recentLimit }),
            } as never,
            ctx,
          );
        } else if (input.action === "list") {
          result = await browserCall(
            "browser.networkList",
            {
              tabId: tab,
              limit: input.limit ?? 20,
              ...(input.after === undefined ? {} : { after: input.after }),
              ...(input.resourceTypes === undefined ? {} : { resourceTypes: input.resourceTypes }),
              ...(input.urlPattern === undefined ? {} : { urlPattern: input.urlPattern }),
              ...(input.status === undefined ? {} : { status: input.status }),
            } as never,
            ctx,
          );
        } else if (input.action === "wait") {
          result = await browserCall(
            "browser.networkWait",
            {
              tabId: tab,
              ...(input.urlPattern === undefined ? {} : { urlPattern: input.urlPattern }),
              ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
              ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            } as never,
            ctx,
          );
        } else if (input.action === "body") {
          result = await browserCall(
            "browser.networkBody",
            {
              tabId: tab,
              networkRequestId: requireValue(input.networkRequestId as string | undefined, "networkRequestId"),
              ...(input.full === undefined ? {} : { full: input.full }),
              ...(input.offset === undefined ? {} : { offset: input.offset }),
              ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
            } as never,
            ctx,
          );
        } else {
          result = await browserCall(
            "browser.networkReplay",
            {
              tabId: tab,
              networkRequestId: requireValue(input.networkRequestId as string | undefined, "networkRequestId"),
              ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
              reason: requireValue(input.reason as string | undefined, "reason"),
            } as never,
            ctx,
          );
        }
        return textResult(result, ctx.sessionManager.getSessionId());
      },
    ),
    tool(
      "browser_console",
      "Advanced Browser Mode Console evidence. Actions: list, wait.",
      Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("wait")]),
        tabId,
        after: Type.Optional(Type.String({ minLength: 36, maxLength: 36, pattern: uuidPattern })),
        levels: Type.Optional(consoleLevels()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 120000 })),
      }),
      async (input, ctx) => {
        const tab = requireTab(input.tabId);
        const result =
          input.action === "list"
            ? await browserCall(
                "browser.consoleList",
                {
                  tabId: tab,
                  ...(input.after === undefined ? {} : { after: input.after }),
                  ...(input.levels === undefined ? {} : { levels: input.levels }),
                  ...(input.limit === undefined ? {} : { limit: input.limit }),
                } as never,
                ctx,
              )
            : await browserCall(
                "browser.consoleWait",
                {
                  tabId: tab,
                  ...(input.after === undefined ? {} : { after: input.after }),
                  ...(input.levels === undefined ? {} : { levels: input.levels }),
                  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
                } as never,
                ctx,
              );
        return textResult(result, ctx.sessionManager.getSessionId());
      },
    ),
    tool(
      "browser_clipboard",
      "Advanced Browser Mode: read or write the local system clipboard.",
      Type.Object({
        action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
        text: Type.Optional(Type.String({ maxLength: 100000 })),
      }),
      async (input, ctx) =>
        textResult(
          await browserCall(
            "browser.clipboard",
            {
              action: input.action,
              ...(input.text === undefined ? {} : { text: input.text }),
            } as never,
            ctx,
          ),
          ctx.sessionManager.getSessionId(),
        ),
    ),
  ];
}
