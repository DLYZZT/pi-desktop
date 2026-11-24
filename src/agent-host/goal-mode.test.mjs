import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as ai from "@earendil-works/pi-ai";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const {
  SessionPromptPolicy,
  createDesktopPromptExtension,
  AgentSessionWrapper,
  createGoalModeExtension,
  decideGoalTurnEnd,
  readSessionGoalState,
  GOAL_CUSTOM_TYPE,
  GOAL_CONTINUATION_TYPE,
} = await importTestBundle("goal-mode", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
    export {SessionPromptPolicy, createDesktopPromptExtension} from "./session-prompt-policy.ts";
    export {AgentSessionWrapper} from "./rpc-manager.ts";
    export {createGoalModeExtension, decideGoalTurnEnd} from "./goal-mode.ts";
    export {readSessionGoalState, GOAL_CUSTOM_TYPE, GOAL_CONTINUATION_TYPE} from "./goal-state.ts";`,
  },
});

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function nextSettle(session) {
  const deferred = createDeferred();
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "agent_settled") return;
    unsubscribe();
    deferred.resolve(event);
  });
  return deferred.promise;
}

async function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-goal-"));
  const policy = new SessionPromptPolicy(false);
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off", retry: { enabled: false } }),
    resourceLoaderOptions: {
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      extensionFactories: [createGoalModeExtension(policy), createDesktopPromptExtension(policy)],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const manager = SessionManager.create(directory, path.join(directory, "sessions"));
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  const requests = [];
  session.agent.streamFunction = (requestModel, context) => {
    requests.push(context);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: `offline turn ${requests.length}` }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      stopReason: "stop",
      timestamp: Date.now(),
      usage,
    };
    const stream = ai.createAssistantMessageEventStream();
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  return { directory, manager, policy, session, requests };
}

function requestPrompt(context) {
  return context.systemPrompt ?? ai.getCurrentSystemPrompt?.(context.messages) ?? "";
}

function goalEntries(manager) {
  return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === GOAL_CUSTOM_TYPE);
}

test("decideGoalTurnEnd continues, checkpoints on schedule and stops at the budget", () => {
  const base = {
    goal: "Fixture goal",
    criteria: [],
    status: "working",
    continuations: 0,
    maxContinuations: 8,
    checkpointEvery: 4,
    report: null,
  };
  const first = decideGoalTurnEnd(base);
  assert.equal(first.continue, true);
  const firstMessage = first.entries.find((entry) => entry.type === "custom_message");
  assert.match(firstMessage.content, /Continue working toward the goal/);
  assert.equal(first.entries.find((entry) => entry.type === "custom").data.kind, "continue");

  const checkpoint = decideGoalTurnEnd({ ...base, continuations: 3 });
  assert.match(checkpoint.entries.find((entry) => entry.type === "custom_message").content, /^Checkpoint:/);

  const spent = decideGoalTurnEnd({ ...base, continuations: 8 });
  assert.equal(spent.continue, false);
  assert.equal(spent.entries.find((entry) => entry.type === "custom").data.kind, "budget_exhausted");
  assert.match(spent.entries.find((entry) => entry.type === "custom_message").content, /budget is exhausted/);

  assert.equal(decideGoalTurnEnd({ ...base, status: "awaiting_acceptance" }), null);
  assert.equal(decideGoalTurnEnd({ ...base, status: "accepted" }), null);
  assert.equal(decideGoalTurnEnd({ ...base, status: "stopped" }), null);
  assert.equal(decideGoalTurnEnd({ ...base, status: "budget_exhausted" }), null);

  const previous = [{ type: "custom", customType: "another-extension", data: {} }];
  const merged = decideGoalTurnEnd(base, previous);
  assert.equal(merged.entries[0].customType, "another-extension", "other boundary drafts are preserved");
});

test("/goal runs autonomously until the continuation budget is spent", async (t) => {
  const { directory, manager, session, requests } = await createFixture();
  t.after(async () => {
    await session.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  const settled = nextSettle(session);
  await session.prompt("/goal ship the fixture");
  await settled;

  assert.equal(requests.length, 9, "one initial turn plus eight continuations");
  const entries = goalEntries(manager);
  assert.equal(entries.filter((entry) => entry.data?.kind === "start").length, 1);
  assert.equal(entries.filter((entry) => entry.data?.kind === "continue").length, 8);
  assert.equal(entries.filter((entry) => entry.data?.kind === "budget_exhausted").length, 1);

  const state = readSessionGoalState(manager);
  assert.equal(state.status, "budget_exhausted");
  assert.equal(state.continuations, 8);
  assert.equal(state.maxContinuations, 8);
  assert.equal(state.goal, "ship the fixture");

  const continuationMessages = manager
    .getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === GOAL_CONTINUATION_TYPE);
  assert.equal(continuationMessages.length, 9);
  assert.match(continuationMessages.at(-1).content, /budget is exhausted/);

  assert.match(requestPrompt(requests[0]), /<pi-desktop-goal>/);
  assert.match(requestPrompt(requests[0]), /Goal: ship the fixture/);
  assert.match(requestPrompt(requests[0]), /Goal mode is active/);

  // A fresh manager over the persisted file derives the same state.
  const reopened = SessionManager.open(manager.getSessionFile());
  assert.deepEqual(readSessionGoalState(reopened), state);
});

test("accepting the goal clears the prompt block and stops continuing", async (t) => {
  const { directory, manager, policy, session, requests } = await createFixture();
  const wrapper = new AgentSessionWrapper(session, [], () => undefined, policy);
  t.after(async () => {
    await wrapper.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  const settled = nextSettle(session);
  await session.prompt("/goal ship the fixture");
  await settled;
  assert.equal(readSessionGoalState(manager).status, "budget_exhausted");

  await wrapper.send({ type: "goal_resolve", action: "accept" });
  assert.equal(readSessionGoalState(manager).status, "accepted");
  const before = requests.length;

  const followUp = nextSettle(session);
  await session.prompt("summarize what is done");
  await followUp;
  assert.equal(requests.length, before + 1, "an accepted goal never continues on its own");
  assert.doesNotMatch(requestPrompt(requests.at(-1)), /<pi-desktop-goal>/);
});

test("adding budget resumes the goal for the extra turns", async (t) => {
  const { directory, manager, policy, session, requests } = await createFixture();
  const wrapper = new AgentSessionWrapper(session, [], () => undefined, policy);
  t.after(async () => {
    await wrapper.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  const settled = nextSettle(session);
  await session.prompt("/goal ship the fixture");
  await settled;
  assert.equal(requests.length, 9);

  const resumed = nextSettle(session);
  await wrapper.send({ type: "goal_resolve", action: "extend" });
  await resumed;

  const state = readSessionGoalState(manager);
  assert.equal(state.status, "budget_exhausted");
  assert.equal(state.continuations, 12);
  assert.equal(state.maxContinuations, 12);
  assert.equal(requests.length, 14, "the resumed run plus four more continuation turns");
  const extendEntry = goalEntries(manager).findLast(
    (entry) => entry.data?.kind === "resolve" && entry.data.action === "extend",
  );
  assert.equal(extendEntry.data.extra, 4);
});
