/**
 * protocol.handle("app") — serve static UI with strict CSP.
 */
import { protocol } from "electron";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { appendMainLog } from "./logger";

const CSP =
  "default-src 'self' app:; " +
  "script-src 'self' app: 'unsafe-inline'; " +
  "style-src 'self' app: 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; " +
  "font-src 'self' app: data: https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
  "img-src 'self' app: data: blob:; " +
  "media-src 'self' app: blob: data:; " +
  "connect-src 'self' app:; " +
  "worker-src 'self' app: blob:; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".ico": "image/x-icon",
};

export function registerAppProtocol(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function handleAppProtocol(rendererRoot: string): void {
  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith("/bundle")) {
        pathname = pathname.slice("/bundle".length) || "/";
      }
      if (pathname === "/" || pathname === "") pathname = "/index.html";

      const filePath = path.normalize(path.join(rendererRoot, pathname));
      if (!filePath.startsWith(path.normalize(rendererRoot))) {
        return new Response("Forbidden", { status: 403 });
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        // SPA fallback
        const index = path.join(rendererRoot, "index.html");
        if (fs.existsSync(index)) {
          const body = fs.readFileSync(index);
          return new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy": CSP,
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      }

      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] ?? "application/octet-stream";
      const data = fs.readFileSync(filePath);
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Content-Security-Policy": CSP,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (err) {
      appendMainLog(`protocol.handle error: ${err}`);
      return new Response("Internal Error", { status: 500 });
    }
  });
}

/** Dev convenience: load via file:// is avoided; keep helper for diagnostics. */
export function rendererRootPath(): string {
  return path.join(__dirname, "..", "renderer");
}

export function fileUrl(p: string): string {
  return pathToFileURL(p).href;
}
