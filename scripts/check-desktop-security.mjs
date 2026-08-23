#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const main = read("src/main/main.ts");
const windowFactory = read("src/main/window.ts");
const protocol = read("src/main/protocol.ts");
const html = read("src/renderer/index.html");
const preload = read("src/preload/preload.ts");
const globals = read("src/renderer/global.d.ts");
const diagnostics = read("src/main/diagnostics.ts");
const diagnosticsRedaction = read("src/main/diagnostics-redaction.ts");
const fileViewer = read("src/renderer/components/FileViewer.tsx");
const credentialVault = read("src/main/credential-vault.ts");
const weixinChannelApi = read("src/agent-host/channels/adapters/weixin/api.ts");
const telegramChannelApi = read("src/agent-host/channels/adapters/telegram/api.ts");
const feishuChannelApi = read("src/agent-host/channels/adapters/feishu/api.ts");
const channelManager = read("src/agent-host/channels/channel-manager.ts");
const channelMediaStore = read("src/agent-host/channels/media-store.ts");
const channelOutboundFiles = read("src/agent-host/channels/outbound-files.ts");
const channelPiBridge = read("src/agent-host/channels/pi-session-bridge.ts");
const rpcManager = read("src/agent-host/rpc-manager.ts");
const weixinMedia = read("src/agent-host/channels/adapters/weixin/media.ts");
const channelContract = read("src/contract/api.ts");
const desktopContract = read("src/contract/desktop.ts");
const desktopIpc = read("src/main/ipc.ts");
const desktopIpcTrust = read("src/main/ipc-trust.ts");
const updateAdapter = read("src/main/update-adapter.ts");
const updateManager = read("src/main/update-manager.ts");
const electronBuilderConfig = read("electron-builder.yml");
const desktopBuildWorkflow = read(".github/workflows/build-desktop.yml");
const toolchainContractCheck = read("scripts/check-toolchain-contract.mjs");
const upstreamToolchainCatalogCheck = read("scripts/verify-toolchain-catalog-upstream.mjs");
const bundledToolsBuild = read("scripts/prepare-bundled-tools.mjs");
const packagedToolchainVerifier = read("scripts/verify-packaged-toolchains.mjs");
const toolchainSearch = read("src/agent-host/toolchain-search.ts");
const toolchainInstaller = read("src/main/toolchains/installer.ts");
const toolchainManager = read("src/main/toolchains/manager.ts");
const electronRuntimeFetch = read("src/main/toolchains/electron-runtime-fetch.ts");
const legacyNpmCommand = read("src/main/toolchains/legacy-npm-command.ts");
const toolchainStateStore = read("src/main/toolchains/state-store.ts");
const verifyScript = read("scripts/verify.mjs");
const browserContract = read("src/contract/browser.ts");
const browserSettings = read("src/main/browser/browser-settings.ts");
const browserPolicy = read("src/main/browser/browser-policy.ts");
const browserService = read("src/main/browser/browser-service.ts");
const browserAuthorization = read("src/main/browser/browser-authorization-coordinator.ts");
const browserGrantStore = read("src/main/browser/browser-persistent-grant-store.ts");
const browserTools = read("src/agent-host/browser-tools.ts");
const browserTabs = read("src/main/browser/browser-tab-manager.ts");
const browserDevToolsShortcut = read("src/main/browser/browser-devtools-shortcut.ts");
const browserNetwork = read("src/main/browser/browser-network-interceptor.ts");
const browserIdentity = read("src/main/browser/browser-identity-manager.ts");
const browserRecorder = read("src/main/browser/browser-network-recorder.ts");
const browserConsole = read("src/main/browser/browser-console-buffer.ts");
const browserInspectionStore = read("src/main/browser/browser-inspection-store.ts");
const browserRedaction = read("src/main/browser/browser-redaction.ts");
const browserSnippets = read("src/main/browser/browser-snippet-store.ts");
const browserVault = read("src/main/browser/browser-secret-vault.ts");
const browserAgentRuntime = read("src/agent-host/browser-agent-runtime.ts");
const toolchainBash = read("src/agent-host/toolchain-bash.ts");
const toolchainRuntime = read("src/agent-host/toolchain-runtime.ts");
const toolEnvironment = read("src/agent-host/tool-environment.ts");
const packageJson = read("package.json");
const windowsHelperCargo = read("native/windows-managed-process-helper/Cargo.toml");
const windowsHelperLock = read("native/windows-managed-process-helper/Cargo.lock");
const windowsHelperMain = read("native/windows-managed-process-helper/src/main.rs");
const windowsHelperWin32 = read("native/windows-managed-process-helper/src/win32/mod.rs");
const windowsHelperState = read("native/windows-managed-process-helper/src/state.rs");
const windowsHelperProtocol = read("native/windows-managed-process-helper/src/protocol.rs");
const windowsHelperJson = read("native/windows-managed-process-helper/src/json.rs");
const windowsHelperError = read("native/windows-managed-process-helper/src/error.rs");
const windowsHelperCargoConfig = read("native/windows-managed-process-helper/.cargo/config.toml");
const windowsHelperBuild = read("scripts/build-windows-managed-helper.mjs");
const windowsHelperReproducibility = read("scripts/verify-windows-helper-reproducibility.mjs");
const windowsHelperPe = read("scripts/windows-helper-pe.mjs");
const windowsHelperClient = read("src/agent-host/managed-process/windows-helper-client.ts");
const windowsHelperResolver = read("src/shared/windows-managed-process-helper.ts");
const managedProcessService = read("src/agent-host/managed-process/service.ts");
const managedProcessBackend = read("src/agent-host/managed-process/backend.ts");
const posixManagedProcessBackend = read("src/agent-host/managed-process/posix-backend.ts");
const managedProcessFrameworkAcceptance = read("scripts/test-managed-process-frameworks.mjs");
const managedProcessFloodAcceptance = read("scripts/test-managed-process-flood.mjs");
const windowsNsisUpgradeAcceptance = read("scripts/test-windows-nsis-upgrade.mjs");
const windowsSbomBuild = read("scripts/generate-windows-sbom.mjs");
const windowsSbomVerify = read("scripts/verify-windows-sbom.mjs");
const packageDesktop = read("scripts/package-desktop.mjs");
const thirdPartyNotices = read("THIRD_PARTY_NOTICES.md");
const reaperJournal = read("src/main/managed-process/reaper-journal.ts");
const managedProcessShutdownCleanup = read("src/main/managed-process/shutdown-cleanup.ts");
const packagedCleanupFaultValidation = read("src/main/packaged-cleanup-fault-validation.ts");
const browserInspectRpc = browserContract.slice(
  browserContract.indexOf('"browser.inspect": {'),
  browserContract.indexOf('"browser.screenshot": {'),
);
const browserDeniedTargetState = browserAgentRuntime.slice(
  browserAgentRuntime.indexOf("type DeniedTarget ="),
  browserAgentRuntime.indexOf("type BrowserWorkingMemory ="),
);
const rendererCsp = protocol.slice(protocol.indexOf("const CSP ="), protocol.indexOf("const HTML_PREVIEW_CSP ="));
const windowsHelperUnsafePattern = /\bunsafe\s*(?:\{|impl\b)/gu;
const windowsHelperUnsafeLines = windowsHelperWin32.split(/\r?\n/u);
const documentedWindowsHelperUnsafe = windowsHelperUnsafeLines.every((line, index) => {
  if (!windowsHelperUnsafePattern.test(line)) {
    windowsHelperUnsafePattern.lastIndex = 0;
    return true;
  }
  windowsHelperUnsafePattern.lastIndex = 0;
  return windowsHelperUnsafeLines
    .slice(Math.max(0, index - 4), index + 1)
    .some((candidate) => candidate.includes("// SAFETY:"));
});
const windowsHelperUnsafeCount = windowsHelperWin32.match(windowsHelperUnsafePattern)?.length ?? 0;

const checks = [
  [
    windowsHelperCargo.includes('windows-sys = { version = "=0.61.2"') &&
      windowsHelperCargo.includes('panic = "abort"') &&
      windowsHelperCargo.includes('unsafe_op_in_unsafe_fn = "deny"') &&
      windowsHelperLock.includes('name = "windows-sys"\nversion = "0.61.2"') &&
      windowsHelperLock.includes('name = "windows-link"\nversion = "0.2.1"') &&
      !/(tokio|serde|reqwest|socket|tls)/i.test(windowsHelperCargo),
    "the Windows helper dependency, panic, unsafe, and runtime allowlist must remain pinned",
  ],
  [
    !/\bunsafe\b/u.test(
      windowsHelperMain + windowsHelperState + windowsHelperProtocol + windowsHelperJson + windowsHelperError,
    ) &&
      documentedWindowsHelperUnsafe &&
      windowsHelperUnsafeCount === 99,
    "the Windows helper safe parser/state machine must contain no unsafe code and every allowlisted Win32 unsafe operation must retain a SAFETY invariant",
  ],
  [
    windowsHelperCargoConfig.includes("target-feature=+crt-static") &&
      windowsHelperCargoConfig.includes("control-flow-guard=yes") &&
      windowsHelperCargoConfig.includes("link-arg=/Brepro") &&
      windowsHelperBuild.includes("verifyWindowsHelperPe(source)") &&
      windowsHelperPe.includes("REQUIRED_DLL_CHARACTERISTICS") &&
      windowsHelperPe.includes("ALLOWED_IMPORTS") &&
      windowsHelperPe.includes("resource type") &&
      desktopBuildWorkflow.includes("cargo install cargo-audit --locked --version 0.22.2") &&
      desktopBuildWorkflow.includes("cargo install cargo-deny --locked --version 0.20.2") &&
      desktopBuildWorkflow.includes("cargo install cargo-xwin --locked --version 0.23.1") &&
      desktopBuildWorkflow.includes("npm run build:windows-helper") &&
      windowsHelperBuild.includes('cargoXwin: "0.23.1"') &&
      windowsHelperBuild.includes('llvmMajor: "18"') &&
      windowsHelperBuild.includes('sdk: "10.0.26100"') &&
      windowsHelperBuild.includes('crt: "14.44.17.14"') &&
      windowsHelperBuild.includes('provenance = "cross-dev"') &&
      windowsHelperBuild.includes('digest.update(relative, "utf8")') &&
      windowsHelperReproducibility.includes("first !== second") &&
      desktopBuildWorkflow.includes("check:windows-helper-reproducibility") &&
      desktopBuildWorkflow.includes("cargo audit --file native/windows-managed-process-helper/Cargo.lock") &&
      desktopBuildWorkflow.includes("native/windows-managed-process-helper/deny.toml --locked check") &&
      desktopBuildWorkflow.includes("Flask==3.1.0 fastapi==0.128.0 uvicorn==0.40.0"),
    "the Windows helper must use static CRT and enforce pinned supply-chain, PE mitigation, import, manifest, and version-resource gates",
  ],
  [
    windowsHelperWin32.includes("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE") &&
      windowsHelperWin32.includes("CREATE_SUSPENDED") &&
      windowsHelperWin32.includes("PROC_THREAD_ATTRIBUTE_HANDLE_LIST") &&
      windowsHelperWin32.indexOf("AssignProcessToJobObject(job.raw(), process.raw())") <
        windowsHelperWin32.indexOf("ResumeThread(thread.raw())") &&
      !windowsHelperWin32.includes("CREATE_BREAKAWAY_FROM_JOB"),
    "the Windows helper must assign a suspended target to a kill-on-close Job before resume with an inherited-handle allowlist",
  ],
  [
    windowsHelperWin32.includes('verify_job_dacl(handle.raw(), "JOB_CREATE_FAILED")') &&
      windowsHelperWin32.includes('verify_job_dacl(handle.raw(), "JOB_QUERY_FAILED")') &&
      windowsHelperWin32.includes("JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY | READ_CONTROL | SYNCHRONIZE") &&
      windowsHelperWin32.includes("PROTECTED_DACL_SECURITY_INFORMATION") &&
      windowsHelperWin32.includes("let reopened = Job::open_for_reap(&name).unwrap().unwrap()"),
    "named Jobs must retain an exact protected current-user plus SYSTEM DACL and reapers must request READ_CONTROL before verifying it",
  ],
  [
    windowsHelperWin32.includes("JobObjectAssociateCompletionPortInformation") &&
      windowsHelperMain.includes("let active = job.active_processes()?") &&
      !windowsHelperWin32.includes("GetQueuedCompletionStatus"),
    "Job completion notifications must remain advisory: authoritative empty detection must query accounting even when no notification is consumed",
  ],
  [
    windowsHelperWin32.includes("CreateFileW") &&
      windowsHelperWin32.includes("GetFinalPathNameByHandleW") &&
      windowsHelperWin32.includes("FILE_SHARE_READ | FILE_SHARE_WRITE") &&
      !windowsHelperWin32.includes("FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE") &&
      windowsHelperWin32.indexOf("verify_spawn_path(&bootstrap.cwd, true)") <
        windowsHelperWin32.indexOf("CreateProcessW(") &&
      windowsHelperWin32.indexOf("verify_spawn_path(&bootstrap.shell_executable, false)") <
        windowsHelperWin32.indexOf("CreateProcessW(") &&
      windowsHelperState.includes("valid_bootstrap_path") &&
      windowsHelperState.includes('normalized.starts_with(r"\\\\?\\")'),
    "the Windows helper must pin and final-path verify cwd/shell before CreateProcessW while rejecting device namespaces",
  ],
  [
    windowsHelperMain.includes('Some("--owner-stdio-v1")') &&
      windowsHelperMain.includes('Some("--reap-stdio-v1")') &&
      windowsHelperMain.includes('Some("--self-test-json-v1")') &&
      windowsHelperMain.includes('Some("--version-json-v1")') &&
      !/(TcpListener|UdpSocket|std::net|WinHttp|WinInet)/u.test(
        windowsHelperMain + windowsHelperWin32 + windowsHelperState + windowsHelperProtocol,
      ),
    "the Windows helper must expose only fixed owner/reaper/self-test/version modes and no network surface",
  ],
  [
    windowsHelperClient.includes('this.descriptor.path, ["--owner-stdio-v1"]') &&
      windowsHelperClient.includes("actual !== this.descriptor.sha256") &&
      windowsHelperMain.includes("win32::lock_current_executable()") &&
      windowsHelperWin32.includes("pub fn lock_current_executable()") &&
      windowsHelperWin32.includes("Sharing only reads pins the helper against write/delete replacement") &&
      windowsHelperResolver.includes('"managed-process", "win32-x64"') &&
      !windowsHelperResolver.includes("process.env") &&
      !/taskkill(?:\.exe)?\s+\/T/i.test(windowsHelperClient + managedProcessService) &&
      reaperJournal.includes("fs.lstatSync(filePath)") &&
      windowsHelperWin32.includes("PROTECTED_DACL_SECURITY_INFORMATION") &&
      windowsHelperWin32.includes("SetFileSecurityW") &&
      windowsHelperWin32.includes("FILE_ATTRIBUTE_REPARSE_POINT") &&
      reaperJournal.includes("JOURNAL_MAX_BYTES = 64 * 1024") &&
      reaperJournal.includes("RECORD_MAX_COUNT = 16"),
    "Windows managed processes must use a fixed verified helper path, never taskkill /T, and retain bounded protected-DACL reparse-aware journals",
  ],
  [
    managedProcessBackend.includes("export interface ManagedProcessBackend") &&
      posixManagedProcessBackend.includes("implements ManagedProcessBackend") &&
      posixManagedProcessBackend.includes("detached: true") &&
      posixManagedProcessBackend.includes("terminatePosixProcessGroup") &&
      managedProcessService.includes("new PosixManagedProcessBackend") &&
      !managedProcessService.includes("record.worker"),
    "managed process orchestration must use explicit POSIX and Windows backend adapters without inline worker ownership",
  ],
  [
    toolEnvironment.includes("export function sanitizeToolEnvironment") &&
      toolEnvironment.includes("SENSITIVE_EXACT_KEYS") &&
      toolEnvironment.includes("SENSITIVE_KEY_SUFFIXES") &&
      toolEnvironment.includes("containsUrlCredentials") &&
      toolchainRuntime.includes("this.baseEnv = sanitizeToolEnvironment(options.baseEnv ?? process.env)") &&
      toolchainBash.includes("env: sanitizeToolEnvironment({ ...spawnContext.env, ...context.shellEnv })"),
    "Agent tools and managed processes must not inherit provider credentials or credential-bearing URLs",
  ],
  [
    managedProcessFrameworkAcceptance.includes("Next dev HMR tree stop") &&
      managedProcessFrameworkAcceptance.includes("Storybook real cold start stop") &&
      managedProcessFrameworkAcceptance.includes("Spring Boot mvnw.cmd JVM tree stop") &&
      managedProcessFrameworkAcceptance.includes(".NET watch non-TTY restart stop") &&
      desktopBuildWorkflow.includes("windows-frameworks:") &&
      desktopBuildWorkflow.includes("actions/setup-dotnet@v5") &&
      desktopBuildWorkflow.includes("dotnet-version: 10.0.400") &&
      desktopBuildWorkflow.includes("next@16.3.2") &&
      desktopBuildWorkflow.includes("storybook@10.5.10") &&
      desktopBuildWorkflow.includes("npm run test:managed-process-frameworks"),
    "real Next, Storybook, Spring Boot, and .NET watch scenarios must remain pinned in the Windows release gate",
  ],
  [
    managedProcessFloodAcceptance.includes('new Set(["stdout", "both"])') &&
      managedProcessFloodAcceptance.includes("processCount > 8") &&
      managedProcessFloodAcceptance.includes("per-process output memory exceeded 2 MiB") &&
      managedProcessFloodAcceptance.includes("a dual-stream flood process did not expose both stdout and stderr") &&
      desktopBuildWorkflow.includes('$env:PI_MANAGED_FLOOD_DURATION_MS = "60000"') &&
      desktopBuildWorkflow.includes('$env:PI_MANAGED_FLOOD_PROCESSES = "8"') &&
      desktopBuildWorkflow.includes('$env:PI_MANAGED_FLOOD_STREAMS = "both"') &&
      desktopBuildWorkflow.includes("npm run test:managed-process-flood"),
    "Windows CI must retain the 60-second eight-process stdout/stderr flood and bounded-output lifecycle budgets",
  ],
  [
    windowsNsisUpgradeAcceptance.includes("assertCleanUserInstallState()") &&
      windowsNsisUpgradeAcceptance.includes("direct rollback must remove the newer helper directory") &&
      windowsNsisUpgradeAcceptance.includes("verifyInstalledHelperLock(executable)") &&
      windowsNsisUpgradeAcceptance.includes("running installed helper must prevent replacement") &&
      windowsNsisUpgradeAcceptance.includes("stopped installed helper must become replaceable") &&
      windowsNsisUpgradeAcceptance.includes("validateStartup(appExecutable(installPath), isolated, currentVersion") &&
      windowsNsisUpgradeAcceptance.includes("validateStartup(appExecutable(installPath), isolated, previousVersion") &&
      desktopBuildWorkflow.includes("5d99744a18f7495c987146a44718dbb5ba7037cf279ada62669aefc9940313c5") &&
      desktopBuildWorkflow.match(/npm run test:windows-nsis-upgrade/g)?.length === 2,
    "Windows PR and release packaging must test a hash-pinned previous NSIS upgrade, installed-helper locking, direct rollback, and clean uninstall",
  ],
  [
    packageJson.includes('"build:windows-sbom": "node scripts/generate-windows-sbom.mjs"') &&
      packageJson.includes('"check:windows-sbom": "node scripts/verify-windows-sbom.mjs"') &&
      packageDesktop.includes("generate Windows release SBOM") &&
      packageDesktop.includes("verify Windows release SBOM") &&
      windowsSbomBuild.includes('bomFormat: "CycloneDX"') &&
      windowsSbomBuild.includes('specVersion: "1.5"') &&
      windowsSbomBuild.includes('facts.helperManifest.provenance !== "release-authoritative"') &&
      windowsSbomBuild.includes('name: "Rust standard library"') &&
      windowsSbomBuild.includes('name: "windows-sys"') &&
      windowsSbomBuild.includes('name: "windows-link"') &&
      windowsSbomBuild.includes('buildTool("tool:cargo-xwin", "cargo-xwin"') &&
      windowsSbomBuild.includes("nativeWindowsSdk") &&
      windowsSbomBuild.includes("nativeMsvcToolset") &&
      windowsSbomVerify.includes("exactly one Windows x64 CycloneDX SBOM") &&
      desktopBuildWorkflow.match(/Generate and verify Windows SBOM/g)?.length === 2 &&
      desktopBuildWorkflow.includes("dist/*.cdx.json") &&
      desktopBuildWorkflow.includes("THIRD_PARTY_NOTICES.md") &&
      thirdPartyNotices.includes("Each Windows release publishes a CycloneDX SBOM"),
    "Windows packaging and draft releases must publish a lock-derived CycloneDX SBOM, exact native/cross build provenance, and third-party notices",
  ],
  [
    managedProcessShutdownCleanup.includes("options.deadline") &&
      managedProcessShutdownCleanup.includes("options.requireConfirmedEmpty") &&
      managedProcessShutdownCleanup.includes("status?.ready !== true") &&
      managedProcessShutdownCleanup.includes("status.records !== 0") &&
      main.includes("cleanupManagedProcessContainment") &&
      main.includes("verifyWindowsManagedProcessHelperReplaceable") &&
      updateManager.includes("await this.prepareToInstall()") &&
      updateManager.includes("await this.recoverInstallLifecycle()"),
    "quit and update cleanup must share a hard deadline while update installation fails closed and restores lifecycle state",
  ],
  [
    main.includes('process.argv.includes("--validate-packaged-cleanup-fault")') &&
      main.includes("runPackagedCleanupFaultValidation") &&
      main.includes("isQuitting = false") &&
      main.includes("createTray(getMainWindow, () => void stopAllManagedProcessesFromTray())") &&
      main.includes("restartHostAfterExit(manager, () => !isQuitting)") &&
      packagedCleanupFaultValidation.includes("requireConfirmedEmpty: false") &&
      packagedCleanupFaultValidation.includes("requireConfirmedEmpty: true") &&
      packagedCleanupFaultValidation.includes("installerLaunches === 0") &&
      packagedCleanupFaultValidation.includes('report.updatePhase === "error"') &&
      packagedToolchainVerifier.includes("runPackagedCleanupFaultValidation(layout.executable)") &&
      packagedToolchainVerifier.includes("packaged-cleanup-fault-check.json"),
    "the packaged Windows gate must fault-inject cleanup uncertainty, retain the journal, recover lifecycle state, and never launch the installer",
  ],
  [windowFactory.includes("sandbox: true"), "BrowserWindow sandbox must remain enabled"],
  [windowFactory.includes("contextIsolation: true"), "context isolation must remain enabled"],
  [windowFactory.includes("nodeIntegration: false"), "renderer Node integration must remain disabled"],
  [main.includes("crashReporter.start"), "local crash reporting must be started"],
  [
    main.includes("createElectronRuntimeFetch") &&
      main.includes("net.request") &&
      !main.includes("net.fetch") &&
      electronRuntimeFetch.includes("request.followRedirect()") &&
      electronRuntimeFetch.includes("assertRuntimeRedirectUrl") &&
      main.includes("fetchImpl:") &&
      toolchainInstaller.includes("fetchImpl: options.fetchImpl"),
    "managed downloads must use Electron networking with synchronous redirect checks so system proxy and trust settings remain effective",
  ],
  [main.includes("setOverlayIcon"), "Windows taskbar overlay badges must remain implemented"],
  [
    diagnostics.includes('app.getPath("crashDumps")') &&
      diagnostics.includes("collectCrashMetadata") &&
      diagnostics.includes("MAX_LOG_BYTES") &&
      !diagnostics.includes("fs.cpSync") &&
      diagnosticsRedaction.includes("redactDiagnosticText") &&
      diagnosticsRedaction.includes("<redacted-token>") &&
      diagnosticsRedaction.includes("buildToolchainDiagnosticSummary"),
    "diagnostic export must redact bounded logs, summarize toolchains, and exclude raw crash process memory",
  ],
  [!/script-src[^;]*unsafe-inline/.test(rendererCsp), "renderer script-src must not allow unsafe-inline"],
  [fileViewer.includes('sandbox="allow-scripts"'), "HTML previews must remain sandboxed"],
  [
    protocol.includes("\"object-src 'none'; \"") && protocol.includes("\"form-action 'none'\""),
    "HTML preview CSP must block plugins and forms",
  ],
  [
    desktopBuildWorkflow.includes("check:toolchain-catalog:upstream") &&
      upstreamToolchainCatalogCheck.includes("SHASUMS256.txt") &&
      upstreamToolchainCatalogCheck.includes("asset.digest") &&
      upstreamToolchainCatalogCheck.includes("asset.size"),
    "tag releases must verify managed runtime checksums and sizes against official upstream metadata",
  ],
  [
    rpcManager.includes("createDesktopSearchToolDefinitions") &&
      toolchainSearch.includes("allowUpstreamDownload: false") &&
      !toolchainSearch.includes("ensureTool") &&
      !toolchainSearch.includes("releases/latest") &&
      bundledToolsBuild.includes("downloadRuntimeArtifact") &&
      bundledToolsBuild.includes("verifyDownloadedArtifact"),
    "Desktop grep/find must use injected rg/fd descriptors and fixed build-time assets without upstream dynamic downloads",
  ],
  [
    main.includes('app.isPackaged && process.argv.includes("--validate-packaged-startup")') &&
      main.includes("packaged-startup-check.json") &&
      main.includes("getToolchainAckRevision") &&
      main.includes('candidate.provider === "bundled"') &&
      main.includes('candidate.health === "healthy"'),
    "the production startup probe must be packaged-only and require Renderer, Host revision ack, and healthy bundled search tools",
  ],
  [
    packagedToolchainVerifier.includes("darwin-arm64|darwin-x64|win32-x64|linux-x64") &&
      packagedToolchainVerifier.includes(
        'assertExact(entries, ["core", "core-catalog.json", "runtime-catalog.json"]',
      ) &&
      packagedToolchainVerifier.includes("verifyManifestFile") &&
      packagedToolchainVerifier.includes("verifyLinuxSandbox") &&
      packagedToolchainVerifier.includes("stat.uid !== 0") &&
      packagedToolchainVerifier.includes('spawnSync(byComponent.get("ripgrep")') &&
      packagedToolchainVerifier.includes("runPackagedStartup") &&
      packagedToolchainVerifier.includes("verifyLinuxAppImageDesktopEntry") &&
      packagedToolchainVerifier.includes('APPIMAGE_EXTRACT_AND_RUN: "1"') &&
      packagedToolchainVerifier.includes("hostAckRevision !== report.revision"),
    "the packaged E2E must enforce the release matrix, exact resources, hashes, functional rg/fd, and production startup ack",
  ],
  [
    ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"].every((target) => desktopBuildWorkflow.includes(target)) &&
      desktopBuildWorkflow.includes("check:packaged-toolchains") &&
      desktopBuildWorkflow.includes("release-linux") &&
      desktopBuildWorkflow.includes("xvfb-run --auto-servernum") &&
      desktopBuildWorkflow.includes("sudo chown root:root dist/linux-unpacked/chrome-sandbox") &&
      desktopBuildWorkflow.includes("sudo chmod 4755 dist/linux-unpacked/chrome-sandbox") &&
      electronBuilderConfig.includes("executableName: pi-agent-desktop") &&
      electronBuilderConfig.includes("--appimage-desktop-launch") &&
      !electronBuilderConfig.includes("--no-sandbox") &&
      desktopBuildWorkflow.includes("Pi-Agent-Desktop-${version}-x86_64.AppImage"),
    "CI and tag releases must run packaged toolchain E2E for every supported target, including Linux under Xvfb",
  ],
  [
    toolchainInstaller.includes("previousRoot") &&
      toolchainInstaller.includes("fs.renameSync(finalRoot, previousRoot)") &&
      toolchainInstaller.includes("this.stateStore.update") &&
      toolchainInstaller.includes("fs.renameSync(previousRoot, finalRoot)") &&
      toolchainInstaller.indexOf("this.stateStore.update") < toolchainInstaller.indexOf("fs.rmSync(previousRoot"),
    "managed activation must preserve the previous same-version runtime until the new state is durable",
  ],
  [
    toolchainInstaller.includes("recoverInterruptedOperations") &&
      toolchainInstaller.includes("cleanupPartialDownloads") &&
      toolchainInstaller.includes("recoverPreviousRuntimeDirectories") &&
      toolchainInstaller.includes("TOOLCHAIN_CANCELLED") &&
      toolchainManager.includes("cancelComponentInstall") &&
      toolchainManager.includes("isRuntimeInUse()"),
    "managed installs must support cancellation, crash-residue recovery, and in-use removal protection",
  ],
  [
    main.includes("readLegacyNpmCommand") &&
      legacyNpmCommand.includes("MAX_SETTINGS_BYTES") &&
      legacyNpmCommand.includes("validateLegacyNpmCommand") &&
      !legacyNpmCommand.includes("writeFile") &&
      toolchainManager.includes('intent === "plugin-install"') &&
      toolchainManager.includes('candidate.discovery === "legacy-npm-command"'),
    "legacy npmCommand migration must remain bounded, read-only, probed, and scoped to plugin compatibility",
  ],
  [
    toolchainStateStore.includes("hasFutureSchema") &&
      toolchainStateStore.includes("compatibilityReadOnly") &&
      toolchainStateStore.includes("primaryHasFutureSchema") &&
      toolchainStateStore.includes("written by a newer Pi Desktop"),
    "future toolchain state must remain read-only so application rollback cannot overwrite managed runtime ownership",
  ],
  [!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "renderer HTML must not contain inline scripts"],
  [preload.includes("../contract/desktop"), "preload must use the shared desktop bridge contract"],
  [globals.includes("../contract/desktop"), "renderer globals must use the shared desktop bridge contract"],
  [credentialVault.includes("safeStorage.encryptString"), "channel credentials must use Electron safeStorage"],
  [credentialVault.includes("safeStorage.isEncryptionAvailable"), "channel credential persistence must fail closed"],
  [!/(createServer|\.listen\s*\()/.test(weixinChannelApi), "Weixin MVP must not open a local listener"],
  [!/(createServer|\.listen\s*\()/.test(telegramChannelApi), "Telegram polling must not open a local listener"],
  [!/(createServer|\.listen\s*\()/.test(feishuChannelApi), "Feishu WebSocket mode must not open a local listener"],
  [
    feishuChannelApi.includes("im.v1.messageResource.get") &&
      feishuChannelApi.includes("FEISHU_MEDIA_MAX_BYTES") &&
      feishuChannelApi.includes("readLimitedStream"),
    "Feishu inbound media must use the message resource API with a local byte limit",
  ],
  [
    channelManager.indexOf("evaluateInboundPolicy") < channelManager.indexOf("adapter.downloadInbound"),
    "channel access policy must run before provider media download",
  ],
  [
    channelMediaStore.includes("CHANNEL_MEDIA_MAX_BYTES") &&
      channelMediaStore.includes("CHANNEL_MEDIA_MAX_ATTACHMENTS") &&
      channelMediaStore.includes("info.isSymbolicLink()") &&
      channelMediaStore.includes("mode: 0o600"),
    "channel media staging must retain byte/count/symlink/private-file controls",
  ],
  [
    channelOutboundFiles.includes("realpath") &&
      channelOutboundFiles.includes("MARKDOWN_LINK") &&
      channelOutboundFiles.includes("isInside(canonical, root)") &&
      channelPiBridge.includes("collectOutboundFiles({ finalText: result.finalText, cwd })"),
    "linked-file delivery must remain inside the actual bound session workspace",
  ],
  [
    weixinMedia.includes('url.protocol !== "https:"') && weixinMedia.includes('redirect: "error"'),
    "Weixin media must use trusted HTTPS origins without cross-origin redirects",
  ],
  [
    channelPiBridge.includes("channelPromptText(envelope.text") && !channelPiBridge.includes("[外部消息来源："),
    "channel user prompts must contain the user's text without transport metadata wrappers",
  ],
  [
    rpcManager.includes("expandPromptTemplates: false") && rpcManager.includes("stripLegacyChannelPrompts"),
    "channel prompts must avoid local expansion and remove legacy transport metadata from model history",
  ],
  [
    !channelContract.includes("botToken") && !channelContract.includes("appSecret"),
    "channel RPC must not expose raw secrets",
  ],
  [
    desktopContract.includes("setChannelCredential") && !desktopContract.includes("getChannelCredential"),
    "renderer channel credential bridge must remain write-only",
  ],
  [
    toolchainContractCheck.includes("ToolchainActionRequest") &&
      toolchainContractCheck.includes("forbiddenPattern") &&
      toolchainContractCheck.includes("url|uri|sha|hash|path|executable|argv|command") &&
      verifyScript.includes('run("toolchain contract safety"'),
    "renderer toolchain actions must retain the URL/hash/path/executable/argv/command safety gate",
  ],
  [
    desktopContract.includes("getToolchainState") &&
      desktopContract.includes("rescanToolchains") &&
      desktopContract.includes("performToolchainAction") &&
      desktopContract.includes("onToolchainState") &&
      preload.includes('ipcRenderer.invoke("desktop:toolchains:get-state"') &&
      preload.includes('ipcRenderer.invoke("desktop:toolchains:rescan"') &&
      preload.includes('ipcRenderer.invoke("desktop:toolchains:action"') &&
      preload.includes('ipcRenderer.on("toolchains:state"') &&
      desktopIpc.includes('trustedHandle("desktop:toolchains:get-state"') &&
      desktopIpc.includes('trustedHandle("desktop:toolchains:rescan"') &&
      desktopIpc.includes('trustedHandle("desktop:toolchains:action"') &&
      desktopIpc.includes("isToolchainActionRequest") &&
      desktopIpc.includes("assertTrustedSender(event)") &&
      desktopIpcTrust.includes("event.sender === window.webContents") &&
      desktopIpcTrust.includes("event.senderFrame === window.webContents.mainFrame") &&
      desktopIpc.includes("toolchainActionConfirmation(request)") &&
      desktopIpc.includes("dialog.showMessageBox") &&
      desktopIpc.includes("validateOptionalToolchainCwd"),
    "toolchain bridge must validate senders/actions/workspaces and keep download/destructive consent in Main",
  ],
  [
    main.includes('method === "toolchain.resolve"') &&
      main.includes('typeof body.trusted !== "boolean"') &&
      !desktopContract.includes("trustedProject") &&
      !desktopContract.includes("projectTrusted"),
    "project-local tool trust must come from the app-owned Host and never from the Renderer bridge",
  ],
  [
    desktopContract.includes("getUpdateState") &&
      desktopContract.includes("checkForUpdates") &&
      desktopContract.includes("downloadUpdate") &&
      desktopContract.includes("installUpdate") &&
      !/(?:setFeedURL|feedUrl|feedURL)/.test(desktopContract),
    "renderer updater contract must expose fixed actions without a configurable feed",
  ],
  [
    preload.includes('ipcRenderer.invoke("desktop:update:check")') &&
      preload.includes('ipcRenderer.invoke("desktop:update:download")') &&
      preload.includes('ipcRenderer.invoke("desktop:update:install")') &&
      preload.includes('ipcRenderer.on("update:state"'),
    "preload updater bridge must use fixed IPC channels",
  ],
  [
    desktopIpc.includes('trustedHandle("desktop:update:set-automatic-checks"') &&
      desktopIpc.includes('typeof enabled !== "boolean"') &&
      !/(?:setFeedURL|feedUrl|feedURL)/.test(desktopIpc),
    "updater IPC must validate its only mutable preference and reject feed configuration",
  ],
  [
    updateAdapter.includes("updater.autoDownload = false") &&
      updateAdapter.includes("updater.autoInstallOnAppQuit = false") &&
      updateAdapter.includes("updater.allowPrerelease = false") &&
      updateAdapter.includes("updater.allowDowngrade = false") &&
      updateAdapter.includes("updater.disableWebInstaller = true") &&
      updateAdapter.includes("updater.logger = null") &&
      updateAdapter.includes('platform === "darwin"') &&
      updateAdapter.includes('platform === "win32"') &&
      !updateAdapter.includes("WINDOWS_UPDATES_RELEASE_READY") &&
      !updateAdapter.includes("process.env"),
    "production updater must support macOS and Windows while remaining stable-only, consent-first, and using redacted application logging",
  ],
  [
    !/^\s*publisherName\s*:/im.test(electronBuilderConfig) &&
      desktopBuildWorkflow.includes("publisherName field in an unsigned Windows release") &&
      desktopBuildWorkflow.includes("/^\\s*publisherName\\s*:/im"),
    "unsigned Windows updates must omit publisher verification in both build configuration and packaged release checks",
  ],
  [
    updateManager.includes('platform === "darwin" || platform === "win32"') &&
      updateManager.includes("options.isPackaged || explicitlyEnabledForDevelopment") &&
      updateManager.includes("redactUpdateError") &&
      updateManager.includes("setRunningSessionCount"),
    "updater manager must retain platform/package gating, redaction, and active-session protection",
  ],
  [
    main.includes("createProductionUpdateAdapter") &&
      main.includes('win.webContents.send("update:state", state)') &&
      main.includes("updateManager?.setRunningSessionCount(ids.length)") &&
      main.includes("updateManager.startAutomaticChecks()"),
    "main process must own updater initialization, state publication, and session-aware scheduling",
  ],
  [
    browserTabs.includes("new WebContentsView") &&
      browserTabs.includes("nodeIntegration: false") &&
      browserTabs.includes("nodeIntegrationInWorker: false") &&
      browserTabs.includes("contextIsolation: true") &&
      browserTabs.includes("sandbox: true") &&
      browserTabs.includes("webviewTag: false") &&
      !/webPreferences\s*:\s*\{[^}]*preload\s*:/s.test(browserTabs),
    "remote Browser WebContentsView must remain sandboxed without Node, webviewTag, or a preload bridge",
  ],
  [
    browserNetwork.includes("setPermissionCheckHandler") &&
      browserNetwork.includes("setPermissionRequestHandler") &&
      browserService.includes("setDevicePermissionHandler(() => false)"),
    "Browser Sessions must install request/check permission handlers and deny device permissions by default",
  ],
  [
    /automation:\s*\{[\s\S]*?enabled:\s*false/.test(browserSettings) &&
      /advancedBrowserMode:\s*\{[\s\S]*?enabled:\s*false/.test(browserSettings) &&
      browserPolicy.includes("enabled: false") &&
      browserPolicy.includes("createDisabledAdvancedRuntimePolicy") &&
      !browserSettings.includes("humanizedInput"),
    "Agent Browser automation and the single Advanced Browser Mode grant must default to disabled",
  ],
  [
    browserService.includes("isBrowserHostMethod(method)") &&
      !browserContract.slice(browserContract.indexOf("export interface BrowserHostRpc")).includes("updateSettings") &&
      !browserContract.slice(browserContract.indexOf("export interface BrowserHostRpc")).includes("setUnsafePolicy"),
    "Host Browser RPC must be allowlisted and must not expose settings or Unsafe policy writes",
  ],
  [
    browserContract.includes('"browser.requestAuthorization"') &&
      browserTools.includes('"browser.requestAuthorization"') &&
      browserService.indexOf('method === "browser.requestAuthorization"') <
        browserService.indexOf("this.policy.assertRequest(context, permission)") &&
      !desktopContract.includes("browserGrantSession:") &&
      !preload.includes("desktop:browser:grant-session"),
    "Agent Browser tools must preflight in Main before side effects and Renderer must not mint arbitrary runtime grants",
  ],
  [
    browserGrantStore.includes("mode: 0o600") &&
      browserGrantStore.includes("fs.renameSync(temp, this.filePath)") &&
      browserAuthorization.includes("private readonly pendingById") &&
      browserAuthorization.includes("AUTHORIZATION_TIMEOUT") &&
      browserAuthorization.includes("isRendererAvailable") &&
      !browserGrantStore.includes("capabilityLeaseId"),
    "persistent Browser policies must be private and atomic while pending requests and leases remain in memory",
  ],
  [
    desktopIpc.includes("const requireTrustedBrowser") &&
      desktopIpc.includes("assertTrustedSender(event)") &&
      desktopIpcTrust.includes("event.sender === window.webContents") &&
      desktopIpcTrust.includes("event.senderFrame === window.webContents.mainFrame") &&
      browserService.includes("authorizeBrowserSettingsUpdate(before, patch") &&
      browserService.includes('this.confirmations.consume(proof, "advanced-browser-mode", payload)') &&
      !browserService.includes('"unsafe-lab"'),
    "Browser settings IPC must validate the main-window sender/frame and consume one-time confirmation proofs",
  ],
  [
    browserVault.includes("safeStorage") === false &&
      browserVault.includes("codec.encrypt(value)") &&
      browserService.includes("getRedactedDiagnostics") &&
      !/interface BrowserDiagnostics[\s\S]*?(cookie|authorization|password|secret|pageText|javascript)/i.test(
        browserContract.slice(
          browserContract.indexOf("export interface BrowserDiagnostics"),
          browserContract.indexOf("export interface BrowserRendererState"),
        ),
      ),
    "Browser diagnostics must expose summaries only while secret values remain encrypted behind opaque references",
  ],
  [
    !browserTools.includes('"browser_set_cookies"') &&
      browserService.includes("Cookie mutation is unavailable because sensitive ToolResult persistence isolation") &&
      browserService.includes("Full cookie values are unavailable because sensitive ToolResult persistence isolation"),
    "Agent Browser tools must not accept cookie values until Gate A proves tool-call persistence isolation",
  ],
  [
    !main.includes("remote-debugging-port") &&
      !browserTabs.includes("remote-debugging-port") &&
      !main.includes("ignore-certificate-errors") &&
      !browserTabs.includes("ignore-certificate-errors") &&
      !windowFactory.includes("webSecurity: false") &&
      browserTabs.includes("isBrowserDevToolsShortcut(input)") &&
      browserDevToolsShortcut.includes('input.key.toLowerCase() === "f12"'),
    "production Browser code must not expose remote debugging, global certificate bypass, or weaken the main Renderer",
  ],
  [
    browserIdentity.includes("Emulation.setUserAgentOverride") &&
      !/Object\.defineProperty\s*\(\s*navigator|navigator\.__defineGetter__|Page\.addScriptToEvaluateOnNewDocument/.test(
        browserIdentity,
      ) &&
      browserNetwork.includes("applyIdentityHeaders"),
    "Browser identity must use Chromium/CDP and coherent network headers without JavaScript navigator patches",
  ],
  [
    browserTools.includes('browser_inspect: "read"') &&
      browserInspectRpc.includes("sinceInspectionId?: string") &&
      browserInspectRpc.includes("screenshot?:") &&
      !/(?:source|selector|console|networkBody|cookie|header|action)\s*\??:/i.test(browserInspectRpc) &&
      browserInspectionStore.includes("contentHash: string") &&
      browserInspectionStore.includes("viewportHash: string") &&
      !/\b(?:text|base64|screenshot|nodes)\s*:/.test(browserInspectionStore),
    "browser_inspect must remain a read-only bounded observation without action, advanced data, or persistent page/image content",
  ],
  [
    browserTabs.includes('from "./browser-redaction.ts"') &&
      browserConsole.includes('from "./browser-redaction.ts"') &&
      browserRecorder.includes('from "./browser-redaction.ts"') &&
      browserRedaction.includes("SENSITIVE_QUERY_KEY") &&
      browserRedaction.includes("SECRET_TEXT") &&
      browserTabs.includes("MAX_INSPECTION_SCREENSHOT_BYTES") &&
      browserTabs.includes("DEFAULT_INSPECTION_MAX_TEXT_CHARS = 8_000") &&
      browserTabs.includes("DEFAULT_INSPECTION_MAX_NODES = 100") &&
      browserTabs.includes("DEFAULT_INSPECTION_NODE_CHARS = 16_000") &&
      browserTabs.includes("input.screenshot?.enabled === true"),
    "inspection, Console, network, frame URLs, and visual results must share redaction and bounded result budgets",
  ],
  [
    browserDeniedTargetState.includes("keyHash: string") &&
      browserDeniedTargetState.includes("originHash: string") &&
      !browserDeniedTargetState.includes("origin: string") &&
      browserAgentRuntime.includes("hashRouteValue(target.origin)") &&
      browserAgentRuntime.includes("BROWSER_RETRY_BLOCKED") &&
      browserAgentRuntime.includes("BROWSER_CALL_BUDGET_EXCEEDED") &&
      browserAgentRuntime.includes("const REPLAN_CALLS = 30") &&
      browserAgentRuntime.includes("const MAX_CALLS = 60") &&
      rpcManager.includes("browserAgentRuntime.guardBash") &&
      toolchainBash.includes("await beforeExec?.(command)"),
    "Browser attempt/workflow state must remain hashed, budgeted, and enforced before Bash execution",
  ],
  [
    browserTools.includes("promptGuidelines: [...BROWSER_CANONICAL_GUIDELINES]") &&
      browserAgentRuntime.includes("Observe once with browser_inspect") &&
      browserAgentRuntime.includes("browser_network_summary before network_list/body") &&
      browserService.includes('workflowGuardScope: "obvious-workflow-bypass-only"') &&
      !/"(?:playwright|puppeteer)"\s*:/.test(packageJson),
    "Browser tools must share canonical efficiency guidance and label the workflow guard as narrower than an OS sandbox without bundling a second browser",
  ],
  [
    browserRecorder.includes("const REPLAY_TTL_MS = 10 * 60 * 1_000") &&
      browserRecorder.includes("private readonly sealed = new Map") &&
      browserRecorder.includes("this.sealed.clear()") &&
      !browserTools.includes('"browser_page_code_delete"') &&
      !browserTools.includes('"browser_page_code_set_enabled"') &&
      browserSnippets.includes("assertSnippetSafe"),
    "sealed replay data must be short-lived Main memory and Agent tools must not mutate the snippet library",
  ],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`OK: ${checks.length} desktop security invariants hold`);
