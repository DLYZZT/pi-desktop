#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function sourceFile(name, source) {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function staticName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function unique(values) {
  return [...new Set(values)];
}

function visitTree(root, visitor) {
  const visit = (node) => {
    visitor(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function extractInterfaceProperties(name, source, interfaceName) {
  const file = sourceFile(name, source);
  const declaration = file.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  );
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) return [];
  return declaration.members.flatMap((member) => {
    if (!member.name) return [];
    const nameValue = staticName(member.name);
    return nameValue === undefined ? [] : [nameValue];
  });
}

export function extractServerHandlers(name, source) {
  const file = sourceFile(name, source);
  const handlers = [];
  visitTree(file, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "server") return;
    if (node.expression.name.text !== "handle") return;
    const object = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
    if (!object || !ts.isObjectLiteralExpression(object)) return;
    for (const property of object.properties) {
      if (!property.name) continue;
      const nameValue = staticName(property.name);
      if (nameValue !== undefined) handlers.push(nameValue);
    }
  });
  return handlers;
}

function isServerEmitter(expression) {
  if (ts.isIdentifier(expression)) return expression.text === "server";
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "server" &&
    expression.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

export function extractStreamTopics(sources) {
  const topics = [];
  for (const { name, source } of sources) {
    visitTree(sourceFile(name, source), (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== "emit" || !isServerEmitter(node.expression.expression)) return;
      const topic = node.arguments[0];
      if (topic && ts.isStringLiteral(topic)) topics.push(topic.text);
    });
  }
  return topics;
}

export function extractTypedObjectProperties(name, source, variableName, typeName) {
  const file = sourceFile(name, source);
  const properties = [];
  visitTree(file, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== variableName) return;
    if (!node.type || node.type.getText(file) !== typeName || !node.initializer) return;
    const object = unwrapExpression(node.initializer);
    if (!ts.isObjectLiteralExpression(object)) return;
    for (const property of object.properties) {
      if (!property.name) continue;
      const nameValue = staticName(property.name);
      if (nameValue !== undefined) properties.push(nameValue);
    }
  });
  return properties;
}

function callTarget(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const owner = node.expression.expression;
  return {
    owner: ts.isIdentifier(owner) ? owner.text : undefined,
    method: node.expression.name.text,
  };
}

export function extractCallChannels(name, source, owner, methods) {
  const file = sourceFile(name, source);
  const channels = [];
  visitTree(file, (node) => {
    const target = callTarget(node);
    if (!target || target.owner !== owner || !methods.includes(target.method)) return;
    const channel = node.arguments[0];
    if (channel && ts.isStringLiteral(channel)) channels.push({ method: target.method, channel: channel.text });
  });
  return channels;
}

export function extractFunctionChannels(name, source, functionNames) {
  const file = sourceFile(name, source);
  const channels = [];
  visitTree(file, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    if (!functionNames.includes(node.expression.text)) return;
    const channel = node.arguments[0];
    if (channel && ts.isStringLiteral(channel)) {
      channels.push({ functionName: node.expression.text, channel: channel.text });
    }
  });
  return channels;
}

export function extractStringSet(name, source, variableName) {
  const file = sourceFile(name, source);
  let values = [];
  visitTree(file, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== variableName) return;
    if (!node.initializer) return;
    const initializer = unwrapExpression(node.initializer);
    if (!ts.isNewExpression(initializer) || initializer.expression.getText(file) !== "Set") return;
    const array = initializer.arguments?.[0];
    if (!array || !ts.isArrayLiteralExpression(array)) return;
    values = array.elements.flatMap((element) => (ts.isStringLiteral(element) ? [element.text] : []));
  });
  return values;
}

function methodComparisonValue(node) {
  if (!ts.isBinaryExpression(node)) return undefined;
  if (
    ![
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(node.operatorToken.kind)
  ) {
    return undefined;
  }
  if (ts.isIdentifier(node.left) && node.left.text === "method" && ts.isStringLiteral(node.right))
    return node.right.text;
  if (ts.isIdentifier(node.right) && node.right.text === "method" && ts.isStringLiteral(node.left))
    return node.left.text;
  return undefined;
}

export function extractBrowserDispatchMethods(name, source) {
  const file = sourceFile(name, source);
  const methods = [];
  let dispatch;
  visitTree(file, (node) => {
    if (ts.isMethodDeclaration(node) && node.name && staticName(node.name) === "dispatchHostRequest" && node.body) {
      dispatch = node.body;
    }
  });
  if (!dispatch) return methods;
  visitTree(dispatch, (node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text.startsWith("browser.")) {
      methods.push(node.expression.text);
      return;
    }
    const compared = methodComparisonValue(node);
    if (compared?.startsWith("browser.")) methods.push(compared);
  });
  return methods;
}

export function exactCoverageFailures(label, expected, actual, options = {}) {
  const failures = [];
  if (expected.length === 0) failures.push(`Empty extraction for ${label} contract`);
  if (actual.length === 0) failures.push(`Empty extraction for ${label} implementation`);
  const expectedDuplicates = duplicateValues(expected);
  const actualDuplicates = options.allowImplementationDuplicates ? [] : duplicateValues(actual);
  if (expectedDuplicates.length) failures.push(`Duplicate ${label} contract entries: ${expectedDuplicates.join(", ")}`);
  if (actualDuplicates.length)
    failures.push(`Duplicate ${label} implementation entries: ${actualDuplicates.join(", ")}`);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = unique(expected).filter((value) => !actualSet.has(value));
  const unknown = unique(actual).filter((value) => !expectedSet.has(value));
  if (missing.length) failures.push(`Missing ${label}: ${missing.join(", ")}`);
  if (unknown.length) failures.push(`Unknown ${label}: ${unknown.join(", ")}`);
  return failures;
}

