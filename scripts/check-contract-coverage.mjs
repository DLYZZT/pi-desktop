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
console.log(`OK: ${methods.length} Api methods have host handlers`);
