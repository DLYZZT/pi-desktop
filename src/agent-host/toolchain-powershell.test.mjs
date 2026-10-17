import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";
const {
  createToolchainPowerShellOptions,
  createDesktopPowerShellTool,
  powerShellArguments,
  createDesktopSessionTools,
  captureExecutionOutput,
  ExecutionLogStore,
} = await importTestBundle("desktop-powershell", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
    export * from "./toolchain-powershell.ts";
    export {createDesktopSessionTools} from "./desktop-session-tools.ts";
    export {captureExecutionOutput} from "./execution-output.ts";
    export {ExecutionLogStore} from "./execution-log-store.ts";`,
  },
});

function fixture(t, mode = "report") {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ps-中文 space-"));
  const program = path.join(root, "transport fixture.cjs");
  // This is a transport/lifecycle fixture, not a PowerShell interpreter or Windows acceptance substitute.
  writeFileSync(
    program,
    `const {spawn} = require('node:child_process');
    const mode = process.env.FIXTURE_MODE;
    const report = () => console.log(JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2),
      command:Buffer.from(process.argv.at(-1).split("'")[1],'base64').toString('utf16le'), env:process.env}));
    if(mode==='flood' || mode==='flood-block') { process.stdout.write('输出\\n'.repeat(12000)); process.stderr.write('错误尾部'); if(mode==='flood-block')setInterval(()=>{},1000);else process.exitCode=7; }
    else if(mode==='split-utf8') {
      const out=Buffer.from('甲😀'), error=Buffer.from('乙🐈');
      process.stdout.write(out.subarray(0,1));
      setTimeout(()=>{process.stderr.write(error.subarray(0,2));
        setTimeout(()=>{process.stdout.write(out.subarray(1));
          setTimeout(()=>process.stderr.write(error.subarray(2)),30);
        },30);
      },30);
    }
    else if(mode==='incomplete-utf8') { process.stdout.write(Buffer.from('甲').subarray(0,1)); process.stderr.write(Buffer.from('乙').subarray(0,2)); }
    else if(mode==='tree') {
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      console.log('CHILD:'+child.pid); setInterval(()=>{},1000);
    } else if(mode==='tail') {
      const child=spawn(process.execPath,['-e',"console.log('TAIL:0');process.send('ready');process.disconnect();let n=0;function write(){while(n<1000){if(!process.stdout.write('TAIL:'+ ++n+' '+ 'x'.repeat(4096)))return process.stdout.once('drain',write)}}write()"],{stdio:['ignore',process.stdout,process.stderr,'ipc']});
      child.once('message',()=>process.exit());
    } else if(mode==='delay') setTimeout(report,150);
    else report();`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const descriptor = {
    capability: "shell.powershell",
    provider: "custom",
    executable: process.execPath,
    argvPrefix: [program],
    cwdSemantics: "native",
    binDir: path.dirname(process.execPath),
    envPatch: {},
  };
  const context = {
    inventoryRevision: 1,
    resolutionId: "fixture-1",
    commands: { "shell.powershell": descriptor },
    nativeEnv: {
      PATH: root,
      SystemRoot: process.env.SystemRoot,
      FIXTURE_MODE: mode,
      SAFE: "kept",
      XAI_API_KEY: "SECRET",
      pi_model: "STALE_MODEL",
      PI_SESSION_ID: "STALE_SESSION",
    },
    shellEnv: { PATH: "/msys/should-not-be-used", MSYSTEM: "MINGW64" },
    summary: [],
  };
  return { root, descriptor, context };
}

test("PowerShell pins the resolved executable, preserves quoted Unicode scripts and uses only sanitized native environment", async (t) => {
  const { root, context } = fixture(t);
  const options = createToolchainPowerShellOptions(context);
  const command = `Write-Output '中文 "quoted"'\n$x = '$literal'; Write-Output $x`;
  const spawned = options.spawnHook({
    command,
    cwd: root,
    env: { PATH: "HOST_PATH", HOST_TOKEN: "SECRET", PI_MODEL: "current", PI_SESSION_ID: "public-session" },
  });
  let output = "";
  const result = await options.operations.exec(command, root, {
    env: spawned.env,
    onData: (chunk) => {
      output += chunk;
    },
  });
  assert.equal(result.exitCode, 0);
  const report = JSON.parse(output);
  assert.equal(realpathSync(report.cwd), realpathSync(root));
  assert.ok(report.command.endsWith(command + "\nexit ([int](-not $?))"));
  assert.match(report.command, /\[Console\]::OutputEncoding/);
  assert.deepEqual(report.args.slice(0, -1), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-OutputFormat",
    "Text",
    "-Command",
  ]);
  assert.equal(report.env.PATH, root);
  assert.equal(report.env.PI_MODEL, "current");
  assert.equal(report.env.PI_SESSION_ID, "public-session");
  assert.equal(report.env.pi_model, undefined);
  assert.equal(report.env.MSYSTEM, undefined);
  assert.equal(report.env.XAI_API_KEY, undefined);
  assert.equal(report.env.HOST_TOKEN, undefined);
});

test("PowerShell rejects oversized commands, missing capability and stale paths without PATH fallback", async (t) => {
  const { root, context, descriptor } = fixture(t);
  let low = 0,
    high = 20000;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    try {
      powerShellArguments(descriptor, "x".repeat(middle));
      low = middle;
    } catch {
      high = middle;
    }
  }
  assert.ok(low > 1000);
  assert.doesNotThrow(() => powerShellArguments(descriptor, "x".repeat(low)));
  let inspected = false;
  const options = createToolchainPowerShellOptions(context, undefined, async () => {
    inspected = true;
  });
  await assert.rejects(
    options.operations.exec("x".repeat(high), root, { onData: () => {} }),
    (error) => error.code === "TOOL_COMMAND_TOO_LONG",
  );
  assert.equal(inspected, false);
  const missing = createToolchainPowerShellOptions({ ...context, commands: {} });
  await assert.rejects(
    missing.operations.exec("exit 0", root, { onData: () => {} }),
    (error) => error.code === "TOOLCHAIN_CAPABILITY_REQUIRED",
  );
  const stale = createToolchainPowerShellOptions({
    ...context,
    commands: { "shell.powershell": { ...descriptor, executable: path.join(root, "missing-powershell.exe") } },
  });
  await assert.rejects(stale.operations.exec("exit 0", root, { onData: () => {} }), (error) => error.code === "ENOENT");
  const aborted = globalThis.AbortSignal.abort("用户取消");
  await assert.rejects(options.operations.exec("exit 0", root, { signal: aborted, onData: () => {} }), /aborted/);
  assert.equal(inspected, false, "rejected commands never reach the pre-execution hook");
});

test(
  "abort while awaiting the raw-command policy check does not wait for or execute a late approval",
  { timeout: 3000 },
  async (t) => {
    const { root, context } = fixture(t);
    const entered = createDeferred(),
      approval = createDeferred(),
      controller = new globalThis.AbortController();
    t.after(() => approval.resolve());
    const command = "iwr 'https://blocked.example/path'";
    const options = createToolchainPowerShellOptions(context, undefined, async (raw) => {
      assert.equal(raw, command);
      entered.resolve();
      await approval.promise;
    });
    let bytes = 0;
    const pending = options.operations.exec(command, root, {
      signal: controller.signal,
      onData: (data) => {
        bytes += data.length;
      },
    });
    await entered.promise;
    controller.abort();
    await assert.rejects(pending, /aborted/);
    approval.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bytes, 0);
  },
);

test("PowerShell preserves split UTF-8 characters independently across stdout and stderr", async (t) => {
  const { root, context } = fixture(t, "split-utf8");
  const result = await createDesktopPowerShellTool(root, context).execute("split", { command: "fixture output" });
  assert.equal(result.structuredContent.exit_code, 0);
  assert.deepEqual([...result.structuredContent.output].sort(), [..."甲😀乙🐈"].sort());
});

test("PowerShell flushes each incomplete UTF-8 tail once when its pipes close", async (t) => {
  const { root, context } = fixture(t, "incomplete-utf8");
  const result = await createDesktopPowerShellTool(root, context).execute("incomplete", { command: "fixture output" });
  assert.equal(result.structuredContent.output, "\uFFFD\uFFFD");
});

test("PowerShell SDK output streams, records nonzero status and persists the full output after truncation", async (t) => {
  const { root, context } = fixture(t, "flood");
  const updates = [];
  const tool = createDesktopPowerShellTool(root, context);
  assert.equal(tool.name, "powershell");
  assert.equal(tool.defaultActive, false);
  const result = await tool.execute("test", { command: "fixture output" }, undefined, (update) => updates.push(update));
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.exit_code, 7);
  assert.ok(updates.length > 0);
  assert.ok(result.details.fullOutputPath);
  const store = new ExecutionLogStore("powershell-output", root);
  const payload = await captureExecutionOutput(store, "powershell", result);
  const full = payload.value ?? (await store.readContent(payload.ref.hash, payload.ref.bytes));
  assert.match(typeof full === "string" ? full : JSON.stringify(full), /错误尾部/);
  // Separate pipes have no total ordering; stderr may arrive between stdout characters.
  assert.equal(
    (typeof full === "string" ? full : JSON.stringify(full)).replace("错误尾部", "").match(/输出/g).length,
    12000,
  );
  assert.equal(full.split("\n").length, 12001, "the fixture emits real lines, not literal backslash-n sequences");
  rmSync(result.details.fullOutputPath, { force: true });
});

for (const cancel of [true, false])
  test(
    `PowerShell ${cancel ? "abort" : "timeout"} settles and terminates the child tree`,
    { timeout: 10000 },
    async (t) => {
      const { root, context } = fixture(t, "tree");
      const controller = new globalThis.AbortController();
      let pid,
        output = "";
      const options = createToolchainPowerShellOptions(context);
      t.after(() => {
        if (pid)
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* the fixture process already exited */
          }
      });
      await assert.rejects(
        options.operations.exec("fixture tree", root, {
          signal: controller.signal,
          timeout: cancel ? 5 : 0.3,
          onData: (chunk) => {
            output += String(chunk);
            const match = output.match(/(?:^|\n)CHILD:(\d+)\r?\n/);
            if (match) {
              pid = Number(match[1]);
              if (cancel) controller.abort();
            }
          },
        }),
        cancel ? /aborted/ : /timeout:0.3/,
      );
      assert.ok(pid);
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          assert.equal(error.code, "ESRCH");
          pid = undefined;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("descendant is still alive after cancellation");
    },
  );

test(
  "PowerShell drains output still arriving through descendant pipes after the shell exits",
  {
    // A Node parent disconnects its Windows named pipe on exit, even when a child
    // inherited it. test-windows-powershell.mjs covers this with real native shells.
    skip: process.platform === "win32",
  },
  async (t) => {
    const { root, context } = fixture(t, "tail");
    let output = "";
    await createToolchainPowerShellOptions(context).operations.exec("fixture tail", root, {
      timeout: 5,
      onData: (chunk) => {
        output += chunk;
      },
    });
    assert.match(output, /TAIL:1000/);
  },
);

test("cancelled PowerShell output keeps the SDK spill path for durable history", async (t) => {
  const { root, context } = fixture(t, "flood-block");
  const controller = new globalThis.AbortController();
  const tool = createDesktopPowerShellTool(root, context);
  const result = await tool.execute(
    "cancelled-output",
    { command: "fixture output", timeout: 5 },
    controller.signal,
    (update) => {
      if (update.details?.fullOutputPath) controller.abort();
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /aborted/);
  assert.ok(result.details.fullOutputPath);
  const store = new ExecutionLogStore("cancelled-powershell", root);
  const payload = await captureExecutionOutput(store, "powershell", result);
  assert.ok(payload.value || payload.ref);
  rmSync(result.details.fullOutputPath, { force: true });
});

test("toolchain reload replaces future executions while the running PowerShell keeps its captured context", async (t) => {
  const { root, context } = fixture(t, "delay");
  let next = context,
    check;
  const runtime = {
    createExecutionContext: async () => next,
    requireFromContext: (_capability, ctx) => ctx.commands["shell.powershell"],
  };
  const tools = await createDesktopSessionTools(
    root,
    { getSessionId: () => "fixture" },
    { isProjectTrusted: () => false, getShellCommandPrefix: () => undefined },
    { tool: () => ({ name: "history", execute: async () => ({ content: [] }) }) },
    { runtime, platform: "win32" },
  );
  const wrapper = { setToolchainSummary() {} },
    policy = {
      isAllowed: () => true,
      setAvailability(fn) {
        check = fn;
      },
    };
  tools.attach(wrapper, policy);
  const powershell = tools.customTools.find((tool) => tool.name === "powershell");
  const first = powershell.execute("one", { command: "one" });
  next = { ...context, inventoryRevision: 2, nativeEnv: { ...context.nativeEnv, SAFE: "new" } };
  await wrapper.refreshToolchain();
  const second = await powershell.execute("two", { command: "two" });
  assert.equal(JSON.parse((await first).structuredContent.output).env.SAFE, "kept");
  assert.equal(JSON.parse(second.structuredContent.output).env.SAFE, "new");
  assert.equal(check("powershell"), true);
  next = { ...next, commands: {} };
  await wrapper.refreshToolchain();
  assert.equal(check("powershell"), false);
});
