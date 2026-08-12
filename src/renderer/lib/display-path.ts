function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\");
}

function trimTrailingSeparators(value: string): string {
  if (value === "/" || /^[a-z]:[\\/]$/i.test(value)) return value;
  return value.replace(/[\\/]+$/, "");
}

export function abbreviateHomePath(cwd: string, homeDir?: string): string {
  if (!homeDir) return cwd;
  const home = trimTrailingSeparators(homeDir);
  const windows = isWindowsPath(home) || isWindowsPath(cwd);
  const comparableHome = windows ? home.replace(/\\/g, "/").toLowerCase() : home;
  const comparableCwd = windows ? cwd.replace(/\\/g, "/").toLowerCase() : cwd;
  if (comparableCwd === comparableHome) return "~";

  if (home === "/" && cwd.startsWith("/")) return `~${cwd}`;
  if (/^[a-z]:[\\/]$/i.test(home) && comparableCwd.startsWith(comparableHome)) {
    return `~${cwd.slice(home.length - 1)}`;
  }
  if (!comparableCwd.startsWith(comparableHome)) return cwd;
  const boundary = cwd.charAt(home.length);
  return boundary === "/" || boundary === "\\" ? `~${cwd.slice(home.length)}` : cwd;
}
