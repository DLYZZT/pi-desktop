import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const LOCALIZED_OWNER_SUFFIXES = [
  "components/SessionSidebar.tsx",
  "components/FileViewer.tsx",
  "components/FileExplorer.tsx",
  "components/BranchNavigator.tsx",
  "components/AppShell.tsx",
  "components/SessionInfoPanel.tsx",
  "components/SkillsConfig.tsx",
  "components/PluginsConfig.tsx",
  "hooks/useAgentSession.ts",
  "hooks/useSessionModels.ts",
  "hooks/useSessionHistory.ts",
  "hooks/useSessionExtensionUi.ts",
];
const VISIBLE_ATTRIBUTE_NAMES = new Set(["title", "aria-label", "aria-valuetext", "placeholder", "alt"]);
const LOCALIZED_DICTIONARIES = [{ name: "zhCN", tag: "zh-CN" }];

export function checkRendererI18n({
  root,
  rendererRoot,
  dictionariesPath,
  localizedDictionaries = LOCALIZED_DICTIONARIES,
}) {
  const failures = [];
  const translations = new Map();

  for (const file of rendererSourceFiles(rendererRoot, dictionariesPath)) {
    const sourceText = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    walk(source, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isIdentifier(node.expression) ||
        !["t", "translate"].includes(node.expression.text)
      ) {
        return;
      }
      const [key, fallback] = node.arguments;
      if (!key || !fallback || !ts.isStringLiteralLike(key) || !ts.isStringLiteralLike(fallback)) {
        failures.push(`${relative(root, file)}:${lineOf(source, node)} dynamic translation key or fallback`);
        return;
      }
      const previous = translations.get(key.text);
      if (previous && previous.fallback !== fallback.text) {
        failures.push(
          `${key.text} uses inconsistent fallbacks at ${previous.location} and ${relative(root, file)}:${lineOf(source, node)}`,
        );
        return;
      }
      translations.set(key.text, {
        fallback: fallback.text,
        location: `${relative(root, file)}:${lineOf(source, node)}`,
      });
    });

    const browserFile = file.includes(`${path.sep}components${path.sep}browser${path.sep}`);
    const localizedOwner = isLocalizedOwner(root, file);
    if (browserFile || localizedOwner) {
      checkVisibleLiterals({ failures, root, file, source, browserFile });
    }
    if (
      localizedOwner &&
      ["useAgentSession.ts", "useSessionModels.ts", "useSessionHistory.ts", "useSessionExtensionUi.ts"].some((name) =>
        file.endsWith(`${path.sep}hooks${path.sep}${name}`),
      )
    ) {
      checkSessionUserFacingSinks({ failures, root, file, source });
    }
    if (browserFile) {
      checkRetiredBrowserTerminology({ failures, root, file, sourceText });
    }
  }

  const enUS = readDictionary({ failures, dictionariesPath, name: "enUS" });
  const localized = localizedDictionaries.map((dictionary) => ({
    tag: dictionary.tag,
    values: readDictionary({ failures, dictionariesPath, name: dictionary.name }),
  }));
  for (const dictionary of localized) checkDictionaryParity(failures, enUS, dictionary.values, dictionary.tag);

  for (const [key, usage] of translations) {
    if (!enUS.has(key)) failures.push(`en-US is missing ${key} used at ${usage.location}`);
    for (const dictionary of localized) {
      if (!dictionary.values.has(key)) failures.push(`${dictionary.tag} is missing ${key} used at ${usage.location}`);
    }
    if (enUS.get(key) !== usage.fallback) {
      failures.push(`${key} fallback at ${usage.location} does not match the registered en-US value`);
    }
  }
  for (const key of enUS.keys()) {
    if (!translations.has(key)) failures.push(`dictionary key ${key} has no static Renderer translation call`);
  }

  return { failures, keyCount: translations.size };
}

function rendererSourceFiles(directory, dictionariesPath, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rendererSourceFiles(file, dictionariesPath, result);
    else if (
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx") &&
      file !== dictionariesPath
    ) {
      result.push(file);
    }
  }
  return result.sort();
}

