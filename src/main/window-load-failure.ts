function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function createLoadFailurePage(code: number, description: string, validatedUrl: string): string {
  return (
    `<!DOCTYPE html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">` +
    `<meta name="referrer" content="no-referrer"></head>` +
    `<body style="font-family:system-ui;background:#f7f6f3;padding:40px;color:#1c1a17">` +
    `<h1 style="font-family:ui-monospace,monospace;font-size:18px">Cannot load UI</h1>` +
    `<p style="color:#57534a;font-size:13.5px;line-height:1.55">Failed to load <code>${escapeHtml(validatedUrl)}</code><br/>Error ${escapeHtml(code)}: ${escapeHtml(description)}</p>` +
    `<p style="color:#57534a;font-size:13.5px">Try: <code>npm run build &amp;&amp; npm start</code> or <code>npm run dev</code></p>` +
    `</body></html>`
  );
}
