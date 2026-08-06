import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, nativeImage, webContents, type WebContentsView } from "electron";
import type { BrowserClickResult, BrowserHostMethod } from "../contract/browser";
import { BrowserError } from "../main/browser/browser-error";
import { BrowserService } from "../main/browser/browser-service";

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDjy01HV0PGcedM
17DGZ2jJqwP8jhOND4henZpqo8XGoQqIdOK6/x6ZzYRkzqLp9jallAggFaG+O9Aq
zgnwlhy/Z8eRLo0w2hcDtBlFBgyUZyptgzhLwAN7Im7LkijOR3VLsR/vdGpTHqqK
cX5obBRz+YPyP5XzCy2XZXD8dtHIy3HdfwlUZKcum2RUScI7Kcw2IViqOULDRnyt
b3OVj3mpBxn2MGo84R7n1zf34lnWRyxAdkcS6pGs1Mml8uy7gyPjT3rQ+OZIKDet
5+2p1qSdkzwiIWiIFP8F1Vb+oeJAGrQzMKKuYfkm3+QpypzCZ60blXo1LKc2skbL
dHyiQVOxAgMBAAECggEABczdryEa9fDdC6EbXHXyHl53J8VjXI5mcchQEAKTDON5
Xe+h/VJ1MEPiKOH1FoGBMzahfVWnrG0f+BMOgDyGR15oX7tAd5u6BctecFo+1EGL
PEYg1xbwz8AY86CJXvVFWJPORR3g/jRT8doBdr23yJs0H6U8V3ezpbz8w0TwQw1U
0C044JYrYV58Jx85t8b/Q1sCJ1YJp6o2YiEFPM3USSRsocbFUVwfWvASbfGx9TDG
uGXaa1Yo5JC/bXiU7nlXbS9s5R4j1gFNZ7B6sTEeujeC32aVxIc9nQR1wi6JicqS
ryEd5mdsjOlOjveGLLMO+VMHcJ8qLpFQcr25EXuWdQKBgQD2pefKNHTR1GQNE3iL
YEMXZqwsfJp37THPXeuEzdXTUYhHysXt+xftY+3e/AXxwc/9aZOkR+XKvrDvde0d
MksuBIugFXxCSgpLT0yzYDbffGnrsuUKgTM2pWB7RXuRWiC4j6XXvns6TB1RdSB9
MSVoCJuadZwPS6KVqOh7X7B4fQKBgQDsbmP2K4zj4cXkX1Nn3lu2VCcMSwuZN0kF
KUE4ez2uoVRI6kVOyizMkDvTK8gr9iGr6sdbd6riDIgbC7Os7xQAX+F8/kpx4fH8
U0WbD9s6ZZVMxCdc5bTGJq/gzWR9QnbwEFbSOIde9havC1PZCsLCz2Y3ZeGzJp9l
CTVR9aViRQKBgFNR6kJhhBEaGY5dRHx40VFHauRAV4Ipy4jMpnIfgps3UL1H36Ms
DoIwHrwUEQIBQfzOPITjkNnznxvVj3sscT8jY/N5LpfKIT4dlMCHwSGwCqwHq93n
lWBhb31VFJAejS0rwY9nFoO0ELdixM3l20gQmFgOYOC94TeDbr22rouVAoGBALhb
A3sKTlvKymHeqsyNJ/ot+Byvz6Vy5G8v0flWr6whg/UvJ0fegbwoo11wAC+3Rl4l
Pbnmv8pvdxmPsFSiP3hjSxIJvsa6JdRYoifc31bTqu0m7oKTYrg3pmCmBztcvh1G
wEw/Y976CIoJTSIqL99zlQKRYMIu1Y8U9QypfIH5AoGBAOZVkR6/U26x8W29fHP3
ljKB4CLHd87W0RpxJ8N2xdU8GHSc1N3T6ptut9fHqbupMtivT4xaFEuyGrfZ/FKv
U7BPaCNtZC9Aeoiybsqtg99PB6ZxGVpo/FbH9WBhztrG9R/njFQLOgWECq80slFm
bJA9m22IZtOu42e3rBIS0pv3
-----END PRIVATE KEY-----`;

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUKqX186yyOVXAZse4Bj+h1izmODkwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyMjAwMjcwOVoXDTM2MDcx
OTAwMjcwOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA48tNR1dDxnHnTNewxmdoyasD/I4TjQ+IXp2aaqPFxqEK
iHTiuv8emc2EZM6i6fY2pZQIIBWhvjvQKs4J8JYcv2fHkS6NMNoXA7QZRQYMlGcq
bYM4S8ADeyJuy5Iozkd1S7Ef73RqUx6qinF+aGwUc/mD8j+V8wstl2Vw/HbRyMtx
3X8JVGSnLptkVEnCOynMNiFYqjlCw0Z8rW9zlY95qQcZ9jBqPOEe59c39+JZ1kcs
QHZHEuqRrNTJpfLsu4Mj40960PjmSCg3reftqdaknZM8IiFoiBT/BdVW/qHiQBq0
MzCirmH5Jt/kKcqcwmetG5V6NSynNrJGy3R8okFTsQIDAQABo28wbTAdBgNVHQ4E
FgQUY9IO1Xm5LiT8GFMcyw+v3yQsZrQwHwYDVR0jBBgwFoAUY9IO1Xm5LiT8GFMc
yw+v3yQsZrQwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAHggnOhHt7NsuGhRho6uWtkhO0OuKFW9
+G0YvjIQhEWa+gzPrvmX/EQwEyMtQg8veBqTvve+TsHT4sknWc2gEn9U5DPJAauP
HXrWER4J1Jk+uvhorubLgriA3wXJJFBx9v2EsexKtHOtkfkkHQvTkry93CkcXItV
NOxowmWKBbQ+O10xlX/EQ0J50hmN5Rlc0HcrJK7FWivIQUnuTTvqoAW3CWG+XXil
4n6WurOpHzxors3PY/W7mzAuhhuXI8B0ijdPb5/RiWScVXww2j5qkSgQMvyFJ6Jy
vNtjr9D3pfageti1t1g1K1KqQ7qckqzoBy5JlbgSNuP1orrY/zXuxaI=
-----END CERTIFICATE-----`;

