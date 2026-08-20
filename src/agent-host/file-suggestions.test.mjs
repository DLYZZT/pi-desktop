import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const {
  FILE_SUGGESTION_DIRECT_LIMIT,
  FILE_SUGGESTION_RETURN_LIMIT,
  FILE_SUGGESTION_SEARCH_LIMIT,
  FILE_SUGGESTION_SEARCH_MAX_BUFFER,
  FILE_SUGGESTION_SEARCH_TIMEOUT_MS,
  buildFdFuzzyPattern,
  buildFdSearchArgs,
  classifyFileSuggestionSearchError,
  createFileSuggestionService,
  fileSuggestionPathKey,
  isHomeSystemDirectoryName,
  normalizeFileSuggestionQuery,
} = await importTestBundle("src/agent-host/file-suggestions", {
  packages: "external",
  absWorkingDir: root,
  entryPoints: ["src/agent-host/file-suggestions.ts"],
});

function fixture(prefix = "pi-file-suggestions-") {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("empty queries browse one directory without starting a search", async () => {
  const project = fixture();
  mkdirSync(path.join(project, "src"));
  mkdirSync(path.join(project, "empty"));
  writeFileSync(path.join(project, "README.md"), "readme");
  writeFileSync(path.join(project, "src", "nested.ts"), "nested");
  let searches = 0;
  const service = createFileSuggestionService({
    homeDirectory: path.join(project, "not-home"),
    runSearch: async () => {
      searches += 1;
      return [];
    },
  });

  const result = await service.suggest(project, "");

  assert.equal(searches, 0);
  assert.deepEqual(
    result.matches.map(({ path: candidate, isDir }) => [candidate, isDir]),
    [
      ["empty", true],
      ["src", true],
      ["README.md", false],
    ],
  );
  assert.equal(result.files.includes("src/nested.ts"), false);
});

test("enforces the direct, search, response, timeout and output budgets", async () => {
  assert.equal(FILE_SUGGESTION_DIRECT_LIMIT, 300);
  assert.equal(FILE_SUGGESTION_SEARCH_LIMIT, 300);
  assert.equal(FILE_SUGGESTION_RETURN_LIMIT, 50);
  assert.equal(FILE_SUGGESTION_SEARCH_TIMEOUT_MS, 2_000);
  assert.equal(FILE_SUGGESTION_SEARCH_MAX_BUFFER, 2 * 1024 * 1024);

  const project = fixture("pi-file-suggestions-limits-");
  const files = [];
  for (let index = 0; index < 305; index += 1) {
    const candidate = path.join(project, `match-${String(index).padStart(3, "0")}.txt`);
    writeFileSync(candidate, "match");
    files.push(candidate);
  }
  const service = createFileSuggestionService({
    homeDirectory: path.join(project, "not-home"),
    runSearch: async () => files,
  });

  const browsed = await service.suggest(project, "");
  assert.equal(browsed.matches.length, 50);
  assert.equal(browsed.truncated, true);
  assert.equal(browsed.truncatedReason, "count");
  const searched = await service.suggest(project, "match");
  assert.equal(searched.matches.length, 50);
  assert.equal(searched.truncated, true);
  const directTarget = await service.suggest(project, "match-304");
  assert.equal(
    directTarget.matches.some((candidate) => candidate.path === "match-304.txt"),
    true,
  );
});

test("scopes an existing directory query and keeps a missing prefix as a full-path root search", async () => {
  const project = fixture("pi-file-suggestions-scope-");
  mkdirSync(path.join(project, "Desktop"));
  const requests = [];
  const service = createFileSuggestionService({
    homeDirectory: path.join(project, "not-home"),
    runSearch: async (request) => {
      requests.push(request);
      return [];
    },
  });

  await service.suggest(project, "Desktop/report");
  await service.suggest(project, "missing/report");

  assert.equal(requests[0].cwd.endsWith(`${path.sep}Desktop`), true);
  assert.equal(requests[0].pattern, "r.*e.*p.*o.*r.*t");
  assert.equal(requests[0].fullPath, false);
  assert.equal(requests[1].cwd.endsWith(path.basename(project)), true);
  assert.equal(requests[1].fullPath, true);
});

test("hides dot entries by default and allows an explicit dot-directory browse", async () => {
  const project = fixture("pi-file-suggestions-hidden-");
  mkdirSync(path.join(project, ".github"));
  writeFileSync(path.join(project, ".github", "CODEOWNERS"), "owners");
  const service = createFileSuggestionService({ homeDirectory: path.join(project, "not-home") });

  const rootBrowse = await service.suggest(project, "");
  assert.equal(
    rootBrowse.matches.some((candidate) => candidate.path === ".github"),
    false,
  );
  const explicitBrowse = await service.suggest(project, ".github/");
  assert.equal(
    explicitBrowse.matches.some((candidate) => candidate.path === ".github/CODEOWNERS"),
    true,
  );
});

test("searches on demand and excludes a large home system directory before traversal", async () => {
  const home = fixture("pi-file-suggestions-home-");
  mkdirSync(path.join(home, "AppData", "Local"), { recursive: true });
  mkdirSync(path.join(home, "Desktop"));
  const wanted = path.join(home, "Desktop", "wanted.txt");
  writeFileSync(path.join(home, "AppData", "Local", "noise.txt"), "noise");
  writeFileSync(wanted, "wanted");
  let request;
  const darwinService = createFileSuggestionService({
    platform: "darwin",
    homeDirectory: home,
    runSearch: async (nextRequest) => {
      request = nextRequest;
      return [wanted];
    },
  });
  mkdirSync(path.join(home, "Library"));
  for (let index = 0; index < 5_001; index += 1) {
    writeFileSync(path.join(home, "Library", `noise-${index}.txt`), "noise");
  }
  const result = await darwinService.suggest(home, "wanted");

  assert.equal(
    request.searchPaths.some((candidate) => candidate.endsWith(`${path.sep}Library`)),
    false,
  );
  assert.equal(
    request.searchPaths.some((candidate) => candidate.endsWith(`${path.sep}Desktop`)),
    true,
  );
  assert.equal(
    result.matches.some((candidate) => candidate.path === "Desktop/wanted.txt"),
    true,
  );
  assert.equal(
    result.matches.some((candidate) => candidate.path.startsWith("Library/")),
    false,
  );
});

test("allows an explicitly scoped home Library and same-named directories outside home", async () => {
  const home = fixture("pi-file-suggestions-home-library-");
  mkdirSync(path.join(home, "Library"));
  writeFileSync(path.join(home, "Library", "visible.txt"), "visible");
  const homeService = createFileSuggestionService({ platform: "darwin", homeDirectory: home });
  const explicit = await homeService.suggest(home, "Library/");
  assert.equal(
    explicit.matches.some((candidate) => candidate.path === "Library/visible.txt"),
    true,
  );

  const project = fixture("pi-file-suggestions-project-");
  mkdirSync(path.join(project, "Library"));
  const nested = path.join(project, "Library", "nested.txt");
  writeFileSync(nested, "nested");
  const projectService = createFileSuggestionService({
    platform: "darwin",
    homeDirectory: home,
    runSearch: async () => [nested],
  });
  const result = await projectService.suggest(project, "nested");
  assert.equal(
    result.matches.some((candidate) => candidate.path === "Library/nested.txt"),
    true,
  );
});

test("degrades to the current scope instead of recursively walking when search is unavailable", async () => {
  const project = fixture();
  mkdirSync(path.join(project, "Desktop"));
  writeFileSync(path.join(project, "Desktop", "wanted.txt"), "wanted");
  const service = createFileSuggestionService({
    homeDirectory: path.join(project, "not-home"),
    runSearch: async () => {
      throw { code: "TOOLCHAIN_CAPABILITY_REQUIRED" };
    },
  });

  const globalFallback = await service.suggest(project, "wanted");
  assert.deepEqual(globalFallback.matches, []);
  assert.equal(globalFallback.truncated, true);
  assert.equal(globalFallback.degradedReason, "search-unavailable");

  const scopedFallback = await service.suggest(project, "Desktop/wanted");
  assert.equal(scopedFallback.matches[0]?.path, "Desktop/wanted.txt");
  assert.equal(scopedFallback.degradedReason, "search-unavailable");
});

test("filters search results and directory symlinks that escape the authorized root", async (context) => {
  const project = fixture();
  const outside = fixture("pi-file-suggestions-outside-");
  const secret = path.join(outside, "secret.txt");
  writeFileSync(secret, "secret");
  try {
    symlinkSync(outside, path.join(project, "outside-link"), "dir");
  } catch (error) {
    context.skip(`symlinks unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const service = createFileSuggestionService({
    homeDirectory: path.join(project, "not-home"),
    runSearch: async () => [secret],
  });

  const browsed = await service.suggest(project, "");
  assert.equal(
    browsed.matches.some((candidate) => candidate.path === "outside-link"),
    false,
  );
  const searched = await service.suggest(project, "secret");
  assert.deepEqual(searched.matches, []);
});

test("normalizes safe relative queries and rejects traversal or absolute paths", () => {
  assert.equal(normalizeFileSuggestionQuery("./src\\main"), "src/main");
  assert.throws(() => normalizeFileSuggestionQuery("../secret"), /Parent traversal/);
  assert.throws(() => normalizeFileSuggestionQuery("/etc/passwd"), /Absolute/);
  assert.throws(() => normalizeFileSuggestionQuery("C:\\secret"), /Absolute/);
  assert.equal(buildFdFuzzyPattern("a+b/c"), "a.*\\+.*b.*[/\\\\].*c");
  const hostilePattern = buildFdFuzzyPattern("a;$(touch owned)");
  const hostileArgs = buildFdSearchArgs({
    cwd: "/workspace",
    pattern: hostilePattern,
    searchPaths: ["/workspace"],
    fullPath: false,
  });
  assert.equal(hostileArgs[hostileArgs.indexOf("--") + 1], hostilePattern);
  assert.equal(hostileArgs.at(-1), "/workspace");
  assert.equal(
    hostileArgs.some((argument) => argument === "touch"),
    false,
  );
  assert.equal(isHomeSystemDirectoryName("AppData", "win32"), true);
  assert.equal(isHomeSystemDirectoryName("appdata", "win32"), true);
  assert.equal(isHomeSystemDirectoryName("Library", "darwin"), true);
  assert.equal(isHomeSystemDirectoryName("Library", "linux"), false);
  assert.equal(fileSuggestionPathKey("Src\\Main.ts", "win32"), fileSuggestionPathKey("src/main.ts", "win32"));
  assert.notEqual(fileSuggestionPathKey("Src/Main.ts", "darwin"), fileSuggestionPathKey("src/main.ts", "darwin"));
});

test("classifies unavailable, timeout and generic search failures", () => {
  assert.equal(classifyFileSuggestionSearchError({ code: "TOOLCHAIN_CAPABILITY_REQUIRED" }), "search-unavailable");
  assert.equal(classifyFileSuggestionSearchError({ code: "ETIMEDOUT" }), "search-timeout");
  assert.equal(classifyFileSuggestionSearchError(new Error("boom")), "search-failed");
});
