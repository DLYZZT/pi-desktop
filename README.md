# Pi Agent Desktop (v2)

纯桌面架构的 Pi Coding Agent 应用——**零服务器、零端口**，基于 Electron 三进程模型。

> 设计文档见相邻仓库 `pi-app/pi-app-design.md`。  
> 浏览器 / `npx pi-web` 模式仍由旧仓库 `@dlyzzt/pi-app` 维护。

## 架构

```
Main (窗口/菜单/协议/Host 监督)
  ├── Agent Host (utilityProcess)  — pi-coding-agent in-process + RPC
  └── Renderer (Vite + React 19)   — UI，经 MessagePort 直连 Host
```

- **无 TCP 监听**：UI ↔ Host 走 Electron `MessagePort` typed IPC
- **数据互通**：会话与配置仍在 `~/.pi/agent/`，与 CLI 完全共享
- **sandbox: true** + 严格 CSP

## 开发

```bash
npm install
npm run dev          # Vite + tsup watch + Electron
```

## 构建

```bash
npm run build        # out/main + out/preload + out/renderer
npm run pack         # electron-builder --dir
npm run dist         # 安装包
```

## 脚本

| 命令 | 说明 |
|------|------|
| `npm run typecheck` | TS 检查 |
| `npm run test` | shared 纯函数测试 |
| `npm run check:contract` | Api 方法 ↔ Host handler 覆盖 |
| `npm run smoke` | Electron 冒烟 |

## 目录

```
src/
  contract/      IPC 契约（类型 + RPC 小层）
  main/          Electron main
  preload/       piBridge
  agent-host/    SessionRegistry / 文件 / 配置 / watcher
  renderer/      React SPA（组件从 pi-app 迁移）
  shared/        纯函数库（带测试）
```

## 里程碑状态

| 阶段 | 状态 |
|------|------|
| M1 骨架（三进程 + 契约 + Vite） | ✅ |
| M2 会话核心 | ✅（RPC + 迁移 UI） |
| M3 项目与文件 | 🟡（list/read/index 可用；watch 简化） |
| M4 配置 / OAuth | 🟡（models/skills 可用；OAuth 流待完整接线） |
| M5 桌面化 | 🟡（通知/badge/菜单/deep link/目录选择） |
| M6 发布 | ⏳ |