function readDictionary({ failures, dictionariesPath, name }) {
  const directory = path.dirname(dictionariesPath);
  const stack = new Set();
  const merge = (target, entries) => {
    for (const [key, value] of entries) {
      if (target.has(key)) failures.push(`${name} contains duplicate key ${key}`);
      target.set(key, value);
    }
    return target;
  };
  const read = (file, symbol) => {
    const reference = `${file}:${symbol}`;
    if (stack.has(reference)) {
      failures.push(`dictionary ${name} contains a cyclic import at ${reference}`);
      return new Map();
    }
    if (!fs.existsSync(file)) {
      failures.push(`dictionary module not found: ${file}`);
      return new Map();
    }
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(directory) + path.sep)) {
      failures.push(`dictionary module leaves Renderer: ${file}`);
      return new Map();
    }
    stack.add(reference);
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const diagnostic of source.parseDiagnostics)
      failures.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    const declarations = new Map(),
      imports = new Map();
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration.initializer);
        }
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        for (const binding of statement.importClause.namedBindings.elements)
          imports.set(binding.name.text, {
            module: statement.moduleSpecifier.text,
            symbol: (binding.propertyName ?? binding.name).text,
          });
      }
    }
    const resolve = (expression) => {
      const values = new Map();
      if (!expression) {
        failures.push(`dictionary ${symbol} was not found in ${file}`);
        return values;
      }
      if (ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
            failures.push(`${name} contains a non-static dictionary entry at ${file}:${lineOf(source, property)}`);
            continue;
          }
          const key =
            ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
          if (!key) {
            failures.push(`${name} contains a dynamic dictionary key at ${file}:${lineOf(source, property)}`);
            continue;
          }
          merge(values, [[key, property.initializer.text]]);
        }
        return values;
      }
      if (ts.isIdentifier(expression)) {
        const imported = imports.get(expression.text);
        if (imported?.module.startsWith(".")) {
          return read(path.resolve(path.dirname(file), imported.module), imported.symbol);
        }
        if (declarations.has(expression.text)) return read(file, expression.text);
      }
      if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        const helper = imports.get(expression.expression.text);
        // Recognize only the explicit runtime merger, never evaluate arbitrary
        // code or ignore a spread/call the checker cannot understand.
        if (
          helper?.symbol === "mergeDictionaries" &&
          path.resolve(path.dirname(file), helper.module) === path.join(directory, "i18n/merge-dictionaries.ts") &&
          expression.arguments.length
        ) {
          for (const argument of expression.arguments) merge(values, resolve(argument));
          return values;
        }
      }
      failures.push(`${name} contains a non-static dictionary composition at ${file}:${lineOf(source, expression)}`);
      return values;
    };
    const values = resolve(declarations.get(symbol));
    stack.delete(reference);
    return values;
  };
  return read(dictionariesPath, name);
}

function checkDictionaryParity(failures, enUS, localized, tag) {
  for (const [key, english] of enUS) {
    if (!localized.has(key)) {
      failures.push(`${tag} is missing ${key}`);
      continue;
    }
    const expected = placeholders(english);
    const actual = placeholders(localized.get(key));
    if (expected.join(",") !== actual.join(",")) {
      failures.push(`${key} placeholder mismatch: en=[${expected}] ${tag}=[${actual}]`);
    }
  }
  for (const key of localized.keys()) {
    if (!enUS.has(key)) failures.push(`en-US is missing ${key}`);
  }
}

function checkVisibleLiterals({ failures, root, file, source, browserFile }) {
  walk(source, (node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (/[A-Za-z]/.test(text) && !isAllowedVisibleLiteral(text, browserFile)) {
        failures.push(`${relative(root, file)}:${lineOf(source, node)} visible English JSX literal: ${text}`);
      }
      return;
    }
    if (
      ts.isJsxAttribute(node) &&
      VISIBLE_ATTRIBUTE_NAMES.has(node.name.text) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      /[A-Za-z]/.test(node.initializer.text) &&
      !isAllowedVisibleLiteral(node.initializer.text, browserFile)
    ) {
      failures.push(
        `${relative(root, file)}:${lineOf(source, node)} visible English JSX literal: ${node.initializer.text}`,
      );
    }
  });
}

function checkSessionUserFacingSinks({ failures, root, file, source }) {
  walk(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const callee = node.expression.text;
    if (callee === "addNotice" || callee === "complete") {
      const object = node.arguments[0];
      if (!object || !ts.isObjectLiteralExpression(object)) return;
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : "";
        if (!["message", "error"].includes(name) || !ts.isStringLiteralLike(property.initializer)) continue;
        failures.push(
          `${relative(root, file)}:${lineOf(source, property)} hardcoded session ${name}: ${property.initializer.text}`,
        );
      }
      return;
    }
    if (["setError", "setCompactError"].includes(callee) && ts.isStringLiteralLike(node.arguments[0])) {
      failures.push(
        `${relative(root, file)}:${lineOf(source, node)} hardcoded session error: ${node.arguments[0].text}`,
      );
    }
  });
}

function checkRetiredBrowserTerminology({ failures, root, file, sourceText }) {
  for (const forbidden of ["Unsafe Lab", "不安全 Profile", "高级 / 不安全", "New unsafe Profile"]) {
    if (sourceText.includes(forbidden)) {
      failures.push(`${relative(root, file)} contains retired Browser terminology: ${forbidden}`);
    }
  }
}

function isLocalizedOwner(root, file) {
  const normalized = relative(root, file).split(path.sep).join("/");
  return LOCALIZED_OWNER_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function relative(root, file) {
  return path.relative(root, file);
}

function placeholders(value) {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]).sort();
}

function isAllowedVisibleLiteral(value, browserFile) {
  if (value === "/path/to/project") return true;
  return (
    browserFile &&
    (/^(?:Electron|Chromium|CDP|JavaScript|Profile|User-Agent|Client Hints)(?:\s+.*)?$/.test(value) ||
      /^https:\/\/example\.com$/.test(value) ||
      /^Mozilla\/5\.0 … Chrome\/\d+\.0\.0\.0 …$/.test(value) ||
      /^macOS, Windows, Linux…$/.test(value))
  );
}
