import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";

export type SessionPtyMark = "running" | "dead";

export type SessionPtyStartRequest = {
  sessionId: string;
  sessionPath?: string;
  cwd: string;
  nodeExecutable: string;
  program: string;
};

export type SessionPtySize = {
  cols: number;
  rows: number;
};

export type SessionPtyProcess = {
  pid: number;
  onData: (listener: (data: string) => void) => { dispose: () => void };
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

export type SessionPtySpawn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    cols: number;
    rows: number;
    name: string;
    env: Record<string, string>;
  },
) => SessionPtyProcess;

export type SessionPtyManager = ReturnType<typeof createSessionPtyManager>;

const DEFAULT_SIZE: SessionPtySize = { cols: 120, rows: 30 };

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function validDimension(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const integer = Math.floor(value);
  return integer > 0 && integer <= 10_000 ? integer : null;
}

export function bundledPiCliPath(): string {
  const packageJsonPath = findPackageJSON(
    "@earendil-works/pi-coding-agent",
    typeof __filename === "string" ? __filename : import.meta.url,
  );
  if (!packageJsonPath) throw new Error("Bundled Pi package not found");
  return join(dirname(packageJsonPath), "dist", "cli.js");
}

type LivePty = {
  pty: SessionPtyProcess;
  cwd: string;
  sessionPath?: string;
};

function samePtyPlacement(live: LivePty, request: SessionPtyStartRequest): boolean {
  return live.cwd === request.cwd && (live.sessionPath ?? "") === (request.sessionPath ?? "");
}

export function createSessionPtyManager(options: {
  spawn: SessionPtySpawn;
  onData?: (sessionId: string, data: string) => void;
  onExit?: (sessionId: string, exitCode: number) => void;
}) {
  const sessions = new Map<string, LivePty>();
  const marks = new Map<string, SessionPtyMark>();

  function start(request: SessionPtyStartRequest, requestedSize: SessionPtySize = DEFAULT_SIZE) {
    const existing = sessions.get(request.sessionId);
    if (existing && samePtyPlacement(existing, request)) {
      return { action: "focus" as const, sessionId: request.sessionId };
    }
    if (existing) {
      sessions.delete(request.sessionId);
      existing.pty.kill();
    }
    const cols = validDimension(requestedSize.cols) ?? DEFAULT_SIZE.cols;
    const rows = validDimension(requestedSize.rows) ?? DEFAULT_SIZE.rows;
    const sessionArgs = request.sessionPath ? ["--session", request.sessionPath] : ["--session-id", request.sessionId];
    const pty = options.spawn(request.nodeExecutable, [request.program, ...sessionArgs], {
      cwd: request.cwd,
      cols,
      rows,
      name: "xterm-256color",
      env: { ...processEnvironment(), TERM: "xterm-256color" },
    });
    const live: LivePty = { pty, cwd: request.cwd, sessionPath: request.sessionPath };
    sessions.set(request.sessionId, live);
    marks.set(request.sessionId, "running");
    pty.onData((data) => {
      if (sessions.get(request.sessionId)?.pty === pty) options.onData?.(request.sessionId, data);
    });
    pty.onExit((event) => {
      if (sessions.get(request.sessionId)?.pty !== pty) return;
      sessions.delete(request.sessionId);
      marks.set(request.sessionId, "dead");
      options.onExit?.(request.sessionId, event.exitCode);
    });
    return { action: "spawn" as const, sessionId: request.sessionId, pid: pty.pid };
  }

  function write(sessionId: string, data: string): void {
    if (!data || data.length > 1_048_576) return;
    sessions.get(sessionId)?.pty.write(data);
  }

  function resize(sessionId: string, cols: number, rows: number): void {
    const validCols = validDimension(cols);
    const validRows = validDimension(rows);
    if (!validCols || !validRows) return;
    sessions.get(sessionId)?.pty.resize(validCols, validRows);
  }

  function kill(sessionId: string): void {
    const live = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (!live) {
      if (marks.has(sessionId)) marks.set(sessionId, "dead");
      return;
    }
    marks.set(sessionId, "dead");
    live.pty.kill();
  }

  function markDead(sessionId: string): void {
    if (!sessions.has(sessionId)) marks.set(sessionId, "dead");
  }

  function killAll(): void {
    const livePtys = [...sessions.values()];
    sessions.clear();
    marks.clear();
    for (const live of livePtys) live.pty.kill();
  }

  function snapshotMarks(): Record<string, SessionPtyMark> {
    return Object.fromEntries(marks);
  }

  return { start, write, resize, kill, markDead, killAll, snapshotMarks };
}
