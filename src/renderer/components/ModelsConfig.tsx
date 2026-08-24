import { useState, useEffect, useCallback, useRef, useReducer } from "react";
import { Check, Field, NumInput, SecretTextInput, Select, SectionTitle, TextInput } from "./form-controls";
import { applyStrictOptionalPositiveInteger } from "@/lib/strict-integer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/i18n";
import {
  addModelTransition,
  deleteProviderTransition,
  modelsConfigEditorReducer,
  renameProviderEntry,
  replaceModelEntry,
  selectionAfterProviderRename,
  setProviderBaseUrl,
  type ModelEntry,
  type ModelsConfigSelection,
  type ModelsConfigUpdate,
  type ModelsJson,
  type ProviderEntry,
} from "@/lib/models-config-state";
import { call, getModelPreferences, setModelPreferences } from "@/lib/api-client";
import { isModelEnabled, setProviderModelsEnabled, toggleModelEnabled } from "@/lib/model-selection";
import type { ModelPreferencesResult } from "@contract/types";
// Color icons (have their own fill colors — no background needed)
import AnthropicIcon from "@lobehub/icons/es/Anthropic/components/Mono";
import OpenAIIcon from "@lobehub/icons/es/OpenAI/components/Mono";
import GoogleColorIcon from "@lobehub/icons/es/Google/components/Color";
import DeepSeekColorIcon from "@lobehub/icons/es/DeepSeek/components/Color";
import GroqIcon from "@lobehub/icons/es/Groq/components/Mono";
import MistralColorIcon from "@lobehub/icons/es/Mistral/components/Color";
import MoonshotIcon from "@lobehub/icons/es/Moonshot/components/Mono";
import MinimaxColorIcon from "@lobehub/icons/es/Minimax/components/Color";
import FireworksColorIcon from "@lobehub/icons/es/Fireworks/components/Color";
import HuggingFaceColorIcon from "@lobehub/icons/es/HuggingFace/components/Color";
import CerebrasColorIcon from "@lobehub/icons/es/Cerebras/components/Color";
import OpenRouterIcon from "@lobehub/icons/es/OpenRouter/components/Mono";
import XAIIcon from "@lobehub/icons/es/XAI/components/Mono";
import CloudflareColorIcon from "@lobehub/icons/es/Cloudflare/components/Color";
import VercelIcon from "@lobehub/icons/es/Vercel/components/Mono";
import GithubCopilotIcon from "@lobehub/icons/es/GithubCopilot/components/Mono";
import AwsColorIcon from "@lobehub/icons/es/Aws/components/Color";
import AzureColorIcon from "@lobehub/icons/es/Azure/components/Color";
import KimiColorIcon from "@lobehub/icons/es/Kimi/components/Color";
import QwenColorIcon from "@lobehub/icons/es/Qwen/components/Color";
import ZhipuColorIcon from "@lobehub/icons/es/Zhipu/components/Color";
import CohereColorIcon from "@lobehub/icons/es/Cohere/components/Color";
import PerplexityColorIcon from "@lobehub/icons/es/Perplexity/components/Color";
import TogetherColorIcon from "@lobehub/icons/es/Together/components/Color";
import GrokIcon from "@lobehub/icons/es/Grok/components/Mono";
import AntGroupColorIcon from "@lobehub/icons/es/AntGroup/components/Color";
import NvidiaColorIcon from "@lobehub/icons/es/Nvidia/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import XiaomiMiMoIcon from "@lobehub/icons/es/XiaomiMiMo/components/Mono";
import ZAIIcon from "@lobehub/icons/es/ZAI/components/Mono";

type IconComponent = React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>;

// hasColor=true → Color icon (self-colored SVG, no wrapper)
// hasColor=false → Mono icon (rendered with currentColor, inherits theme text color)
const PROVIDER_ICONS: Record<string, { Icon: IconComponent; hasColor: boolean }> = {
  anthropic: { Icon: AnthropicIcon, hasColor: false },
  openai: { Icon: OpenAIIcon, hasColor: false },
  "openai-codex": { Icon: OpenAIIcon, hasColor: false },
  google: { Icon: GoogleColorIcon, hasColor: true },
  "google-vertex": { Icon: GoogleColorIcon, hasColor: true },
  "ant-ling": { Icon: AntGroupColorIcon, hasColor: true },
  deepseek: { Icon: DeepSeekColorIcon, hasColor: true },
  groq: { Icon: GroqIcon, hasColor: false },
  mistral: { Icon: MistralColorIcon, hasColor: true },
  moonshotai: { Icon: MoonshotIcon, hasColor: false },
  "moonshotai-cn": { Icon: MoonshotIcon, hasColor: false },
  moonshot: { Icon: MoonshotIcon, hasColor: false },
  minimax: { Icon: MinimaxColorIcon, hasColor: true },
  "minimax-cn": { Icon: MinimaxColorIcon, hasColor: true },
  fireworks: { Icon: FireworksColorIcon, hasColor: true },
  huggingface: { Icon: HuggingFaceColorIcon, hasColor: true },
  cerebras: { Icon: CerebrasColorIcon, hasColor: true },
  openrouter: { Icon: OpenRouterIcon, hasColor: false },
  xai: { Icon: XAIIcon, hasColor: false },
  "cloudflare-ai-gateway": { Icon: CloudflareColorIcon, hasColor: true },
  "cloudflare-workers-ai": { Icon: CloudflareColorIcon, hasColor: true },
  "vercel-ai-gateway": { Icon: VercelIcon, hasColor: false },
  "github-copilot": { Icon: GithubCopilotIcon, hasColor: false },
  "amazon-bedrock": { Icon: AwsColorIcon, hasColor: true },
  "azure-openai-responses": { Icon: AzureColorIcon, hasColor: true },
  "kimi-coding": { Icon: KimiColorIcon, hasColor: true },
  nvidia: { Icon: NvidiaColorIcon, hasColor: true },
  opencode: { Icon: OpenCodeIcon, hasColor: false },
  "opencode-go": { Icon: OpenCodeIcon, hasColor: false },
  qwen: { Icon: QwenColorIcon, hasColor: true },
  xiaomi: { Icon: XiaomiMiMoIcon, hasColor: false },
  "xiaomi-token-plan-ams": { Icon: XiaomiMiMoIcon, hasColor: false },
  "xiaomi-token-plan-cn": { Icon: XiaomiMiMoIcon, hasColor: false },
  "xiaomi-token-plan-sgp": { Icon: XiaomiMiMoIcon, hasColor: false },
  zai: { Icon: ZAIIcon, hasColor: false },
  "zai-coding-cn": { Icon: ZAIIcon, hasColor: false },
  zhipu: { Icon: ZhipuColorIcon, hasColor: true },
  cohere: { Icon: CohereColorIcon, hasColor: true },
  perplexity: { Icon: PerplexityColorIcon, hasColor: true },
  together: { Icon: TogetherColorIcon, hasColor: true },
  grok: { Icon: GrokIcon, hasColor: false },
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
}

interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
}

type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | {
      phase: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds: number | null;
      expiresInSeconds: number | null;
    }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success"; message?: string; warning?: boolean }
  | { phase: "error"; message: string };

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

type Selection = ModelsConfigSelection;

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

// ── Provider detail ───────────────────────────────────────────────────────────

