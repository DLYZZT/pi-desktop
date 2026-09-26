import fs from "node:fs";
import path from "node:path";
import { createRequire, isBuiltin } from "node:module";
import ts from "typescript";

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const assetExtension = /\.(?:css|scss|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|json)$/i;
const serverPackages = ["electron", "@earendil-works/pi-coding-agent", "@earendil-works/pi-telemetry"];
const allowedLayers = {
  renderer: ["renderer", "shared", "contract"],
  main: ["main", "shared", "node", "contract"],
  host: ["host", "shared", "node", "contract"],
  preload: ["preload", "shared", "contract"],
  shared: ["shared", "node", "contract"],
  node: ["node", "shared", "contract"],
  contract: ["contract", "shared"],
};

function layer(file) {
  if (file.startsWith("src/shared/node/")) return "node";
  const top = file.split("/")[1];
  return top === "agent-host" ? "host" : top;
}

function sourceFiles(directory, root, failures, files = [], ancestors = new Set()) {
  if (!fs.existsSync(directory)) return files;
  const actual = fs.realpathSync(directory);
  const relative = path.relative(path.join(root, "src"), actual);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    failures.push("Source directory symlink leaves src: " + path.relative(root, directory));
    return files;
  }
  if (ancestors.has(actual)) {
    failures.push("Source directory symlink cycle: " + path.relative(root, directory));
    return files;
  }
  const nextAncestors = new Set(ancestors).add(actual);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() && !fs.existsSync(file)) {
      failures.push("Broken source symlink: " + path.relative(root, file));
      continue;
    }
    if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(file).isDirectory()))
      sourceFiles(file, root, failures, files, nextAncestors);
    else if (sourceExtension.test(file) && !/\.(?:test|spec|d)\.[^.]+$/.test(file)) files.push(file);
  }
  return files.sort();
}

function configOptions(root, failures) {
  const read = (name) => {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) return {};
    const result = ts.readConfigFile(file, ts.sys.readFile);
    if (result.error) failures.push(name + ": " + ts.flattenDiagnosticMessageText(result.error.messageText, " "));
    return result.config ?? {};
  };
  const base = read("tsconfig.json"),
    renderer = read("tsconfig.renderer.json");
  const result = ts.parseJsonConfigFileContent(
    {
      ...base,
      compilerOptions: {
        ...base.compilerOptions,
        paths: { ...base.compilerOptions?.paths, ...renderer.compilerOptions?.paths },
      },
    },
    ts.sys,
    root,
  );
  // No-input diagnostics are expected for small isolated rule fixtures.
  for (const error of result.errors.filter((error) => error.code !== 18003))
    failures.push(ts.flattenDiagnosticMessageText(error.messageText, " "));
  return { ...result.options, baseUrl: result.options.baseUrl ?? root };
}

function dependencies(tree) {
  const found = [];
  const add = (node, argument) =>
    found.push({
      specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : null,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    });
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node, node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node, node.moduleReference.expression);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node, node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function isDataOnly(tree) {
  const names = new Set();
  const literal = (node) => {
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isParenthesizedExpression(node)
    )
      return literal(node.expression);
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)
    )
      return true;
    if (ts.isIdentifier(node)) return names.has(node.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(literal);
    return (
      ts.isObjectLiteralExpression(node) &&
      node.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          literal(property.initializer),
      )
    );
  };
  return tree.statements.every((statement) => {
    if (ts.isImportDeclaration(statement)) return statement.importClause?.isTypeOnly === true;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) return false;
    return statement.declarationList.declarations.every((declaration) => {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !literal(declaration.initializer))
        return false;
      names.add(declaration.name.text);
      return true;
    });
  });
}

