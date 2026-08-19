const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const WEZTERM = process.env.WEZTERM_GUI || "C:\\Program Files\\WezTerm\\wezterm-gui.exe";
const NODE_EXE = process.env.NODE_BINARY || "C:\\Program Files\\nodejs\\node.exe";
const ROOT = path.resolve(__dirname, "..", "..");
const PI_CLI = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const RELAY = path.join(__dirname, "relay.cjs");
const HWND_PS1 = path.join(__dirname, "hwnd.ps1");
const PTY_MODE = process.env.SPIKE_MODE === "pty";
const OWN_MODE = process.env.SPIKE_MODE === "own";
const CLASS_NAME = OWN_MODE
  ? "org.pi.wezterm.spike.own"
  : PTY_MODE
    ? "org.pi.wezterm.spike.pty"
    : "org.pi.wezterm.spike";
const FIND_MS = 12_000;

let mainWindow = null;
let wezterm = null;
let childHwnd = null;
let lastRect = null;
let ptyProcess = null;
let bridgeServer = null;
let bridgePort = null;
let relaySock = null;
const pendingChunks = [];
const LOG_FILE = path.join(__dirname, "spike.log");

function log(message) {
  const line = `[spike] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status", message);
  }
}

function hwndHex(buf) {
  const value = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  return `0x${value.toString(16)}`;
}

function ps(args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HWND_PS1, ...args],
    { encoding: "utf8", windowsHide: true },
  );
  return {
    code: result.status ?? 1,
    out: (result.stdout || "").trim(),
    err: (result.stderr || "").trim(),
  };
}

function findWeztermHwnd(pid) {
  const byClass = ps(["-Action", "find", "-Class", CLASS_NAME]);
  if (byClass.code === 0 && byClass.out) return byClass.out;
  const byPid = ps(["-Action", "find", "-TargetPid", String(pid)]);
  if (byPid.code === 0 && byPid.out) return byPid.out;
  return null;
}

function placeChild() {
  if (!childHwnd || !lastRect || lastRect.w < 8 || lastRect.h < 8) return;
  const moved = ps([
    "-Action",
    "move",
    "-Child",
    childHwnd,
    "-X",
    String(lastRect.x),
    "-Y",
    String(lastRect.y),
    "-W",
    String(lastRect.w),
    "-H",
    String(lastRect.h),
  ]);
  if (moved.code !== 0) log(`move failed: ${moved.err || moved.out || moved.code}`);
}

function parentChild(parentHwnd) {
  if (!childHwnd || !lastRect) return false;
  const result = ps([
    "-Action",
    "parent",
    "-Child",
    childHwnd,
    "-Parent",
    parentHwnd,
    "-X",
    String(lastRect.x),
    "-Y",
    String(lastRect.y),
    "-W",
    String(lastRect.w),
    "-H",
    String(lastRect.h),
  ]);
  if (result.code !== 0) {
    log(`SetParent failed: ${result.err || result.out || result.code}`);
    return false;
  }
  log(`SetParent ok prev=${result.out} child=${childHwnd} rect=${lastRect.x},${lastRect.y} ${lastRect.w}x${lastRect.h}`);
  return true;
}

function killWezterm() {
  if (!wezterm || wezterm.killed) return;
  const pid = wezterm.pid;
  spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
  wezterm = null;
}

function killPty() {
  try {
    ptyProcess?.kill();
  } catch {}
  ptyProcess = null;
  try {
    bridgeServer?.close();
  } catch {}
  bridgeServer = null;
}

function estimateSize() {
  if (!lastRect) return { cols: 120, rows: 30 };
  return {
    cols: Math.max(40, Math.floor(lastRect.w / 9)),
    rows: Math.max(12, Math.floor(lastRect.h / 18)),
  };
}

function startMarkerPty(pty, size) {
  log("Pi CLI missing or failed — marker PTY (NODEPTY-SPIKE)");
  return pty.spawn(
    NODE_EXE,
    [
      "-e",
      'process.stdout.write("\\r\\n==== NODEPTY-SPIKE ====\\r\\nthis is the Electron node-pty, not WezTerm cmd\\r\\n"); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", (d) => { process.stdout.write(d); if (d[0] === 3) process.exit(0); });',
    ],
    {
      cwd: os.tmpdir(),
      cols: size.cols,
      rows: size.rows,
      name: "xterm-256color",
      env: { ...process.env, TERM: "xterm-256color" },
    },
  );
}

function startPiPty(pty, size) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wezterm-pty-spike-"));
  log(`node-pty spawn Pi cwd=${cwd}`);
  return pty.spawn(NODE_EXE, [PI_CLI, "--session-id", "spike-wezterm-pty", "--tui-mode", "fullscreen"], {
    cwd,
    cols: size.cols,
    rows: size.rows,
    name: "xterm-256color",
    env: { ...process.env, TERM: "xterm-256color" },
  });
}

function startPtyBridge() {
  return new Promise((resolve, reject) => {
    let pty;
    try {
      pty = require("node-pty");
    } catch (error) {
      reject(error);
      return;
    }
    const size = estimateSize();
    try {
      if (fs.existsSync(NODE_EXE) && fs.existsSync(PI_CLI)) {
        ptyProcess = startPiPty(pty, size);
      } else {
        ptyProcess = startMarkerPty(pty, size);
      }
    } catch (error) {
      log(`Pi spawn failed: ${error.message}`);
      ptyProcess = startMarkerPty(pty, size);
    }
    let dataEvents = 0;
    ptyProcess.onExit(({ exitCode }) => log(`node-pty exit ${exitCode}`));
    ptyProcess.onData((data) => {
      dataEvents += 1;
      if (dataEvents <= 5) log(`pty data #${dataEvents} len=${data.length} ${JSON.stringify(data.slice(0, 80))}`);
      if (relaySock) {
        try {
          relaySock.write(data);
        } catch {}
        return;
      }
      pendingChunks.push(data);
      if (pendingChunks.length > 400) pendingChunks.shift();
    });
    bridgeServer = net.createServer((sock) => {
      sock.setNoDelay(true);
      log(`relay connected — flush ${pendingChunks.length} buffered chunks`);
      try {
        sock.write("\r\n==== BRIDGE-OK ====\r\nIf you see this, WezTerm is showing the pipe.\r\n");
      } catch {}
      relaySock = sock;
      for (const chunk of pendingChunks) {
        try {
          sock.write(chunk);
        } catch {}
      }
      pendingChunks.length = 0;
      sock.on("data", (chunk) => {
        try {
          ptyProcess.write(chunk.toString("utf8"));
        } catch {}
      });
      sock.on("close", () => {
        if (relaySock === sock) relaySock = null;
        log("relay disconnected");
      });
    });
    bridgeServer.listen(0, "127.0.0.1", () => {
      const addr = bridgeServer.address();
      bridgePort = addr.port;
      log(`bridge listen 127.0.0.1:${bridgePort} ptyPid=${ptyProcess.pid}`);
      resolve(bridgePort);
    });
    bridgeServer.on("error", reject);
  });
}

