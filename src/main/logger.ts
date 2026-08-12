import { app } from "electron";
import path from "path";
import { AsyncRotatingFileLogger, sanitizeLogLine } from "./logger-core";

let logPath: string | null = null;
let logger: AsyncRotatingFileLogger | null = null;

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_GENERATIONS = 3;
const MAX_QUEUE_BYTES = 512 * 1024;
const FLUSH_INTERVAL_MS = 50;

function ensureLogPath(): string {
  if (logPath) return logPath;
  logPath = path.join(app.getPath("logs"), "main.log");
  return logPath;
}

export function appendMainLog(line: string): void {
  appendMainLogs([line]);
}

export function appendMainLogs(lines: readonly string[]): void {
  const stamp = new Date().toISOString();
  const sanitizedLines = lines.map((line) => sanitizeLogLine(line));
  getLogger().append(sanitizedLines.map((line) => `[${stamp}] ${line}\n`));
  if (!app.isPackaged) {
    for (const line of sanitizedLines) console.log(`[main] ${line}`);
  }
}

export function getMainLogPath(): string {
  return ensureLogPath();
}

export function flushMainLog(): Promise<void> {
  return logger?.flush() ?? Promise.resolve();
}

function getLogger(): AsyncRotatingFileLogger {
  logger ??= new AsyncRotatingFileLogger({
    filePath: ensureLogPath(),
    maxBytes: MAX_LOG_BYTES,
    maxGenerations: MAX_LOG_GENERATIONS,
    maxQueueBytes: MAX_QUEUE_BYTES,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[main logger] asynchronous write failed: ${sanitizeLogLine(message, 1_024)}`);
    },
  });
  return logger;
}
