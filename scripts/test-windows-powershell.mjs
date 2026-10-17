import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDesktopPowerShellTool,
  createToolchainPowerShellOptions,
} from "../src/agent-host/toolchain-powershell.ts";
import { ToolchainManager } from "../src/main/toolchains/manager.ts";
import { probeSucceeded, runProbeCommand } from "../src/main/toolchains/process-runner.ts";

// Native shells can expand the runner's 8.3 TEMP aliases and normalize casing.
const canonicalPath = (value) => realpathSync.native(value).toLowerCase();

for (const edition of ["5.1", "7"])
  test(
    `native Windows PowerShell ${edition}: transport, encoding, exit and lifecycle`,
    { skip: process.platform !== "win32", timeout: 60000 },
    async (t) => {
      const executable =
        edition === "5.1"
          ? path.join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            )
          : (process.env.PI_DESKTOP_TEST_PWSH ??
            path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"));
      assert.ok(
        path.isAbsolute(executable) && existsSync(executable),
        `PowerShell ${edition} is required for native acceptance`,
      );
      const root = mkdtempSync(path.join(tmpdir(), "pi-powershell-中文 space-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const context = {
        inventoryRevision: 1,
        resolutionId: "native-acceptance",
        summary: [],
        commands: {
          "shell.powershell": {
            capability: "shell.powershell",
            provider: "custom",
            executable,
            argvPrefix: [],
            binDir: path.dirname(executable),
            envPatch: {},
            cwdSemantics: "native",
          },
        },
        // No Git Bash or secondary PowerShell on PATH: every call must use the chosen absolute executable.
        nativeEnv: { ...process.env, PATH: root, Path: root },
        shellEnv: { PATH: "SHOULD_NOT_BE_USED" },
      };
      const tool = createDesktopPowerShellTool(root, context);
      const run = (command) => tool.execute("native", { command, timeout: 15 });
      const report = await run(
        "$o=@{version=$PSVersionTable.PSVersion.ToString();exe=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName;cwd=(Get-Location).Path};$o|ConvertTo-Json -Compress",
      );
      const data = JSON.parse(report.structuredContent.output);
      assert.ok(data.version.startsWith(edition + ".") || data.version === edition);
      assert.equal(canonicalPath(data.exe), canonicalPath(executable));
      assert.equal(canonicalPath(data.cwd), canonicalPath(root));
      t.diagnostic(`PowerShell ${data.version}, selected executable verified`);
      const unicode = await run(
        `$s='中文 "双引号" 和 ''单引号''';[Console]::WriteLine($s)\n[Console]::Error.WriteLine('错误流中文')`,
      );
      assert.match(unicode.structuredContent.output, /中文 "双引号" 和 '单引号'/);
      assert.match(unicode.structuredContent.output, /错误流中文/);
      assert.doesNotMatch(unicode.structuredContent.output, /#< CLIXML/);
      const streams = await run(
        "Write-Error '錯誤消息中文'; Write-Information '信息流中文' -InformationAction Continue; Write-Output 'continued'",
      );
      assert.equal(streams.structuredContent.exit_code, 0);
      assert.match(streams.structuredContent.output, /錯誤消息中文/);
      assert.match(streams.structuredContent.output, /信息流中文/);
      assert.doesNotMatch(streams.structuredContent.output, /#< CLIXML/);
      for (const [command, code] of [
        ["exit 7", 7],
        ["throw 'expected failure'", 1],
        ["& $env:SystemRoot\\System32\\cmd.exe /d /c exit 9", 1],
        ["& $env:SystemRoot\\System32\\cmd.exe /d /c exit 9; exit $LASTEXITCODE", 9],
        ["Write-Error 'nonterminating'; Write-Output 'continued'", 0],
        ["Write-Error 'final error'", 1],
        ["return 'early return'", 0],
        ["Write-Output 'trailing comment' # no trailing newline", 0],
      ]) {
        const result = await run(command);
        assert.equal(result.structuredContent.exit_code, code, command);
        assert.equal(Boolean(result.isError), code !== 0);
      }
      const long = await run(`$text='${'中文"'.repeat(1800)}'; Write-Output $text.Length`);
      assert.equal(long.structuredContent.exit_code, 0);
      const marker = path.join(root, "must-not-exist.txt");
      await assert.rejects(
        run(`Set-Content '${marker.replaceAll("'", "''")}' BAD\n#${"x".repeat(20000)}`),
        (error) => error.code === "TOOL_COMMAND_TOO_LONG",
      );
      assert.equal(existsSync(marker), false);
      // Unlike the Node transport fixture, a native Windows shell keeps its
      // inherited output pipe usable when the parent exits before its child.
      const ready = path.join(root, "tail-ready").replaceAll("'", "''");
      const tailCode = Buffer.from(
        `[Console]::WriteLine('TAIL:0');[IO.File]::WriteAllText('${ready}','ready');for($i=1;$i -le 1000;$i++){[Console]::WriteLine(('TAIL:'+$i+' '+('x'*4096)))}`,
        "utf16le",
      ).toString("base64");
      let tail = "";
      const tailResult = await createToolchainPowerShellOptions(context).operations.exec(
        `$child=Start-Process -FilePath '${executable.replaceAll("'", "''")}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${tailCode}' -NoNewWindow -PassThru;while(-not (Test-Path '${ready}')){Start-Sleep -Milliseconds 5};exit 0`,
        root,
        {
          timeout: 15,
          onData: (chunk) => {
            tail += chunk;
          },
        },
      );
      assert.equal(tailResult.exitCode, 0);
      assert.equal((tail.match(/TAIL:\d+/g) ?? []).length, 1001);
      assert.ok(tail.endsWith(`TAIL:1000 ${"x".repeat(4096)}\r\n`));
      for (const abort of [true, false]) {
        const controller = new globalThis.AbortController();
        let childPid,
          output = "";
        const childCode = Buffer.from("Start-Sleep -Seconds 60", "utf16le").toString("base64");
        const script = `$child=Start-Process -FilePath '${executable.replaceAll("'", "''")}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${childCode}' -WindowStyle Hidden -PassThru;[Console]::WriteLine('CHILD:'+$child.Id);Start-Sleep -Seconds 60`;
        try {
          await assert.rejects(
            createToolchainPowerShellOptions(context).operations.exec(script, root, {
              signal: controller.signal,
              timeout: abort ? 15 : 3,
              onData: (chunk) => {
                output += String(chunk);
                const match = output.match(/(?:^|\n)CHILD:(\d+)\r?\n/);
                if (match) {
                  childPid = Number(match[1]);
                  if (abort) controller.abort();
                }
              },
            }),
            abort ? /aborted/ : /timeout:3/,
          );
          assert.ok(childPid);
          assert.throws(
            () => process.kill(childPid, 0),
            (error) => error.code === "ESRCH",
          );
          childPid = undefined;
        } finally {
          if (childPid)
            try {
              process.kill(childPid, "SIGKILL");
            } catch {
              /* the fixture process already exited */
            }
        }
      }
    },
  );

test(
  "native Windows PowerShell selection follows rescans and explicit paths without Bash",
  {
    skip: process.platform !== "win32",
    timeout: 60000,
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-powershell-selection-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const inbox = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const seven =
      process.env.PI_DESKTOP_TEST_PWSH ??
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    let executables = [inbox];
    // Control discovery, not the probes: every selected candidate is executed by
    // the production probe and tool. No machine installation is modified.
    const manager = new ToolchainManager({
      userDataRoot: root,
      env: { ...process.env, Path: root, PATH: root },
      executor: {
        async run(command) {
          const result = await runProbeCommand(command);
          if (!probeSucceeded(result))
            t.diagnostic(
              `PowerShell probe failed: ${JSON.stringify({ ...result, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) })}`,
            );
          return result;
        },
      },
      registry: {
        collect: async () =>
          executables.map((executable) => ({
            capability: "shell.powershell",
            provider: "system",
            discovery: "native-acceptance",
            executable,
            argvPrefix: [],
            binDir: path.dirname(executable),
            rank: 1,
          })),
      },
    });
    const verify = async (expected) => {
      const resolution = await manager.resolveForProject(root);
      assert.equal(resolution.commands["shell.bash"], undefined);
      const selected = resolution.commands["shell.powershell"];
      assert.equal(
        selected ? canonicalPath(selected.executable) : undefined,
        expected ? canonicalPath(expected) : undefined,
      );
      if (selected) {
        const tool = createDesktopPowerShellTool(root, {
          ...resolution,
          nativeEnv: { ...process.env, Path: root, PATH: root },
        });
        const result = await tool.execute("selection", {
          command: "[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName",
          timeout: 15,
        });
        assert.equal(canonicalPath(result.structuredContent.output.trim()), canonicalPath(expected));
      }
      return resolution;
    };
    await manager.initialize();
    const first = await verify(inbox);
    executables = [inbox, seven];
    await manager.rescan();
    await verify(seven);
    assert.equal(canonicalPath(first.commands["shell.powershell"].executable), canonicalPath(inbox));
    await manager.registerCustomTool("shell.powershell", inbox);
    await verify(inbox);
    executables = [seven];
    await manager.performAction({ action: "set-preference", capability: "shell.powershell", preference: "system" });
    await verify(seven);
    executables = [inbox];
    await manager.rescan();
    await verify(inbox);
    executables = [];
    await manager.rescan();
    await verify(undefined);
    t.diagnostic(
      "Real probes/executions: 5.1-only, coexistence preferring 7, explicit 5.1, switch to system 7, fallback, unavailable; Bash absent from inventory/PATH",
    );
  },
);
