import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  encodedSessionCwdDirName,
  rewriteSessionHeaderCwdText,
  SESSION_CWD_CHANGED_CUSTOM_TYPE,
  sessionCwdChangedNotice,
} from "../shared/session-cwd.ts";

export function sessionsRoot(): string {
  return path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR || path.join(getAgentDir(), "sessions"));
}

export function defaultSessionDirForCwd(cwd: string): string {
  return path.join(sessionsRoot(), encodedSessionCwdDirName(path.resolve(cwd)));
}

export function relocateSessionFile(filePath: string, fromCwd: string, toCwd: string): string {
  const destDir = defaultSessionDirForCwd(toCwd);
  mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, path.basename(filePath));
  if (path.resolve(filePath) !== path.resolve(destPath) && existsSync(destPath)) {
    throw new Error("A session file already exists at the destination");
  }
  const next = rewriteSessionHeaderCwdText(readFileSync(filePath, "utf8"), toCwd);
  if (path.resolve(filePath) === path.resolve(destPath)) {
    writeFileSync(filePath, next);
  } else {
    writeFileSync(destPath, next);
    unlinkSync(filePath);
  }
  SessionManager.open(destPath).appendCustomMessageEntry(
    SESSION_CWD_CHANGED_CUSTOM_TYPE,
    sessionCwdChangedNotice(fromCwd, toCwd),
    true,
    { from: fromCwd, to: toCwd },
  );
  return destPath;
}
