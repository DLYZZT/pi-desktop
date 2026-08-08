import type { AgentSessionRuntimeDiagnostic } from "@earendil-works/pi-coding-agent";

export type ExtensionDiagnosticStatus = { key: string; text: string };

function safeDiagnosticMessage(message: string): string {
  return message
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[redacted]")
    .replace(/\b(api[_ -]?key|token|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function projectExtensionDiagnostics(
  diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): ExtensionDiagnosticStatus[] {
  return diagnostics.map((diagnostic, index) => ({
    key: `pi-runtime-${diagnostic.type}-${index + 1}`,
    text: safeDiagnosticMessage(diagnostic.message) || `Pi runtime ${diagnostic.type}`,
  }));
}
