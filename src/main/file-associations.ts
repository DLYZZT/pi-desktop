import { execFile, spawn } from "node:child_process";
import path from "node:path";

// ---------------------------------------------------------------------------
// Windows file association resolver.
// Reads the registry (via reg.exe) to find:
//   - the default app for a file type ("Open in VS Code")
//   - the system "Open with" handler list for that extension
// Shell tools (Terminal, Git Bash, WSL, PowerShell...) are excluded — those
// are not editors. Everything is cached per extension for 5 minutes.
// ---------------------------------------------------------------------------

export interface FileOpenHandler {
  name: string;
  command: string;
}

export interface FileAssociations {
  defaultApp: FileOpenHandler | null;
  handlers: FileOpenHandler[];
}

const SHELL_BLOCKLIST = new Set([
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "wt.exe",
  "windowsterminal.exe",
  "wsl.exe",
  "bash.exe",
  "mintty.exe",
  "git-bash.exe",
  "git-cmd.exe",
  "conhost.exe",
  "explorer.exe",
  "rundll32.exe",
  "dllhost.exe",
  "mshta.exe",
  "cscript.exe",
  "wscript.exe",
]);

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; result: FileAssociations }>();

function regQuery(key: string): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    execFile("reg.exe", ["query", key], { timeout: 5000, windowsHide: true }, (_err, stdout) => {
      resolve(parseRegOutput(String(stdout ?? "")));
    });
  });
}

function parseRegOutput(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    // "    <name>    REG_SZ    <data>" — default value shows as "(Default)".
    const m = line.match(/^\s+(\(Default\)|\S+)\s+REG_\w+(?:\s+(.*))?$/);
    if (m) map.set(m[1], (m[2] ?? "").trim());
  }
  return map;
}

interface ResolvedHandler extends FileOpenHandler {
  exe: string | null;
}

function extractExe(command: string): string | null {
  const quoted = command.match(/^"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  const bare = command.match(/([^\s]+\.exe)/i);
  return bare ? bare[1] : null;
}

function prettyExeName(exePath: string): string {
  return path.basename(exePath).replace(/\.exe$/i, "");
}

/**
 * Pretty display names from the exe's own version resource (FileDescription),
 * e.g. "Notepad++" / "Google Chrome" / "Visual Studio Code". Many apps do not
 * register FriendlyAppName, and the raw exe basename looks bad ("chrome").
 * One PowerShell call for the whole batch; results are keyed by exe path.
 */
async function readFileDescriptions(exes: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(exes.filter(Boolean))];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const list = unique.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    `@(${list}) | ForEach-Object { try { $v = (Get-Item -LiteralPath $_).VersionInfo.FileDescription;` +
    " if ($v) { Write-Output ($_ + [char]31 + $v) } } catch {} }";
  try {
    const { spawn } = await import("node:child_process");
    const out = await new Promise<string>((resolve) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      let buf = "";
      child.stdout.on("data", (d: Buffer) => (buf += d.toString("utf8")));
      child.on("close", () => resolve(buf));
      child.on("error", () => resolve(""));
    });
    for (const line of out.split(/\r?\n/)) {
      const i = line.indexOf("\x1f");
      if (i > 0) map.set(line.slice(0, i), line.slice(i + 1).trim());
    }
  } catch {
    /* PowerShell unavailable — keep basename fallback */
  }
  return map;
}

/** Upgrade bare exe-basename names ("chrome") to FileDescription ("Google Chrome"). */
async function applyPrettyNames(handlers: (ResolvedHandler | FileOpenHandler)[]): Promise<void> {
  const exes = handlers.map((h) => ("exe" in h ? h.exe : null)).filter((e): e is string => Boolean(e));
  if (exes.length === 0) return;
  const descriptions = await readFileDescriptions(exes);
  if (descriptions.size === 0) return;
  for (const h of handlers) {
    if (!("exe" in h) || !h.exe) continue;
    const description = descriptions.get(h.exe);
    // Only replace names that fell back to the raw basename.
    if (description && h.name === prettyExeName(h.exe)) h.name = description;
  }
}

function cleanName(raw: string | undefined): string {
  if (!raw) return "";
  // "@shell32.dll,-123" / "@{Package...}" style resource refs can't be resolved cheaply.
  if (raw.startsWith("@")) return "";
  return raw;
}

async function resolveProgId(progId: string): Promise<ResolvedHandler | null> {
  try {
    // CurVer redirect (e.g. "txtfile" -> versioned id), follow one level.
    const curver = await regQuery(`HKCR\\${progId}\\CurVer`);
    const id = curver.get("(Default)") || progId;
    const [rootVals, cmdVals] = await Promise.all([
      regQuery(`HKCR\\${id}`),
      regQuery(`HKCR\\${id}\\shell\\open\\command`),
    ]);
    const command = cmdVals.get("(Default)");
    if (!command) return null;
    const exe = extractExe(command);
    const name =
      cleanName(rootVals.get("FriendlyAppName")) ||
      cleanName(rootVals.get("ApplicationName")) ||
      (exe ? prettyExeName(exe) : id);
    return { name, command, exe };
  } catch {
    return null;
  }
}

