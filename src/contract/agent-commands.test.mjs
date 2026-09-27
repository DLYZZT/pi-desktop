import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { isAgentCommand } from "./agent-commands.ts";

test("open command envelopes retain extension fields while rejecting missing or non-string types", () => {
  for (const value of [null, undefined, [], "prompt", {}, { type: 1 }, { type: "  " }]) {
    assert.equal(isAgentCommand(value), false);
  }
  const extension = { type: "future_sdk_command", payload: { selection: [1, 2] }, custom: true };
  assert.equal(isAgentCommand(extension), true);
  assert.deepEqual(extension, { type: "future_sdk_command", payload: { selection: [1, 2] }, custom: true });
  assert.equal(isAgentCommand({ type: "prompt", message: "/extension-command argument" }), true);
});

for (const separator of ["/", "\\"])
  test(`builtin command types remain checked with ${separator === "/" ? "forward-slash" : "backslash"} fixture paths`, () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const config = ts.readConfigFile(path.join(root, "tsconfig.renderer.json"), ts.sys.readFile);
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const filename = path.join(root, "src/renderer/lib/__agent-command-type-fixture.ts");
    const virtualFilename = filename.replace(/[\\/]/g, separator);
    const source = `
    import { sendAgentCommand } from './agent-client';
    import { agentCommand } from './api-client';
    async function verify() {
      const tools = await sendAgentCommand('session', {type: 'get_tools'});
      const active: boolean = tools[0].active;
      const text = await sendAgentCommand('session', {type: 'get_last_assistant_text'});
      const content: string = text.text;
      const fork = await sendAgentCommand('session', {type: 'fork', entryId: 'entry'});
      if (!fork.cancelled) {const id: string = fork.newSessionId;}
      await sendAgentCommand('session', {type: 'extension_ui_response', id: 'request', cancelled: true});
      await sendAgentCommand('session', {type: 'prompt', message: '/extension-custom', images: [{type: 'image', data: 'a', mimeType: 'image/png'}]});
      // @ts-expect-error model selection requires modelId as well as provider
      await sendAgentCommand('session', {type: 'set_model', provider: 'fixture'});
      // @ts-expect-error tool names must be strings
      await sendAgentCommand('session', {type: 'set_tools', toolNames: [1]});
      // @ts-expect-error response must carry a result or cancellation
      await sendAgentCommand('session', {type: 'extension_ui_response', id: 'request'});
      // @ts-expect-error builtins cannot silently accept a mistyped command name
      await sendAgentCommand('session', {type: 'set_modle', provider: 'fixture', modelId: 'model'});
      // @ts-expect-error callers cannot choose an arbitrary result shape
      await sendAgentCommand<{madeUp: boolean}>('session', {type: 'get_tools'});
      // @ts-expect-error results do not expose an unrelated operation's fields
      text.cancelled;
      const dynamic: string = 'future_sdk_command';
      const raw = await agentCommand('session', {type: dynamic, payload: {custom: true}});
      // @ts-expect-error open transport results require explicit narrowing
      raw.text;
    }
  `;
    const host = ts.createCompilerHost(options);
    // TypeScript normalizes source filenames to forward slashes on every platform.
    const canonical = (file) => host.getCanonicalFileName(file.replaceAll("\\", "/"));
    const fixtureKey = canonical(virtualFilename);
    const isFixture = (file) => canonical(file) === fixtureKey;
    const originalFileExists = host.fileExists.bind(host);
    const originalReadFile = host.readFile.bind(host);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (file) => isFixture(file) || originalFileExists(file);
    host.readFile = (file) => (isFixture(file) ? source : originalReadFile(file));
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
      isFixture(file)
        ? ts.createSourceFile(file, source, languageVersion, true)
        : originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([filename, path.join(root, "src/renderer/global.d.ts")], options, host);
    assert.ok(program.getSourceFile(filename), "the virtual fixture must be included in type checking");
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
  });
