import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertContractCoverage,
  exactCoverageFailures,
  extractBrowserDispatchMethods,
  extractInterfaceProperties,
  extractServerHandlers,
  extractStreamTopics,
  loadContractSources,
} from "./check-contract-coverage.mjs";

test("AST extraction ignores comments and formatting while finding real contract nodes", () => {
  const api = `
    // interface Api { "comment.only": unknown }
    export interface Api {
      "alpha.call": { params: void; result: void };
      beta: { params: void; result: void };
    }
  `;
  const handlers = `
    // server.handle({ "comment.only": async () => undefined });
    server
      .handle({
        "alpha.call": async () => undefined,
        beta() {},
      });
  `;
  assert.deepEqual(extractInterfaceProperties("api.ts", api, "Api"), ["alpha.call", "beta"]);
  assert.deepEqual(extractServerHandlers("handlers.ts", handlers), ["alpha.call", "beta"]);
});

test("coverage diagnostics distinguish missing, duplicate, unknown, and empty extraction", () => {
  assert.deepEqual(exactCoverageFailures("Api handlers", ["one"], ["one"]), []);
  assert.match(exactCoverageFailures("Api handlers", ["one", "two"], ["one"]).join("\n"), /Missing.*two/);
  assert.match(exactCoverageFailures("Api handlers", ["one"], ["one", "one"]).join("\n"), /Duplicate/);
  assert.match(exactCoverageFailures("Api handlers", ["one"], ["one", "other"]).join("\n"), /Unknown.*other/);
  assert.match(exactCoverageFailures("Api handlers", [], []).join("\n"), /Empty extraction.*contract/);
  assert.match(exactCoverageFailures("Api handlers", [], []).join("\n"), /Empty extraction.*implementation/);
});

test("stream coverage reports a contract topic with no real server emitter", () => {
  const contract = extractInterfaceProperties(
    "api.ts",
    'interface Streams { "present.topic": unknown; "missing.topic": unknown }',
    "Streams",
  );
  const emitted = extractStreamTopics([
    { name: "host.ts", source: 'server.emit("present.topic", "*", {}); // server.emit("missing.topic")' },
  ]);
  assert.match(exactCoverageFailures("Streams topics", contract, emitted).join("\n"), /Missing.*missing\.topic/);
});

test("Browser dispatch extraction reads equality guards and switch cases only from the dispatch method", () => {
  const source = `
    class BrowserService {
      unrelated(method) { if (method === "browser.fake") return; }
      dispatchHostRequest(method) {
        if (method === "browser.capabilities") return;
        switch (method) {
          case "browser.open": return;
          default: return;
        }
      }
    }
  `;
  assert.deepEqual(extractBrowserDispatchMethods("browser-service.ts", source), [
    "browser.capabilities",
    "browser.open",
  ]);
});

test("the repository contract has non-empty exact AST coverage", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const counts = assertContractCoverage(loadContractSources(root));
  assert.ok(counts.apiMethods > 0);
  assert.ok(counts.streamTopics > 0);
  assert.ok(counts.bridgeMethods > 0);
  assert.ok(counts.browserHostMethods > 0);
});
