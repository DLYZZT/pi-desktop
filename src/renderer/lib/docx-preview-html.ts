import { APP_MONO_FONT_FAMILY, APP_SANS_FONT_FAMILY } from "../../shared/font-stack.ts";

type DocxPreviewTheme = "light" | "dark";

const DOCX_THEME = {
  light: {
    bg: "#fcfbf9",
    text: "#1c1a17",
    muted: "#57534a",
    border: "#e4e1da",
    codeBg: "#f0eeea",
    link: "#9a3412",
  },
  dark: {
    bg: "#1c1a17",
    text: "#faf9f7",
    muted: "#a19d92",
    border: "#4a453c",
    codeBg: "#0f0e0c",
    link: "#fb923c",
  },
} satisfies Record<DocxPreviewTheme, Record<string, string>>;

export function createDocxPreviewHtml(content: string, theme: DocxPreviewTheme): string {
  const colors = DOCX_THEME[theme];
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="color-scheme" content="${theme}"/><style>
    :root{color-scheme:${theme};--bg:${colors.bg};--text:${colors.text};--muted:${colors.muted};--border:${colors.border};--code-bg:${colors.codeBg};--link:${colors.link}}
    *{box-sizing:border-box}
    html,body{min-height:100%;margin:0;background:var(--bg);color:var(--text)}
    body{padding:24px;font-family:${APP_SANS_FONT_FAMILY};font-size:14px;line-height:1.6;overflow-wrap:anywhere}
    p,li{color:var(--text)}small,figcaption{color:var(--muted)}
    a{color:var(--link);text-underline-offset:2px}
    pre,code{font-family:${APP_MONO_FONT_FAMILY};background:var(--code-bg);color:var(--text);border-radius:4px}
    code{padding:.1em .3em}pre{padding:12px;overflow:auto}pre code{padding:0}
    table{border-collapse:collapse;max-width:100%}th,td{border:1px solid var(--border);padding:6px 8px}
    blockquote{margin-left:0;padding-left:16px;border-left:3px solid var(--border);color:var(--muted)}
    img{display:block;max-width:100%;height:auto}
  </style></head><body>${content}</body></html>`;
}
