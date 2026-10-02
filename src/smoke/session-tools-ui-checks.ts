import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
type Call = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export async function runSessionToolsUiChecks(window: BrowserWindow, call: Call, sessionId: string): Promise<void> {
  const until = async (names: string[], enabled: boolean) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const tools = await call<Array<{ name: string; active: boolean }>>("agent.command", {
        sessionId,
        command: { type: "get_tools" },
      });
      if (names.every((name) => tools.some((tool) => tool.name === name && tool.active === enabled))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Conversation tool preset did not update its registered tools");
  };
  const select = String.raw`async (labels) => {
    const until = async (read) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { const value = read(); if(value) return value; await new Promise(resolve => setTimeout(resolve,25)); }
      throw new Error('Conversation tool menu did not appear');
    };
    const sidebar = await until(() => Array.from(document.querySelectorAll('button[aria-label]')).find(button => button.getAttribute('aria-label')?.includes('MCP smoke session')));
    sidebar.click();
    await until(() => document.body.innerText.includes('MCP_BOOTSTRAP'));
    const trigger = await until(() => Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find(button => ['Change permission settings','更改权限设置','變更權限設定'].some(label => button.getAttribute('aria-label')?.startsWith(label))));
    trigger.click();
    (await until(() => Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(button => labels.some(label => button.textContent?.trim().startsWith(label))))).click();
  }`;
  await window.webContents.executeJavaScript(`(${select})(["Full access","完全访问","完整存取"])`);
  await until(["codemode", "tool_search"], true);
  await window.webContents.executeJavaScript(`(${select})(["Read only","只读","唯讀"])`);
  await until(["read", "codemode", "tool_search"], false);
  await window.webContents.executeJavaScript(`(${select})(["Full access","完全访问","完整存取"])`);
  await until(["codemode", "tool_search"], true);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Conversation tool preset reload timed out")), 15000);
    window.webContents.once("did-finish-load", () => {
      clearTimeout(timeout);
      resolve();
    });
    window.webContents.reload();
  });
  await until(["codemode", "tool_search"], true);
  await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const settings = document.querySelector('button[title="Settings"],button[title="设置"],button[title="設定"]');
      if(settings) { settings.click(); break; }
      await new Promise(resolve => setTimeout(resolve,25));
    }
    while(Date.now() < deadline) {
      if(document.querySelector('#settings-tab-mcp')) {
        if(document.querySelector('#settings-tab-session-tools, [data-session-tools-config]')) throw new Error('Duplicate session tool settings are still present');
        return true;
      }
      await new Promise(resolve => setTimeout(resolve,25));
    }
    throw new Error('Settings navigation did not appear');
  })()`);
  const directory = process.env.PI_DESKTOP_MCP_PRESENTATION_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "settings-without-session-tools.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  await window.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('[role=\"dialog\"] button[aria-label]')).find(button => ['Close','关闭','關閉'].includes(button.getAttribute('aria-label')))?.click()",
  );
  console.log(
    "Conversation tool presets passed: full access, no-tools, restored orchestration entries, reload and no duplicate settings page",
  );
}
