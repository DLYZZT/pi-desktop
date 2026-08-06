#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserRoot = path.join(root, "src/renderer/components/browser");
const i18nPath = path.join(root, "src/renderer/i18n.ts");
const browserFiles = fs
  .readdirSync(browserRoot)
  .filter((name) => name.endsWith(".tsx"))
  .map((name) => path.join(browserRoot, name));
const failures = [];
const browserFallbacks = new Map();

for (const file of browserFiles) {
  const sourceText = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  walk(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "t" &&
      node.arguments.length >= 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith("browser")
    ) {
      const fallback = node.arguments[1];
      if (!ts.isStringLiteralLike(fallback)) {
        failures.push(
          `${path.relative(root, file)}:${lineOf(source, node)} ${node.arguments[0].text} has no static fallback`,
        );
        return;
      }
      const previous = browserFallbacks.get(node.arguments[0].text);
      if (previous !== undefined && previous !== fallback.text) {
        failures.push(`${node.arguments[0].text} uses inconsistent English fallbacks`);
      }
      browserFallbacks.set(node.arguments[0].text, fallback.text);
    }
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (/[A-Za-z]/.test(text) && !isAllowedProductLiteral(text)) {
        failures.push(`${path.relative(root, file)}:${lineOf(source, node)} visible English JSX literal: ${text}`);
      }
    }
  });
  for (const forbidden of ["Unsafe Lab", "不安全 Profile", "高级 / 不安全", "New unsafe Profile"]) {
    if (sourceText.includes(forbidden)) {
      failures.push(`${path.relative(root, file)} contains retired Browser terminology: ${forbidden}`);
    }
  }
}

const zh = readZhDictionary();
for (const [key, fallback] of browserFallbacks) {
  const translated = zh.get(key);
  if (translated === undefined) {
    failures.push(`zh-CN is missing ${key}`);
    continue;
  }
  const expected = placeholders(fallback);
  const actual = placeholders(translated);
  if (expected.join(",") !== actual.join(",")) {
    failures.push(`${key} placeholder mismatch: en=[${expected}] zh-CN=[${actual}]`);
  }
}

if (failures.length) {
  console.error(`[browser-i18n] ${failures.length} invariant(s) failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[browser-i18n] ${browserFallbacks.size} Browser keys have zh-CN parity and safe visible literals`);

function readZhDictionary() {
  const sourceText = fs.readFileSync(i18nPath, "utf8");
  const source = ts.createSourceFile(i18nPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = new Map();
  walk(source, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== "zhCN" ||
      !node.initializer ||
      !ts.isObjectLiteralExpression(node.initializer)
    ) {
      return;
    }
    for (const property of node.initializer.properties) {
      if (!ts.isPropertyAssignment(property) || !property.name || !ts.isStringLiteralLike(property.initializer)) {
        continue;
      }
      const key =
        ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
      if (key) result.set(key, property.initializer.text);
    }
  });
  return result;
}

function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function placeholders(value) {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]).sort();
}

function isAllowedProductLiteral(value) {
  return /^(?:Electron|Chromium|CDP|JavaScript|Profile|User-Agent|Client Hints)(?:\s+.*)?$/.test(value);
}
