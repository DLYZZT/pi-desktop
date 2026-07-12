/**
 * protocol.handle("app") — serve static UI with strict CSP.
 */
import { protocol } from "electron";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { appendMainLog } from "./logger";

const CSP =
  "default-src 'self' app:; " +
  "script-src 'self' app:; " +
  "style-src 'self' app: https://fonts.googleapis.com https://cdn.jsdelivr.net; " +
  "style-src-elem 'self' app: 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; " +
  "style-src-attr 'unsafe-inline'; " +
  "font-src 'self' app: data: https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
  "img-src 'self' app: data: blob: https:; " +
  "media-src 'self' app: blob: data:; " +
  "connect-src 'self' app:; " +
  "worker-src 'self' app: blob:; " +
  "frame-src 'self' app: blob:; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'";

const HTML_PREVIEW_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' app: http: https:; " +
  "style-src 'unsafe-inline' app: http: https:; " +
  "img-src app: data: blob: http: https:; " +
  "font-src app: data: http: https:; " +
  "media-src app: data: blob: http: https:; " +
  "connect-src http: https:; " +
  "worker-src blob:; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'";

const HTML_PREVIEW_MAX_BYTES = 1024 * 1024;
const HTML_PREVIEW_ASSET_MAX_BYTES = 20 * 1024 * 1024;

type HtmlPreviewEntry = {
  content: string;
  filePath: string;
  loadAsset: (filePath: string) => Promise<{ base64: string; size: number; mime?: string }>;
};

const htmlPreviews = new Map<string, HtmlPreviewEntry>();

export function createHtmlPreviewUrl(
  content: string,
  filePath: string,
  loadAsset: HtmlPreviewEntry["loadAsset"],
): string {
  if (
    typeof content !== "string" ||
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    Buffer.byteLength(content, "utf8") > HTML_PREVIEW_MAX_BYTES
  ) {
    throw new Error("HTML preview is too large");
  }
  const token = randomUUID();
  htmlPreviews.set(token, { content, filePath, loadAsset });
  return `app://preview/${token}/index.html`;
}

export function releaseHtmlPreviewUrl(previewUrl: string): void {
  try {
    const url = new URL(previewUrl);
    if (url.protocol !== "app:" || url.hostname !== "preview") return;
    const [token] = url.pathname.split("/").filter(Boolean);
    if (token) htmlPreviews.delete(token);
  } catch {
    /* ignore malformed preview URLs */
  }
}

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
      if (url.hostname === "preview") {
        const [token, ...assetSegments] = url.pathname.split("/").filter(Boolean);
        const preview = token ? htmlPreviews.get(token) : undefined;
        if (!preview) return new Response("Not Found", { status: 404 });

        if (assetSegments.join("/") === "index.html") {
          return new Response(preview.content, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy": HTML_PREVIEW_CSP,
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
            },
          });
        }

        const relativePath = decodeURIComponent(assetSegments.join("/"));
        const assetPath = path.resolve(path.dirname(preview.filePath), relativePath);
        const asset = await preview.loadAsset(assetPath);
        if (asset.size > HTML_PREVIEW_ASSET_MAX_BYTES) {
          return new Response("Asset too large", { status: 413 });
        }
        const ext = path.extname(assetPath).toLowerCase();
        const mime = MIME[ext] ?? asset.mime ?? "application/octet-stream";
        return new Response(Buffer.from(asset.base64, "base64"), {
          status: 200,
          headers: {
            "Content-Type": mime,
            "Access-Control-Allow-Origin": "*",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        });
      }
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
export function rendererRootPath(mainDirectory = __dirname): string {
  return path.join(mainDirectory, "..", "renderer");
}

export function fileUrl(p: string): string {
  return pathToFileURL(p).href;
}
