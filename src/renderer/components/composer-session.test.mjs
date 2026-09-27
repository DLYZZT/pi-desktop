import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement, useState } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { RpcError } from "../../contract/types.ts";

const { ChatInput, useAgentSession, api } = await importTestBundle("composer-session", {
  stdin: {
    contents:
      'export {ChatInput} from "./ChatInput.tsx"; export {useAgentSession} from "../hooks/useAgentSession.ts"; export * as api from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "composer-session-transport",
      setup(build) {
        build.onResolve({ filter: /^(?:@\/lib\/api-client|\.\/api-client)$/ }, () => ({
          path: "api",
          namespace: "composer-test",
        }));
        build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: "i18n", namespace: "composer-test" }));
        build.onLoad({ filter: /.*/, namespace: "composer-test" }, ({ path }) => ({
          contents:
            path === "i18n"
              ? `
      const t = (_key, fallback) => fallback; export const useI18n = () => ({t, language:'en-US'});
    `
              : `
      export const requests = [], streams = [];
      let cwd, running;
      export function reset(directory, active) {requests.length = streams.length = 0; cwd=directory; running=active;}
      function pending(method, params, commandType) {
        return new Promise((resolve,reject) => requests.push({method,params,commandType,resolve,reject,settled:false}));
      }
      export const newAgent = params => pending('agent.new', params, 'ensure_session');
      export async function agentCommand(sessionId, command) {
        if(command.type === 'get_tools')return [];
        if(command.type === 'get_commands')return {commands:[]};
        return pending('agent.command', {sessionId,command}, command.type);
      }
      export const agentState = async () => ({running, state:{isStreaming:running, isPromptRunning:running}});
      export const getSession = async (id) => ({sessionId:id,info:{id,cwd,firstMessage:'fixture',messageCount:0},tree:[],leafId:null,
        context:{messages:[],entryIds:[],model:null,thinkingLevel:'off',historyRevision:'fixture',totalMessages:0,loadedMessages:0,truncatedBefore:false},agentState:await agentState()});
      export const listModels = async () => ({models:[],catalog:{source:'cache',refreshed:false,aborted:false,warnings:[]}});
      export async function subscribeAgentEvents(key, on) {const stream={key,on,closed:0}; streams.push(stream); return()=>stream.closed++;}
      export async function subscribeSessionsChanged(on) {const stream={key:'*',on,closed:0}; streams.push(stream); return()=>stream.closed++;}
      export const fileIndex = async () => ({files:[],truncated:false});
      const unexpected = async () => {throw new Error('Unexpected composer session IO');};
      export {unexpected as call,unexpected as getSessionContext,unexpected as getSessionContextPage,unexpected as getSessionEntryContent,unexpected as refreshModels,unexpected as cancelModelsRefresh};
    `,
        }));
      },
    },
  ],
});

