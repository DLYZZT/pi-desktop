type Translate = (key: string, fallback: string) => string;
type ActionInput = Record<string, unknown>;

function shortText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Keep only small display fields in the live phase; file contents and scripts stay in the transcript. */
export function toolActionInput(toolName: string, value: unknown): ActionInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as ActionInput;
  const keys = ["path", "file_path", "pattern", "query", "url"];
  if (toolName === "bash" || toolName === "powershell") keys.push("description", "command");
  if (toolName.startsWith("browser_")) keys.push("action");
  const entries = keys.flatMap((key) => {
    const text = shortText(input[key]);
    return text ? [[key, text]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Describe the requested action, never infer success or the intent of arbitrary shell code. */
export function toolActionTitle(toolName: string, input: ActionInput | undefined, t: Translate): string {
  const target = (template: string, value: unknown) => {
    const text = shortText(value);
    return text ? `${template}: ${text}` : template;
  };
  const path = input?.path ?? input?.file_path;
  switch (toolName) {
    case "bash":
    case "powershell":
      return shortText(input?.description) || target(t("toolActionCommand", "Run command"), input?.command);
    case "read":
      return target(t("toolActionRead", "Read file"), path);
    case "write":
      return target(t("toolActionWrite", "Write file"), path);
    case "edit":
      return target(t("toolActionEdit", "Edit file"), path);
    case "ls":
      return target(t("toolActionList", "List directory"), path);
    case "find":
      return target(t("toolActionFind", "Find files"), input?.pattern);
    case "grep":
      return target(t("toolActionGrep", "Search file contents"), input?.pattern);
    case "web_search":
      return target(t("toolActionWebSearch", "Search the web"), input?.query);
    case "web_fetch":
      return target(t("toolActionWebFetch", "Read web page"), input?.url);
    case "browser_open":
    case "browser_navigate":
      return target(t("toolActionBrowserOpen", "Open web page"), input?.url);
    case "browser_tab":
      if (input?.action === "open" || input?.action === "navigate") {
        return target(t("toolActionBrowserOpen", "Open web page"), input?.url);
      }
      return t("toolActionBrowserInspect", "Inspect web page");
    case "browser_device":
      return t("toolActionBrowserInspect", "Inspect web page");
    case "browser_inspect":
    case "browser_read":
      return t("toolActionBrowserInspect", "Inspect web page");
    case "browser_pointer":
    case "browser_input":
    case "browser_wait":
    case "browser_request_user_help":
    case "browser_upload":
    case "browser_downloads":
    case "browser_network":
    case "browser_console":
    case "browser_js":
    case "browser_clipboard":
    case "browser_header_rules":
    case "browser_get_cookies":
    case "browser_send_cdp_command":
      return t("toolActionCall", "Call tool: {tool}").replace("{tool}", shortText(toolName));
    case "browser_screenshot":
      return t("toolActionBrowserScreenshot", "Take page screenshot");
    case "browser_batch":
      return t("toolActionCodemode", "Run a batch of operations");
    case "codemode":
      return t("toolActionCodemode", "Run a batch of operations");
    default:
      return t("toolActionCall", "Call tool: {tool}").replace("{tool}", shortText(toolName));
  }
}
