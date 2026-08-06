#!/usr/bin/env node
/**
 * Assert every Api method has a host handler registration.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiTs = fs.readFileSync(path.join(root, "src/contract/api.ts"), "utf8");
const handlersTs = fs.readFileSync(path.join(root, "src/agent-host/handlers.ts"), "utf8");
const desktopTs = fs.readFileSync(path.join(root, "src/contract/desktop.ts"), "utf8");
const preloadTs = fs.readFileSync(path.join(root, "src/preload/preload.ts"), "utf8");
const ipcTs = fs.readFileSync(path.join(root, "src/main/ipc.ts"), "utf8");
const browserTs = fs.readFileSync(path.join(root, "src/contract/browser.ts"), "utf8");
const browserServiceTs = fs.readFileSync(path.join(root, "src/main/browser/browser-service.ts"), "utf8");
const mainTs = fs.readFileSync(path.join(root, "src/main/main.ts"), "utf8");

const apiSource = ts.createSourceFile("api.ts", apiTs, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const handlersSource = ts.createSourceFile("handlers.ts", handlersTs, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const apiInterface = apiSource.statements.find(
  (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === "Api",
);
if (!apiInterface || !ts.isInterfaceDeclaration(apiInterface)) {
  console.error("Could not find Api interface");
  process.exit(1);
}

const methods = apiInterface.members.flatMap((member) => {
  if (!ts.isPropertySignature(member) || !member.name) return [];
  if (ts.isStringLiteral(member.name) || ts.isIdentifier(member.name)) return [member.name.text];
  return [];
});

const registered = [];
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "handle" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "server"
  ) {
    const [argument] = node.arguments;
    if (argument && ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) {
        if (
          (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
          (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))
        ) {
          registered.push(property.name.text);
        }
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(handlersSource);

const registeredSet = new Set(registered);
const missing = methods.filter((method) => !registeredSet.has(method));
const duplicates = registered.filter((method, index) => registered.indexOf(method) !== index);
const unknown = registered.filter((method) => !methods.includes(method));

if (missing.length) {
  console.error("Missing host handlers for:", missing.join(", "));
  process.exit(1);
}
if (duplicates.length) {
  console.error("Duplicate host handlers:", [...new Set(duplicates)].join(", "));
  process.exit(1);
}
if (unknown.length) {
  console.error("Handlers missing from Api contract:", unknown.join(", "));
  process.exit(1);
}

const piBridgeBody = desktopTs.slice(desktopTs.indexOf("export interface PiBridge"));
const browserBridgeMethods = [...piBridgeBody.matchAll(/^\s+(browser[A-Z]\w*):/gm)].map((match) => match[1]);
const missingPreloadMethods = browserBridgeMethods.filter((method) => !preloadTs.includes(`${method}:`));
if (missingPreloadMethods.length) {
  console.error("Missing Browser preload methods for:", missingPreloadMethods.join(", "));
  process.exit(1);
}

const browserInvokeChannels = [...preloadTs.matchAll(/ipcRenderer\.invoke\("(desktop:browser:[^"]+)"/g)].map(
  (match) => match[1],
);
const registeredBrowserIpcChannels = new Set(
  [...ipcTs.matchAll(/browserHandler\(\s*"(desktop:browser:[^"]+)"/g)].map((match) => match[1]),
);
const missingBrowserIpcHandlers = browserInvokeChannels.filter((channel) => !registeredBrowserIpcChannels.has(channel));
if (missingBrowserIpcHandlers.length) {
  console.error("Missing Browser IPC handlers for:", missingBrowserIpcHandlers.join(", "));
  process.exit(1);
}
if (!preloadTs.includes("onBrowserEvent:") || !mainTs.includes('webContents.send("browser:event"')) {
  console.error("Browser event bridge is incomplete");
  process.exit(1);
}

const browserMethodSetBody = browserTs.slice(
  browserTs.indexOf("export const BROWSER_HOST_METHODS"),
  browserTs.indexOf("]);", browserTs.indexOf("export const BROWSER_HOST_METHODS")) + 3,
);
const browserHostMethods = [...browserMethodSetBody.matchAll(/"(browser\.[A-Za-z]+)"/g)].map((match) => match[1]);
const missingBrowserDispatch = browserHostMethods.filter(
  (method) => !browserServiceTs.includes(`case "${method}"`) && !browserServiceTs.includes(`method === "${method}"`),
);
if (missingBrowserDispatch.length) {
  console.error("Missing Browser Host dispatch cases for:", missingBrowserDispatch.join(", "));
  process.exit(1);
}
if (new Set(browserInvokeChannels).size !== browserInvokeChannels.length) {
  console.error("Duplicate Browser IPC channels in preload");
  process.exit(1);
}
if (new Set(browserHostMethods).size !== browserHostMethods.length) {
  console.error("Duplicate Browser Host methods in contract");
  process.exit(1);
}

console.log(
  `OK: ${methods.length} Api handlers, ${browserBridgeMethods.length} Browser bridge methods, and ${browserHostMethods.length} Browser Host methods are covered`,
);