function ProviderDetail({
  name,
  provider,
  onChange,
  onRename,
  onDelete,
  modelSelection,
}: {
  name: string;
  provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void;
  onRename: (n: string) => void;
  onDelete: () => void;
  modelSelection: ModelSelectionControl;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(name);
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial provider load intentionally runs once.
  }, [provider.api]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelProvider", "Provider")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ProviderEnableToggle
            providerId={name}
            preferences={modelSelection.preferences}
            saving={modelSelection.saving}
            onChange={modelSelection.onChange}
          />
          <button
            type="button"
            onClick={onDelete}
            style={{
              minHeight: 32,
              padding: "0 10px",
              background: "none",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 4,
              color: "#ef4444",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("delete", "Delete")}
          </button>
        </div>
      </div>

      <Field label={t("modelProviderName", "Provider name")}>
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button
            type="button"
            onClick={() => onRename(editingName.trim())}
            style={{
              marginTop: 4,
              minHeight: 32,
              padding: "0 12px",
              background: "var(--accent)",
              border: "none",
              borderRadius: 4,
              color: "#fff",
              cursor: "pointer",
              fontSize: 12,
              alignSelf: "flex-start",
            }}
          >
            {t("rename", "Rename")}
          </button>
        )}
      </Field>

      <Field label={t("modelBaseUrl", "Base URL")}>
        <TextInput
          value={provider.baseUrl ?? ""}
          onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1"
          mono
        />
      </Field>

      <Field label={t("modelApiKey", "API Key")}>
        <SecretTextInput
          value={provider.apiKey ?? ""}
          onChange={(v) => set("apiKey", v || undefined)}
          placeholder={t("modelApiKeySourcePlaceholder", "ENV_VAR_NAME, !shell-command, or literal key")}
          mono
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {t("modelApiKeySourceHint", "Prefix with ! to run a shell command, or use an environment variable name.")}
        </span>
      </Field>

      <Field label={t("modelApi", "API")}>
        <Select
          value={provider.api ?? "openai-completions"}
          onChange={(v) => set("api", v)}
          options={API_OPTIONS}
          required
        />
      </Field>
    </div>
  );
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function thinkingLevelLabel(level: ThinkingLevel, t: (key: string, fallback: string) => string): string {
  switch (level) {
    case "off":
      return t("thinkingOff", "Off");
    case "minimal":
      return t("thinkingMinimal", "Minimal");
    case "low":
      return t("thinkingLow", "Low");
    case "medium":
      return t("thinkingMedium", "Medium");
    case "high":
      return t("thinkingHigh", "High");
    case "xhigh":
      return t("thinkingXHigh", "Extra high");
  }
}

