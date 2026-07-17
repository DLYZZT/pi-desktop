<div align="center">

<img src="./build/icon.png" width="112" alt="Pi Agent Desktop icon" />

# Pi Agent Desktop

**Turn Pi Coding Agent into a full desktop workspace.**

Local-first · No local server · Cross-platform

[![Desktop Build](https://github.com/DLYZZT/pi-desktop/actions/workflows/build-desktop.yml/badge.svg)](https://github.com/DLYZZT/pi-desktop/actions/workflows/build-desktop.yml)
![Electron 43](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=0B1F2A)
![macOS & Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)

**English** · [简体中文](./README.md)

[Features](#features) · [Quick start](#quick-start) · [Architecture](#architecture) · [Contributing](#contributing) · [Build and release](#build-and-release)

</div>

## Features

### A complete agent workspace

- Create, switch, rename, and delete sessions with continuously streamed responses
- Search and browse sessions by date while using stable titles in both the sidebar and conversation header
- Inspect tool calls, execution progress, and context compaction status
- Queue messages and use Steer or Follow-up interaction modes
- Quickly switch models, reasoning levels, tool presets, and notification sounds
- Attach images, run slash commands, and reference project files with `@`
- Keep chat and composer content aligned to one reading width, with a mouse- and keyboard-resizable file panel that remembers its width

### A project-focused file experience

- Select project directories natively and manage Git branches and worktrees
- Browse project files, open multiple tabs, download files, or reference them in prompts
- Preview Markdown, syntax-highlighted code, Mermaid, KaTeX, and Word (`.docx`) documents
- Keep sessions aligned with the project through file watching and Git status awareness

### Unified model and extension management

- Manage model providers and model configurations
- Sign in through browser-based OAuth flows
- Search for, install, and configure Skills
- Manage Plugins while continuing to use the Pi Agent extension ecosystem

### WeChat, Telegram, and Feishu/Lark channels

- Connect personal WeChat with QR login, Telegram with a BotFather token, or a Feishu/Lark self-built app with an App ID and App Secret
- Protect direct messages with pairing and Telegram or Feishu/Lark groups with allowlists and mention requirements; WeChat groups are not enabled yet, and remote tools are disabled by default
- Give each external conversation an isolated Pi Session by default, or bind it from the active desktop session to share history and context with the UI; the binding list stays within the window and scrolls internally when long
- Send only the user's actual IM text as the model's user prompt; the desktop distinguishes sources with black local, green WeChat, blue Telegram, and orange Feishu/Lark user bubbles without adding user or group IDs to the prompt
- Keep channels running in the background with long polling or WebSocket, reconnects, event deduplication, and cursor/offset checkpoints
- Receive images, files, and voice messages from WeChat, Telegram, and Feishu/Lark, plus Feishu/Lark video resources; images enter the model as multimodal input, while other attachments use an isolated staging area and WeChat SILK audio is converted to WAV when possible
- When the user explicitly requests a file, return an existing or newly created file from the current workspace by linking it in the final answer; each attachment is limited to 20 MiB and four per message, with paths outside the workspace and symlink escapes rejected
- Stream Rich Message previews in Telegram private chats, preserve Markdown in the final response, and collapse reasoning and tool details; groups receive a rich final response
- Receive Feishu/Lark DMs, controlled groups, and threads through the official SDK long connection; Card JSON 2.0 renders Markdown, streams thinking/tool progress, and folds process details in the final card with safe fallback when CardKit is unavailable
- Show turn-status reactions on the source message in Telegram and Feishu/Lark; Feishu DMs can invoke `/help`, `/status`, `/new`, `/compact`, and `/reload` from a native bot menu
- Encrypt channel credentials with Electron `safeStorage`; saved tokens and App Secrets are never returned to the Renderer

### Designed for long-running desktop use

- Single-instance behavior, system tray, desktop notifications, and Dock/taskbar badges
- Window-state persistence, system theme integration, and custom protocol handling
- Agent Host crash recovery, crash reports, and diagnostic exports
- Electron `sandbox: true`, a strict Content Security Policy, and typed IPC contracts

## Quick start

### Use a desktop build

Pi Agent Desktop bundles the Pi Coding Agent runtime. Regular users do not need to install the Pi CLI, Pi Coding Agent, Node.js, or npm separately. Install the desktop application, configure a model provider, and start working.

The application reads sessions and configuration from `~/.pi/agent/`. If you already use the Pi CLI, your existing data is available without migration. The desktop application also works if you have never used the CLI. Installing some Skills or npm Plugins from the internet may still require Node.js and npm.

### Desktop system requirements

- macOS 12 Monterey or later, on Apple Silicon (arm64) or Intel (x64)
- 64-bit Windows 10 or Windows 11 on x64; Windows 11 is recommended because it remains under regular security support
- Windows 32-bit (x86) and Windows ARM64 installers are not currently provided

### Development requirements

- Node.js 22.19 or later
- npm, included with Node.js
- macOS or Windows; Linux can be used for development, but official Linux builds are not currently published

### Run locally

```bash
git clone https://github.com/DLYZZT/pi-desktop.git
cd pi-desktop
npm ci
npm run dev
```

### Download a preview build

CI currently produces the following unsigned installers:

- macOS Apple Silicon (arm64): DMG and ZIP
- macOS Intel (x64): DMG and ZIP
- Windows (x64): NSIS installer

Download artifacts from a successful [GitHub Actions build](https://github.com/DLYZZT/pi-desktop/actions/workflows/build-desktop.yml). Artifacts are retained for 14 days. Because the builds are not signed yet, the operating system may show an unknown-developer or security warning. Running from source is currently recommended.

## Architecture

Pi Agent Desktop uses a three-process Electron architecture to isolate privileged desktop capabilities, the Agent runtime, and the UI.

```mermaid
flowchart LR
    Main["Electron Main<br/>Window · tray · protocol · Host supervision"]
    Host["Agent Host / utilityProcess<br/>Pi Agent · sessions · files · configuration"]
    UI["Renderer<br/>React 19 · Vite"]
    Data["~/.pi/agent/<br/>Sessions · models · configuration"]

    Main --> Host
    Main --> UI
    UI <-->|"Typed MessagePort IPC"| Host
    Host <--> Data
```

- **Main** manages the window lifecycle, menus, tray, notifications, custom protocols, and Agent Host supervision
- **Agent Host** runs Pi Coding Agent in an isolated `utilityProcess` and handles sessions, files, configuration, and extensions
- **Renderer** hosts the React UI and communicates only through controlled preload bridges
- **No local service** means production does not listen on TCP ports or bundle a web server

## Data, security, and privacy

- Sessions and Pi configuration remain in `~/.pi/agent/` by default
- The application does not open an additional local network port for UI communication
- The Renderer runs in the Electron sandbox with a strict Content Security Policy
- Preload exposes only controlled bridge APIs, and TypeScript contracts constrain Host RPC
- WeChat and Telegram use outbound-only long polling, while Feishu/Lark uses an outbound WebSocket; none opens a webhook or local listener
- Model providers determine how model request data is processed; review the privacy policy of every provider you configure

## Contributing

### Common commands

| Command                  | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `npm run dev`            | Start Vite, Main process build watch, and Electron    |
| `npm run typecheck`      | Run TypeScript type checking                          |
| `npm run test`           | Run the automated test suite                          |
| `npm run check:contract` | Verify coverage between API methods and Host handlers |
| `npm run smoke`          | Run Electron smoke tests                              |
| `npm run verify`         | Run the complete pre-commit quality gate              |
| `npm run build`          | Build Main, preload, and Renderer                     |
| `npm run pack`           | Generate the unpacked application directory           |
| `npm run dist`           | Build every configured architecture for this platform |

### Project structure

```text
src/
├── contract/      # IPC type contracts and RPC layer
├── main/          # Electron Main process
├── preload/       # Secure bridge APIs
├── agent-host/    # Agent, sessions, files, configuration, and watchers
├── renderer/      # React desktop UI
└── shared/        # Testable pure functions and shared modules
```

Use [Issues](https://github.com/DLYZZT/pi-desktop/issues) for bug reports and suggestions. Pull requests are also welcome. Before submitting code, run at least:

```bash
npm run verify
```

## Build and release

Run the complete quality gate before submitting changes or producing an installer:

```bash
npm run verify
```

Local build commands:

```bash
npm run build  # Build the application
npm run pack   # Generate an unpacked application directory
npm run dist   # Build every configured architecture for this platform
```

On an Apple Silicon Mac, the macOS configuration builds both arm64 and x64, so the first package run also downloads the x64 Electron archive into `~/Library/Caches/electron/`. An `EOF` while downloading from `release-assets.githubusercontent.com` normally indicates an interrupted GitHub Release CDN transfer; rerunning can reuse completed architectures and the local cache. The trailing `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` is an electron-builder wrapper error and does not necessarily mean that a local executable lacks permission. For repeated failures, follow the cache verification and recovery steps in [`docs/learn.md`](./docs/learn.md#83-packdist-与跨架构-electron-缓存).

GitHub Actions builds artifacts for macOS arm64, macOS x64, and Windows x64 separately. Current artifacts are unsigned. A public release still requires macOS notarization, Windows code signing, and installation testing on each target platform.

## Roadmap

- [x] Electron three-process architecture and typed IPC
- [x] Sessions, project files, models, Skills, Plugins, and OAuth
- [x] Personal WeChat, Telegram, and Feishu/Lark text, image, file, and voice channels, plus Feishu/Lark video resources
- [x] Tray, notifications, system theme, crash recovery, and diagnostic exports
- [x] macOS arm64, macOS x64, and Windows x64 CI build matrix
- [ ] macOS code signing and notarization
- [ ] Windows code signing
- [ ] End-to-end automatic update validation
- [ ] Expanded cross-platform E2E and pre-release testing

## Relationship to the Pi ecosystem

Pi Agent Desktop is a desktop workspace for Pi Coding Agent. It continues to use sessions and configuration from `~/.pi/agent/`, so it can be used alongside the CLI.

Plugins continue to load through Pi's package manager and runtime. Extension APIs that only make sense in the terminal TUI, such as custom terminal components or raw key listeners, cannot be represented equivalently in the desktop Renderer. The application reports an explicit compatibility message instead of silently ignoring them.

## License

[Apache License 2.0](./LICENSE)
