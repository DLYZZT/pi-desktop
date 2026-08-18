import { copyFile, open } from "node:fs/promises";
import path from "node:path";
import {
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  shell,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from "electron";
import type { ShowFileContextMenuRequest, ShowFileContextMenuResult } from "../contract/desktop";
import { getFileAssociations, openWithDialog, runOpenWith } from "./file-associations";
import {
  MAX_CONTEXT_TEXT_FILE_BYTES,
  validateFileContextRequest,
  validateFileContextRequestResult,
  type ValidatedFileContextTarget,
} from "./file-context-policy";

type FileMenuLabels = ReturnType<typeof fileMenuLabels>;
const ASSOCIATION_LOOKUP_TIMEOUT_MS = 1_800;

async function getBoundedFileAssociations(filePath: string) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      getFileAssociations(filePath),
      new Promise<{ defaultApp: null; handlers: [] }>((resolve) => {
        timer = setTimeout(() => resolve({ defaultApp: null, handlers: [] }), ASSOCIATION_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fileMenuLabels(language: ShowFileContextMenuRequest["language"]) {
  if (language === "zh-CN") {
    return {
      openFile: "打开文件",
      openIn: (name: string) => `使用 ${name} 打开`,
      openWith: "打开方式",
      chooseAnother: "选择其他应用…",
      saveAs: "另存为…",
      copyPath: "复制路径",
      copyContents: "复制文件内容",
      showInFolder: "在文件夹中显示",
      cut: "剪切",
      copy: "复制",
      paste: "粘贴",
      selectAll: "全选",
      openBrowser: "在浏览器中打开",
      copyLink: "复制链接地址",
      search: (text: string) => `用 Google 搜索“${text}”`,
    };
  }
  return {
    openFile: "Open file",
    openIn: (name: string) => `Open in ${name}`,
    openWith: "Open with",
    chooseAnother: "Choose another app…",
    saveAs: "Save as…",
    copyPath: "Copy path",
    copyContents: "Copy file contents",
    showInFolder: "Show in folder",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
    openBrowser: "Open in browser",
    copyLink: "Copy link address",
    search: (text: string) => `Search Google for “${text}”`,
  };
}

function appendTextItems(
  template: MenuItemConstructorOptions[],
  params: ContextMenuParams,
  win: BrowserWindow,
  labels: FileMenuLabels,
) {
  let added = false;
  if (params.isEditable) {
    if (params.editFlags.canCut) template.push({ label: labels.cut, role: "cut" });
    if (params.editFlags.canCopy) template.push({ label: labels.copy, role: "copy" });
    if (params.editFlags.canPaste) template.push({ label: labels.paste, role: "paste" });
    added = params.editFlags.canCut || params.editFlags.canCopy || params.editFlags.canPaste;
  } else if (params.selectionText.trim().length > 0) {
    const selection = params.selectionText.trim();
    template.push(
      { label: labels.copy, click: () => clipboard.writeText(params.selectionText) },
      {
        label: labels.search(selection.slice(0, 42)),
        click: () => void shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(selection)}`),
      },
    );
    added = true;
  }
  if (added || template.length > 0) template.push({ type: "separator" });
  template.push({ label: labels.selectAll, click: () => void win.webContents.selectAll() });
}

async function saveFileAs(win: BrowserWindow, sourcePath: string): Promise<void> {
  const result = await dialog.showSaveDialog(win, { defaultPath: path.basename(sourcePath) });
  if (result.canceled || !result.filePath) return;
  try {
    await copyFile(sourcePath, result.filePath);
    shell.showItemInFolder(result.filePath);
  } catch {
    // The destination may disappear or become unwritable after the dialog.
  }
}

async function isReadableTextTarget(target: ValidatedFileContextTarget): Promise<boolean> {
  if (!target.allowCopyContents || !target.isFile || target.size > MAX_CONTEXT_TEXT_FILE_BYTES) return false;
  try {
    const handle = await open(target.path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_CONTEXT_TEXT_FILE_BYTES) return false;
      const probe = Buffer.alloc(Math.min(8192, before.size));
      const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
      return !probe.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function copyValidatedFileContents(target: ValidatedFileContextTarget): Promise<void> {
  if (!target.allowCopyContents) return;
  try {
    const handle = await open(target.path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_CONTEXT_TEXT_FILE_BYTES) return;
      const data = await handle.readFile();
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || data.includes(0))
        return;
      clipboard.writeText(data.toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort after an explicit user action.
  }
}

export async function buildValidatedFileContextMenu(
  win: BrowserWindow,
  target: ValidatedFileContextTarget,
  language: ShowFileContextMenuRequest["language"],
  params?: ContextMenuParams,
): Promise<MenuItemConstructorOptions[]> {
  const labels = fileMenuLabels(language);
  const template: MenuItemConstructorOptions[] = [];
  const associations = target.isFile
    ? await getBoundedFileAssociations(target.path)
    : { defaultApp: null, handlers: [] };

  template.push({ label: labels.openFile, click: () => void shell.openPath(target.path) });
  if (associations.defaultApp) {
    template.push({
      label: labels.openIn(associations.defaultApp.name),
      click: () => runOpenWith(associations.defaultApp!.command, target.path),
    });
  }
  if (process.platform === "win32" && target.isFile) {
    const openWithItems: MenuItemConstructorOptions[] = associations.handlers.map((handler) => ({
      label: handler.name,
      click: () => runOpenWith(handler.command, target.path),
    }));
    if (openWithItems.length > 0) openWithItems.push({ type: "separator" });
    openWithItems.push({ label: labels.chooseAnother, click: () => openWithDialog(target.path) });
    template.push({ label: labels.openWith, submenu: openWithItems });
  }

  template.push({ type: "separator" });
  if (target.isFile) template.push({ label: labels.saveAs, click: () => void saveFileAs(win, target.path) });
  template.push({ label: labels.copyPath, click: () => clipboard.writeText(target.path) });
  template.push({
    label: labels.copyContents,
    enabled: await isReadableTextTarget(target),
    click: () => void copyValidatedFileContents(target),
  });
  template.push({ label: labels.showInFolder, click: () => shell.showItemInFolder(target.path) });
  if (params) appendTextItems(template, params, win, labels);
  return template;
}

export async function showFileContextMenu(win: BrowserWindow, request: unknown): Promise<ShowFileContextMenuResult> {
  const validation = await validateFileContextRequestResult(request);
  if (!validation.ok) return { shown: false, code: validation.code };
  const target = validation.target;
  const language = (request as ShowFileContextMenuRequest).language;
  try {
    const template = await buildValidatedFileContextMenu(win, target, language);
    if (win.isDestroyed()) return { shown: false, code: "UNAVAILABLE" };
    Menu.buildFromTemplate(template).popup({ window: win });
    return { shown: true };
  } catch {
    return { shown: false, code: "UNAVAILABLE" };
  }
}

export function setupContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const labels = fileMenuLabels("en-US");
    if (/^file:/i.test(params.linkURL)) {
      void validateFileContextRequest({ href: params.linkURL, source: "rendered-agent-text", language: "en-US" })
        .then(async (target) => {
          if (!target || win.isDestroyed()) return;
          const template = await buildValidatedFileContextMenu(win, target, "en-US", params);
          if (!win.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: win });
        })
        .catch(() => undefined);
      return;
    }

    const template: MenuItemConstructorOptions[] = [];
    if (/^https?:\/\//i.test(params.linkURL)) {
      template.push(
        { label: labels.openBrowser, click: () => void shell.openExternal(params.linkURL) },
        { label: labels.copyLink, click: () => clipboard.writeText(params.linkURL) },
      );
    }
    appendTextItems(template, params, win, labels);
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