async function resolveExeApp(exeName: string): Promise<ResolvedHandler | null> {
  try {
    const [appCmd, appRoot] = await Promise.all([
      regQuery(`HKCR\\Applications\\${exeName}\\shell\\open\\command`),
      regQuery(`HKCR\\Applications\\${exeName}`),
    ]);
    let command = appCmd.get("(Default)") || "";
    if (!command) {
      // App Paths fallback: full exe path, assume "%1" arg convention.
      for (const root of [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
      ]) {
        const vals = await regQuery(`${root}\\${exeName}`);
        const exePath = vals.get("(Default)");
        if (exePath && /\.exe$/i.test(exePath)) {
          command = `"${exePath}" "%1"`;
          break;
        }
      }
    }
    if (!command) return null;
    const exe = extractExe(command);
    const name =
      cleanName(appRoot.get("FriendlyAppName")) || (exe ? prettyExeName(exe) : exeName.replace(/\.exe$/i, ""));
    return { name, command, exe };
  } catch {
    return null;
  }
}

function isBlocked(handler: ResolvedHandler): boolean {
  const base = handler.exe ? path.basename(handler.exe).toLowerCase() : "";
  return base !== "" && SHELL_BLOCKLIST.has(base);
}

function sameHandler(a: ResolvedHandler | FileOpenHandler, b: ResolvedHandler | FileOpenHandler): boolean {
  const keyOf = (h: ResolvedHandler | FileOpenHandler) => ("exe" in h && h.exe ? h.exe : h.command).toLowerCase();
  return keyOf(a) === keyOf(b);
}

async function computeAssociations(ext: string): Promise<FileAssociations> {
  const fileExtsKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}`;
  const [userChoice, hkcrExt, crProgids, cuProgids, openWithList] = await Promise.all([
    regQuery(`${fileExtsKey}\\UserChoice`),
    regQuery(`HKCR\\${ext}`),
    regQuery(`HKCR\\${ext}\\OpenWithProgids`),
    regQuery(`${fileExtsKey}\\OpenWithProgids`),
    regQuery(`${fileExtsKey}\\OpenWithList`),
  ]);

  const defaultProgId = userChoice.get("ProgId") || hkcrExt.get("(Default)") || null;

  const progIds = new Set<string>();
  for (const map of [crProgids, cuProgids]) {
    for (const key of map.keys()) {
      if (key !== "(Default)") progIds.add(key);
    }
  }
  const exeNames: string[] = [];
  for (const [key, value] of openWithList) {
    if (key === "(Default)" || key.toLowerCase() === "mrulist" || !value) continue;
    exeNames.push(value);
  }

  const resolvedProgIds = await Promise.all([...progIds].map(resolveProgId));
  const resolvedExes = await Promise.all(exeNames.map(resolveExeApp));
  const all = [...resolvedProgIds, ...resolvedExes].filter((h): h is ResolvedHandler => h !== null);
  // Raw exe basenames ("chrome") get replaced with FileDescription ("Google Chrome").
  await applyPrettyNames(all);

  // Default app for "Open in X" — the per-user choice wins over the system default.
  let defaultApp: ResolvedHandler | null = null;
  if (defaultProgId) {
    defaultApp = /^Applications\\/i.test(defaultProgId)
      ? await resolveExeApp(defaultProgId.replace(/^Applications\\/i, ""))
      : await resolveProgId(defaultProgId);
  }
  if (defaultApp && isBlocked(defaultApp)) defaultApp = null;
  // Self-executing types (.exe, .bat...) resolve to a bare "%1" command —
  // that's not an editor, "Open file" already covers it.
  if (defaultApp && /^"?%1"?/.test(defaultApp.command.trim())) defaultApp = null;

  // Handlers for "Open with": dedupe by exe/command, drop shells and the default
  // (it already has its own menu entry).
  const seen = new Set<string>();
  const handlers: FileOpenHandler[] = [];
  for (const handler of all) {
    if (isBlocked(handler)) continue;
    if (defaultApp && sameHandler(handler, defaultApp)) continue;
    const key = (handler.exe || handler.command).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handlers.push({ name: handler.name, command: handler.command });
  }

  return {
    defaultApp: defaultApp ? { name: defaultApp.name, command: defaultApp.command } : null,
    handlers: handlers.slice(0, 10),
  };
}

export async function getFileAssociations(filePath: string): Promise<FileAssociations> {
  if (process.platform !== "win32") return { defaultApp: null, handlers: [] };
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return { defaultApp: null, handlers: [] };
  const hit = cache.get(ext);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const result = await computeAssociations(ext);
  if (cache.size > 64) cache.clear();
  cache.set(ext, { at: Date.now(), result });
  return result;
}

/** Split a trusted registry command line into tokens (quotes stripped). */
function tokenizeCommandLine(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) tokens.push(m[1] ?? m[2]);
  return tokens;
}

/** Run a registry open-command against a file: expands env vars, substitutes %1 / %*.
 *  Uses spawn without a shell so %VAR%-like sequences inside the file name survive. */
export function runOpenWith(command: string, targetPath: string): void {
  const expanded = command.replace(/%([A-Za-z0-9_]+)%/g, (match, name: string) => process.env[name] ?? match);
  const tokens = tokenizeCommandLine(expanded);
  if (!tokens.length) return;
  const exe = tokens[0];
  let substituted = false;
  const args = tokens.slice(1).map((token) => {
    if (/%1/i.test(token)) {
      substituted = true;
      return token.replace(/%1/gi, targetPath);
    }
    if (token === "%*") {
      substituted = true;
      return targetPath;
    }
    return token;
  });
  if (!substituted) args.push(targetPath);
  try {
    const child = spawn(exe, args, { windowsHide: true, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* handler exe missing */
  }
}

/** Native Windows "Open with…" dialog. */
export function openWithDialog(targetPath: string): void {
  execFile("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", targetPath], { windowsHide: true }, () => {});
}