let fixtureNumber = 0;
const text = (node) => (typeof node === "string" ? node : (node?.children?.map(text).join("") ?? ""));
async function mount(t, { existing = false, running = false } = {}) {
  const cwd = `/composer-fixture-${++fixtureNumber}`;
  const initialId = `existing-${fixtureNumber}`;
  const previous = new Map(
    [
      "window",
      "document",
      "localStorage",
      "navigator",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "IS_REACT_ACT_ENVIRONMENT",
    ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const values = new Map([["pi-desktop:autoSessionTitle", "off"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const frames = new Map();
  let frameId = 0;
  const install = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("localStorage", storage);
  install("navigator", { language: "en-US" });
  install("window", {
    innerHeight: 900,
    localStorage: storage,
    navigator: globalThis.navigator,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    piBridge: {
      platform: "darwin",
      inspectLocalFiles: async ({ paths }) =>
        paths.map((path) => ({ path, exists: true, isFile: true, insideCwd: true })),
    },
  });
  install("document", {
    visibilityState: "visible",
    activeElement: null,
    body: {},
    documentElement: { lang: "en-US" },
    addEventListener() {},
    removeEventListener() {},
  });
  install("requestAnimationFrame", (callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  install("cancelAnimationFrame", (id) => frames.delete(id));
  t.mock.method(console, "error", () => {});
  api.reset(cwd, running);
  const promotions = [];
  let current, renderer;
  function Harness() {
    const [session, setSession] = useState(existing ? { id: initialId, cwd } : null);
    current = useAgentSession({
      session,
      newSessionCwd: session ? null : cwd,
      onSessionCreated(next) {
        promotions.push(next);
        setSession(next);
      },
    });
    return createElement(ChatInput, {
      cwd,
      draftKey: session?.id ?? `new:${cwd}`,
      draftPromotionFrom: !existing && session ? `new:${cwd}` : undefined,
      isStreaming: current.agentRunning,
      onSend: current.handleSend,
      onAbort: current.handleAbort,
      onBuiltinCommand: current.handleBuiltinSlashCommand,
      onSteer: current.agentRunning ? current.handleSteer : undefined,
      onFollowUp: current.agentRunning ? current.handleFollowUp : undefined,
      onPromptWithStreamingBehavior: current.agentRunning ? current.handlePromptWithStreamingBehavior : undefined,
    });
  }
  const textarea = {
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    scrollHeight: 24,
    style: {},
    focus() {
      globalThis.document.activeElement = this;
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(async () => {
    await unmount();
    await act(async () => {
      for (const request of api.requests)
        if (!request.settled) {
          request.settled = true;
          request.reject(new Error("Fixture ended"));
        }
    });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(async () => {
    renderer = create(createElement(Harness), {
      createNodeMock: (element) => (element.type === "textarea" ? textarea : null),
    });
  });
  const next = (type) => {
    const found = api.requests.find((request) => request.commandType === type && !request.settled);
    assert.ok(found, `No pending ${type}`);
    return found;
  };
  return {
    cwd,
    values,
    promotions,
    unmount,
    next,
    get current() {
      return current;
    },
    value: () => renderer.root.findByType("textarea").props.value,
    text: () => text(renderer.root),
    count: (type) => api.requests.filter((request) => request.commandType === type).length,
    async type(value) {
      textarea.value = value;
      textarea.selectionStart = textarea.selectionEnd = value.length;
      await act(async () => renderer.root.findByType("textarea").props.onChange({ target: textarea }));
    },
    async enter(times = 1) {
      await act(async () => {
        const onKeyDown = renderer.root.findByType("textarea").props.onKeyDown;
        for (let i = 0; i < times; i++)
          onKeyDown({
            key: "Enter",
            shiftKey: false,
            nativeEvent: { isComposing: false, keyCode: 13 },
            preventDefault() {},
          });
      });
    },
    async click(label) {
      const button = renderer.root.find((node) => node.type === "button" && text(node) === label);
      await act(async () => {
        void button.props.onClick();
      });
    },
    async reply(type, value) {
      const request = next(type);
      request.settled = true;
      await act(async () => request.resolve(value));
    },
    async reject(type) {
      const request = next(type);
      request.settled = true;
      await act(async () =>
        request.reject(new RpcError({ code: "CONFLICT", message: "Fixture rejected the operation" })),
      );
    },
  };
}

test("creation failure restores the real composer draft and retry promotes the allocated ID once", async (t) => {
  const f = await mount(t);
  await f.type("create this session");
  await f.enter(2);
  assert.equal(f.count("ensure_session"), 1);
  assert.equal(f.value(), "");
  await f.reject("ensure_session");
  assert.equal(f.value(), "create this session");
  assert.equal(f.current.agentRunning, false);
  assert.equal(f.count("prompt"), 0);
  assert.equal(f.promotions.length, 0);
  await f.enter();
  await f.reply("ensure_session", { sessionId: "created-once" });
  await f.reply("prompt", null);
  assert.equal(f.promotions.length, 1);
  assert.equal(f.promotions[0].id, "created-once");
  assert.equal(f.count("ensure_session"), 2);
  assert.equal(f.count("prompt"), 1);
  assert.equal(f.value(), "");
});

test("a failed first prompt retains the allocated session and retry does not allocate or promote it twice", async (t) => {
  const f = await mount(t);
  await f.type("first prompt");
  await f.enter();
  await f.reply("ensure_session", { sessionId: "retained-session" });
  await f.reject("prompt");
  assert.equal(f.value(), "first prompt");
  assert.equal(f.current.agentRunning, false);
  assert.equal(f.promotions.length, 0);
  await f.enter();
  assert.equal(f.next("prompt").params.sessionId, "retained-session");
  await f.reply("prompt", null);
  assert.equal(f.count("ensure_session"), 1);
  assert.equal(f.count("prompt"), 2);
  assert.equal(f.promotions.length, 1);
});

test("a failed creation cannot overwrite text entered after the send was cleared", async (t) => {
  const f = await mount(t);
  await f.type("earlier draft");
  await f.enter();
  await f.type("newer draft");
  await f.reject("ensure_session");
  assert.equal(f.value(), "newer draft");
  assert.match(f.text(), /newer draft was kept/);
});

test("new-session promotion carries the live draft to the persistent session key", async (t) => {
  const f = await mount(t);
  await f.type("first prompt");
  await f.enter();
  await f.reply("ensure_session", { sessionId: "promoted-with-draft" });
  await f.type("next draft");
  await f.reply("prompt", null);
  assert.equal(f.value(), "next draft");
  await f.unmount();
  assert.equal(JSON.parse(f.values.get("pi-desktop-draft:promoted-with-draft")).value, "next draft");
  assert.equal(f.values.has(`pi-desktop-draft:new:${f.cwd}`), false);
});

test("restored sessions reconcile the actual tool list even when idle", async (t) => {
  const f = await mount(t, { existing: true });
  assert.equal(f.current.agentRunning, false);
  assert.equal(f.current.toolPreset, "none");
});

for (const mode of ["steer", "follow_up", "queued-prompt"])
  for (const newerDraft of [false, true]) {
    test(`${mode} rejection ${newerDraft ? "preserves newer input" : "restores the submitted draft"} through the actual session callback`, async (t) => {
      const f = await mount(t, { existing: true, running: true });
      assert.equal(f.current.agentRunning, true);
      const message = mode === "queued-prompt" ? "/fixture queued instruction" : "queue this draft";
      await f.type(message);
      await f.click(mode === "steer" ? "Steer" : "Follow-up");
      const command = mode === "queued-prompt" ? "prompt" : mode;
      assert.equal(f.value(), "");
      if (mode === "queued-prompt") assert.equal(f.next(command).params.command.streamingBehavior, "followUp");
      if (newerDraft) await f.type("newer queue draft");
      await f.reject(command);
      assert.equal(f.value(), newerDraft ? "newer queue draft" : message);
      assert.match(f.text(), newerDraft ? /newer draft was kept/ : /draft was restored/);
      assert.equal(f.count(command), 1);
      assert.equal(f.current.agentRunning, true);
    });
  }

test("a built-in command failure restores the draft and a successful retry never sends a prompt", async (t) => {
  const f = await mount(t, { existing: true });
  await f.type("/name composer fixture");
  await f.enter();
  assert.equal(f.next("set_session_name").params.command.name, "composer fixture");
  assert.equal(f.value(), "");
  await f.reject("set_session_name");
  assert.equal(f.value(), "/name composer fixture");
  await f.enter();
  await f.type("new draft while renaming");
  await f.reply("set_session_name", null);
  assert.equal(f.count("set_session_name"), 2);
  assert.equal(f.count("prompt"), 0);
  assert.equal(f.count("ensure_session"), 0);
  assert.equal(f.value(), "new draft while renaming");
});
