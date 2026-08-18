export const SESSION_CWD_CHANGED_CUSTOM_TYPE = "desktop.cwdChanged";

export function sessionCwdChangedNotice(from: string, to: string): string {
  return `${from} → ${to}`;
}

export function encodedSessionCwdDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function rewriteSessionHeaderCwdText(raw: string, cwd: string): string {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const first = lines[0];
  if (!first?.trim()) throw new Error("Session file is empty");
  const header = JSON.parse(first) as { type?: string; cwd?: string };
  if (header.type !== "session") throw new Error("Session header missing");
  header.cwd = cwd;
  lines[0] = JSON.stringify(header);
  return lines.join(newline);
}