function resolveAsset(specifier, from, options) {
  const candidates = specifier.startsWith(".") ? [path.resolve(path.dirname(from), specifier)] : [];
  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    const [prefix, suffix = ""] = pattern.split("*");
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (!pattern.includes("*") && pattern !== specifier) continue;
    const replacement = pattern.includes("*") ? specifier.slice(prefix.length, specifier.length - suffix.length) : "";
    for (const target of targets) candidates.push(path.resolve(options.baseUrl, target.replace("*", replacement)));
  }
  try {
    candidates.push(createRequire(from).resolve(specifier));
  } catch {
    /* normal unresolved diagnostic follows */
  }
  return candidates.find(
    (candidate) =>
      fs.existsSync(candidate) && fs.statSync(candidate).isFile() && assetExtension.test(fs.realpathSync(candidate)),
  );
}

/** Analyze real runtime module paths; TypeScript erasure precedes graph traversal. */
export function checkArchitecture({ root, policy = {} }) {
  root = fs.realpathSync(root);
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  const failures = [],
    violations = new Map(),
    graph = new Map(),
    assets = new Set();
  const options = configOptions(root, failures);
  const cache = ts.createModuleResolutionCache(root, (file) => file, options);
  const budgets = policy.budgets ?? {},
    dataModules = policy.dataModules ?? {};
  const files = sourceFiles(path.join(root, "src"), root, failures);
  const stats = { modules: 0, runtimeEdges: 0, codeBudgets: Object.keys(budgets).length, dataModules: [], lines: {} };
  if (files.length === 0) failures.push("No runtime source modules found under src");

  const violation = (rule, from, to, chain = [from, to]) => {
    const key = [rule, from, to].join("|");
    if (!violations.has(key)) violations.set(key, { rule, from, to, chain });
  };
  const inspect = (file) => {
    file = fs.realpathSync(file);
    const name = relative(file);
    if (graph.has(name)) return;
    const text = fs.readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const error of tree.parseDiagnostics)
      failures.push(name + ": " + ts.flattenDiagnosticMessageText(error.messageText, " "));
    const lines = text.trimEnd().split(/\r?\n/).length;
    stats.lines[name] = lines;
    const limit = policy.lineLimit ?? 1200;
    if (layer(name) !== "smoke") {
      if (dataModules[name]) {
        if (!dataModules[name].reason || !Number.isInteger(dataModules[name].baselineLines))
          failures.push(name + ": data baseline needs a reason and baselineLines");
        if (!isDataOnly(tree)) failures.push(name + ": data-only exemption contains executable logic");
        stats.dataModules.push({ file: name, lines, baselineLines: dataModules[name].baselineLines });
      } else if (budgets[name]) {
        const budget = budgets[name];
        if (!budget.reason || !Number.isInteger(budget.maxLines) || budget.maxLines <= limit)
          failures.push(name + ": invalid existing-code budget");
        if (lines > budget.maxLines) failures.push(name + ": " + lines + " lines exceeds baseline " + budget.maxLines);
        if (lines <= limit) failures.push(name + ": remove the obsolete existing-code budget");
      } else if (lines > limit) failures.push(name + ": " + lines + " lines exceeds new-module limit " + limit);
    }
    const original = dependencies(tree);
    // Preserve ESM and require forms, while removing types and imports used only
    // as types. This does not change the actual build/compiler configuration.
    const emitted = ts.transpileModule(text, {
      fileName: file,
      compilerOptions: {
        ...options,
        module: ts.ModuleKind.Preserve,
        jsx: ts.JsxEmit.Preserve,
        noEmit: false,
        declaration: false,
        emitDeclarationOnly: false,
        sourceMap: false,
        inlineSourceMap: false,
      },
    }).outputText;
    const runtime = ts.createSourceFile(file + ".jsx", emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const edges = [];
    graph.set(name, edges);
    for (const dependency of dependencies(runtime)) {
      const specifier = dependency.specifier;
      const line = original.find((item) => item.specifier === specifier)?.line ?? dependency.line;
      if (specifier === null) {
        failures.push(name + ":" + line + ": non-literal runtime import cannot be checked");
        continue;
      }
      const bare = specifier.replace(/[?#].*$/, "");
      if (isBuiltin(bare)) {
        edges.push({ to: bare.startsWith("node:") ? bare : "node:" + bare, server: true });
        continue;
      }
      const resolved = ts.resolveModuleName(bare, file, options, ts.sys, cache).resolvedModule;
      if (!resolved) {
        const asset = resolveAsset(bare, file, options);
        if (asset) {
          assets.add(relative(fs.realpathSync(asset)));
          continue;
        }
        failures.push(name + ":" + line + ": unresolved runtime import " + specifier);
        continue;
      }
      const actual = fs.realpathSync(resolved.resolvedFileName),
        target = relative(actual);
      if (!target.startsWith("src/")) {
        if (resolved.isExternalLibraryImport) {
          edges.push({
            to: specifier,
            server: serverPackages.some((pkg) => bare === pkg || bare.startsWith(pkg + "/")),
          });
        } else if (assetExtension.test(actual)) assets.add(target);
        else failures.push(name + ":" + line + ": local runtime import leaves src: " + target);
        continue;
      }
      if (/\.d\.[cm]?ts$/.test(target)) {
        failures.push(name + ":" + line + ": runtime import resolves only to a declaration: " + target);
        continue;
      }
      const fromLayer = layer(name),
        toLayer = layer(target);
      if (allowedLayers[fromLayer] && !allowedLayers[fromLayer].includes(toLayer)) violation("layer", name, target);
      edges.push({ to: target, server: toLayer === "node" });
      if (sourceExtension.test(actual)) inspect(actual);
      else assets.add(target);
    }
  };
  for (const file of files) {
    const logical = relative(file),
      actual = relative(fs.realpathSync(file));
    if (!actual.startsWith("src/")) {
      failures.push(logical + ": source symlink leaves src: " + actual);
      continue;
    }
    if (allowedLayers[layer(logical)] && !allowedLayers[layer(logical)].includes(layer(actual)))
      violation("layer", logical, actual);
    inspect(file);
  }
  for (const file of [...Object.keys(budgets), ...Object.keys(dataModules)]) {
    if (!graph.has(file)) failures.push("Unused structure baseline: " + file);
  }
  // Multi-source traversal reports one actionable edge with its shortest
  // Renderer path, rather than repeating a shared violation for every caller.
  const queue = [...graph.keys()].filter((file) => layer(file) === "renderer").map((file) => [file]);
  const seen = new Set(queue.map((chain) => chain[0]));
  for (let index = 0; index < queue.length; index++) {
    const chain = queue[index],
      from = chain.at(-1);
    for (const edge of graph.get(from) ?? []) {
      if (edge.server) violation("renderer-node", from, edge.to, [...chain, edge.to]);
      else if (graph.has(edge.to) && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push([...chain, edge.to]);
      }
    }
  }

  const exceptionKeys = new Set();
  for (const exception of policy.exceptions ?? []) {
    const key = [exception.rule, exception.from, exception.to].join("|");
    if (
      !exception.reason ||
      !exception.removeWhen ||
      [exception.from, exception.to].some(
        (value) => typeof value !== "string" || value.includes("*") || value.endsWith("/"),
      )
    ) {
      failures.push("Invalid architecture exception: " + key);
      continue;
    }
    if (exceptionKeys.has(key)) failures.push("Duplicate architecture exception: " + key);
    exceptionKeys.add(key);
    if (!violations.delete(key)) failures.push("Unused architecture exception: " + key);
  }
  for (const item of violations.values()) failures.push(item.rule + ": " + item.chain.join(" -> "));
  stats.modules = graph.size;
  stats.runtimeEdges = [...graph.values()].reduce((sum, edges) => sum + edges.length, 0);
  stats.assets = assets.size;
  return { failures, stats };
}