function hasBrowserCode(code: string): (error: unknown) => boolean {
  return (error) => typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-electron-"));
const downloads = path.join(root, "downloads");
const uploadFile = path.join(root, "upload.txt");
fs.mkdirSync(downloads, { recursive: true });
fs.writeFileSync(uploadFile, "approved upload fixture", "utf8");
app.setPath("userData", path.join(root, "user-data"));

let mainWindow: BrowserWindow | null = null;
let server: http.Server | null = null;
let corsServer: http.Server | null = null;
let secureServer: https.Server | null = null;
let proxyServer: http.Server | null = null;
let service: BrowserService | null = null;
let proxyAuthenticatedRequests = 0;
let sensitiveApprovalRequests = 0;
let externalProtocolRequests = 0;
let privateNetworkApprovals = 0;
let permissionRequests = 0;
let permissionResolutions = 0;
let allowSensitiveApproval = true;
const replayRequestCounts = new Map<string, number>();
const replayRequestBodies = new Map<string, string>();

function nativeViewFor(tabId: string): WebContentsView {
  const current = service;
  assert.ok(current, "Browser service is not ready");
  const manager = (
    current as unknown as {
      tabs: { tabs: Map<string, { view: WebContentsView }> };
    }
  ).tabs;
  const record = manager.tabs.get(tabId);
  assert.ok(record, `Native Browser View was not found for ${tabId}`);
  return record.view;
}

app.on("login", (event, webContents, _details, authInfo, callback) => {
  const credentials = service?.getProxyCredentialsForWebContents(webContents.id, authInfo.isProxy);
  if (!credentials) return;
  event.preventDefault();
  callback(credentials.username, credentials.password);
});

function fixtureHtml(): string {
  return `<!doctype html>
  <html><head><meta charset="utf-8"><title>Browser Fixture</title></head>
  <body style="min-height:2400px">
    <button id="action">Run action</button>
    <form id="form"><label>Name <input id="name" placeholder="Your name"></label><button>Submit form</button></form>
    <label>Password <input id="secret" type="password" value="snapshot-secret-value" autocomplete="current-password"></label>
    <a href="/download" download>Download fixture</a>
    <input id="upload" type="file">
    <button id="popup">Open popup</button>
    <button id="popup-fail">Open failing popup</button>
    <a href="mailto:fixture@example.com">Email fixture</a>
    <button id="fullscreen">Request fullscreen</button>
    <div id="output">ready</div>
    <script>
      action.onclick = (event) => output.textContent = 'clicked:' + (event.isTrusted ? 'trusted' : 'untrusted');
      form.onsubmit = (event) => { event.preventDefault(); output.textContent = 'submitted:' + document.getElementById('name').value + ':' + (event.isTrusted ? 'trusted' : 'untrusted'); };
      addEventListener('wheel', (event) => output.textContent = 'wheel:' + (event.isTrusted ? 'trusted' : 'untrusted'), { passive: true });
      upload.onchange = () => output.textContent = 'uploaded:' + (upload.files[0]?.name || 'none');
      popup.onclick = () => window.open('/popup', '_blank');
      document.getElementById('popup-fail').onclick = () => window.open('/popup-fail', '_blank');
      document.getElementById('fullscreen').onclick = () => document.documentElement.requestFullscreen();
    </script>
  </body></html>`;
}

async function startFixture(): Promise<{ origin: string; corsOrigin: string; secureOrigin: string }> {
  corsServer = http.createServer((request, response) => {
    if (request.url === "/cross-frame") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'",
      });
      response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:20px}</style>
        <button id="cross-action">Cross frame action</button>
        <input id="cross-input" aria-label="Cross frame input">
        <script>
          const cross_action = document.getElementById('cross-action');
          const cross_input = document.getElementById('cross-input');
          cross_action.addEventListener('click', event => parent.postMessage({
            fixture: 'cross-click', trusted: event.isTrusted
          }, '*'));
          cross_input.addEventListener('input', event => parent.postMessage({
            fixture: 'cross-input', trusted: event.isTrusted, value: cross_input.value
          }, '*'));
        </script>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("cross-origin fixture");
  });
  await new Promise<void>((resolve, reject) => {
    corsServer!.once("error", reject);
    corsServer!.listen(0, "127.0.0.1", resolve);
  });
  const corsAddress = corsServer.address();
  if (!corsAddress || typeof corsAddress === "string") throw new Error("CORS fixture server did not bind");
  const corsOrigin = `http://127.0.0.1:${corsAddress.port}`;
  secureServer = https.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Certificate fixture</title><body>certificate:allowed</body>");
  });
  await new Promise<void>((resolve, reject) => {
    secureServer!.once("error", reject);
    secureServer!.listen(0, "127.0.0.1", resolve);
  });
  const secureAddress = secureServer.address();
  if (!secureAddress || typeof secureAddress === "string") throw new Error("Certificate fixture server did not bind");
  const secureOrigin = `https://127.0.0.1:${secureAddress.port}`;
  server = http.createServer((request, response) => {
    if (request.url?.startsWith("/identity")) {
      const requestHeaders = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(", ") : (value ?? ""),
        ]),
      );
      const serializedHeaders = JSON.stringify(requestHeaders).replaceAll("<", "\\u003c");
      response.writeHead(200, {
        "content-type": "text/html",
        "accept-ch":
          "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-WoW64",
      });
      response.end(`<!doctype html><meta charset="utf-8"><title>Identity</title>
        <body>identity-ready<script>globalThis.__serverIdentity = ${serializedHeaders}</script></body>`);
      return;
    }
    if (request.url === "/cross-iframe") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; frame-src *",
      });
      response.end(`<!doctype html><meta charset="utf-8"><title>Cross frame</title>
        <div id="cross-output">cross:pending</div>
        <iframe src="${corsOrigin}/cross-frame" style="width:500px;height:220px"></iframe>
        <script>addEventListener('message', event => {
          const output = document.getElementById('cross-output');
          if (event.data?.fixture === 'cross-click') output.textContent = 'cross-click:' + (event.data.trusted ? 'trusted' : 'untrusted');
          if (event.data?.fixture === 'cross-input') output.textContent = 'cross-input:' + event.data.value + ':' + (event.data.trusted ? 'trusted' : 'untrusted');
        })</script>`);
      return;
    }
    if (request.url === "/network") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      response.end(`<!doctype html><meta charset="utf-8"><title>Network</title>
        <div id="network-output">network:pending</div>
        <script>fetch('/api/replay?case=initial&token=fixture-secret', { cache: 'no-store' })
          .then(response => response.json())
          .then(value => document.getElementById('network-output').textContent = 'network:' + value.ok)</script>`);
      return;
    }
    if (request.url?.startsWith("/api/phase9-fail")) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "phase9 fixture failure" }));
      return;
    }
    if (request.url === "/phase9-diagnostics") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      response.end(`<!doctype html><meta charset="utf-8"><title>Phase 9 Diagnostics</title>
        <body><div id="phase9-output">phase9:failed-request-complete</div><script>
          console.warn('phase9 warning token=fixture-console-secret');
          console.error('phase9 error');
          fetch('/api/phase9-fail?token=fixture-network-secret', { cache: 'no-store' })
            .then(response => response.arrayBuffer());
        </script></body>`);
      return;
    }
    if (request.url === "/phase9-visual-a" || request.url === "/phase9-visual-b") {
      const variant = request.url.endsWith("-b") ? "b" : "a";
      const color = variant === "a" ? "#1d4ed8" : "#dc2626";
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'",
      });
      response.end(`<!doctype html><meta charset="utf-8"><title>Phase 9 Visual ${variant}</title>
        <body style="margin:0;min-height:2400px;background:#fff">
          <div id="phase9-box" role="img" aria-label="Phase 9 comparison box"
            style="width:240px;height:160px;background:${color};margin:24px"></div>
          <div style="margin-top:1900px">full-page-end-${variant}</div>
        </body>`);
      return;
    }
    if (request.url === "/api/cross-redirect") {
      response.writeHead(302, { location: `${corsOrigin}/redirect-target` });
      response.end();
      return;
    }
    if (request.url?.startsWith("/api/replay")) {
      const method = (request.method ?? "GET").toUpperCase();
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        replayRequestCounts.set(method, (replayRequestCounts.get(method) ?? 0) + 1);
        replayRequestBodies.set(method, body);
        response.writeHead(method === "POST" ? 201 : method === "DELETE" ? 204 : 200, {
          "content-type": "application/json",
          "x-replay-method": method,
        });
        if (method === "HEAD" || method === "DELETE") response.end();
        else response.end(JSON.stringify({ ok: true, method, body }));
      });
      return;
    }
    if (request.url === "/download") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="fixture.txt"',
      });
      response.end("download fixture");
      return;
    }
    if (request.url === "/headers") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<title>Headers</title><body>header:${request.headers["x-pi-test"] ?? "missing"};` +
          `auth:${request.headers.authorization ?? "missing"};ua:${request.headers["user-agent"] ?? "missing"};` +
          `hints:${request.headers["sec-ch-ua-platform"] ?? "missing"}</body>`,
      );
      return;
    }
    if (request.url === "/csp") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; script-src 'none'",
        "x-frame-options": "DENY",
      });
      response.end(
        "<title>CSP</title><body><div id='csp-output'>blocked</div><script>document.getElementById('csp-output').textContent='executed'</script></body>",
      );
      return;
    }
    if (request.url === "/response-header") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'",
        "x-fixture-original": "original",
      });
      response.end(
        "<title>Response header</title><body><div id='output'>response:pending</div>" +
          "<script>fetch(location.href,{cache:'no-store'}).then(r=>document.getElementById('output').textContent='response:'+(r.headers.get('x-pi-response')||'missing'))</script></body>",
      );
      return;
    }
    if (request.url?.startsWith("/cors")) {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; connect-src *",
      });
      response.end(
        `<title>CORS</title><body><div id="output">cors:pending</div><script>` +
          `fetch(${JSON.stringify(`${corsOrigin}/data`)}).then(r=>r.text()).then(()=>output.textContent='cors:allowed').catch(()=>output.textContent='cors:blocked')` +
          "</script></body>",
      );
      return;
    }
    if (request.url === "/set-persistent-cookie") {
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "persistent_cookie=kept; Path=/; SameSite=Lax",
      });
      response.end("<title>Cookie set</title><body>cookie set</body>");
      return;
    }
    if (request.url === "/cookie-check") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<title>Cookie check</title><body>cookie:${request.headers.cookie ?? "missing"}</body>`);
      return;
    }
    if (request.url === "/popup") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<title>Popup</title><body>popup opened;referrer:${request.headers.referer ?? "missing"}</body>`);
      return;
    }
    if (request.url === "/popup-fail") {
      request.socket.destroy();
      return;
    }
    if (request.url === "/spa") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'",
      });
      response.end(
        "<title>SPA</title><body><button id='spa-route'>Change route</button><div id='spa-output'>spa:ready</div>" +
          "<script>document.getElementById('spa-route').onclick=()=>{history.pushState({},'', '/spa/updated');document.getElementById('spa-output').textContent='spa:updated'}</script></body>",
      );
      return;
    }
    if (request.url === "/frame") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Frame</title><body>frame-content</body>");
      return;
    }
    if (request.url === "/iframe") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; frame-src 'self'",
      });
      response.end(
        "<title>Iframe</title><body><div id='iframe-output'>iframe:pending</div><iframe id='fixture-frame' src='/frame'></iframe>" +
          "<script>document.getElementById('fixture-frame').onload=()=>{document.getElementById('iframe-output').textContent='iframe:'+document.getElementById('fixture-frame').contentDocument.body.innerText}</script></body>",
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'",
    });
    response.end(fixtureHtml());
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return { origin: `http://127.0.0.1:${address.port}`, corsOrigin, secureOrigin };
}