function weztermProgram() {
  if (OWN_MODE) {
    return [NODE_EXE, PI_CLI, "--session-id", "spike-wezterm-own", "--tui-mode", "fullscreen"];
  }
  if (PTY_MODE) {
    return [NODE_EXE, RELAY, "127.0.0.1", String(bridgePort)];
  }
  return ["cmd.exe", "/k", "echo SPIKE GPU cells. Try the red overlay."];
}

function weztermStartArgs() {
  const args = ["start", "--always-new-process", "--class", CLASS_NAME];
  if (OWN_MODE) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wezterm-own-spike-"));
    log(`wezterm owns Pi cwd=${cwd}`);
    args.push("--cwd", cwd);
  }
  args.push("--", ...weztermProgram());
  return args;
}

async function waitForRect() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (lastRect && lastRect.w >= 8 && lastRect.h >= 8) return lastRect;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return lastRect;
}

async function attachWezterm(win) {
  if (!fs.existsSync(WEZTERM)) {
    log(`missing wezterm-gui: ${WEZTERM}`);
    return;
  }
  const rect = await waitForRect();
  log(`term rect ${rect ? `${rect.x},${rect.y} ${rect.w}x${rect.h}` : "none"}`);
  if (PTY_MODE) {
    await startPtyBridge();
    log("NOTE: no official attach-to-PTY. byte bridge (double PTY).");
  }
  if (OWN_MODE) log("WezTerm owns Pi — no node-pty, no relay");
  const startArgs = weztermStartArgs();
  log(`spawn wezterm ${startArgs.join(" ")}`);
  wezterm = spawn(
    WEZTERM,
    [
      "--skip-config",
      "--config",
      "enable_tab_bar=false",
      "--config",
      'window_decorations="NONE"',
      "--config",
      "font_size=12.0",
      ...startArgs,
    ],
    { windowsHide: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  wezterm.stdout.on("data", (chunk) => log(`wezterm out ${chunk}`));
  wezterm.stderr.on("data", (chunk) => log(`wezterm err ${chunk}`));
  wezterm.on("error", (error) => log(`wezterm spawn error ${error.message}`));
  wezterm.on("exit", (code) => log(`wezterm exit ${code}`));
  log(`spawned wezterm pid=${wezterm.pid}`);

  const started = Date.now();
  while (Date.now() - started < FIND_MS) {
    childHwnd = findWeztermHwnd(wezterm.pid);
    if (childHwnd) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!childHwnd) {
    log("no WezTerm HWND — look for a separate WezTerm window");
    return;
  }
  log(`found HWND ${childHwnd}`);
  const parentHwnd = hwndHex(win.getNativeWindowHandle());
  parentChild(parentHwnd);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    title: OWN_MODE ? "WezTerm owns Pi spike" : PTY_MODE ? "WezTerm PTY bridge spike" : "WezTerm HWND overlay spike",
    backgroundColor: "#f4f1ea",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "spike.html"), {
    query: { mode: OWN_MODE ? "own" : PTY_MODE ? "pty" : "overlay" },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    killWezterm();
    killPty();
  });
  mainWindow.on("resize", () => {
    placeChild();
    if (ptyProcess && lastRect) {
      const size = estimateSize();
      try {
        ptyProcess.resize(size.cols, size.rows);
      } catch {}
    }
  });
}

app.whenReady().then(() => {
  try {
    fs.writeFileSync(LOG_FILE, "");
  } catch {}
  log(`ready mode=${PTY_MODE ? "pty" : "overlay"}`);
  ipcMain.on("term-rect", (_event, rect) => {
    if (!rect || typeof rect.x !== "number") return;
    lastRect = rect;
    if (childHwnd) placeChild();
  });
  createWindow();
  mainWindow.webContents.once("did-finish-load", () => {
    attachWezterm(mainWindow).catch((error) => log(`attach failed: ${error && error.stack ? error.stack : error}`));
  });
});

app.on("before-quit", () => {
  killWezterm();
  killPty();
});
app.on("window-all-closed", () => app.quit());
