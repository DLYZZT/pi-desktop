import type { MenuItemConstructorOptions } from "electron";
import type { AppLanguage } from "../shared/app-language";

// Include role labels explicitly: Electron otherwise uses the OS language,
// which can differ from the language selected in the app.
const labels: Record<string, [string, string]> = {
  File: ["文件", "檔案"],
  Edit: ["编辑", "編輯"],
  View: ["视图", "檢視"],
  Window: ["窗口", "視窗"],
  Help: ["帮助", "說明"],
  "Check for Updates…": ["检查更新…", "檢查更新…"],
  "Settings…": ["设置…", "設定…"],
  "New Session": ["新建会话", "新增對話"],
  "Switch Session…": ["切换会话…", "切換對話…"],
  "Open Logs Folder": ["打开日志文件夹", "開啟記錄資料夾"],
  "Export Diagnostics…": ["导出诊断信息…", "匯出診斷資訊…"],
  "Learn More": ["了解更多", "瞭解更多"],
};

const roleLabels: Record<string, [string, string, string]> = {
  about: ["About Pi Agent Desktop", "关于 Pi Agent Desktop", "關於 Pi Agent Desktop"],
  services: ["Services", "服务", "服務"],
  hide: ["Hide Pi Agent Desktop", "隐藏 Pi Agent Desktop", "隱藏 Pi Agent Desktop"],
  hideOthers: ["Hide Others", "隐藏其他应用", "隱藏其他應用程式"],
  unhide: ["Show All", "显示全部", "顯示全部"],
  quit: ["Quit Pi Agent Desktop", "退出 Pi Agent Desktop", "結束 Pi Agent Desktop"],
  close: ["Close Window", "关闭窗口", "關閉視窗"],
  undo: ["Undo", "撤销", "復原"],
  redo: ["Redo", "重做", "重做"],
  cut: ["Cut", "剪切", "剪下"],
  copy: ["Copy", "复制", "複製"],
  paste: ["Paste", "粘贴", "貼上"],
  selectAll: ["Select All", "全选", "全選"],
  reload: ["Reload", "重新加载", "重新載入"],
  forceReload: ["Force Reload", "强制重新加载", "強制重新載入"],
  toggleDevTools: ["Toggle Developer Tools", "切换开发者工具", "切換開發人員工具"],
  resetZoom: ["Actual Size", "实际大小", "實際大小"],
  zoomIn: ["Zoom In", "放大", "放大"],
  zoomOut: ["Zoom Out", "缩小", "縮小"],
  togglefullscreen: ["Toggle Full Screen", "切换全屏", "切換全螢幕"],
  minimize: ["Minimize", "最小化", "最小化"],
  zoom: ["Zoom", "缩放窗口", "縮放視窗"],
  front: ["Bring All to Front", "全部置于前端", "將全部視窗移至最前方"],
};

export function localizeMenuTemplate(
  template: MenuItemConstructorOptions[],
  language: AppLanguage,
): MenuItemConstructorOptions[] {
  const index = language === "en-US" ? 0 : language === "zh-CN" ? 1 : 2;
  return template.map((item) => {
    const customLabels = item.label ? labels[item.label] : undefined;
    const label =
      customLabels && index > 0
        ? customLabels[index - 1]
        : (item.label ?? (item.role ? roleLabels[item.role]?.[index] : undefined));
    return {
      ...item,
      ...(label ? { label } : {}),
      ...(Array.isArray(item.submenu) ? { submenu: localizeMenuTemplate(item.submenu, language) } : {}),
    };
  });
}
