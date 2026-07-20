import type { PublicToolchainState } from "../shared/toolchains/types";

export interface DiagnosticRedactionRoots {
  homeDir: string;
  userDataDir: string;
  logsDir: string;
  platform?: NodeJS.Platform;
}

const SECRET_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s,;]+)`;

export function redactDiagnosticText(input: string, roots: DiagnosticRedactionRoots): string {
  let output = input;
  const replacements = [
    { value: roots.userDataDir, label: "<userData>" },
    { value: roots.logsDir, label: "<logs>" },
    { value: roots.homeDir, label: roots.platform === "win32" ? "%USERPROFILE%" : "$HOME" },
  ]
    .filter((entry) => entry.value.length > 0)
    .sort((left, right) => right.value.length - left.value.length);

  for (const replacement of replacements) {
    const variants = new Set([
      replacement.value,
      replacement.value.replaceAll("\\", "/"),
      replacement.value.replaceAll("/", "\\"),
    ]);
    for (const value of variants) {
      if (!value) continue;
      output = output.replace(
        new RegExp(escapeRegExp(value), roots.platform === "win32" ? "gi" : "g"),
        replacement.label,
      );
    }
  }

  output = output.replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi, (match) => {
    const separator = match.includes(":") ? ":" : "=";
    return `${match.slice(0, match.indexOf(separator))}${separator} <redacted>`;
  });
  output = output.replace(
    new RegExp(
      String.raw`\b(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG__AUTH|NPM_CONFIG__AUTHTOKEN|PIP_INDEX_URL|UV_INDEX_URL|HTTPS?_PROXY)\s*[:=]\s*${SECRET_VALUE}`,
      "gi",
    ),
    "$1=<redacted>",
  );
  output = output.replace(
    new RegExp(
      String.raw`(["']?(?:token|password|passwd|secret|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*)${SECRET_VALUE}`,
      "gi",
    ),
    "$1<redacted>",
  );
  output = output.replace(
    /\b(?:npm_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
    "<redacted-token>",
  );
  output = output.replace(/(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, "$1<redacted>@");
  return output;
}

export function buildToolchainDiagnosticSummary(state: PublicToolchainState): Record<string, unknown> {
  const capabilities = Object.fromEntries(
    Object.entries(state.capabilities).map(([capability, entry]) => [
      capability,
      entry
        ? {
            provider: entry.provider,
            version: entry.version,
            health: entry.health,
            reasonCode: entry.reasonCode,
          }
        : { health: "missing" },
    ]),
  );
  const components = Object.fromEntries(
    Object.entries(state.components)
      .filter(([, entry]) => entry?.installed)
      .map(([componentId, entry]) => [
        componentId,
        {
          activeVersion: entry?.activeVersion,
          platformArch: entry?.platformArch,
          health: entry?.health,
          diskBytes: entry?.diskBytes,
        },
      ]),
  );
  return {
    revision: state.revision,
    platformArch: `${state.platform}-${state.arch}`,
    coreReady: state.coreReady,
    stateReadOnly: state.stateReadOnly ?? false,
    capabilities,
    components,
    operations: state.operations.map((operation) => ({
      componentId: operation.componentId,
      phase: operation.phase,
      errorCode: operation.error?.code,
    })),
    lastScanAt: state.lastScanAt,
    lastErrorCode: state.lastErrorCode ?? null,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
