#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const main = read("src/main/main.ts");
const protocol = read("src/main/protocol.ts");
const html = read("src/renderer/index.html");
const preload = read("src/preload/preload.ts");
const globals = read("src/renderer/global.d.ts");
const diagnostics = read("src/main/diagnostics.ts");
const fileViewer = read("src/renderer/components/FileViewer.tsx");
const rendererCsp = protocol.slice(
  protocol.indexOf("const CSP ="),
  protocol.indexOf("const HTML_PREVIEW_CSP ="),
);

const checks = [
  [main.includes("sandbox: true"), "BrowserWindow sandbox must remain enabled"],
  [main.includes("contextIsolation: true"), "context isolation must remain enabled"],
  [main.includes("nodeIntegration: false"), "renderer Node integration must remain disabled"],
  [main.includes("crashReporter.start"), "local crash reporting must be started"],
  [main.includes("setOverlayIcon"), "Windows taskbar overlay badges must remain implemented"],
  [diagnostics.includes('app.getPath("crashDumps")'), "diagnostic export must include local crash dumps"],
  [!/script-src[^;]*unsafe-inline/.test(rendererCsp), "renderer script-src must not allow unsafe-inline"],
  [fileViewer.includes('sandbox="allow-scripts"'), "HTML previews must remain sandboxed"],
  [protocol.includes('"object-src \'none\'; "') && protocol.includes('"form-action \'none\'"'), "HTML preview CSP must block plugins and forms"],
  [!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "renderer HTML must not contain inline scripts"],
  [preload.includes('../contract/desktop'), "preload must use the shared desktop bridge contract"],
  [globals.includes('../contract/desktop'), "renderer globals must use the shared desktop bridge contract"],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`OK: ${checks.length} desktop security invariants hold`);