export function analyzeContractCoverage(sources) {
  const apiMethods = extractInterfaceProperties("api.ts", sources.api, "Api");
  const handlers = extractServerHandlers("handlers.ts", sources.handlers);
  const streamContract = extractInterfaceProperties("api.ts", sources.api, "Streams");
  const emittedTopics = extractStreamTopics(sources.streamSources);
  const bridgeContract = extractInterfaceProperties("desktop.ts", sources.desktop, "PiBridge");
  const bridgeImplementation = extractTypedObjectProperties("preload.ts", sources.preload, "bridge", "PiBridge");
  const preloadCalls = extractCallChannels("preload.ts", sources.preload, "ipcRenderer", ["invoke", "send", "on"]);
  const ipcRegistrations = extractFunctionChannels("ipc.ts", sources.ipc, [
    "trustedHandle",
    "trustedOn",
    "browserHandler",
  ]);
  const invokeChannels = preloadCalls.filter(({ method }) => method === "invoke").map(({ channel }) => channel);
  const sendChannels = preloadCalls.filter(({ method }) => method === "send").map(({ channel }) => channel);
  const handleChannels = ipcRegistrations
    .filter(({ functionName }) => functionName === "trustedHandle" || functionName === "browserHandler")
    .map(({ channel }) => channel);
  const onChannels = ipcRegistrations
    .filter(({ functionName }) => functionName === "trustedOn")
    .map(({ channel }) => channel);
  const browserRpcMethods = extractInterfaceProperties("browser.ts", sources.browser, "BrowserHostRpc");
  const browserMethodSet = extractStringSet("browser.ts", sources.browser, "BROWSER_HOST_METHODS");
  const browserDispatch = extractBrowserDispatchMethods("browser-service.ts", sources.browserService);
  const browserBridgeMethods = bridgeContract.filter((method) => method.startsWith("browser"));
  const browserPreloadMethods = bridgeImplementation.filter((method) => method.startsWith("browser"));
  const browserInvokeChannels = invokeChannels.filter((channel) => channel.startsWith("desktop:browser:"));
  const browserIpcChannels = ipcRegistrations
    .filter(({ functionName, channel }) => functionName === "browserHandler" && channel.startsWith("desktop:browser:"))
    .map(({ channel }) => channel);
  const mainSends = extractCallChannels("main.ts", sources.main, undefined, ["send"]);
  const failures = [
    ...exactCoverageFailures("Api handlers", apiMethods, handlers),
    ...exactCoverageFailures("Streams topics", streamContract, emittedTopics, { allowImplementationDuplicates: true }),
    ...exactCoverageFailures("PiBridge methods", bridgeContract, bridgeImplementation),
    ...exactCoverageFailures("IPC invoke handlers", unique(invokeChannels), handleChannels),
    ...exactCoverageFailures("IPC send listeners", unique(sendChannels), onChannels),
    ...exactCoverageFailures("Browser preload methods", browserBridgeMethods, browserPreloadMethods),
    ...exactCoverageFailures("Browser IPC handlers", unique(browserInvokeChannels), browserIpcChannels),
    ...exactCoverageFailures("Browser Host method set", browserRpcMethods, browserMethodSet),
    ...exactCoverageFailures("Browser Host dispatch", browserRpcMethods, browserDispatch),
  ];
  const preloadBrowserEvents = preloadCalls.filter(
    ({ method, channel }) => method === "on" && channel === "browser:event",
  );
  const mainBrowserEvents = mainSends.filter(({ channel }) => channel === "browser:event");
  if (preloadBrowserEvents.length !== 1) {
    failures.push(`Browser event preload listener count must be 1, received ${preloadBrowserEvents.length}`);
  }
  if (mainBrowserEvents.length === 0) failures.push("Missing Browser event Main sender: browser:event");

  return {
    failures,
    counts: {
      apiMethods: apiMethods.length,
      streamTopics: streamContract.length,
      bridgeMethods: bridgeContract.length,
      browserBridgeMethods: browserBridgeMethods.length,
      browserHostMethods: browserRpcMethods.length,
    },
  };
}

export function assertContractCoverage(sources) {
  const result = analyzeContractCoverage(sources);
  if (result.failures.length) throw new Error(result.failures.join("\n"));
  return result.counts;
}

export function loadContractSources(root) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const streamSources = fs
    .globSync("src/agent-host/**/*.ts", { cwd: root })
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => ({ name: file, source: read(file) }));
  return {
    api: read("src/contract/api.ts"),
    handlers: read("src/agent-host/handlers.ts"),
    streamSources,
    desktop: read("src/contract/desktop.ts"),
    preload: read("src/preload/preload.ts"),
    ipc: read("src/main/ipc.ts"),
    browser: read("src/contract/browser.ts"),
    browserService: read("src/main/browser/browser-service.ts"),
    main: read("src/main/main.ts"),
  };
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const counts = assertContractCoverage(loadContractSources(root));
    console.log(
      `Contract coverage OK: ${counts.apiMethods} Api handlers, ${counts.streamTopics} Streams topics, ${counts.bridgeMethods} PiBridge methods, ${counts.browserBridgeMethods} Browser bridge methods, and ${counts.browserHostMethods} Browser Host methods`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) run();