async function startProxy(): Promise<{ rules: string }> {
  proxyServer = http.createServer((request, response) => {
    const expected = `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`;
    if (request.headers["proxy-authorization"] !== expected) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="pi-browser-fixture"' });
      response.end("proxy authentication required");
      return;
    }
    proxyAuthenticatedRequests += 1;
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400);
      response.end("invalid proxy target");
      return;
    }
    const upstream = http.request(
      target,
      {
        method: request.method,
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "proxy-authorization"),
        ),
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end("proxy upstream failed");
    });
    request.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    proxyServer!.once("error", reject);
    proxyServer!.listen(0, "127.0.0.1", resolve);
  });
  const address = proxyServer.address();
  if (!address || typeof address === "string") throw new Error("Proxy server did not bind");
  return { rules: `http://127.0.0.1:${address.port}` };
}

async function waitFor(predicate: () => boolean, message: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function run(): Promise<void> {
  const stage = (name: string) => console.log(`[browser-e2e] ${name}`);
  const fixture = await startFixture();
  const proxy = await startProxy();
  stage("fixture-ready");
  mainWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await mainWindow.loadURL(
    "data:text/html,<body style='margin:0;background:%23000;color:%23fff'>Browser integration host</body>",
  );
  mainWindow.show();
  await new Promise((resolve) => setTimeout(resolve, 250));
  service = new BrowserService({
    userDataDir: app.getPath("userData"),
    getWindow: () => mainWindow,
    confirm: async () => true,
    confirmSensitiveAction: async () => {
      sensitiveApprovalRequests += 1;
      return allowSensitiveApproval;
    },
    confirmExternalProtocol: async () => {
      externalProtocolRequests += 1;
      return false;
    },
    confirmPrivateNetwork: async () => {
      privateNetworkApprovals += 1;
      return true;
    },
    chooseSavePath: async (filename) => path.join(downloads, filename),
    chooseUploadPaths: async () => [uploadFile],
    emit: (event) => {
      if (event.type === "permission-request") permissionRequests += 1;
      if (event.type === "permission-resolved") permissionResolutions += 1;
    },
  });

  const defaults = service.getState();
  stage("service-ready");
  assert.equal(defaults.settings.settings.enabled, true);
  assert.equal(defaults.settings.settings.automation.enabled, false);
  assert.equal(defaults.settings.settings.automation.defaultPermission, "ask");
  assert.equal(defaults.settings.runtime.advancedBrowserModeEnabled, false);
  assert.equal(
    ((await service.handleHostRequest("browser.capabilities", { sessionId: "fixture-session" })) as { lease?: unknown })
      .lease,
    undefined,
  );

  service.updateSettings({ navigation: { allowHttp: true } });
  const locallyApprovedTab = await service.createUserTab({ url: fixture.origin, activate: false });
  service.closeTab(locallyApprovedTab.id);
  assert.doesNotThrow(() => service!.setSurfaceVisible({ tabId: locallyApprovedTab.id, visible: true }));
  assert.doesNotThrow(() =>
    service!.setBounds({ tabId: locallyApprovedTab.id, rect: { x: 0, y: 0, width: 800, height: 600 } }),
  );
  const reusedPrivateApprovalTab = await service.createUserTab({ url: fixture.origin, activate: false });
  service.closeTab(reusedPrivateApprovalTab.id);
  assert.equal(privateNetworkApprovals, 1, "private-network approval should be remembered for this launch");
  service.updateSettings({ automation: { enabled: true } });
  service.grantSession({ sessionId: "fixture-session", permission: "read", source: "local" });
  const privateCaps = (await service.handleHostRequest("browser.capabilities", {
    sessionId: "fixture-session",
  })) as { snapshot: { revision: number }; lease: { id: string } };
  await assert.rejects(
    service.handleHostRequest("browser.open", {
      url: fixture.origin,
      sessionId: "fixture-session",
      capabilityLeaseId: privateCaps.lease.id,
      policyRevision: privateCaps.snapshot.revision,
      requestId: "private-network-agent-denied",
    }),
    hasBrowserCode("PRIVATE_NETWORK_BLOCKED"),
  );

  service.updateSettings({
    navigation: { allowHttp: true, allowPrivateNetwork: true },
    automation: { enabled: true },
    downloads: { mode: "allow-to-directory", directory: downloads },
    panel: { restoreTabs: true },
  });
  service.grantSession({ sessionId: "fixture-session", permission: "read", source: "local" });

  const call = async (method: BrowserHostMethod, body: Record<string, unknown> = {}) => {
    const capabilities = (await service!.handleHostRequest("browser.capabilities", {
      sessionId: "fixture-session",
    })) as { snapshot: { revision: number }; lease?: { id: string } };
    assert.ok(capabilities.lease, `lease missing for ${method}`);
    return service!.handleHostRequest(method, {
      ...body,
      sessionId: "fixture-session",
      capabilityLeaseId: capabilities.lease.id,
      policyRevision: capabilities.snapshot.revision,
      requestId: `${method}-${Date.now()}`,
    });
  };

  const tabsBeforeFailedOpen = service.listTabs("fixture-session").length;
  await assert.rejects(
    call("browser.open", {
      url: `${fixture.origin}/popup-fail`,
      profileId: "temporary",
      activate: false,
    }),
    (error: unknown) => {
      if (!hasBrowserCode("NAVIGATION_FAILED")(error)) return false;
      const browserError = error as BrowserError;
      assert.equal(browserError.recovery.reason, "transient-network");
      assert.equal(browserError.recovery.remediation, "wait-and-retry-once");
      assert.match(String(browserError.details?.netError ?? ""), /ERR_/);
      return true;
    },
  );
  assert.equal(
    service.listTabs("fixture-session").length,
    tabsBeforeFailedOpen,
    "failed browser.open must not leave an unknown owned tab",
  );
  stage("structured-navigation-failure-ready");

  const tab = (await call("browser.open", { url: fixture.origin, profileId: "temporary", activate: true })) as {
    id: string;
  };
  stage("tab-opened");
  const listedTabs = (await call("browser.listTabs")) as { tabs: Array<{ id: string }> };
  assert.ok(listedTabs.tabs.some((candidate) => candidate.id === tab.id));
  service.grantSession({ sessionId: "other-session", permission: "read", source: "local" });
  const otherCapabilities = (await service.handleHostRequest("browser.capabilities", {
    sessionId: "other-session",
  })) as { snapshot: { revision: number }; lease: { id: string } };
  await assert.rejects(
    service.handleHostRequest("browser.snapshot", {
      tabId: tab.id,
      sessionId: "other-session",
      capabilityLeaseId: otherCapabilities.lease.id,
      policyRevision: otherCapabilities.snapshot.revision,
      requestId: "cross-session-snapshot",
    }),
    hasBrowserCode("TAB_NOT_OWNED"),
  );
  service.setBounds({ tabId: tab.id, rect: { x: 0, y: 0, width: 800, height: 600 } });
  service.setSurfaceVisible({ tabId: tab.id, visible: true });
  const nativeView = nativeViewFor(tab.id);
  assert.equal(nativeView.getVisible(), true);
  service.handleWindowVisibility(false);
  assert.equal(service.getState().surfaceVisible, false);
  service.handleWindowVisibility(true);
  assert.equal(service.getState().surfaceVisible, true);
  service.handleRendererUnavailable();
  assert.equal(service.getState().surfaceVisible, false);
  assert.equal(nativeView.getVisible(), false);
  service.handleWindowVisibility(false);
  service.handleWindowVisibility(true);
  assert.equal(service.getState().surfaceVisible, false, "renderer loss must clear requested surface visibility");
  assert.equal(nativeView.getVisible(), false, "a window restore must not reveal a stale Browser View");
  service.setSurfaceVisible({ tabId: tab.id, visible: true });
  let snapshot = (await call("browser.snapshot", { tabId: tab.id })) as {
    text: string;
    snapshotId: string;
    generation: number;
    nodes: Array<{
      ref: string;
      name: string;
      role: string;
      value?: string;
      description?: string;
      frameUrl?: string;
    }>;
  };
  assert.doesNotMatch(JSON.stringify(snapshot), /snapshot-secret-value/);
  const redactedPassword = snapshot.nodes.find((node) => node.role === "password");
  assert.equal(redactedPassword?.value, undefined);
  assert.equal(redactedPassword?.description, "Sensitive value redacted");
  assert.match(snapshot.text, /ready/);
  assert.ok(snapshot.nodes.some((node) => node.name.includes("Run action")));
  stage("snapshot-ready");
  const compactInspection = (await call("browser.inspect", { tabId: tab.id })) as {
    changed: boolean;
    snapshot?: typeof snapshot;
    screenshot?: unknown;
    truncated: { text: boolean; nodes: boolean; screenshot: boolean };
  };
  assert.equal(compactInspection.changed, true);
  assert.equal(compactInspection.screenshot, undefined, "browser.inspect must not capture a screenshot by default");
  assert.ok((compactInspection.snapshot?.nodes.length ?? 0) <= 100);
  assert.ok((compactInspection.snapshot?.text.length ?? 0) <= 8_000);
  assert.equal(compactInspection.truncated.nodes, false, "hidden elements must not report false node truncation");
  assert.equal(compactInspection.truncated.screenshot, false);
  const inspection = (await call("browser.inspect", {
    tabId: tab.id,
    maxNodes: 300,
    maxTextChars: 20_000,
    screenshot: { enabled: true, format: "jpeg", quality: 70 },
  })) as {
    inspectionId: string;
    tabId: string;
    generation: number;
    changed: boolean;
    snapshot?: typeof snapshot;
    screenshot?: { base64: string; generation: number };
    tabs: Array<{ id: string; url: string }>;
  };
  assert.equal(inspection.tabId, tab.id);
  assert.equal(inspection.changed, true);
  assert.equal(inspection.snapshot?.generation, inspection.generation);
  assert.equal(inspection.screenshot?.generation, inspection.generation);
  assert.ok(inspection.tabs.some(({ id }) => id === tab.id));
  assert.ok((inspection.snapshot?.nodes.length ?? 0) <= 300);
  assert.ok((inspection.snapshot?.text.length ?? 0) <= 20_000);
  assert.doesNotMatch(JSON.stringify(inspection), /snapshot-secret-value/);
  const inspectionDelta = (await call("browser.inspect", {
    tabId: tab.id,
    sinceInspectionId: inspection.inspectionId,
    screenshot: { enabled: true },
  })) as {
    inspectionId: string;
    changed: boolean;
    snapshot?: unknown;
    screenshot?: unknown;
  };
  assert.equal(inspectionDelta.changed, false);
  assert.equal(inspectionDelta.snapshot, undefined);
  assert.equal(inspectionDelta.screenshot, undefined);
  stage("inspection-delta-ready");
  service.setSurfaceVisible({ visible: false });
  assert.equal(nativeView.getVisible(), false);
  const screenshotRequest = call("browser.screenshot", { tabId: tab.id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(nativeView.getVisible(), false, "capturing a hidden tab must not expose its native View");
  const screenshot = (await screenshotRequest) as { base64: string; width: number };
  assert.equal(service.getState().surfaceVisible, false);
  assert.equal(nativeView.getVisible(), false);
  assert.ok(screenshot.base64.length > 100);
  assert.ok(screenshot.width > 0);
  const capturedImage = nativeImage.createFromBuffer(Buffer.from(screenshot.base64, "base64"));
  const capturedSize = capturedImage.getSize();
  const centerOffset =
    (Math.floor(capturedSize.height / 2) * capturedSize.width + Math.floor(capturedSize.width / 2)) * 4;
  assert.ok(
    [...capturedImage.toBitmap().subarray(centerOffset, centerOffset + 3)].every((channel) => channel > 240),
    "screenshot must contain the white remote page rather than the black host Renderer",
  );
  stage("screenshot-ready");
  service.setSurfaceVisible({ tabId: tab.id, visible: true });

  const runButton = snapshot.nodes.find((node) => node.name.includes("Run action"))!;
  await assert.rejects(
    call("browser.click", {
      tabId: tab.id,
      ref: runButton.ref,
      snapshotId: snapshot.snapshotId,
      generation: snapshot.generation,
    }),
    /interact permission is required/,
  );

  service.grantSession({ sessionId: "fixture-session", permission: "interact", source: "local" });
  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const clickResult = (await call("browser.click", {
    tabId: tab.id,
    ref: snapshot.nodes.find((node) => node.name.includes("Run action"))!.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
  })) as BrowserClickResult;
  assert.equal(clickResult.action, "clicked");
  assert.equal(clickResult.navigation, undefined);
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "clicked", timeoutMs: 5_000 });
  stage("click-ready");

  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const nameInput = snapshot.nodes.find((node) => node.name.includes("Your name"))!;
  const typeResult = (await call("browser.type", {
    tabId: tab.id,
    ref: nameInput.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
    text: "Pi Desktop",
    submit: true,
  })) as { inputPath: string };
  assert.equal(typeResult.inputPath, "key-events");
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "submitted:Pi Desktop", timeoutMs: 5_000 });
  await call("browser.press", { tabId: tab.id, key: "Tab" });
  stage("type-ready");

  const staleSnapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const staleRunButton = staleSnapshot.nodes.find((node) => node.name.includes("Run action"))!;
  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/history-a` });
  await assert.rejects(
    call("browser.inspect", {
      tabId: tab.id,
      sinceInspectionId: inspectionDelta.inspectionId,
      screenshot: { enabled: false },
    }),
    hasBrowserCode("INSPECTION_STALE"),
  );
  await assert.rejects(
    call("browser.click", {
      tabId: tab.id,
      ref: staleRunButton.ref,
      snapshotId: staleSnapshot.snapshotId,
      generation: staleSnapshot.generation,
    }),
    hasBrowserCode("STALE_ELEMENT_REF"),
  );
  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/history-b` });
  const backResult = (await call("browser.back", { tabId: tab.id })) as { url: string };
  assert.match(backResult.url, /\/history-a$/);
  const forwardResult = (await call("browser.forward", { tabId: tab.id })) as { url: string };
  assert.match(forwardResult.url, /\/history-b$/);
  const reloadResult = (await call("browser.reload", { tabId: tab.id })) as { url: string };
  assert.match(reloadResult.url, /\/history-b$/);

  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/spa` });
  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const spaButton = snapshot.nodes.find((node) => node.name.includes("Change route"))!;
  const spaClickResult = (await call("browser.click", {
    tabId: tab.id,
    ref: spaButton.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
  })) as BrowserClickResult;
  assert.equal(spaClickResult.navigation?.kind, "same-tab");
  assert.equal(spaClickResult.navigation?.status, "completed");
  assert.match(spaClickResult.navigation?.url ?? "", /\/spa\/updated$/);
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "spa:updated", timeoutMs: 5_000 });
  assert.match(
    service.listTabs("fixture-session").find((candidate) => candidate.id === tab.id)!.url,
    /\/spa\/updated$/,
  );
  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/iframe` });
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "iframe:frame-content", timeoutMs: 5_000 });
  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/cross-iframe` });
  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const crossFrameButton = snapshot.nodes.find((node) => node.name.includes("Cross frame action"))!;
  assert.ok(crossFrameButton?.frameUrl?.startsWith(fixture.corsOrigin));
  await call("browser.click", {
    tabId: tab.id,
    ref: crossFrameButton.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
  });
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "cross-click:trusted", timeoutMs: 5_000 });
  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const crossFrameInput = snapshot.nodes.find((node) => node.name.includes("Cross frame input"))!;
  const crossType = (await call("browser.type", {
    tabId: tab.id,
    ref: crossFrameInput.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
    text: "跨框架🙂",
  })) as { inputPath: string };
  assert.equal(crossType.inputPath, "mixed-insert-text");
  const crossFrame = nativeViewFor(tab.id).webContents.mainFrame.frames.find((frame) =>
    frame.url.startsWith(fixture.corsOrigin),
  );
  assert.ok(crossFrame, "cross-origin input frame was not found");
  assert.deepEqual(
    await crossFrame.executeJavaScript(`(() => {
      const input = document.getElementById('cross-input');
      return { value: input?.value, focused: document.activeElement === input };
    })()`),
    { value: "跨框架🙂", focused: true },
  );
  await call("browser.wait", {
    tabId: tab.id,
    condition: "text",
    value: "cross-input:跨框架🙂:trusted",
    timeoutMs: 5_000,
  });
  stage("cross-frame-input-ready");
  await call("browser.navigate", { tabId: tab.id, url: fixture.origin });

  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const popupButton = snapshot.nodes.find((node) => node.name.includes("Open popup"))!;
  const popupClickResult = (await call("browser.click", {
    tabId: tab.id,
    ref: popupButton.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
  })) as BrowserClickResult;
  assert.equal(popupClickResult.navigation?.kind, "new-tab");
  assert.equal(popupClickResult.navigation?.status, "completed");
  await waitFor(
    () =>
      service!
        .listTabs("fixture-session")
        .some((candidate) => candidate.id !== tab.id && /\/popup$/.test(candidate.url)),
    "managed popup tab was not created or did not finish navigating",
  );
  const popupTab = service.listTabs("fixture-session").find((candidate) => candidate.id !== tab.id)!;
  assert.match(popupTab.url, /\/popup$/);
  const popupSnapshot = (await call("browser.snapshot", { tabId: popupTab.id })) as { text: string };
  assert.match(popupSnapshot.text, new RegExp(`referrer:${fixture.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await call("browser.close", { tabId: popupTab.id });

  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const failingPopupButton = snapshot.nodes.find((node) => node.name.includes("Open failing popup"))!;
  const failedPopupClickResult = (await call("browser.click", {
    tabId: tab.id,
    ref: failingPopupButton.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
  })) as BrowserClickResult;
  assert.equal(failedPopupClickResult.navigation?.kind, "new-tab");
  assert.equal(failedPopupClickResult.navigation?.status, "failed");
  assert.match(failedPopupClickResult.navigation?.error?.errorDescription ?? "", /ERR_|Failed to load URL/);
  if (failedPopupClickResult.navigation?.tabId) {
    await call("browser.close", { tabId: failedPopupClickResult.navigation.tabId });
  }

  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const mailLink = snapshot.nodes.find((node) => node.name.includes("Email fixture"))!;
  await call("browser.click", {
    tabId: tab.id,
    ref: mailLink.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
  });
  await waitFor(() => externalProtocolRequests === 1, "mailto request did not use local confirmation policy");

  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const pointerLockButton = snapshot.nodes.find((node) => node.name.includes("Request fullscreen"))!;
  await call("browser.click", {
    tabId: tab.id,
    ref: pointerLockButton.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
  });
  await waitFor(() => service!.getState().permissionRequests.length === 1, "fullscreen permission was not prompted");
  const permissionRequest = service.getState().permissionRequests[0]!;
  assert.equal(permissionRequest.permission, "fullscreen");
  service.respondPermission(permissionRequest.id, "deny");
  await waitFor(
    () => service!.getState().permissionRequests.length === 0 && permissionResolutions === 1,
    "permission resolution was not published",
  );
  assert.equal(permissionRequests, 1);

  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const downloadLink = snapshot.nodes.find((node) => node.name.includes("Download fixture"))!;
  await call("browser.click", {
    tabId: tab.id,
    ref: downloadLink.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
  });
  await waitFor(() => fs.existsSync(path.join(downloads, "fixture.txt")), "download did not complete");
  assert.equal(fs.readFileSync(path.join(downloads, "fixture.txt"), "utf8"), "download fixture");
  stage("download-ready");
  assert.ok(sensitiveApprovalRequests >= 2, "form submission and download must request sensitive-action approval");

  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const uploadInput = snapshot.nodes.find((node) => node.role === "file-upload")!;
  assert.ok(uploadInput);
  await call("browser.click", {
    tabId: tab.id,
    ref: uploadInput.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
  });
  assert.deepEqual(await service.chooseUploadFiles(tab.id), [uploadFile]);
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "uploaded:upload.txt", timeoutMs: 5_000 });
  assert.ok(sensitiveApprovalRequests >= 3, "file upload interaction must request sensitive-action approval");
  stage("upload-ready");

  const takeoverWaitOne = call("browser.wait", {
    tabId: tab.id,
    condition: "text",
    value: "never-present-takeover-one",
    timeoutMs: 30_000,
  });
  await waitFor(
    () => service!.listTabs("fixture-session").find((candidate) => candidate.id === tab.id)?.control === "agent",
    "Browser action did not start before local takeover",
  );
  const takeoverWaitTwo = call("browser.wait", {
    tabId: tab.id,
    condition: "text",
    value: "never-present-takeover-two",
    timeoutMs: 30_000,
  });
  const userCancellationResults = Promise.allSettled([takeoverWaitOne, takeoverWaitTwo]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await service.reload(tab.id);
  const userCancelledQueue = await userCancellationResults;
  for (const result of userCancelledQueue) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason?.code, "USER_TOOK_CONTROL");
  }

  const queuedWaitOne = call("browser.wait", {
    tabId: tab.id,
    condition: "text",
    value: "never-present-one",
    timeoutMs: 30_000,
  });
  await waitFor(
    () => service!.listTabs("fixture-session").find((candidate) => candidate.id === tab.id)?.control === "agent",
    "first queued Browser action did not start",
  );
  const queuedWaitTwo = call("browser.wait", {
    tabId: tab.id,
    condition: "text",
    value: "never-present-two",
    timeoutMs: 30_000,
  });
  const hostCancellationResults = Promise.allSettled([queuedWaitOne, queuedWaitTwo]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  service.onHostStopped();
  const cancelledQueue = await hostCancellationResults;
  assert.equal(
    cancelledQueue.every((result) => result.status === "rejected"),
    true,
  );
  for (const result of cancelledQueue) {
    if (result.status === "rejected") assert.equal(result.reason?.code, "CAPABILITY_LEASE_EXPIRED");
  }
  service.grantSession({ sessionId: "fixture-session", permission: "interact", source: "local" });

  const advancedPatch = {
    advancedBrowserMode: {
      enabled: true,
      persistence: "this-launch" as const,
      identityMode: "custom" as const,
      customUserAgentValue:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      customUserAgentPlatform: "PiFixtureOS",
      customUserAgentFullVersion: "142.0.0.0",
      certificateBypassDomains: ["127.0.0.1"],
      maxRequestsPerTab: 500,
      maxBodyBytesPerTab: 16 * 1024 * 1024,
      maxPerHost: 40,
    },
  };
  const advancedProof = await service.requestConfirmation("advanced-browser-mode", advancedPatch);
  assert.ok(advancedProof);
  service.updateSettings(advancedPatch, advancedProof!);
  service.grantSession({ sessionId: "fixture-session", permission: "advanced", source: "local" });

  const identityTab = (await call("browser.open", {
    url: `${fixture.origin}/identity?pass=first`,
    profileId: "temporary",
    activate: false,
  })) as { id: string };
  const identityProbe = (await call("browser.executeJavaScript", {
    tabId: identityTab.id,
    source: `(async () => ({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData?.brands ?? [],
      platform: navigator.userAgentData?.platform ?? '',
      high: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'wow64'
      ]) : {},
      server: globalThis.__serverIdentity
    }))()`,
  })) as {
    value?: {
      userAgent: string;
      brands: Array<{ brand: string; version: string }>;
      platform: string;
      high: { architecture?: string; bitness?: string; fullVersionList?: Array<{ brand: string; version: string }> };
      server: Record<string, string>;
    };
  };
  assert.equal(identityProbe.value?.userAgent, advancedPatch.advancedBrowserMode.customUserAgentValue);
  assert.equal(identityProbe.value?.platform, "PiFixtureOS");
  assert.ok(identityProbe.value?.brands.some(({ brand, version }) => brand === "Chromium" && version === "142"));
  assert.ok(
    identityProbe.value?.high.fullVersionList?.some(
      ({ brand, version }) => brand === "Chromium" && version === "142.0.0.0",
    ),
  );
  assert.equal(identityProbe.value?.high.architecture, "x86");
  assert.equal(identityProbe.value?.high.bitness, "64");
  assert.equal(identityProbe.value?.server["user-agent"], advancedPatch.advancedBrowserMode.customUserAgentValue);
  assert.equal(identityProbe.value?.server["sec-ch-ua-platform"], '"PiFixtureOS"');
  assert.match(identityProbe.value?.server["sec-ch-ua"] ?? "", /"Chromium";v="142"/);
  const initialNetwork = (await call("browser.networkList", {
    tabId: identityTab.id,
    urlPattern: "*identity*",
  })) as {
    requests: Array<{ requestId: string; resourceType: string; requestHeaders: Record<string, string> }>;
  };
  assert.ok(
    initialNetwork.requests.some(({ resourceType }) => resourceType.toLowerCase() === "document"),
    "the first document request must be captured behind the identity/network barrier",
  );
  assert.equal(
    initialNetwork.requests.some(({ requestHeaders }) =>
      Object.keys(requestHeaders).some((name) => name.toLowerCase() === "authorization"),
    ),
    false,
  );
  await call("browser.navigate", { tabId: identityTab.id, url: `${fixture.origin}/identity?pass=second` });
  const negotiatedIdentity = (await call("browser.executeJavaScript", {
    tabId: identityTab.id,
    source: "globalThis.__serverIdentity",
  })) as { value?: Record<string, string> };
  if (negotiatedIdentity.value?.["sec-ch-ua-arch"] !== undefined) {
    assert.equal(negotiatedIdentity.value["sec-ch-ua-arch"], '"x86"');
    assert.equal(negotiatedIdentity.value["sec-ch-ua-bitness"], '"64"');
  }
  stage("identity-network-barrier-ready");

  service.setBounds({ tabId: identityTab.id, rect: { x: 0, y: 0, width: 800, height: 600 } });
  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/phase9-visual-a` });
  await call("browser.navigate", { tabId: identityTab.id, url: `${fixture.origin}/phase9-visual-b` });
  const visualSnapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const visualNode = visualSnapshot.nodes.find((node) => node.name === "Phase 9 comparison box");
  assert.ok(visualNode, "visual fixture element was not available in the owned snapshot");
  const viewportShot = (await call("browser.screenshot", {
    tabId: tab.id,
    mode: "viewport",
    format: "png",
  })) as { width: number; height: number; mode: string; generation: number; base64: string };
  const fullPageShot = (await call("browser.screenshot", {
    tabId: tab.id,
    mode: "full-page",
    format: "jpeg",
    quality: 70,
  })) as typeof viewportShot;
  const elementShot = (await call("browser.screenshot", {
    tabId: tab.id,
    mode: "element",
    snapshotId: visualSnapshot.snapshotId,
    ref: visualNode!.ref,
    generation: visualSnapshot.generation,
    format: "png",
  })) as typeof viewportShot;
  assert.equal(viewportShot.mode, "viewport");
  assert.equal(fullPageShot.mode, "full-page");
  assert.equal(elementShot.mode, "element");
  assert.ok(fullPageShot.height > viewportShot.height, "full-page screenshot did not include the tall document");
  assert.ok(elementShot.width < viewportShot.width && elementShot.height < viewportShot.height);
  assert.equal(elementShot.generation, visualSnapshot.generation);
  const identicalVisual = (await call("browser.visualCompare", {
    left: { tabId: tab.id },
    right: { tabId: tab.id },
    mode: "viewport",
    includeDiff: true,
  })) as {
    dimensionsMatch: boolean;
    differenceRatio: number;
    differentPixels: number;
    diff?: { base64: string };
  };
  assert.equal(identicalVisual.dimensionsMatch, true);
  assert.equal(identicalVisual.differentPixels, 0);
  assert.equal(identicalVisual.differenceRatio, 0);
  assert.ok(identicalVisual.diff?.base64);
  service.activateTab(identityTab.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  service.activateTab(tab.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const changedVisual = (await call("browser.visualCompare", {
    left: { tabId: tab.id },
    right: { tabId: identityTab.id },
    mode: "viewport",
  })) as {
    dimensionsMatch: boolean;
    differenceRatio: number;
    regions: Array<{ width: number; height: number }>;
  };
  assert.equal(changedVisual.dimensionsMatch, true);
  assert.ok(changedVisual.differenceRatio > 0);
  assert.ok(changedVisual.regions.length > 0);
  stage("phase9-screenshot-compare-ready");

  service.activateTab(identityTab.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await call("browser.navigate", { tabId: identityTab.id, url: `${fixture.origin}/phase9-diagnostics` });
  await call("browser.wait", {
    tabId: identityTab.id,
    condition: "text",
    value: "phase9:failed-request-complete",
    timeoutMs: 5_000,
  });
  const consolePage = (await call("browser.consoleList", {
    tabId: identityTab.id,
    levels: ["error", "warning"],
    limit: 20,
  })) as {
    entries: Array<{ id: string; level: string; text: string; stack?: string; source: string }>;
  };
  assert.ok(consolePage.entries.some(({ level, text }) => level === "warning" && /phase9 warning/.test(text)));
  assert.ok(consolePage.entries.some(({ level, text }) => level === "error" && /phase9 error/.test(text)));
  assert.doesNotMatch(JSON.stringify(consolePage), /fixture-console-secret/);
  const consoleCursor = consolePage.entries.at(-1)?.id;
  assert.ok(consoleCursor);
  await call("browser.executeJavaScript", {
    tabId: identityTab.id,
    source: "setTimeout(() => console.warn('phase9 delayed warning'), 100); true",
  });
  const waitedConsole = (await call("browser.consoleWait", {
    tabId: identityTab.id,
    after: consoleCursor,
    levels: ["warning"],
    timeoutMs: 5_000,
  })) as { level: string; text: string };
  assert.equal(waitedConsole.level, "warning");
  assert.match(waitedConsole.text, /phase9 delayed warning/);
  const networkSummary = (await call("browser.networkSummary", {
    tabId: identityTab.id,
    failureLimit: 5,
    recentLimit: 10,
  })) as {
    total: number;
    byStatusClass: Record<string, number>;
    recent: Array<{ url: string; status?: number }>;
  };
  assert.ok(networkSummary.total >= 2);
  assert.ok((networkSummary.byStatusClass["5xx"] ?? 0) >= 1);
  assert.doesNotMatch(JSON.stringify(networkSummary), /fixture-network-secret/);
  const failedNetwork = (await call("browser.networkList", {
    tabId: identityTab.id,
    status: 503,
    limit: 5,
  })) as { requests: Array<{ status?: number; url: string }> };
  assert.ok(failedNetwork.requests.some(({ status }) => status === 503));
  assert.doesNotMatch(JSON.stringify(failedNetwork), /fixture-network-secret/);
  service.activateTab(tab.id);
  stage("phase9-console-network-summary-ready");

  const js = (await call("browser.executeJavaScript", { tabId: tab.id, source: "Promise.resolve(2 + 2)" })) as {
    value?: unknown;
    exception?: string;
  };
  assert.equal(js.value, 4);
  await assert.rejects(
    call("browser.executeJavaScript", {
      tabId: tab.id,
      source: "throw new Error('fixture-js-error')",
    }),
    (error: unknown) => {
      if (!hasBrowserCode("JAVASCRIPT_EXECUTION_FAILED")(error)) return false;
      const value = error as {
        retryable?: unknown;
        recovery?: { remediation?: unknown };
        details?: { exception?: unknown };
      };
      assert.equal(value.retryable, false);
      assert.equal(value.recovery?.remediation, "change-input");
      assert.match(String(value.details?.exception ?? ""), /fixture-js-error/);
      return true;
    },
  );
  await assert.rejects(
    call("browser.executeJavaScript", {
      tabId: tab.id,
      source: "new Promise(() => {})",
      timeoutMs: 75,
    }),
    hasBrowserCode("JAVASCRIPT_TIMEOUT"),
  );
  const recoveredJs = (await call("browser.executeJavaScript", { tabId: tab.id, source: "21 * 2" })) as {
    value?: unknown;
  };
  assert.equal(recoveredJs.value, 42);
  await assert.rejects(
    call("browser.executeJavaScript", { tabId: tab.id, source: "'x'.repeat(2200000)" }),
    hasBrowserCode("RESULT_TOO_LARGE"),
  );
  await call("browser.executeJavaScript", {
    tabId: tab.id,
    source: "globalThis.piIsolatedFixture = 7",
    world: "isolated",
  });
  const mainWorldIsolation = (await call("browser.executeJavaScript", {
    tabId: tab.id,
    source: "typeof globalThis.piIsolatedFixture",
  })) as { value?: unknown };
  assert.equal(mainWorldIsolation.value, "undefined");
  const remembered = (await call("browser.executeJavaScript", {
    tabId: identityTab.id,
    source: "document.title",
    purpose: "Read the identity fixture title",
    remember: true,
  })) as { snippetId?: string };
  assert.match(remembered.snippetId ?? "", /^[0-9a-f-]{36}$/i);
  const snippetList = (await call("browser.pageCodeList", { tabId: identityTab.id })) as {
    snippets: Array<Record<string, unknown>>;
    siteCount: number;
  };
  assert.equal(snippetList.siteCount, 1);
  assert.equal("code" in snippetList.snippets[0]!, false);
  const snippet = (await call("browser.pageCodeGet", {
    tabId: identityTab.id,
    snippetId: remembered.snippetId,
    maxChars: 4_000,
  })) as { code: string };
  assert.equal(snippet.code, "document.title");
  service.setPageSnippetEnabled(remembered.snippetId!, false);
  assert.equal(((await call("browser.pageCodeList", { tabId: identityTab.id })) as { siteCount: number }).siteCount, 0);
  service.setPageSnippetEnabled(remembered.snippetId!, true);
  await assert.rejects(
    call("browser.executeJavaScript", {
      tabId: identityTab.id,
      source: "const localFile = '/Users/fixture/private.txt'; document.title",
      purpose: "Unsafe local path fixture",
      remember: true,
    }),
    hasBrowserCode("PERMISSION_DENIED"),
  );
  assert.equal(service.listPageSnippets().length, 1);
  const experienceOpen = (await call("browser.open", {
    url: `${fixture.origin}/identity?pass=experience-count`,
    profileId: "temporary",
    activate: false,
  })) as { id: string; siteSnippetCount: number };
  assert.equal(experienceOpen.siteSnippetCount, 1);
  await call("browser.close", { tabId: experienceOpen.id });
  stage("snippet-library-ready");
  await call("browser.navigate", { tabId: tab.id, url: fixture.origin });
  const actionPoint = (await call("browser.executeJavaScript", {
    tabId: tab.id,
    source: `(() => { const rect = document.getElementById('action').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`,
  })) as { value?: { x: number; y: number } };
  assert.ok(actionPoint.value);
  await call("browser.clickAt", {
    tabId: tab.id,
    x: actionPoint.value!.x,
    y: actionPoint.value!.y,
    modifiers: ["shift"],
  });
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "clicked:trusted", timeoutMs: 5_000 });
  await call("browser.scroll", { tabId: tab.id, deltaY: 600 });
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "wheel:trusted", timeoutMs: 5_000 });
  snapshot = (await call("browser.snapshot", { tabId: tab.id })) as typeof snapshot;
  const takeoverInput = snapshot.nodes.find((node) => node.name.includes("Your name"))!;
  const interruptedTyping = call("browser.type", {
    tabId: tab.id,
    ref: takeoverInput.ref,
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
    text: "x".repeat(200),
  }).then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  await waitFor(
    () => service!.listTabs("fixture-session").find((candidate) => candidate.id === tab.id)?.control === "agent",
    "trusted typing did not start before user takeover",
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  await service.reload(tab.id);
  const interruptedTypingResult = await interruptedTyping;
  assert.equal(interruptedTypingResult.status, "rejected");
  if (interruptedTypingResult.status === "rejected") {
    assert.equal((interruptedTypingResult.error as { code?: string })?.code, "USER_TOOK_CONTROL");
  }
  assert.equal(await nativeViewFor(tab.id).webContents.executeJavaScript("document.getElementById('name').value"), "");
  stage("trusted-coordinate-scroll-ready");
  stage("advanced-js-ready");
  await assert.rejects(
    call("browser.setCookies", {
      profileId: "temporary",
      cookies: [],
    }),
    hasBrowserCode("SENSITIVE_RESULT_UNAVAILABLE"),
  );
  await assert.rejects(
    call("browser.getCookies", { profileId: "temporary", scope: "current-site" }),
    hasBrowserCode("SENSITIVE_RESULT_UNAVAILABLE"),
  );
  stage("cookie-gate-ready");

  await call("browser.setRequestHeaderRules", {
    profileId: "temporary",
    rules: [
      {
        id: "fixture-rule",
        enabled: true,
        profileId: "temporary",
        urlPattern: `${fixture.origin}/*`,
        header: "x-pi-test",
        operation: "set",
        value: "observed",
      },
    ],
  });
  const authSecretRef = service.storeHeaderSecret("Bearer fixture-secret-value");
  service.setLocalHeaderRules("temporary", "request", [
    {
      id: "fixture-rule",
      enabled: true,
      profileId: "temporary",
      urlPattern: `${fixture.origin}/*`,
      header: "x-pi-test",
      operation: "set",
      value: "observed",
    },
    {
      id: "fixture-auth-rule",
      enabled: true,
      profileId: "temporary",
      urlPattern: `${fixture.origin}/*`,
      header: "authorization",
      operation: "set",
      secretRef: authSecretRef,
    },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/headers` });
  const headerSnapshot = (await call("browser.snapshot", { tabId: tab.id })) as { text: string };
  assert.match(headerSnapshot.text, /header:observed/);
  assert.match(headerSnapshot.text, /auth:Bearer fixture-secret-value/);
  assert.match(headerSnapshot.text, /ua:Mozilla\/5\.0 .*Chrome\/142\.0\.0\.0/);
  const clientHintPlatform = (await call("browser.executeJavaScript", {
    tabId: tab.id,
    source: "navigator.userAgentData?.platform ?? 'unavailable'",
  })) as { value?: unknown };
  assert.equal(clientHintPlatform.value, "PiFixtureOS");
  await call("browser.setResponseHeaderRules", {
    profileId: "temporary",
    rules: [
      {
        id: "fixture-response-rule",
        enabled: true,
        profileId: "temporary",
        urlPattern: `${fixture.origin}/*`,
        header: "x-pi-response",
        operation: "set",
        value: "observed",
      },
    ],
  });
  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/response-header` });
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "response:observed", timeoutMs: 5_000 });
  const cdp = (await call("browser.sendCdpCommand", {
    tabId: tab.id,
    method: "Runtime.evaluate",
    commandParams: { expression: "6 * 7", returnByValue: true },
  })) as { result?: { value?: unknown } };
  assert.equal(cdp.result?.value, 42);
  const releasedCdpObject = (await call("browser.sendCdpCommand", {
    tabId: tab.id,
    method: "Runtime.evaluate",
    commandParams: { expression: "({fixture: true})", returnByValue: false },
  })) as { result?: { objectId?: string } };
  assert.equal(releasedCdpObject.result?.objectId, "<released>");
  await assert.rejects(
    call("browser.sendCdpCommand", {
      tabId: tab.id,
      method: "Runtime.evaluate",
      commandParams: { expression: "'x'.repeat(2200000)", returnByValue: true },
    }),
    hasBrowserCode("RESULT_TOO_LARGE"),
  );
  stage("header-cdp-ready");
  const targets = (await call("browser.sendCdpCommand", {
    tabId: tab.id,
    method: "Target.getTargets",
  })) as { targetInfos?: unknown[] };
  assert.ok(Array.isArray(targets.targetInfos));

  await call("browser.navigate", { tabId: identityTab.id, url: `${fixture.origin}/network` });
  await call("browser.wait", {
    tabId: identityTab.id,
    condition: "text",
    value: "network:true",
    timeoutMs: 5_000,
  });
  const initialApiRequest = (await call("browser.networkWait", {
    tabId: identityTab.id,
    urlPattern: "*case=initial*",
    timeoutMs: 5_000,
  })) as {
    requestId: string;
    url: string;
    requestHeaders: Record<string, string>;
    bodyAvailable: boolean;
  };
  assert.doesNotMatch(initialApiRequest.url, /fixture-secret/);
  assert.equal(
    Object.keys(initialApiRequest.requestHeaders).some((name) => name.toLowerCase() === "authorization"),
    false,
  );
  const initialApiBody = (await call("browser.networkBody", {
    tabId: identityTab.id,
    networkRequestId: initialApiRequest.requestId,
    full: true,
  })) as { data: string; untrustedWebContent: boolean };
  assert.match(initialApiBody.data, /"ok":true/);
  assert.equal(initialApiBody.untrustedWebContent, true);
  const getCountBeforeReplay = replayRequestCounts.get("GET") ?? 0;
  const getReplay = (await call("browser.networkReplay", {
    tabId: identityTab.id,
    networkRequestId: initialApiRequest.requestId,
    reason: "Verify explicit GET replay",
  })) as { request: { replayedFrom?: string; requestId: string } };
  assert.equal(getReplay.request.replayedFrom, initialApiRequest.requestId);
  assert.equal(replayRequestCounts.get("GET"), getCountBeforeReplay + 1);

  const replayableMethods = ["HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
  for (const method of replayableMethods) {
    const requestUrl = `${fixture.origin}/api/replay?case=${method.toLowerCase()}-original`;
    const payload = `payload-${method}`;
    await call("browser.executeJavaScript", {
      tabId: identityTab.id,
      source: `fetch(${JSON.stringify(requestUrl)}, {
        method: ${JSON.stringify(method)},
        headers: { 'content-type': 'text/plain' },
        ${method === "HEAD" ? "" : `body: ${JSON.stringify(payload)},`}
        cache: 'no-store'
      }).then(response => response.text()).catch(() => '')`,
    });
    const captured = (await call("browser.networkWait", {
      tabId: identityTab.id,
      urlPattern: `*case=${method.toLowerCase()}-original*`,
      timeoutMs: 5_000,
    })) as { requestId: string; method: string; requestHeaders: Record<string, string> };
    assert.equal(captured.method, method);
    assert.equal(
      Object.keys(captured.requestHeaders).some((name) => name.toLowerCase() === "authorization"),
      false,
    );
    const countBeforeReplay = replayRequestCounts.get(method) ?? 0;
    if (method === "POST") {
      allowSensitiveApproval = false;
      await assert.rejects(
        call("browser.networkReplay", {
          tabId: identityTab.id,
          networkRequestId: captured.requestId,
          reason: "Declined write replay fixture",
        }),
        hasBrowserCode("PERMISSION_DENIED"),
      );
      assert.equal(replayRequestCounts.get(method), countBeforeReplay, "declined replay must send zero requests");
      allowSensitiveApproval = true;
    }
    const replayed = (await call("browser.networkReplay", {
      tabId: identityTab.id,
      networkRequestId: captured.requestId,
      reason: `Confirm one ${method} replay`,
    })) as { request: { replayedFrom?: string } };
    assert.equal(replayed.request.replayedFrom, captured.requestId);
    assert.equal(replayRequestCounts.get(method), countBeforeReplay + 1);
    if (method !== "HEAD" && method !== "DELETE") assert.equal(replayRequestBodies.get(method), payload);
  }
  await call("browser.executeJavaScript", {
    tabId: identityTab.id,
    source: "fetch('/api/cross-redirect').catch(() => undefined)",
  });
  const redirectRequest = (await call("browser.networkWait", {
    tabId: identityTab.id,
    urlPattern: "*/api/cross-redirect*",
    timeoutMs: 5_000,
  })) as { requestId: string };
  await assert.rejects(
    call("browser.networkReplay", {
      tabId: identityTab.id,
      networkRequestId: redirectRequest.requestId,
      reason: "Cross-origin redirect must remain blocked",
    }),
    hasBrowserCode("REQUEST_REPLAY_BLOCKED"),
  );
  stage("network-replay-ready");

  service.onHostStopped();
  await waitFor(
    () =>
      service!.getRedactedDiagnostics().attachedDebuggerCount === 0 &&
      service!.getRedactedDiagnostics().capturedRequestCount === 0,
    "Host revoke did not release advanced Browser CDP and network state",
  );
  service.grantSession({ sessionId: "fixture-session", permission: "advanced", source: "local" });
  await call("browser.navigate", {
    tabId: identityTab.id,
    url: `${fixture.origin}/identity?pass=after-host-restart`,
  });
  const resumedCapture = (await call("browser.networkList", {
    tabId: identityTab.id,
    urlPattern: "*identity*",
  })) as { requests: Array<{ resourceType: string }> };
  assert.ok(
    resumedCapture.requests.some(({ resourceType }) => resourceType.toLowerCase() === "document"),
    "advanced Browser state did not resume after a new advanced lease",
  );
  stage("advanced-host-revoke-ready");

  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/csp` });
  const normalCspSnapshot = (await call("browser.snapshot", { tabId: tab.id })) as { text: string };
  assert.match(normalCspSnapshot.text, /blocked/);
  await call("browser.navigate", { tabId: tab.id, url: `${fixture.origin}/cors` });
  await call("browser.wait", { tabId: tab.id, condition: "text", value: "cors:blocked", timeoutMs: 5_000 });
  await assert.rejects(call("browser.navigate", { tabId: tab.id, url: fixture.secureOrigin }), (error: unknown) => {
    if (!hasBrowserCode("NAVIGATION_FAILED")(error)) return false;
    const browserError = error as BrowserError;
    assert.equal(browserError.recovery.reason, "unsupported");
    assert.equal(browserError.recovery.remediation, "ask-user");
    assert.match(String(browserError.details?.netError ?? ""), /CERT_/);
    return true;
  });

  const unrestrictedNormal = (await call("browser.sendCdpCommand", {
    tabId: tab.id,
    method: "Browser.getVersion",
  })) as { product?: string };
  assert.match(unrestrictedNormal.product ?? "", /Chrome/);
  const advancedProfile = service.createProfile({ name: "Advanced fixture", mode: "unsafe" });
  const advancedTab = await service.createUserTab({
    profileId: advancedProfile.id,
    ownerSessionId: "fixture-session",
    url: fixture.origin,
  });
  service.grantSession({ sessionId: "fixture-session", permission: "advanced", source: "local" });
  const unrestricted = (await call("browser.sendCdpCommand", {
    tabId: advancedTab.id,
    method: "Browser.getVersion",
  })) as { product?: string };
  assert.match(unrestricted.product ?? "", /Chrome/);
  await call("browser.navigate", { tabId: advancedTab.id, url: `${fixture.origin}/csp` });
  const advancedCspSnapshot = (await call("browser.snapshot", { tabId: advancedTab.id })) as { text: string };
  assert.match(advancedCspSnapshot.text, /executed/);
  await call("browser.navigate", { tabId: advancedTab.id, url: `${fixture.origin}/cors` });
  await call("browser.wait", {
    tabId: advancedTab.id,
    condition: "text",
    value: "cors:allowed",
    timeoutMs: 5_000,
  });
  await call("browser.navigate", { tabId: advancedTab.id, url: fixture.secureOrigin });
  const advancedCertificateSnapshot = (await call("browser.snapshot", { tabId: advancedTab.id })) as { text: string };
  assert.match(advancedCertificateSnapshot.text, /certificate:allowed/);
  const advancedContents = webContents
    .getAllWebContents()
    .find((candidate) => candidate.getURL().startsWith(fixture.secureOrigin));
  assert.ok(advancedContents, "advanced renderer WebContents was not found");
  advancedContents.forcefullyCrashRenderer();
  await waitFor(
    () => service!.listTabs().some((candidate) => candidate.id === advancedTab.id && candidate.crashed),
    "advanced renderer crash was not reported",
  );
  stage("advanced-profile-ready");

  service.updateSettings({ navigation: { networkIsolation: "strict" } });
  await assert.rejects(service.navigateUser(tab.id, fixture.origin), hasBrowserCode("NETWORK_ISOLATION_UNAVAILABLE"));
  service.updateSettings({ navigation: { networkIsolation: "best-effort" } });

  service.updateSettings({ advancedBrowserMode: { enabled: false } });
  assert.equal(service.getSettings().runtime.advancedBrowserModeEnabled, false);
  assert.equal(
    service.listTabs().some((candidate) => candidate.id === advancedTab.id),
    false,
  );
  await waitFor(
    () => service!.getRedactedDiagnostics().attachedDebuggerCount === 0,
    "debugger sessions were not released after Advanced was disabled",
  );
  assert.equal(service.getRedactedDiagnostics().capturedRequestCount, 0);
  const revokedCapabilities = (await service.handleHostRequest("browser.capabilities", {
    sessionId: "fixture-session",
  })) as { snapshot: { revision: number }; lease?: { id: string } };
  const callAfterAdvancedRevoke = (
    method: "browser.networkList" | "browser.networkSummary" | "browser.consoleList" | "browser.pageCodeList",
  ) =>
    service!.handleHostRequest(method, {
      tabId: identityTab.id,
      sessionId: "fixture-session",
      capabilityLeaseId: revokedCapabilities.lease?.id ?? "revoked-advanced-lease",
      policyRevision: revokedCapabilities.snapshot.revision,
      requestId: `${method}-after-advanced-revoke`,
    });
  await assert.rejects(callAfterAdvancedRevoke("browser.networkList"), hasBrowserCode("CAPABILITY_LEASE_EXPIRED"));
  await assert.rejects(callAfterAdvancedRevoke("browser.networkSummary"), hasBrowserCode("CAPABILITY_LEASE_EXPIRED"));
  await assert.rejects(callAfterAdvancedRevoke("browser.consoleList"), hasBrowserCode("CAPABILITY_LEASE_EXPIRED"));
  await assert.rejects(callAfterAdvancedRevoke("browser.pageCodeList"), hasBrowserCode("CAPABILITY_LEASE_EXPIRED"));
  await service.navigateUser(identityTab.id, `${fixture.origin}/identity?pass=after-disable`);
  const restoredNativeUa = await nativeViewFor(identityTab.id).webContents.executeJavaScript("navigator.userAgent");
  assert.notEqual(restoredNativeUa, advancedPatch.advancedBrowserMode.customUserAgentValue);
  stage("advanced-revoke-cleanup-ready");

  service.setProxyCredentials({ username: "proxy-user", password: "proxy-password" });
  service.updateSettings({
    proxy: { mode: "custom", proxyRules: proxy.rules, proxyBypassRules: "<-loopback>" },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await service.navigateUser(tab.id, `${fixture.origin}/proxy-check`);
  assert.ok(proxyAuthenticatedRequests > 0, "custom proxy credentials must answer a 407 challenge");
  const vaultText = fs.readFileSync(path.join(app.getPath("userData"), "browser-secrets.json"), "utf8");
  assert.doesNotMatch(vaultText, /proxy-user|proxy-password/);
  service.updateSettings({ proxy: { mode: "direct" } });

  const persistent = service.createProfile({ name: "Persistent fixture", mode: "persistent" });
  const persistentTab = await service.createUserTab({
    profileId: persistent.id,
    url: `${fixture.origin}/set-persistent-cookie`,
    ownerSessionId: "fixture-session",
    activate: false,
  });
  await service.navigateUser(persistentTab.id, `${fixture.origin}/cookie-check`);
  await service.navigateUser(tab.id, `${fixture.origin}/cookie-check`);
  await service.dispose();
  service = new BrowserService({
    userDataDir: app.getPath("userData"),
    getWindow: () => mainWindow,
    confirm: async () => true,
    confirmSensitiveAction: async () => true,
    confirmExternalProtocol: async () => false,
    confirmPrivateNetwork: async () => true,
    chooseSavePath: async (filename) => path.join(downloads, filename),
    chooseUploadPaths: async () => [uploadFile],
  });
  await service.restoreTabs();
  const restoredPersistent = service.listTabs().find((candidate) => candidate.profileId === persistent.id);
  assert.ok(restoredPersistent);
  service.grantSession({ sessionId: "fixture-session", permission: "read", source: "local" });
  const restoredCall = async (tabId: string) => {
    const capabilities = (await service!.handleHostRequest("browser.capabilities", {
      sessionId: "fixture-session",
    })) as { snapshot: { revision: number }; lease: { id: string } };
    return service!.handleHostRequest("browser.snapshot", {
      tabId,
      sessionId: "fixture-session",
      capabilityLeaseId: capabilities.lease.id,
      policyRevision: capabilities.snapshot.revision,
      requestId: `restored-snapshot-${tabId}`,
    }) as Promise<{ text: string }>;
  };
  assert.match((await restoredCall(restoredPersistent!.id)).text, /persistent_cookie=kept/);
  const restoredTemporary = service.listTabs().find((candidate) => candidate.profileId === "temporary");
  assert.ok(restoredTemporary);
  assert.doesNotMatch((await restoredCall(restoredTemporary!.id)).text, /fixture=cookie-value/);
  stage("restore-ready");
  assert.equal(
    service
      .listTabs()
      .some((candidate) => service!.listProfiles().find((p) => p.id === candidate.profileId)?.mode === "unsafe"),
    false,
  );
  service.closeAllTabs();
  assert.equal(service.listTabs().length, 0);

  console.log("OK: Browser Electron integration passed");
}

void app.whenReady().then(async () => {
  try {
    await run();
    await service?.dispose();
    mainWindow?.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => corsServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => secureServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => proxyServer?.close(() => resolve()) ?? resolve());
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    try {
      await service?.dispose();
    } catch {
      // Best effort teardown after test failure.
    }
    mainWindow?.destroy();
    server?.close();
    corsServer?.close();
    secureServer?.close();
    proxyServer?.close();
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(1);
  }
});
