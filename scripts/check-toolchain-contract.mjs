#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const typesPath = path.join(root, "src/shared/toolchains/types.ts");
const desktopPath = path.join(root, "src/contract/desktop.ts");
const typesText = fs.readFileSync(typesPath, "utf8");
const desktopText = fs.readFileSync(desktopPath, "utf8");
const source = ts.createSourceFile(typesPath, typesText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const actionAlias = source.statements.find(
  (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === "ToolchainActionRequest",
);
if (!actionAlias || !ts.isTypeAliasDeclaration(actionAlias) || !ts.isUnionTypeNode(actionAlias.type)) {
  console.error("FAIL: ToolchainActionRequest must be an explicit union type");
  process.exit(1);
}

const allowedProperties = new Set(["action", "profileId", "componentId", "capability", "preference", "cacheId"]);
const forbiddenPattern = /(?:url|uri|sha|hash|path|executable|argv|command|extract|destination|target)/i;
const seenActions = new Set();
const failures = [];

for (const member of actionAlias.type.types) {
  if (!ts.isTypeLiteralNode(member)) {
    failures.push("each ToolchainActionRequest member must be an object literal");
    continue;
  }

  for (const property of member.members) {
    if (!ts.isPropertySignature(property) || !property.name) {
      failures.push("ToolchainActionRequest may only contain named properties");
      continue;
    }

    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
    if (!name || !allowedProperties.has(name) || forbiddenPattern.test(name)) {
      failures.push(`unsafe or unknown renderer-writable toolchain property: ${name ?? "<computed>"}`);
    }
    if (
      name === "action" &&
      property.type &&
      ts.isLiteralTypeNode(property.type) &&
      ts.isStringLiteral(property.type.literal)
    ) {
      seenActions.add(property.type.literal.text);
    }
  }
}

const requiredActions = [
  "install-profile",
  "install-component",
  "repair-component",
  "cancel-component-install",
  "remove-component",
  "set-preference",
  "clear-cache",
  "rescan",
];
for (const action of requiredActions) {
  if (!seenActions.has(action)) failures.push(`missing fixed toolchain action: ${action}`);
}

for (const exportedType of [
  "PublicToolchainState",
  "ToolchainActionRequest",
  "ToolCapabilityId",
  "ManagedComponentId",
  "ToolPreference",
]) {
  if (!desktopText.includes(exportedType)) {
    failures.push(`desktop contract must re-export ${exportedType}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(
  `OK: renderer toolchain actions expose ${seenActions.size} fixed operations with no writable URL/hash/path/executable/argv/command fields`,
);