function modelCostLabel(
  kind: "input" | "output" | "cacheRead" | "cacheWrite",
  t: (key: string, fallback: string) => string,
): string {
  switch (kind) {
    case "input":
      return t("modelCostInput", "input");
    case "output":
      return t("modelCostOutput", "output");
    case "cacheRead":
      return t("modelCostCacheRead", "cache read");
    case "cacheWrite":
      return t("modelCostCacheWrite", "cache write");
  }
}

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off: "var(--text-dim)",
  minimal: "#a19d92",
  low: "#d97706",
  medium: "#ea580c",
  high: "#c2410c",
  xhigh: "#9a3412",
};

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const { t } = useI18n();
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") {
      delete next[level];
    } else {
      next[level] = entry;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" = !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        const btnBase: React.CSSProperties = {
          minHeight: 32,
          padding: "0 10px",
          fontSize: 12,
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background 0.1s, color 0.1s",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        };
        const btnActive: React.CSSProperties = {
          background: "var(--accent)",
          color: "#fff",
          fontWeight: 600,
        };
        const btnActiveDisabled: React.CSSProperties = {
          background: "#ef4444",
          color: "#fff",
          fontWeight: 600,
        };

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            {/* Level badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: color,
                  flexShrink: 0,
                  opacity: state === "null" ? 0.3 : 1,
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                  textDecoration: state === "null" ? "line-through" : "none",
                }}
              >
                {thinkingLevelLabel(level, t)}
              </span>
            </div>

            {/* Default + Disabled buttons */}
            <div
              style={{
                display: "flex",
                borderRadius: 5,
                border: "1px solid var(--border)",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setLevel(level, "omit")}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                {t("modelDefault", "Default")}
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{
                  ...btnBase,
                  borderLeft: "1px solid var(--border)",
                  ...(state === "null" ? btnActiveDisabled : {}),
                }}
              >
                {t("modelDisabled", "Disabled")}
              </button>
            </div>

            {/* Custom button + input fused */}
            <div
              style={{
                display: "flex",
                borderRadius: 5,
                border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`,
                overflow: "hidden",
                transition: "border-color 0.1s",
              }}
            >
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{
                  ...btnBase,
                  ...(state === "string" ? btnActive : {}),
                  borderRight: "1px solid var(--border)",
                  flexShrink: 0,
                }}
              >
                {t("modelCustom", "Custom")}
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => {
                  if (state !== "string") setLevel(level, strVal || level);
                }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 7px",
                  transition: "background 0.1s, color 0.1s",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model detail ──────────────────────────────────────────────────────────────

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const costVal = (k: keyof NonNullable<ModelEntry["cost"]>) =>
    model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: keyof NonNullable<ModelEntry["cost"]>, v: string) => {
    const n = parseFloat(v);
    onChange({ ...model, cost: { ...(model.cost ?? {}), [k]: isNaN(n) ? undefined : n } });
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return t("modelTestingConnection", "Testing model connection…");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return [t("modelConnectionConnected", "Connected"), ...meta, testState.responseText || null]
        .filter(Boolean)
        .join(" · ");
    }
    return [t("modelConnectionFailed", "Failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("model", "Model")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {testSummary && (
            <span
              title={testSummary}
              style={{
                maxWidth: 260,
                height: 24,
                padding: "0 8px",
                border: `1px solid ${testState.phase === "error" ? "var(--danger-border)" : testState.phase === "success" ? "var(--success-border)" : "var(--border)"}`,
                borderRadius: 4,
                background:
                  testState.phase === "error"
                    ? "var(--danger-soft)"
                    : testState.phase === "success"
                      ? "var(--success-soft)"
                      : "var(--bg-hover)",
                color:
                  testState.phase === "error"
                    ? "var(--danger)"
                    : testState.phase === "success"
                      ? "var(--success)"
                      : "var(--text-muted)",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {testSummary}
            </span>
          )}
          <button
            type="button"
            onClick={handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={t("modelTestConnection", "Test model connection")}
            style={{
              height: 32,
              padding: "0 10px",
              background: testState.phase === "success" ? "var(--success)" : "none",
              border: `1px solid ${testState.phase === "success" ? "var(--success)" : "var(--border)"}`,
              borderRadius: 4,
              color:
                testState.phase === "success"
                  ? "var(--on-accent)"
                  : !model.id.trim() || testState.phase === "testing"
                    ? "var(--text-dim)"
                    : "var(--text-muted)",
              cursor: !model.id.trim() || testState.phase === "testing" ? "not-allowed" : "pointer",
              fontSize: 12,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
              gap: 5,
            }}
          >
            {testState.phase === "success" && (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {testState.phase === "testing"
              ? t("testingConnection", "Testing…")
              : testState.phase === "success"
                ? "OK"
                : t("modelTest", "Test")}
          </button>
          <button
            type="button"
            onClick={onDelete}
            style={{
              height: 32,
              padding: "0 10px",
              background: "none",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 4,
              color: "#ef4444",
              cursor: "pointer",
              fontSize: 12,
              boxSizing: "border-box",
            }}
          >
            {t("modelRemove", "Remove")}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("modelId", "ID *")}>
          <TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono />
        </Field>
        <Field label={t("modelName", "Name")}>
          <TextInput
            value={model.name ?? ""}
            onChange={(v) => set("name", v || undefined)}
            placeholder={t("modelDisplayName", "Display name")}
          />
        </Field>
      </div>

      <Field label={t("modelApiOverride", "API override")}>
        <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Check
          label={t("modelReasoning", "Reasoning / thinking")}
          checked={model.reasoning ?? false}
          onChange={(v) => set("reasoning", v || undefined)}
        />
        <Check
          label={t("modelImageInput", "Image input")}
          checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)}
        />
      </div>

      {model.reasoning && (
        <>
          <Check
            label={t("modelDeepSeekCompat", "DeepSeek thinking compatibility")}
            checked={hasDeepseekCompat(model)}
            onChange={(v) => onChange(setDeepseekCompat(model, v))}
          />
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>{t("modelThinkingLevelMap", "Thinking level map")}</SectionTitle>
              {model.thinkingLevelMap && (
                <button
                  type="button"
                  onClick={() => set("thinkingLevelMap", undefined)}
                  style={{
                    minHeight: 32,
                    fontSize: 12,
                    padding: "0 9px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                  }}
                >
                  {t("modelClearAll", "Clear all")}
                </button>
              )}
            </div>
            <ThinkingLevelMapEditor value={model.thinkingLevelMap} onChange={(v) => set("thinkingLevelMap", v)} />
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("modelContextWindow", "Context window (tokens)")}>
          <NumInput
            value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(value) => set("contextWindow", applyStrictOptionalPositiveInteger(model.contextWindow, value))}
            placeholder="128000"
          />
        </Field>
        <Field label={t("modelMaxOutputTokens", "Max output tokens")}>
          <NumInput
            value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(value) => set("maxTokens", applyStrictOptionalPositiveInteger(model.maxTokens, value))}
            placeholder="16384"
          />
        </Field>
      </div>

      <div>
        <SectionTitle>{t("modelCostPerMillion", "Cost (per million tokens)")}</SectionTitle>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <Field key={k} label={modelCostLabel(k, t)}>
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </Field>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Managed provider models ──────────────────────────────────────────────────

function ProviderEnableToggle({
  providerId,
  preferences,
  saving,
  onChange,
}: {
  providerId: string;
  preferences: ModelPreferencesResult | null;
  saving: boolean;
  onChange: (enabledModels: string[] | null) => Promise<void>;
}) {
  const providerModels = (preferences?.models ?? []).filter((model) => model.provider === providerId);
  const enabledCount = providerModels.filter((model) =>
    isModelEnabled(model, preferences?.enabledModels ?? null),
  ).length;
  const enabled = enabledCount > 0;
  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (saving || providerModels.length === 0) return;
    void onChange(setProviderModelsEnabled(providerModels, preferences?.enabledModels ?? null, providerId, !enabled));
  };
  // Same switch look as Skills/Plugins toggles.
  const w = 48;
  const h = 32;
  const knob = 20;
  const pad = (h - knob) / 2;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={(enabled ? "Disable " : "Enable ") + providerId + " models in the picker"}
      title={(enabled ? "Disable " : "Enable ") + providerId + " models in the picker"}
      onClick={toggle}
      disabled={saving}
      style={{
        flexShrink: 0,
        width: w,
        height: h,
        borderRadius: h / 2,
        border: "none",
        padding: 0,
        cursor: saving ? "wait" : providerModels.length === 0 ? "not-allowed" : "pointer",
        opacity: providerModels.length === 0 ? 0.4 : 1,
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: pad,
          left: enabled ? w - knob - pad : pad,
          width: knob,
          height: knob,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

interface ModelSelectionControl {
  preferences: ModelPreferencesResult | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onChange: (enabledModels: string[] | null) => Promise<void>;
}

function ManagedModelsControl({
  providerId,
  preferences,
  loading,
  saving,
  error,
  onChange,
}: ModelSelectionControl & { providerId: string }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [providerId]);

  const providerModels = (preferences?.models ?? []).filter((model) => model.provider === providerId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleModels = normalizedQuery
    ? providerModels.filter(
        (model) =>
          model.name.toLocaleLowerCase().includes(normalizedQuery) ||
          model.id.toLocaleLowerCase().includes(normalizedQuery),
      )
    : providerModels;
  const enabledCount = preferences
    ? providerModels.filter((model) => isModelEnabled(model, preferences.enabledModels)).length
    : 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        paddingTop: 16,
        borderTop: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <SectionTitle>{t("models", "Models")}</SectionTitle>
        {!loading && preferences && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            {t("modelEnabledCount", "{enabled} of {total} enabled")
              .replace("{enabled}", String(enabledCount))
              .replace("{total}", String(providerModels.length))}
          </span>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {t(
          "modelSelectionDescription",
          "Choose which models appear in the model picker. The active model in an existing session is not changed.",
        )}
      </p>

      {loading && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          {t("modelLoadingModels", "Loading models…")}
        </p>
      )}
      {!loading && preferences && providerModels.length === 0 && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          {t("modelNoAvailableModels", "No models are currently available for this provider.")}
        </p>
      )}

      {!loading && preferences && providerModels.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              disabled={saving || enabledCount === providerModels.length}
              onClick={() =>
                void onChange(setProviderModelsEnabled(preferences.models, preferences.enabledModels, providerId, true))
              }
              style={{
                padding: "4px 9px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text-muted)",
                cursor: saving || enabledCount === providerModels.length ? "not-allowed" : "pointer",
                fontSize: 11,
              }}
            >
              {t("modelEnableAll", "Enable all")}
            </button>
            <button
              type="button"
              disabled={saving || enabledCount === 0}
              onClick={() =>
                void onChange(
                  setProviderModelsEnabled(preferences.models, preferences.enabledModels, providerId, false),
                )
              }
              style={{
                padding: "4px 9px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text-muted)",
                cursor: saving || enabledCount === 0 ? "not-allowed" : "pointer",
                fontSize: 11,
              }}
            >
              {t("modelDisableAll", "Disable all")}
            </button>
          </div>

          {providerModels.length > 8 && (
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("modelSearchModels", "Search models…")}
              aria-label={t("modelSearchProviderModels", "Search provider models")}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "6px 9px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text)",
                fontSize: 12,
                outline: "none",
              }}
            />
          )}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              maxHeight: 300,
              overflowY: "auto",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          >
            {visibleModels.map((model, index) => {
              const enabled = isModelEnabled(model, preferences.enabledModels);
              return (
                <label
                  key={`${model.provider}/${model.id}`}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 9,
                    padding: "8px 10px",
                    borderTop: index > 0 ? "1px solid var(--border)" : undefined,
                    cursor: saving ? "not-allowed" : "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={saving}
                    onChange={(event) =>
                      void onChange(
                        toggleModelEnabled(preferences.models, preferences.enabledModels, model, event.target.checked),
                      )
                    }
                    style={{ margin: "2px 0 0", accentColor: "var(--accent)", flexShrink: 0 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        color: "var(--text)",
                        fontSize: 12,
                        lineHeight: 1.35,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {model.name}
                    </span>
                    {model.name !== model.id && (
                      <code
                        style={{
                          display: "block",
                          marginTop: 2,
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {model.id}
                      </code>
                    )}
                  </span>
                </label>
              );
            })}
            {visibleModels.length === 0 && (
              <span style={{ padding: "10px", color: "var(--text-muted)", fontSize: 12 }}>
                {t("modelNoMatchingModels", "No matching models.")}
              </span>
            )}
          </div>
        </>
      )}

      {saving && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>
          {t("modelSavingSelection", "Saving selection…")}
        </p>
      )}
      {error && <p style={{ margin: 0, fontSize: 11, color: "#f87171", lineHeight: 1.4 }}>{error}</p>}
    </div>
  );
}

// ── OAuth detail ──────────────────────────────────────────────────────────────

function OAuthDetail({
  provider,
  onRefresh,
  modelSelection,
}: {
  provider: OAuthProvider;
  onRefresh: () => void;
  modelSelection: ModelSelectionControl;
}) {
  const { t } = useI18n();
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const [inputValue, setInputValue] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const loginAttemptRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state on entry/provider changes. The outgoing effect owns cancellation
  // for its captured provider, so a replacement provider is never cancelled.
  useEffect(() => {
    const providerId = provider.id;
    loginAttemptRef.current += 1;
    setLoginState({ phase: "idle" });
    setInputValue("");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    return () => {
      loginAttemptRef.current += 1;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      void call("auth.loginCancel", { provider: providerId }).catch(() => {});
    };
  }, [provider.id]);

  const handleLogin = useCallback(async () => {
    const attempt = loginAttemptRef.current + 1;
    loginAttemptRef.current = attempt;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setLoginState({ phase: "connecting" });
    setInputValue("");

    try {
      // Do not race cancellation with startup: a late cancel would abort the
      // brand-new OAuth flow and make the Login button appear unresponsive.
      await call("auth.loginCancel", { provider: provider.id });
    } catch (error) {
      if (loginAttemptRef.current !== attempt) return;
      setLoginState({
        phase: "error",
        message: error instanceof Error ? error.message : t("modelUnableResetLogin", "Unable to reset login"),
      });
      return;
    }
    if (loginAttemptRef.current !== attempt) return;

    const es = new EventSource(`/api/auth/login/${encodeURIComponent(provider.id)}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      if (eventSourceRef.current !== es || loginAttemptRef.current !== attempt) return;
      const data = JSON.parse(e.data) as {
        type: string;
        url?: string;
        instructions?: string | null;
        token?: string;
        message?: string;
        placeholder?: string | null;
        userCode?: string;
        verificationUri?: string;
        intervalSeconds?: number | null;
        expiresInSeconds?: number | null;
        options?: { id: string; label: string }[];
        warning?: { code: "MODEL_SYNC_FAILED"; message: string };
      };
      if (data.type === "auth") {
        setLoginState({ phase: "auth", url: data.url!, instructions: data.instructions ?? null, token: data.token! });
        // Single open path (ISSUE-008): prefer desktop openExternal
        if (data.url) {
          void (
            window.piBridge?.openExternal(data.url) ??
            Promise.resolve(window.open(data.url, "_blank", "noopener,noreferrer"))
          );
        }
      } else if (data.type === "device_code") {
        setLoginState({
          phase: "device_code",
          userCode: data.userCode!,
          verificationUri: data.verificationUri!,
          intervalSeconds: data.intervalSeconds ?? null,
          expiresInSeconds: data.expiresInSeconds ?? null,
        });
        if (data.verificationUri) {
          void (
            window.piBridge?.openExternal(data.verificationUri) ??
            Promise.resolve(window.open(data.verificationUri, "_blank", "noopener,noreferrer"))
          );
        }
      } else if (data.type === "prompt_request") {
        setLoginState({
          phase: "prompt",
          message: data.message!,
          placeholder: data.placeholder ?? null,
          token: data.token!,
        });
      } else if (data.type === "select_request") {
        setLoginState({ phase: "select", message: data.message!, options: data.options ?? [], token: data.token! });
      } else if (data.type === "progress") {
        setLoginState({ phase: "progress", message: data.message! });
      } else if (data.type === "success") {
        es.close();
        eventSourceRef.current = null;
        setLoginState({
          phase: "success",
          ...(data.warning ? { message: data.warning.message, warning: true } : {}),
        });
        onRefresh();
      } else if (data.type === "error") {
        es.close();
        eventSourceRef.current = null;
        setLoginState({ phase: "error", message: data.message! });
      } else if (data.type === "cancelled") {
        es.close();
        eventSourceRef.current = null;
        setLoginState({ phase: "idle" });
      }
    };
    es.onerror = (event) => {
      if (eventSourceRef.current !== es || loginAttemptRef.current !== attempt) return;
      es.close();
      eventSourceRef.current = null;
      const message =
        event instanceof ErrorEvent && event.message ? event.message : t("modelConnectionLost", "Connection lost");
      setLoginState((prev) => (prev.phase === "success" ? prev : { phase: "error", message }));
    };
  }, [provider.id, onRefresh, t]);

  const handleCancelLogin = useCallback(() => {
    loginAttemptRef.current += 1;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setLoginState({ phase: "idle" });
    setInputValue("");
    void call("auth.loginCancel", { provider: provider.id }).catch(() => {});
  }, [provider.id]);

  const handleLogout = useCallback(async () => {
    try {
      const response = await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, { method: "POST" });
      const result = (await response.json().catch(() => ({}))) as {
        warning?: { code: "MODEL_SYNC_FAILED"; message: string };
        error?: string;
      };
      if (!response.ok || result.error) {
        setLoginState({ phase: "error", message: result.error ?? `HTTP ${response.status}` });
        return;
      }
      setLoginState(
        result.warning
          ? { phase: "success", message: result.warning.message, warning: true }
          : { phase: "success", message: t("modelDisconnectedSuccessfully", "Disconnected successfully.") },
      );
      onRefresh();
    } catch (error) {
      setLoginState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [provider.id, onRefresh, t]);

  const submitCode = useCallback(
    async (token: string, code: string) => {
      if (!code.trim()) return;
      setLoginState({ phase: "progress", message: t("modelVerifying", "Verifying…") });
      try {
        const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, code: code.trim() }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          setLoginState({
            phase: "error",
            message: d.error ?? t("modelServerError", "Server error {status}").replace("{status}", String(res.status)),
          });
          return;
        }
        setInputValue("");
        // Success path: the auth progress stream emits "success" and updates state.
      } catch (e) {
        setLoginState({
          phase: "error",
          message: e instanceof Error ? e.message : t("modelNetworkError", "Network error"),
        });
      }
    },
    [provider.id, t],
  );

  const submitSelection = useCallback(
    async (token: string, value: string) => {
      setLoginState({ phase: "progress", message: t("modelContinuing", "Continuing…") });
      try {
        const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, code: value }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          setLoginState({
            phase: "error",
            message: d.error ?? t("modelServerError", "Server error {status}").replace("{status}", String(res.status)),
          });
        }
      } catch (e) {
        setLoginState({
          phase: "error",
          message: e instanceof Error ? e.message : t("modelNetworkError", "Network error"),
        });
      }
    },
    [provider.id, t],
  );

  const isWorking =
    loginState.phase === "connecting" ||
    loginState.phase === "progress" ||
    loginState.phase === "auth" ||
    loginState.phase === "device_code" ||
    loginState.phase === "prompt" ||
    loginState.phase === "select";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelSubscription", "Subscription")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: provider.loggedIn ? "#4ade80" : "var(--border)",
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 11, color: provider.loggedIn ? "#4ade80" : "var(--text-dim)" }}>
            {provider.loggedIn ? t("modelConnected", "connected") : t("modelNotConnected", "not connected")}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={{ minHeight: 48 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {provider.loggedIn
              ? t("modelAlreadyConnected", "Already connected. You can re-login or disconnect.")
              : t("modelConnectAccount", "Connect your {provider} account.").replace("{provider}", provider.name)}
          </p>
        )}
        {loginState.phase === "connecting" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
            {t("modelOpeningBrowser", "Opening browser…")}
          </p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{loginState.message}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{
                    padding: "6px 9px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "var(--text)",
                    cursor: "pointer",
                    fontSize: 12,
                    textAlign: "left",
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {(loginState.phase === "auth" || loginState.phase === "prompt") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.phase === "auth"
                ? t(
                    "modelCompleteSignIn",
                    "Complete sign-in in the browser, then copy the redirect URL from the address bar and paste it below.",
                  )
                : loginState.message}
            </p>
            {loginState.phase === "auth" && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                {t("modelBrowserDidNotOpen", "If the browser window did not open,")}{" "}
                <a
                  href={loginState.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent)", wordBreak: "break-all" }}
                >
                  {t("modelOpenLoginPage", "click here to open the login page")}
                </a>
                .
              </p>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCode(loginState.token, inputValue);
                }}
                placeholder={
                  loginState.phase === "auth"
                    ? "http://localhost:1455/auth/callback?code=…"
                    : (loginState.placeholder ?? t("modelEnterValue", "Enter value…"))
                }
                style={{
                  flex: 1,
                  padding: "6px 9px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  color: "var(--text)",
                  fontSize: 12,
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  boxSizing: "border-box",
                }}
              />
              <button
                onClick={() => submitCode(loginState.token, inputValue)}
                disabled={!inputValue.trim()}
                style={{
                  padding: "6px 12px",
                  background: inputValue.trim() ? "var(--accent)" : "var(--bg-panel)",
                  border: "none",
                  borderRadius: 5,
                  color: inputValue.trim() ? "#fff" : "var(--text-dim)",
                  cursor: inputValue.trim() ? "pointer" : "not-allowed",
                  fontSize: 12,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {t("submit", "Submit")}
              </button>
            </div>
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("modelOpenVerificationPage", "Open the verification page and enter this code:")}
            </p>
            <div
              style={{
                padding: "8px 10px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text)",
                fontSize: 16,
                fontWeight: 700,
                fontFamily: "var(--font-mono)",
                letterSpacing: 0,
              }}
            >
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a
                href={loginState.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", wordBreak: "break-all" }}
              >
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds
                ? ` ${t("modelCodeExpires", "Expires in {minutes} minutes.").replace(
                    "{minutes}",
                    String(Math.ceil(loginState.expiresInSeconds / 60)),
                  )}`
                : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
          <p style={{ margin: 0, fontSize: 12, color: loginState.warning ? "#d97706" : "#4ade80" }}>
            {loginState.message ?? t("modelConnectedSuccessfully", "Connected successfully.")}
          </p>
        )}
        {loginState.phase === "error" && (
          <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{loginState.message}</p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        {isWorking ? (
          <button
            onClick={handleCancelLogin}
            style={{
              padding: "5px 12px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("cancel", "Cancel")}
          </button>
        ) : (
          <>
            <button
              onClick={handleLogin}
              style={{
                padding: "5px 14px",
                background: "var(--accent)",
                border: "none",
                borderRadius: 5,
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {provider.loggedIn ? t("modelRelogin", "Re-login") : t("modelLogin", "Login")}
            </button>
            {provider.loggedIn && (
              <button
                onClick={handleLogout}
                style={{
                  padding: "5px 12px",
                  background: "none",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 5,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {t("modelDisconnect", "Disconnect")}
              </button>
            )}
          </>
        )}
      </div>

      {provider.loggedIn && <ManagedModelsControl providerId={provider.id} {...modelSelection} />}
    </div>
  );
}

// ── API Key detail ────────────────────────────────────────────────────────────

function ApiKeyDetail({
  provider,
  baseUrl,
  onBaseUrlChange,
  onRefresh,
  modelSelection,
}: {
  provider: ApiKeyProvider;
  baseUrl: string;
  onBaseUrlChange: (baseUrl: string) => void;
  onRefresh: () => void;
  modelSelection: ModelSelectionControl;
}) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setWarning(null);
    setSavedOk(false);
  }, [provider.id]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setWarning(null);
    setSavedOk(false);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        warning?: { code: "MODEL_SYNC_FAILED"; message: string };
        error?: string;
      };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
      } else {
        setApiKey("");
        setSavedOk(true);
        setWarning(d.warning?.message ?? null);
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider.id, onRefresh]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      const d = (await res.json()) as {
        ok?: boolean;
        warning?: { code: "MODEL_SYNC_FAILED"; message: string };
        error?: string;
      };
      if (!res.ok || d.error) setError(d.error ?? `HTTP ${res.status}`);
      else {
        setWarning(d.warning?.message ?? null);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [provider.id, onRefresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelApiKey", "API Key")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: provider.configured ? "#4ade80" : "var(--border)",
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 11, color: provider.configured ? "#4ade80" : "var(--text-dim)" }}>
            {provider.configured ? t("configured", "configured") : t("notConfigured", "not configured")}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.configured
          ? t(
              "modelApiKeyStored",
              "API key is stored. Enter a new key below to replace it, or disconnect to remove it.",
            )
          : t("modelEnterApiKey", "Enter your {provider} API key to enable {count} models.")
              .replace("{provider}", provider.displayName)
              .replace("{count}", String(provider.modelCount))}
      </p>

      <Field label={t("modelBaseUrl", "Base URL")}>
        <TextInput
          value={baseUrl}
          onChange={onBaseUrlChange}
          placeholder={t("modelBaseUrlPlaceholder", "Leave empty to use the provider default")}
          mono
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {t(
            "modelBaseUrlHint",
            "Overrides the endpoint for this provider. Use the Save button below to apply changes.",
          )}
        </span>
      </Field>

      <Field label={t("modelApiKey", "API Key")}>
        <div style={{ display: "flex", gap: 6 }}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim()) void handleSave();
            }}
            placeholder={provider.configured ? t("modelReplaceApiKey", "Enter new key to replace…") : "sk-…"}
            style={{ flex: 1 }}
            autoComplete="off"
            spellCheck={false}
            mono
          />
          <button
            onClick={handleSave}
            disabled={saving || !apiKey.trim() || savedOk}
            style={{
              padding: "6px 12px",
              background: savedOk ? "#16a34a" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
              border: "none",
              borderRadius: 5,
              color: apiKey.trim() || savedOk ? "#fff" : "var(--text-dim)",
              cursor: saving || !apiKey.trim() || savedOk ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {savedOk && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {savedOk ? t("saved", "Saved") : saving ? t("saving", "Saving…") : t("save", "Save")}
          </button>
        </div>
      </Field>

      {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}
      {warning && <p style={{ margin: 0, fontSize: 12, color: "#d97706" }}>{warning}</p>}

      {provider.configured && <ManagedModelsControl providerId={provider.id} {...modelSelection} />}

      {provider.configured && (
        <button
          onClick={handleRemove}
          disabled={removing}
          style={{
            alignSelf: "flex-start",
            padding: "5px 12px",
            background: "none",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 5,
            color: "#ef4444",
            cursor: removing ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {removing ? t("modelRemoving", "Removing…") : t("modelDisconnect", "Disconnect")}
        </button>
      )}
    </div>
  );
}

// ── Provider icon ─────────────────────────────────────────────────────────────

function ProviderIcon({ id, size }: { id: string; size: number }) {
  const pi = PROVIDER_ICONS[id];
  if (!pi) {
    const label =
      id
        .split(/[-_]/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase() || "?";
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text-dim)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: Math.max(8, Math.floor(size * 0.42)),
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {label}
      </span>
    );
  }
  // Color icons: self-colored SVG, no wrapper needed
  if (pi.hasColor) return <pi.Icon size={size} />;
  // Mono icons: use currentColor so they adapt to light/dark theme
  return <pi.Icon size={size} style={{ color: "var(--text-muted)" }} />;
}

// ── Add provider picker ───────────────────────────────────────────────────────

interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

function AddProviderPicker({
  oauthProviders,
  apiKeyProviders,
  onSelectOAuth,
  onSelectApiKey,
  onAddCustom,
  onClose,
}: AddProviderPickerProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const q = search.trim().toLowerCase();

  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q)));
  const availableApiKey = apiKeyProviders.filter(
    (p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)),
  );
  const customSearchTerms = [
    "custom",
    "openai-compatible",
    "anthropic-compatible",
    t("modelCustom", "Custom"),
    t("modelCompatibleProvider", "OpenAI / Anthropic compatible"),
  ]
    .join(" ")
    .toLowerCase();
  const showCustom = !q || customSearchTerms.includes(q);

  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  const cardStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    transition: "border-color 0.12s, background 0.12s",
    width: "100%",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 820,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "min(72vh, calc(100vh - 32px))",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        {/* Search */}
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "var(--text-dim)", flexShrink: 0 }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder={t("modelSearchProviders", "Search providers…")}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              color: "var(--text)",
              fontSize: 13,
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {totalCount === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
              {t("modelNoProvidersMatch", "No providers match")}
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
                gap: 8,
              }}
            >
              {showCustom && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                  }}
                >
                  {t("modelCustom", "Custom")}
                </div>
              )}
              {showCustom && (
                <button
                  onClick={() => {
                    onAddCustom();
                    onClose();
                  }}
                  style={cardStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)";
                    e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.background = "var(--bg-panel)";
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text)",
                        lineHeight: 1.3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("modelCompatibleProvider", "OpenAI / Anthropic compatible")}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                      {t("modelCustomEndpointFormat", "Custom endpoint format")}
                    </div>
                  </div>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 5,
                      background: "var(--bg-hover)",
                      border: "1px dashed var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ color: "var(--text-dim)" }}
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    paddingTop: showCustom ? 6 : 0,
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                  }}
                >
                  {t("modelSubscriptions", "Subscriptions")}
                </div>
              )}
              {availableOAuth.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelectOAuth(p.id);
                    onClose();
                  }}
                  style={cardStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)";
                    e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.background = "var(--bg-panel)";
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text)",
                        lineHeight: 1.3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.name}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    paddingTop: availableOAuth.length > 0 ? 6 : 0,
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                  }}
                >
                  {t("modelApiKey", "API Key")}
                </div>
              )}
              {availableApiKey.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelectApiKey(p.id);
                    onClose();
                  }}
                  style={cardStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)";
                    e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.background = "var(--bg-panel)";
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text)",
                        lineHeight: 1.3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.displayName}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                      {t("modelCount", "{count} models").replace("{count}", String(p.modelCount))}
                    </div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({
  onClose,
  onChanged,
  embedded = false,
  cwd = null,
}: {
  onClose: () => void;
  onChanged?: () => void;
  embedded?: boolean;
  cwd?: string | null;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [{ config, selection }, dispatchEditor] = useReducer(modelsConfigEditorReducer, {
    config: { providers: {} },
    selection: null,
  });
  const setConfig = useCallback((update: ModelsConfigUpdate) => dispatchEditor({ type: "config.update", update }), []);
  const setSelection = useCallback(
    (nextSelection: Selection | null) => dispatchEditor({ type: "selection.set", selection: nextSelection }),
    [],
  );
  const [configVersion, setConfigVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [modelPreferences, setModelPreferencesState] = useState<ModelPreferencesResult | null>(null);
  // Snapshot of models.json as last loaded from disk. Used to auto-enable
  // newly added provider models in the model picker on save.
  const baselineConfigRef = useRef<ModelsJson | null>(null);
  const [modelPreferencesLoading, setModelPreferencesLoading] = useState(true);
  const [modelPreferencesSaving, setModelPreferencesSaving] = useState(false);
  const [modelPreferencesError, setModelPreferencesError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const loadOAuthProviders = useCallback(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d: { providers: OAuthProvider[] }) => setOauthProviders(d.providers))
      .catch(() => {});
  }, []);

  const loadApiKeyProviders = useCallback(() => {
    fetch("/api/auth/all-providers")
      .then((r) => r.json())
      .then((d: { providers: ApiKeyProvider[] }) => setApiKeyProviders(d.providers))
      .catch(() => {});
  }, []);

  const loadModelPreferences = useCallback(async () => {
    setModelPreferencesLoading(true);
    setModelPreferencesError(null);
    try {
      setModelPreferencesState(await getModelPreferences(cwd ?? undefined));
    } catch (error) {
      setModelPreferencesError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelPreferencesLoading(false);
    }
  }, [cwd]);

  const updateModelPreferences = useCallback(
    async (enabledModels: string[] | null) => {
      setModelPreferencesSaving(true);
      setModelPreferencesError(null);
      try {
        const result = await setModelPreferences(cwd ?? undefined, enabledModels);
        setModelPreferencesState(result);
        onChanged?.();
      } catch (error) {
        setModelPreferencesError(error instanceof Error ? error.message : String(error));
      } finally {
        setModelPreferencesSaving(false);
      }
    },
    [cwd, onChanged],
  );

  const refreshOAuthProviders = useCallback(() => {
    loadOAuthProviders();
    void loadModelPreferences();
  }, [loadModelPreferences, loadOAuthProviders]);

  const refreshApiKeyProviders = useCallback(() => {
    loadApiKeyProviders();
    void loadModelPreferences();
  }, [loadApiKeyProviders, loadModelPreferences]);

  const [loadFailed, setLoadFailed] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  const loadModelsConfig = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    setConfigLoaded(false);
    try {
      const response = await fetch("/api/models-config");
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const snapshot = (await response.json()) as { config?: ModelsJson; version?: string; error?: string };
      if (snapshot.error) throw new Error(snapshot.error);
      if (!snapshot.config || typeof snapshot.version !== "string") throw new Error("Invalid models config snapshot");
      const normalized = snapshot.config.providers ? snapshot.config : { ...snapshot.config, providers: {} };
      const keys = Object.keys(normalized.providers ?? {});
      dispatchEditor({
        type: "config.replace",
        config: normalized,
        selection: keys.length > 0 ? { type: "provider", name: keys[0] } : null,
      });
      baselineConfigRef.current = normalized;
      setConfigVersion(snapshot.version);
      setConfigLoaded(true);
      setSaveConflict(false);
      setSaveError(null);
    } catch (error) {
      setLoadFailed(true);
      setSaveError(error instanceof Error ? error.message : String(error));
      // Do NOT reset to empty providers — keep prior state / block save
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModelsConfig();
    loadOAuthProviders();
    loadApiKeyProviders();
  }, [loadApiKeyProviders, loadModelsConfig, loadOAuthProviders]);

  useEffect(() => {
    void loadModelPreferences();
  }, [loadModelPreferences]);

  const addCustomProvider = useCallback(() => {
    dispatchEditor({ type: "provider.addCustom" });
  }, []);

  const updateProvider = useCallback(
    (name: string, p: ProviderEntry) => {
      setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
    },
    [setConfig],
  );

  const renameProvider = useCallback(
    (oldName: string, newName: string) => {
      const result = renameProviderEntry(config, oldName, newName);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setSaveError(null);
      setConfig(result.config);
      setSelection(selectionAfterProviderRename(selection, oldName, result.name));
    },
    [config, selection, setConfig, setSelection],
  );

  const deleteProvider = useCallback(
    (name: string) => {
      const transition = deleteProviderTransition(config, selection, name);
      setConfig(transition.config);
      setSelection(transition.selection);
    },
    [config, selection, setConfig, setSelection],
  );

  const addModel = useCallback(
    (providerName: string) => {
      const transition = addModelTransition(config, providerName);
      setConfig(transition.config);
      setSelection(transition.selection);
    },
    [config, setConfig, setSelection],
  );

  const updateModel = useCallback(
    (providerName: string, index: number, m: ModelEntry) => {
      setConfig((prev) => replaceModelEntry(prev, providerName, index, m));
    },
    [setConfig],
  );

  const removeModel = useCallback(
    (providerName: string, index: number) => {
      setConfig((prev) => {
        const provider = prev.providers?.[providerName] ?? {};
        const models = [...(provider.models ?? [])];
        models.splice(index, 1);
        return {
          ...prev,
          providers: {
            ...(prev.providers ?? {}),
            [providerName]: { ...provider, models: models.length ? models : undefined },
          },
        };
      });
      setSelection({ type: "provider", name: providerName });
    },
    [setConfig, setSelection],
  );

  const handleSave = useCallback(async () => {
    if (!configVersion) return;
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, expectedVersion: configVersion }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string; code?: string; version?: string };
      if (!res.ok || d.error) {
        const conflict = res.status === 409 || d.code === "CONFLICT";
        setSaveConflict(conflict);
        setSaveError(
          conflict
            ? t(
                "modelConfigConflict",
                "models.json changed outside this editor. Your edits are preserved here; copy or compare them before reloading the disk version to merge manually.",
              )
            : (d.error ?? `HTTP ${res.status}`),
        );
      } else if (typeof d.version !== "string") {
        setSaveError("Invalid models config save response");
      } else {
        setConfigVersion(d.version);
        setSaveConflict(false);
        setSavedOk(true);
        onChanged?.();
        // Newly added provider models are enabled in the picker by default:
        // merge refs absent from the last disk snapshot into enabledModels.
        if (modelPreferences?.enabledModels != null) {
          const baseline = baselineConfigRef.current;
          const baselineRefs = new Set<string>();
          for (const [pName, p] of Object.entries(baseline?.providers ?? {})) {
            for (const m of p.models ?? []) {
              const id = m.id?.trim();
              if (id) baselineRefs.add(`${pName}/${id}`);
            }
          }
          const newRefs: string[] = [];
          for (const [pName, p] of Object.entries(config.providers ?? {})) {
            for (const m of p.models ?? []) {
              const id = m.id?.trim();
              const ref = id ? `${pName}/${id}` : "";
              if (ref && !baselineRefs.has(ref) && !modelPreferences.enabledModels.includes(ref)) {
                newRefs.push(ref);
              }
            }
          }
          if (newRefs.length > 0) {
            void updateModelPreferences([...modelPreferences.enabledModels, ...newRefs]);
          }
        }
        baselineConfigRef.current = config;
        void loadModelPreferences();
        setTimeout(() => setSavedOk(false), 2000);
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config, configVersion, loadModelPreferences, modelPreferences, updateModelPreferences, onChanged, t]);

  const providers = Object.entries(config.providers ?? {});
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured);

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return (
        <OAuthDetail
          key={p.id}
          provider={p}
          onRefresh={refreshOAuthProviders}
          modelSelection={{
            preferences: modelPreferences,
            loading: modelPreferencesLoading,
            saving: modelPreferencesSaving,
            error: modelPreferencesError,
            onChange: updateModelPreferences,
          }}
        />
      );
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return (
        <ApiKeyDetail
          key={p.id}
          provider={p}
          baseUrl={config.providers?.[p.id]?.baseUrl ?? ""}
          onBaseUrlChange={(baseUrl) => setConfig((prev) => setProviderBaseUrl(prev, p.id, baseUrl))}
          onRefresh={refreshApiKeyProviders}
          modelSelection={{
            preferences: modelPreferences,
            loading: modelPreferencesLoading,
            saving: modelPreferencesSaving,
            error: modelPreferencesError,
            onChange: updateModelPreferences,
          }}
        />
      );
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      return (
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
          modelSelection={{
            preferences: modelPreferences,
            loading: modelPreferencesLoading,
            saving: modelPreferencesSaving,
            error: modelPreferencesError,
            onChange: updateModelPreferences,
          }}
        />
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  return (
    <>
      <div
        style={
          embedded
            ? { position: "relative", flex: 1, minWidth: 0, minHeight: 0, display: "flex" }
            : {
                position: "fixed",
                inset: 0,
                zIndex: 1000,
                background: "rgba(0,0,0,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }
        }
        onClick={(e) => {
          if (!embedded && e.target === e.currentTarget) onClose();
        }}
      >
        <div
          style={
            embedded
              ? {
                  width: "100%",
                  height: "100%",
                  background: "var(--bg)",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }
              : {
                  width: isMobile ? "calc(100vw - 16px)" : 860,
                  maxWidth: "calc(100vw - 16px)",
                  height: isMobile ? "calc(100dvh - 16px)" : "78vh",
                  maxHeight: "calc(100dvh - 16px)",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  display: "flex",
                  flexDirection: "column",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
                  overflow: "hidden",
                }
          }
        >
          {/* Header */}
          {!embedded && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("models", "Models")}</span>
                <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  ~/.pi/agent/models.json
                </code>
              </div>
              <button
                type="button"
                onClick={onClose}
                title={t("modelCloseModels", "Close models")}
                aria-label={t("modelCloseModels", "Close models")}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 20,
                  lineHeight: 1,
                  width: 36,
                  height: 36,
                  padding: 0,
                  borderRadius: 7,
                }}
              >
                ×
              </button>
            </div>
          )}

          {/* Body */}
          <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
            {/* Left: tree */}
            <div
              style={{
                width: isMobile ? "100%" : 210,
                maxHeight: isMobile ? "40vh" : undefined,
                borderRight: isMobile ? "none" : "1px solid var(--border)",
                borderBottom: isMobile ? "1px solid var(--border)" : "none",
                display: "flex",
                flexDirection: "column",
                flexShrink: 0,
                background: "var(--bg-panel)",
              }}
            >
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
                {/* Active OAuth subscriptions */}
                {activeOAuth.map((p) => {
                  const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "5px 8px",
                        borderRadius: 5,
                        cursor: "pointer",
                        background: isSelected ? "var(--bg-selected)" : "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "none";
                      }}
                    >
                      <ProviderIcon id={p.id} size={16} />
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.name}
                      </span>
                    </div>
                  );
                })}

                {/* Active API key providers */}
                {activeApiKey.map((p) => {
                  const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "5px 8px",
                        borderRadius: 5,
                        cursor: "pointer",
                        background: isSelected ? "var(--bg-selected)" : "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "none";
                      }}
                    >
                      <ProviderIcon id={p.id} size={16} />
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.displayName}
                      </span>
                    </div>
                  );
                })}

                {/* Divider before custom providers, only when there are active managed providers */}
                {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && (
                  <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
                )}

                {/* Custom providers */}
                {loading ? (
                  <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                    {t("loading", "Loading…")}
                  </div>
                ) : (
                  providers.map(([pName, pData]) => {
                    const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                    const models = pData.models ?? [];
                    return (
                      <div key={pName} style={{ marginBottom: 2 }}>
                        {/* Provider row */}
                        <div
                          onClick={() => setSelection({ type: "provider", name: pName })}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "7px 8px",
                            borderRadius: 5,
                            cursor: "pointer",
                            background: isProviderSelected ? "var(--bg-selected)" : "none",
                          }}
                          onMouseEnter={(e) => {
                            if (!isProviderSelected) e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            if (!isProviderSelected) e.currentTarget.style.background = "none";
                          }}
                        >
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ color: "var(--text-dim)", flexShrink: 0 }}
                          >
                            <rect x="4" y="4" width="16" height="16" rx="2" />
                            <rect x="9" y="9" width="6" height="6" />
                            <line x1="9" y1="1" x2="9" y2="4" />
                            <line x1="15" y1="1" x2="15" y2="4" />
                            <line x1="9" y1="20" x2="9" y2="23" />
                            <line x1="15" y1="20" x2="15" y2="23" />
                            <line x1="20" y1="9" x2="23" y2="9" />
                            <line x1="20" y1="14" x2="23" y2="14" />
                            <line x1="1" y1="9" x2="4" y2="9" />
                            <line x1="1" y1="14" x2="4" y2="14" />
                          </svg>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: isProviderSelected ? 600 : 400,
                              color: "var(--text)",
                              fontFamily: "var(--font-mono)",
                              flex: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {pName}
                          </span>
                        </div>

                        {/* Model rows */}
                        {models.map((m, i) => {
                          const isModelSelected =
                            selection?.type === "model" && selection.providerName === pName && selection.index === i;
                          return (
                            <div
                              key={i}
                              onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                padding: "5px 8px 5px 26px",
                                borderRadius: 5,
                                cursor: "pointer",
                                background: isModelSelected ? "var(--bg-selected)" : "none",
                              }}
                              onMouseEnter={(e) => {
                                if (!isModelSelected) e.currentTarget.style.background = "var(--bg-hover)";
                              }}
                              onMouseLeave={(e) => {
                                if (!isModelSelected) e.currentTarget.style.background = "none";
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  fontFamily: "var(--font-mono)",
                                  color: m.id ? "var(--text-muted)" : "var(--text-dim)",
                                  flex: 1,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {m.id || t("modelNewModel", "new model")}
                              </span>
                              {m.reasoning && (
                                <span
                                  style={{
                                    fontSize: 9,
                                    padding: "1px 4px",
                                    background: "rgba(99,102,241,0.12)",
                                    color: "rgba(99,102,241,0.8)",
                                    borderRadius: 3,
                                    flexShrink: 0,
                                  }}
                                >
                                  T
                                </span>
                              )}
                            </div>
                          );
                        })}

                        {/* Add model button */}
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            addModel(pName);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "4px 8px 4px 26px",
                            borderRadius: 5,
                            cursor: "pointer",
                            color: "var(--text-dim)",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = "var(--text-dim)";
                            e.currentTarget.style.background = "none";
                          }}
                        >
                          <span style={{ fontSize: 11 }}>+ {t("modelAddModel", "model")}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Add provider */}
              <div style={{ borderTop: "1px solid var(--border)", padding: "8px 6px" }}>
                <button
                  onClick={() => setPickerOpen(true)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 5,
                    width: "100%",
                    padding: "6px 0",
                    background: "none",
                    border: "1px dashed var(--border)",
                    borderRadius: 5,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)";
                    e.currentTarget.style.color = "var(--accent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  + {t("addProvider", "Add provider")}
                </button>
              </div>
            </div>

            {/* Right: detail */}
            <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
              {loading
                ? null
                : (detailContent ?? (
                    <div
                      style={{
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--text-dim)",
                        fontSize: 13,
                      }}
                    >
                      {t("selectProviderOrModel", "Select a provider or model")}
                    </div>
                  ))}
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 10,
              padding: "10px 18px",
              borderTop: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            {saveError && <span style={{ fontSize: 12, color: "#f87171", flex: 1 }}>{saveError}</span>}
            {saveConflict && (
              <button
                type="button"
                onClick={() => void loadModelsConfig()}
                disabled={loading || saving}
                title={t("modelReloadDiskVersionHint", "Discard local edits and load the current models.json")}
                style={{
                  padding: "6px 12px",
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text)",
                  cursor: loading || saving ? "default" : "pointer",
                  fontSize: 12,
                }}
              >
                {t("modelReloadDiskVersion", "Reload disk version")}
              </button>
            )}
            {!embedded && (
              <button
                onClick={onClose}
                style={{
                  padding: "6px 14px",
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {t("cancel", "Cancel")}
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || savedOk || loading || loadFailed || saveConflict || !configLoaded || !configVersion}
              title={
                loadFailed ? t("modelCannotSaveBeforeLoad", "Cannot save until config loads successfully") : undefined
              }
              style={{
                position: "relative",
                padding: "6px 16px",
                minWidth: 92,
                background: savedOk
                  ? "#16a34a"
                  : saving || loadFailed || saveConflict || !configLoaded || !configVersion
                    ? "var(--bg-panel)"
                    : "var(--accent)",
                border: "none",
                borderRadius: 6,
                color:
                  savedOk || !(saving || loadFailed || saveConflict || !configLoaded || !configVersion)
                    ? "#fff"
                    : "var(--text-muted)",
                cursor:
                  saving || savedOk || loading || loadFailed || saveConflict || !configLoaded || !configVersion
                    ? "default"
                    : "pointer",
                fontSize: 13,
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                transition: "background-color 0.2s ease, color 0.2s ease",
                animation: savedOk ? "saved-pop 0.45s ease" : undefined,
              }}
            >
              {savedOk && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ strokeDasharray: 18, animation: "saved-check-draw 0.35s ease forwards", flexShrink: 0 }}
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
              <span>{savedOk ? t("saved", "Saved") : saving ? t("saving", "Saving…") : t("save", "Save")}</span>
            </button>
          </div>
        </div>
      </div>
      {pickerOpen && (
        <AddProviderPicker
          oauthProviders={oauthProviders}
          apiKeyProviders={apiKeyProviders}
          onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })}
          onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })}
          onAddCustom={addCustomProvider}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
