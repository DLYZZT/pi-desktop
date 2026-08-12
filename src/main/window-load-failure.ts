import { APP_MONO_FONT_FAMILY, APP_SANS_FONT_FAMILY } from "../shared/font-stack.ts";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type FailurePageTheme = "light" | "dark";

const FAILURE_PAGE_COLORS: Record<
  FailurePageTheme,
  { bg: string; panel: string; text: string; muted: string; link: string }
> = {
  light: { bg: "#f7f6f3", panel: "#fcfbf9", text: "#1c1a17", muted: "#57534a", link: "#9a3412" },
  dark: { bg: "#141210", panel: "#1c1a17", text: "#faf9f7", muted: "#a19d92", link: "#fb923c" },
};

function createFailurePage(title: string, content: string, theme: FailurePageTheme): string {
  const colors = FAILURE_PAGE_COLORS[theme];
  return (
    `<!DOCTYPE html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">` +
    `<meta name="referrer" content="no-referrer">` +
    `<meta name="color-scheme" content="${theme}">` +
    `<style>:root{color-scheme:${theme};--bg:${colors.bg};--panel:${colors.panel};--text:${colors.text};--muted:${colors.muted};--link:${colors.link}}` +
    `html,body{min-height:100%;margin:0;background:var(--bg);color:var(--text)}` +
    `body{box-sizing:border-box;padding:40px;font-family:${APP_SANS_FONT_FAMILY}}` +
    `main{max-width:720px;padding:24px;border:1px solid color-mix(in srgb,var(--text) 14%,transparent);border-radius:12px;background:var(--panel)}` +
    `h1,code{font-family:${APP_MONO_FONT_FAMILY}}h1{margin-top:0;font-size:18px}` +
    `p{color:var(--muted);font-size:13.5px;line-height:1.55}a{color:var(--link)}</style></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1>${content}</main>` +
    `</body></html>`
  );
}

export function createLoadFailurePage(
  code: number,
  description: string,
  validatedUrl: string,
  theme: FailurePageTheme = "light",
): string {
  return createFailurePage(
    "Cannot load UI",
    `<p>Failed to load <code>${escapeHtml(validatedUrl)}</code><br/>Error ${escapeHtml(code)}: ${escapeHtml(description)}</p>` +
      `<p>Try: <code>npm run build &amp;&amp; npm start</code> or <code>npm run dev</code></p>`,
    theme,
  );
}

export const RENDERER_CRASH_RETRY_URL = "pi-desktop://renderer-retry";

export function createRendererCrashPage(reason: string, theme: FailurePageTheme = "light"): string {
  return createFailurePage(
    "Renderer stopped",
    `<p>The UI was not restarted automatically (${escapeHtml(reason)}).</p>` +
      `<p><a href="${RENDERER_CRASH_RETRY_URL}">Retry loading the UI</a></p>`,
    theme,
  );
}
