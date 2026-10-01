import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
type Call = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export async function runSessionToolsUiChecks(window: BrowserWindow, call: Call, sessionId: string): Promise<void> {
  const tools = await call<Array<{ name: string; active: boolean }>>("agent.command", {
    sessionId,
    command: { type: "get_tools" },
  });
  if (tools.some((tool) => tool.name.startsWith("mcp__")))
    throw new Error("General tool UI fixture unexpectedly contains MCP server tools");
  await window.webContents.executeJavaScript(`(async () => {
    const until = async (read) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { const value = read(); if(value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw new Error('Session tool settings did not settle');
    };
    (await until(() => Array.from(document.querySelectorAll('button[aria-label]')).find(button => button.getAttribute('aria-label')?.includes('MCP smoke session')))).click();
    (await until(() => document.querySelector('button[title="Settings"], button[title="设置"]'))).click();
    (await until(() => document.querySelector('#settings-tab-session-tools'))).click();
    (await until(() => { const button = document.querySelector('[data-tool-preset="full"]'); return button && !button.disabled && button; })).click();
    await until(() => ['codemode', 'tool_search'].every(name => { const input = document.querySelector('[data-session-orchestration] input[aria-label="' + name + '"]'); return input?.checked && !input.disabled; }));
    document.querySelector('[data-session-orchestration] input[aria-label="codemode"]').click();
    await until(() => !document.querySelector('[data-session-orchestration] input[aria-label="codemode"]').checked && !document.querySelector('[data-tool-preset="full"]').disabled);
    await until(() => Array.from(document.querySelectorAll('button[aria-label]')).some(button => ['Custom', '自定义', '自訂'].some(label => button.getAttribute('aria-label')?.includes(label))));
    document.querySelector('[data-tool-preset="full"]').click();
    await until(() => ['codemode', 'tool_search'].every(name => document.querySelector('[data-session-orchestration] input[aria-label="' + name + '"]')?.checked));
    Array.from(document.querySelectorAll('[role="dialog"] button[aria-label]')).find(button => ['Close', '关闭', '關閉'].includes(button.getAttribute('aria-label'))).click();
  })()`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Session tool UI reload timed out")), 15000);
    window.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
    window.webContents.reload();
  });
  const restored = await call<Array<{ name: string; active: boolean }>>("agent.command", {
    sessionId,
    command: { type: "get_tools" },
  });
  if (!["codemode", "tool_search"].every((name) => restored.some((tool) => tool.name === name && tool.active)))
    throw new Error("Full access lost general tool entries after reload");
  await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const sidebar = Array.from(document.querySelectorAll('button[aria-label]')).find(button => button.getAttribute('aria-label')?.includes('MCP smoke session'));
      const settings = document.querySelector('button[title="Settings"], button[title="设置"]');
      if (sidebar && settings) { sidebar.click(); settings.click(); return true; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Could not reopen session tool settings');
  })()`);
  const presentation = String.raw`async (language, theme, restore = false) => {
    const until = async (read) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) { const value = read(); if(value) return value; await new Promise(resolve=>setTimeout(resolve,25)); }
      throw new Error('General tool presentation did not settle');
    };
    const set = (element, value) => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('change', {bubbles:true}));
    };
    (await until(() => document.querySelector('#settings-tab-general'))).click();
    const languageControl = await until(() => Array.from(document.querySelectorAll('select')).find(select => Array.from(select.options).some(option => option.value === 'en-US')));
    const themeControl = await until(() => Array.from(document.querySelectorAll('select')).find(select => Array.from(select.options).some(option => option.value === 'dark')));
    const previous = {language: languageControl.value, theme: themeControl.value};
    set(languageControl, language); set(themeControl, theme);
    await until(() => document.documentElement.lang === language && document.documentElement.classList.contains('dark') === (theme === 'dark'));
    if(restore) return {previous};
    document.querySelector('#settings-tab-session-tools').click();
    await until(() => ['codemode','tool_search'].every(name => { const input = document.querySelector('[data-session-orchestration] input[aria-label="' + name + '"]'); return input?.checked && !input.disabled; }));
    const root = document.querySelector('[data-session-tools-config]'), bounds = root.getBoundingClientRect();
    if(root.scrollWidth > root.clientWidth + 1) throw new Error('Session tool settings overflow horizontally');
    for(const element of root.querySelectorAll('button,input')) {
      const rect = element.getBoundingClientRect();
      if(rect.left < bounds.left || rect.right > bounds.right + 1) throw new Error('Session tool control overflows its pane');
    }
    root.querySelector('[data-tool-preset="full"]').focus();
    await new Promise(resolve => setTimeout(resolve, 350));
    return {previous};
  }`;
  const bounds = window.getBounds(),
    minimum = window.getMinimumSize();
  let previous: { language: string; theme: string } | undefined;
  try {
    window.setMinimumSize(600, minimum[1]);
    for (const width of [1440, 900]) {
      window.setBounds({ ...bounds, width });
      for (const language of ["en-US", "zh-CN", "zh-TW"])
        for (const theme of ["light", "dark"]) {
          const result = await window.webContents.executeJavaScript(
            `(${presentation})(${JSON.stringify(language)},${JSON.stringify(theme)})`,
          );
          previous ??= result.previous;
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
          if (
            !(await window.webContents.executeJavaScript(
              "Boolean(document.activeElement?.closest('[data-session-tools-config]'))",
            ))
          )
            throw new Error("Session tool settings lost keyboard focus");
          const directory = process.env.PI_DESKTOP_MCP_PRESENTATION_DIR;
          if (directory) {
            await mkdir(directory, { recursive: true });
            await writeFile(
              path.join(directory, `session-tools-${language}-${theme}-${width}.png`),
              (await window.webContents.capturePage()).toPNG(),
            );
          }
          console.log(`Session tools presentation passed: ${language}, ${theme}, width=${width}`);
        }
    }
  } finally {
    window.setMinimumSize(minimum[0], minimum[1]);
    window.setBounds(bounds);
    if (previous)
      await window.webContents.executeJavaScript(
        `(${presentation})(${JSON.stringify(previous.language)},${JSON.stringify(previous.theme)},true)`,
      );
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('[role=\"dialog\"] button[aria-label]')).find(button => ['Close','关闭','關閉'].includes(button.getAttribute('aria-label')))?.click()",
    );
  }
  console.log(
    "General session tool entries passed: no MCP configuration, full access, manual toggle, reload and child grant isolation",
  );
}
