import { useState } from "react";
import type { ToolCapabilityId, ToolchainActionRequest } from "@shared/toolchains/types";
import { isToolCapabilityId } from "@shared/toolchains/types";
import { useI18n } from "@/i18n";

export interface CapabilityIssue {
  code: string;
  capability?: ToolCapabilityId;
  message?: string;
}

export function parseCapabilityIssue(value: unknown): CapabilityIssue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string") return null;
  const capability = isToolCapabilityId(record.capability) ? record.capability : capabilityFromCode(record.code);
  const isRequired = record.code === "TOOLCHAIN_CAPABILITY_REQUIRED" || /_REQUIRED$/.test(record.code);
  if (!isRequired) return null;
  return {
    code: record.code,
    capability,
    message: typeof record.error === "string" ? record.error : undefined,
  };
}

export function CapabilityRequired({
  issue,
  cwd,
  onContinue,
  onCancel,
}: {
  issue: CapabilityIssue;
  cwd: string;
  onContinue: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<"install" | "rescan" | "choose" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const installAction = installActionForIssue(
    issue,
    typeof window === "undefined" ? "linux" : window.piBridge.platform,
  );
  const label = capabilityLabel(issue.capability, t);

  const installAndContinue = async (): Promise<void> => {
    if (!installAction) return;
    setPending("install");
    setError(null);
    try {
      await window.piBridge.performToolchainAction(installAction);
      await onContinue();
    } catch (caught) {
      if (String(caught).includes("TOOLCHAIN_CANCELLED")) return;
      setError(
        t("capabilityInstallFailed", "The required tools could not be installed. Nothing was added to system PATH."),
      );
    } finally {
      setPending(null);
    }
  };

  const rescan = async (): Promise<void> => {
    setPending("rescan");
    setError(null);
    try {
      await window.piBridge.rescanToolchains(cwd);
    } catch {
      setError(t("capabilityRescanFailed", "Tool rescan failed. Existing selections were not changed."));
    } finally {
      setPending(null);
    }
  };

  const chooseExisting = async (): Promise<void> => {
    if (!issue.capability) return;
    setPending("choose");
    setError(null);
    try {
      await window.piBridge.performToolchainAction({ action: "choose-custom-tool", capability: issue.capability });
      onCancel();
    } catch (caught) {
      if (String(caught).includes("TOOLCHAIN_CANCELLED")) return;
      setError(t("capabilitySelectionFailed", "The selected executable did not provide the required healthy tool."));
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      role="alert"
      style={{
        padding: 13,
        border: "1px solid color-mix(in srgb, #f59e0b 45%, var(--border))",
        borderRadius: 8,
        background: "color-mix(in srgb, #f59e0b 8%, var(--bg-panel))",
        color: "var(--text)",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700 }}>
        {t("capabilityRequiredTitle", `${label} is required for this operation.`).replace("{tool}", label)}
      </div>
      <p style={{ margin: "5px 0 10px", fontSize: 11, lineHeight: 1.55, color: "var(--text-muted)" }}>
        {t(
          "capabilityRequiredDescription",
          "No verified tool satisfying this operation was found. Pi Desktop will not download one in the background.",
        )}
      </p>
      {error && <p style={{ margin: "0 0 9px", fontSize: 11, color: "#f87171" }}>{error}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {installAction && (
          <PromptButton primary disabled={pending !== null} onClick={() => void installAndContinue()}>
            {pending === "install"
              ? t("installingAndContinue", "Installing…")
              : t("installAndContinue", "Install and continue")}
          </PromptButton>
        )}
        <PromptButton disabled={pending !== null} onClick={() => void rescan()}>
          {pending === "rescan" ? t("rescanningTools", "Scanning…") : t("rescanTools", "Rescan")}
        </PromptButton>
        {issue.capability && (
          <PromptButton disabled={pending !== null} onClick={() => void chooseExisting()}>
            {pending === "choose"
              ? t("checkingSelectedTool", "Checking…")
              : t("chooseExistingTool", "Choose existing…")}
          </PromptButton>
        )}
        <PromptButton disabled={pending !== null} onClick={onCancel}>
          {t("cancel", "Cancel")}
        </PromptButton>
      </div>
    </div>
  );
}

function PromptButton({
  children,
  disabled,
  primary = false,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        minHeight: 31,
        padding: "6px 10px",
        border: `1px solid ${primary ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 6,
        background: primary ? "var(--accent)" : "var(--bg)",
        color: primary ? "white" : "var(--text)",
        fontSize: 11,
        fontWeight: 600,
        cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function capabilityFromCode(code: string): ToolCapabilityId | undefined {
  const values: Record<string, ToolCapabilityId> = {
    TOOLCHAIN_NODE_REQUIRED: "js.node",
    TOOLCHAIN_PYTHON_REQUIRED: "python.interpreter",
    TOOLCHAIN_UV_REQUIRED: "python.uv",
    TOOLCHAIN_GIT_REQUIRED: "vcs.git",
    TOOLCHAIN_BASH_REQUIRED: "shell.bash",
  };
  return values[code];
}

export function installActionForIssue(
  issue: CapabilityIssue,
  platform: NodeJS.Platform,
): Extract<ToolchainActionRequest, { action: "install-profile" | "install-component" }> | undefined {
  if (issue.capability === "js.bun") return { action: "install-component", componentId: "bun" };
  if (["js.node", "js.npm", "js.npx"].includes(issue.capability ?? "")) {
    return { action: "install-profile", profileId: "javascript-essentials" };
  }
  if (issue.capability?.startsWith("python.")) {
    return { action: "install-profile", profileId: "python-essentials" };
  }
  if (platform === "win32" && (issue.capability === "vcs.git" || issue.capability === "shell.bash")) {
    return { action: "install-profile", profileId: "windows-shell-essentials" };
  }
  if (issue.capability === "data.jq") return { action: "install-profile", profileId: "cli-essentials" };
  return undefined;
}

function capabilityLabel(
  capability: ToolCapabilityId | undefined,
  t: (key: string, fallback: string) => string,
): string {
  if (!capability) return t("developerTool", "A developer tool");
  const labels: Partial<Record<ToolCapabilityId, string>> = {
    "js.node": "Node.js/npm",
    "js.npm": "Node.js/npm",
    "js.npx": "Node.js/npm",
    "js.bun": "Bun",
    "python.interpreter": "Python",
    "python.uv": "Python/uv",
    "python.uvx": "Python/uv",
    "vcs.git": "Git",
    "shell.bash": "Bash",
    "data.jq": "jq",
  };
  return labels[capability] ?? capability;
}
