import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";

export async function captureSettingsReferences(window: BrowserWindow): Promise<void> {
  const directory = process.env.PI_DESKTOP_SETTINGS_REFERENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  for (const [name, labels] of [
    ["models", ["Models", "模型"]],
    ["skills", ["Skills", "技能"]],
    ["mcp-before", ["MCP"]],
  ] as const) {
    await window.webContents.executeJavaScript(`(async () => {
      const labels=${JSON.stringify(labels)};
      const button=Array.from(document.querySelectorAll('button[role="tab"]')).find(button=>labels.includes(button.textContent.trim()));
      if(!button) throw new Error('Reference setting tab not found');
      button.click();
      await new Promise(resolve=>setTimeout(resolve,400));
    })()`);
    await writeFile(path.join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
}
