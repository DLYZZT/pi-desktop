import { useState, useEffect, useCallback, useRef } from "react";
import { Check, Field, NumInput, SecretTextInput, Select, SectionTitle, TextInput, inputStyle } from "./form-controls";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/i18n";
import { replaceModelEntry, type ModelEntry, type ModelsJson, type ProviderEntry } from "@/lib/models-config-state";
import { call } from "@/lib/api-client";
import type { BuiltinProviderInfo, ProviderModelsResult } from "@contract/types";
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

type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string }
  | { type: "builtin"; providerId: string };

type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  exiting?: boolean;
}

function ToastStack({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 1400,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
        maxWidth: 360,
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 12px",
            borderRadius: 8,
            background: "var(--bg-panel)",
            border: `1px solid ${
              toast.type === "error"
                ? "rgba(239,68,68,0.5)"
                : toast.type === "success"
                  ? "rgba(74,222,128,0.5)"
                  : "var(--border)"
            }`,
            boxShadow: "0 6px 20px rgba(0,0,0,0.22)",
            fontSize: 12,
            color: "var(--text)",
            lineHeight: 1.4,
            opacity: toast.exiting ? 0 : 1,
            transform: toast.exiting ? "translateY(4px)" : "none",
            transition: "opacity 0.18s ease, transform 0.18s ease",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              flexShrink: 0,
              background: toast.type === "error" ? "#ef4444" : toast.type === "success" ? "#4ade80" : "#94a3b8",
            }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

// ── Provider detail ───────────────────────────────────────────────────────────

type FetchModelsState =
  | { phase: "idle" }
  | { phase: "fetching" }
  | { phase: "done"; models: { id: string; name?: string }[] }
  | { phase: "error"; message: string };

// ── Search Selection: one input that filters a dropdown list as you type ──────

function SearchSelect({
  options,
  value,
  onChange,
  placeholder,
  mono,
}: {
  options: { id: string; name?: string }[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dirty, setDirty] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dropdownUp, setDropdownUp] = useState(false);
  const [dropdownHeight, setDropdownHeight] = useState(240);
  const rootRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q))
    : options;
  const selected = value ? options.find((m) => m.id === value) : undefined;
  const label = (m: { id: string; name?: string }) => (m.name && m.name !== m.id ? `${m.name} — ${m.id}` : m.id);

  // Close when clicking outside the control
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Reset the highlight whenever the filter changes
  useEffect(() => {
    setHighlight(0);
  }, [q]);

  // ISSUE: the dropdown must never get clipped by the scroll container or the
  // viewport bottom. Estimate its height and open upward when there is not
  // enough room below the input, capping the height to the available space.
  useEffect(() => {
    if (!open) return;
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const estHeight = Math.min(240, filtered.length * 29 + 12);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    if (spaceBelow < estHeight && spaceAbove > spaceBelow) {
      setDropdownUp(true);
      setDropdownHeight(Math.max(80, Math.min(240, spaceAbove)));
    } else {
      setDropdownUp(false);
      setDropdownHeight(Math.max(80, Math.min(240, spaceBelow)));
    }
  }, [open, filtered.length]);

  const choose = (id: string) => {
    onChange(id);
    setQuery("");
    setDirty(false);
    setOpen(false);
  };

  const shown = dirty ? query : selected ? label(selected) : "";
  const shownTitle = dirty ? query : selected ? label(selected) : "";

  return (
    <div ref={rootRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <input
        type="text"
        value={shown}
        placeholder={placeholder}
        title={shownTitle || undefined}
        onFocus={(e) => {
          setOpen(true);
          e.target.select();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setDirty(true);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) setOpen(true);
            else if (filtered.length > 0) setHighlight((h) => Math.min(h + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (open && filtered.length > 0) choose(filtered[Math.min(highlight, filtered.length - 1)].id);
            else if (!open) setOpen(true);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        style={{
          ...inputStyle,
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          fontSize: 12,
          paddingRight: 30,
        }}
      />
      <span
        style={{
          position: "absolute",
          right: 8,
          top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
          color: "var(--text-dim)",
          display: "flex",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
      {open && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            zIndex: 20,
            maxHeight: dropdownHeight,
            overflowY: "auto",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            ...(dropdownUp ? { bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)" }),
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("noModelsMatch", "No models match “{query}”").replace("{query}", query.trim())}
            </div>
          ) : (
            filtered.map((m, i) => (
              <div
                key={m.id}
                onClick={() => choose(m.id)}
                onMouseEnter={() => setHighlight(i)}
                title={label(m)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 10px",
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text)",
                  background: i === highlight ? "var(--bg-hover)" : "none",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {m.id === value && (
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#4ade80"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0 }}
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label(m)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ProviderDetail({
  name,
  provider,
  onChange,
  onRename,
  onDelete,
  showToast,
}: {
  name: string;
  provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void;
  onRename: (n: string) => void;
  onDelete: () => void;
  showToast: (message: string, type?: ToastType) => void;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(name);
  useEffect(() => setEditingName(name), [name]);
  const [fetchState, setFetchState] = useState<FetchModelsState>({ phase: "idle" });
  const [fetchedModel, setFetchedModel] = useState("");
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  // Commit an edited identifier on Enter / blur so Save alone is enough; the
  // explicit Rename button stays as a visible affordance.
  const commitRename = useCallback(() => {
    const next = editingName.trim();
    if (!next || next === name) {
      if (!next) setEditingName(name);
      return;
    }
    onRename(next);
  }, [editingName, name, onRename]);

  const handleFetchModels = useCallback(async () => {
    const baseUrl = provider.baseUrl?.trim();
    if (!baseUrl) {
      showToast(t("enterBaseUrlFirst", "Enter a Base URL first, then fetch the model list"), "error");
      return;
    }
    setFetchState({ phase: "fetching" });
    setFetchedModel("");
    try {
      const res = await fetch("/api/models-config/fetch-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey: provider.apiKey }),
      });
      const d = (await res.json()) as { ok?: boolean; models?: { id: string; name?: string }[]; error?: string };
      if (!res.ok || !d.ok || !d.models) {
        const message = d.error ?? `HTTP ${res.status}`;
        setFetchState({ phase: "error", message });
        showToast(message, "error");
        return;
      }
      setFetchState({ phase: "done", models: d.models });
      showToast(t("modelsFound", "{count} models found").replace("{count}", String(d.models.length)), "success");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setFetchState({ phase: "error", message });
      showToast(message, "error");
    }
  }, [provider.baseUrl, provider.apiKey, showToast, t]);

  const handleAddFetchedModel = useCallback(() => {
    if (fetchState.phase !== "done" || !fetchedModel) return;
    const model = fetchState.models.find((m) => m.id === fetchedModel);
    if (!model) return;
    const existing = provider.models ?? [];
    if (existing.some((m) => m.id === model.id)) {
      showToast(t("modelAlreadyInList", 'Model "{id}" is already in the list').replace("{id}", model.id), "info");
      return;
    }
    onChange({ ...provider, models: [...existing, { id: model.id, name: model.name }] });
    showToast(t("modelAdded", 'Added "{id}" — click Save to apply').replace("{id}", model.id), "success");
    setFetchedModel("");
  }, [fetchState, fetchedModel, onChange, provider, showToast, t]);

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial provider load intentionally runs once.
  }, [provider.api]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{provider.name || name}</SectionTitle>
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

      <Field label={t("providerDisplayName", "Provider name")}>
        <TextInput
          value={provider.name ?? ""}
          onChange={(v) => set("name", v || undefined)}
          placeholder={t("providerNamePlaceholder", "Display name")}
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {t("providerDisplayNameHint", "Shown in the provider list; leave empty to use the identifier.")}
        </span>
      </Field>

      <Field label={t("providerId", "Provider ID")}>
        <TextInput
          value={editingName}
          onChange={setEditingName}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
          }}
          onBlur={() => commitRename()}
          placeholder="provider-id"
          mono
        />
        {editingName !== name && editingName.trim() && (
          <button
            type="button"
            onClick={() => commitRename()}
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

      <Field label={t("baseUrlLabel", "Base URL")}>
        <TextInput
          value={provider.baseUrl ?? ""}
          onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1"
          mono
        />
      </Field>

      <Field label={t("apiKey", "API Key")}>
        <SecretTextInput
          value={provider.apiKey ?? ""}
          onChange={(v) => set("apiKey", v || undefined)}
          placeholder={t("apiKeyPlaceholder", "ENV_VAR_NAME, !shell-command, or literal key")}
          mono
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {t("shellCommandHint", "Prefix with ! to run a shell command, or use an env var name")}
        </span>
      </Field>

      <Field label={t("api", "API")}>
        <Select
          value={provider.api ?? "openai-completions"}
          onChange={(v) => set("api", v)}
          options={API_OPTIONS}
          required
        />
      </Field>

      {/* Fetch model list from {BaseURL}/models */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={handleFetchModels}
            disabled={fetchState.phase === "fetching" || !provider.baseUrl?.trim()}
            title={t("fetchModelsHint", "Fetch the model list from {BaseURL}/models")}
            style={{
              height: 34,
              padding: "0 12px",
              background: fetchState.phase === "done" ? "#16a34a" : "var(--accent)",
              border: "none",
              borderRadius: 5,
              color: "#fff",
              cursor: fetchState.phase === "fetching" || !provider.baseUrl?.trim() ? "not-allowed" : "pointer",
              opacity: fetchState.phase === "fetching" || !provider.baseUrl?.trim() ? 0.6 : 1,
              fontSize: 12,
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
            }}
          >
            {fetchState.phase === "fetching" && (
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: "50%",
                  border: "2px solid rgba(255,255,255,0.4)",
                  borderTopColor: "#fff",
                  animation: "spin 0.7s linear infinite",
                }}
              />
            )}
            {fetchState.phase === "fetching" ? t("fetchingModels", "Fetching…") : t("fetchModels", "Fetch models")}
          </button>
          {fetchState.phase === "done" && (
            <span style={{ fontSize: 11, color: "#4ade80" }}>
              {t("modelsFound", "{count} models found").replace("{count}", String(fetchState.models.length))}
            </span>
          )}
          {fetchState.phase === "error" && (
            <span
              style={{
                fontSize: 11,
                color: "#f87171",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 300,
              }}
              title={fetchState.message}
            >
              {fetchState.message}
            </span>
          )}
        </div>

        {fetchState.phase === "done" && fetchState.models.length > 0 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <SearchSelect
              options={fetchState.models}
              value={fetchedModel}
              onChange={setFetchedModel}
              placeholder={t("searchModelsPlaceholder", "Type to search, pick a model to add…")}
              mono
            />
            <button
              type="button"
              onClick={handleAddFetchedModel}
              disabled={!fetchedModel}
              style={{
                height: 34,
                padding: "0 14px",
                background: fetchedModel ? "var(--accent)" : "var(--bg-panel)",
                border: "none",
                borderRadius: 5,
                color: fetchedModel ? "#fff" : "var(--text-dim)",
                cursor: fetchedModel ? "pointer" : "not-allowed",
                fontSize: 12,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {t("addModel", "Add model")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

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
                {t(
                  {
                    off: "thinkingOff",
                    minimal: "thinkingMinimal",
                    low: "thinkingLow",
                    medium: "thinkingMedium",
                    high: "thinkingHigh",
                    xhigh: "thinkingXHigh",
                  }[level],
                  level,
                )}
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
                {t("default", "Default")}
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{
                  ...btnBase,
                  borderLeft: "1px solid var(--border)",
                  ...(state === "null" ? btnActiveDisabled : {}),
                }}
              >
                {t("disabled", "Disabled")}
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
                {t("custom", "Custom")}
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
    if (testState.phase === "testing") return t("testingModelConnection", "Testing model connection...");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return [t("connected", "Connected"), ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
    return [t("failed", "Failed"), ...meta, testState.message].filter(Boolean).join(" · ");
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
                border: `1px solid ${testState.phase === "error" ? "#fecaca" : testState.phase === "success" ? "#bbf7d0" : "var(--border)"}`,
                borderRadius: 4,
                background:
                  testState.phase === "error" ? "#fee2e2" : testState.phase === "success" ? "#dcfce7" : "#e5e7eb",
                color: "#111827",
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
            title={t("testModelConnection", "Test model connection")}
            style={{
              height: 32,
              padding: "0 10px",
              background: testState.phase === "success" ? "#16a34a" : "none",
              border: `1px solid ${testState.phase === "success" ? "#16a34a" : "var(--border)"}`,
              borderRadius: 4,
              color:
                testState.phase === "success"
                  ? "#fff"
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
              ? t("testing", "Testing…")
              : testState.phase === "success"
                ? t("ok", "OK")
                : t("test", "Test")}
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
            {t("remove", "Remove")}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("modelId", "ID *")}>
          <TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono />
        </Field>
        <Field label={t("name", "Name")}>
          <TextInput
            value={model.name ?? ""}
            onChange={(v) => set("name", v || undefined)}
            placeholder={t("displayName", "Display name")}
          />
        </Field>
      </div>

      <Field label={t("apiOverride", "API override")}>
        <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Check
          label={t("reasoningThinking", "Reasoning / thinking")}
          checked={model.reasoning ?? false}
          onChange={(v) => set("reasoning", v || undefined)}
        />
        <Check
          label={t("imageInput", "Image input")}
          checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)}
        />
      </div>

      {model.reasoning && (
        <>
          <Check
            label={t("deepseekThinkingCompat", "DeepSeek thinking compat")}
            checked={hasDeepseekCompat(model)}
            onChange={(v) => onChange(setDeepseekCompat(model, v))}
          />
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>{t("thinkingLevelMap", "Thinking level map")}</SectionTitle>
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
                  {t("clearAll", "clear all")}
                </button>
              )}
            </div>
            <ThinkingLevelMapEditor value={model.thinkingLevelMap} onChange={(v) => set("thinkingLevelMap", v)} />
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("contextWindow", "Context window (tokens)")}>
          <NumInput
            value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)}
            placeholder="128000"
          />
        </Field>
        <Field label={t("maxOutputTokens", "Max output tokens")}>
          <NumInput
            value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)}
            placeholder="16384"
          />
        </Field>
      </div>

      <div>
        <SectionTitle>{t("costPerMillionTokens", "Cost (per million tokens)")}</SectionTitle>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <Field
              key={k}
              label={t(
                k === "input"
                  ? "usageInput"
                  : k === "output"
                    ? "usageOutput"
                    : k === "cacheRead"
                      ? "cacheRead"
                      : "cacheWrite",
                k,
              )}
            >
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </Field>
          ))}
        </div>
      </div>
    </div>
  );
}

function OAuthDetail({ provider, onRefresh }: { provider: OAuthProvider; onRefresh: () => void }) {
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

  // Reset state when provider changes and invalidate any in-flight startup.
  useEffect(() => {
    loginAttemptRef.current += 1;
    setLoginState({ phase: "idle" });
    setInputValue("");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    void call("auth.loginCancel", { provider: provider.id }).catch(() => {});
  }, [provider.id]);

  useEffect(() => {
    return () => {
      loginAttemptRef.current += 1;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      void call("auth.loginCancel", { provider: provider.id }).catch(() => {});
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
        message: error instanceof Error ? error.message : t("unableToResetLogin", "Unable to reset login"),
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
        event instanceof ErrorEvent && event.message ? event.message : t("connectionLost", "Connection lost");
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
          : { phase: "success", message: t("disconnectedSuccessfully", "Disconnected successfully.") },
      );
      onRefresh();
    } catch (error) {
      setLoginState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [provider.id, onRefresh, t]);

  const submitCode = useCallback(
    async (token: string, code: string) => {
      if (!code.trim()) return;
      setLoginState({ phase: "progress", message: t("verifying", "Verifying…") });
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
        setLoginState({ phase: "error", message: e instanceof Error ? e.message : t("networkError", "Network error") });
      }
    },
    [provider.id, t],
  );

  const submitSelection = useCallback(
    async (token: string, value: string) => {
      setLoginState({ phase: "progress", message: t("continuing", "Continuing…") });
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
        setLoginState({ phase: "error", message: e instanceof Error ? e.message : t("networkError", "Network error") });
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
        <SectionTitle>{t("subscription", "Subscription")}</SectionTitle>
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
            {provider.loggedIn ? t("connectedStatus", "connected") : t("notConnectedStatus", "not connected")}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={{ minHeight: 48 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {provider.loggedIn
              ? t("alreadyConnected", "Already connected. You can re-login or disconnect.")
              : t("connectAccount", "Connect your {name} account.").replace("{name}", provider.name)}
          </p>
        )}
        {loginState.phase === "connecting" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
            {t("openingBrowser", "Opening browser…")}
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
                    "completeSignIn",
                    "Complete sign-in in the browser, then copy the redirect URL from the address bar and paste it below.",
                  )
                : loginState.message}
            </p>
            {loginState.phase === "auth" && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                {t("browserDidNotOpen", "If the browser window did not open,")}{" "}
                <a
                  href={loginState.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent)", wordBreak: "break-all" }}
                >
                  {t("clickHereToOpenLogin", "click here to open the login page")}
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
                    : (loginState.placeholder ?? t("enterValue", "Enter value…"))
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
              {t("verificationPageHint", "Open the verification page and enter this code:")}
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
                ? " " +
                  t("expiresInMinutes", "Expires in {n} minutes.").replace(
                    "{n}",
                    String(Math.ceil(loginState.expiresInSeconds / 60)),
                  )
                : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
          <p style={{ margin: 0, fontSize: 12, color: loginState.warning ? "#d97706" : "#4ade80" }}>
            {loginState.message ?? t("connectedSuccessfully", "Connected successfully.")}
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
              {provider.loggedIn ? t("relogin", "Re-login") : t("login", "Login")}
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
                {t("disconnect", "Disconnect")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── API Key detail ────────────────────────────────────────────────────────────

function ApiKeyDetail({ provider, onRefresh }: { provider: ApiKeyProvider; onRefresh: () => void }) {
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
        <SectionTitle>{t("apiKey", "API Key")}</SectionTitle>
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
            {provider.configured ? t("configuredStatus", "configured") : t("notConfiguredStatus", "not configured")}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.configured
          ? t("apiKeyStoredHint", "API key is stored. Enter a new key below to replace it, or disconnect to remove it.")
          : t("enterApiKeyHint", "Enter your {name} API key to enable {count} models.")
              .replace("{name}", provider.displayName)
              .replace("{count}", String(provider.modelCount))}
      </p>

      <Field label={t("apiKey", "API Key")}>
        <div style={{ display: "flex", gap: 6 }}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim()) void handleSave();
            }}
            placeholder={provider.configured ? t("enterNewKey", "Enter new key to replace…") : "sk-…"}
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
          {removing ? t("removing", "Removing…") : t("disconnect", "Disconnect")}
        </button>
      )}
    </div>
  );
}

// ── Built-in provider detail (custom Base URL + enabled model toggles) ────────

function BuiltinProviderDetail({
  providerId,
  onChanged,
  onApplied,
  showToast,
}: {
  providerId: string;
  onChanged: () => void;
  onApplied?: (overlay: { providerId: string; baseUrl: string; enabledModels: string[] | null }) => void;
  showToast: (message: string, type?: ToastType) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<ProviderModelsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  // null = no filter (all models enabled by default)
  const [enabledModels, setEnabledModels] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const pendingRef = useRef<{ baseUrl: string; enabledModels: string[] | null } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [providerId]);

  const persist = useCallback(
    async (nextBaseUrl: string, nextEnabledModels: string[] | null) => {
      // Consume the pending request so a re-render / unmount cannot re-fire it.
      pendingRef.current = null;
      setSaving(true);
      try {
        const res = await fetch("/api/models-config/set-provider-overlay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId, baseUrl: nextBaseUrl, enabledModels: nextEnabledModels }),
        });
        const d = (await res.json()) as { error?: string };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 1500);
        onChanged();
        // Mirror the overlay into the parent config snapshot so a later full-config
        // save (custom provider form) does not revert this built-in provider.
        onApplied?.({ providerId, baseUrl: nextBaseUrl, enabledModels: nextEnabledModels });
        showToast(t("settingsSaved", "Settings saved"), "success");
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setSaving(false);
      }
    },
    [onChanged, onApplied, providerId, showToast, t],
  );

  const scheduleSave = useCallback(
    (nextBaseUrl: string, nextEnabledModels: string[] | null) => {
      pendingRef.current = { baseUrl: nextBaseUrl, enabledModels: nextEnabledModels };
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        const pending = pendingRef.current;
        if (pending) void persist(pending.baseUrl, pending.enabledModels);
      }, 500);
    },
    [persist],
  );

  // Flush any pending save only when actually unmounting (switching provider /
  // closing the panel). The effect must not re-run on every render — `persist`
  // is recreated when the parent re-renders, and re-running would re-fire the
  // pending save and loop forever.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      const pending = pendingRef.current;
      if (pending) void persistRef.current(pending.baseUrl, pending.enabledModels);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setBaseUrl("");
    setEnabledModels(null);
    fetch("/api/models-config/provider-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<ProviderModelsResult>;
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setBaseUrl(d.provider.customBaseUrl ?? "");
        setEnabledModels(d.enabledModels);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  if (loading) {
    return (
      <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-muted)" }}>{t("loading", "Loading…")}</div>
    );
  }
  if (loadError || !data) {
    return (
      <div style={{ padding: "20px 0", fontSize: 12, color: "#f87171" }}>
        {loadError ?? t("failedToLoadProvider", "Failed to load provider")}
      </div>
    );
  }

  const allEnabled = enabledModels === null;
  const enabledSet = new Set(allEnabled ? [] : enabledModels);
  const enabledCount = allEnabled ? data.models.length : enabledModels!.length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleModels = normalizedQuery
    ? data.models.filter(
        (m) =>
          m.name.toLocaleLowerCase().includes(normalizedQuery) || m.id.toLocaleLowerCase().includes(normalizedQuery),
      )
    : data.models;

  const isChecked = (id: string) => allEnabled || enabledSet.has(id);

  const toggleModel = (id: string) => {
    if (allEnabled) {
      // First uncheck: everything except this model becomes the explicit list.
      const next = data.models.filter((m) => m.id !== id).map((m) => m.id);
      setEnabledModels(next);
      scheduleSave(baseUrl, next);
    } else {
      const next = new Set(enabledModels);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const list = [...next];
      // Re-enabling every model collapses back to the default (no filter).
      const value = list.length === data.models.length ? null : list;
      setEnabledModels(value);
      scheduleSave(baseUrl, value);
    }
  };

  const selectAll = () => {
    setEnabledModels(null);
    scheduleSave(baseUrl, null);
  };

  const deselectAll = () => {
    const next: string[] = [];
    setEnabledModels(next);
    scheduleSave(baseUrl, next);
  };

  const statusText = saving ? t("saving", "Saving…") : savedOk ? t("saved", "Saved") : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("provider", "Provider")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
          {statusText && <span style={{ color: savedOk ? "#4ade80" : "var(--text-dim)" }}>{statusText}</span>}
          <ProviderIcon id={providerId} size={22} />
          <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{data.provider.name}</span>
        </div>
      </div>

      <Field label={t("baseUrlLabel", "Base URL")}>
        <TextInput
          value={baseUrl}
          onChange={(v) => {
            setBaseUrl(v);
            scheduleSave(v, enabledModels);
          }}
          placeholder={data.provider.defaultBaseUrl || "https://api.example.com/v1"}
          mono
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {t("leaveEmptyForOfficial", "Leave empty to use the official endpoint ({url})").replace(
            "{url}",
            data.provider.defaultBaseUrl || "—",
          )}
        </span>
      </Field>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <SectionTitle>
            {t("enabledModelsCount", "Enabled models — {enabled} / {total}")
              .replace("{enabled}", String(enabledCount))
              .replace("{total}", String(data.models.length))}
          </SectionTitle>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={selectAll}
              style={{
                minHeight: 26,
                padding: "0 9px",
                fontSize: 11,
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {t("selectAll", "Select all")}
            </button>
            <button
              type="button"
              onClick={deselectAll}
              style={{
                minHeight: 26,
                padding: "0 9px",
                fontSize: 11,
                background: "none",
                border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 4,
                color: "#ef4444",
                cursor: "pointer",
              }}
            >
              {t("deselectAll", "Deselect all")}
            </button>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
          {t(
            "enabledModelsHint",
            "Only enabled models appear in the chat model picker. The active model in an existing session is not changed.",
          )}
        </p>
        {data.models.length > 0 && (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("modelSearchModels", "Search models…")}
            aria-label={t("modelSearchProviderModels", "Search provider models")}
            style={{
              width: "100%",
              boxSizing: "border-box",
              marginTop: 8,
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
        {data.models.length === 0 ? (
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
            {t("modelNoAvailableModels", "No models are currently available for this provider.")}
          </p>
        ) : (
          <div
            style={{
              marginTop: 8,
              maxHeight: 320,
              overflowY: "auto",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 10px",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(min(220px, 100%), 1fr))",
              gap: 2,
            }}
          >
            {visibleModels.map((m) => (
              <label
                key={m.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "4px 4px",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 12,
                  color: "var(--text-muted)",
                  minWidth: 0,
                }}
                title={`${m.name} — ${m.id}`}
              >
                <input
                  type="checkbox"
                  checked={isChecked(m.id)}
                  onChange={() => toggleModel(m.id)}
                  style={{
                    width: 15,
                    height: 15,
                    margin: 0,
                    accentColor: "var(--accent)",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                />
                <span style={{ minWidth: 0, lineHeight: 1.3 }}>
                  <span
                    style={{
                      display: "block",
                      color: "var(--text)",
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.name}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--text-dim)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.id}
                  </span>
                </span>
              </label>
            ))}
            {visibleModels.length === 0 && (
              <span style={{ padding: "10px 0", color: "var(--text-muted)", fontSize: 12 }}>
                {t("modelNoMatchingModels", "No matching models.")}
              </span>
            )}
          </div>
        )}
      </div>
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
            placeholder={t("searchProviders", "Search providers…")}
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
              {t("noProvidersMatch", "No providers match")}
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
                  {t("custom", "Custom")}
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
                      {t("customCompatible", "OpenAI / Anthropic compatible")}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                      {t("customEndpointFormat", "Custom endpoint format")}
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
                  {t("subscriptions", "Subscriptions")}
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
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{t("oauth", "OAuth")}</div>
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
                  {t("apiKey", "API Key")}
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
}: {
  onClose: () => void;
  onChanged?: () => void;
  embedded?: boolean;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [builtinProviders, setBuiltinProviders] = useState<BuiltinProviderInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = "info") => {
    if (!message.trim()) return;
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 200);
    }, 3500);
  }, []);

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

  const loadBuiltinProviders = useCallback(() => {
    fetch("/api/models-config/providers")
      .then((r) => r.json())
      .then((d: { providers: BuiltinProviderInfo[] }) => setBuiltinProviders(d.providers))
      .catch(() => {});
  }, []);

  const [loadFailed, setLoadFailed] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    setLoadFailed(false);
    setConfigLoaded(false);
    fetch("/api/models-config")
      .then(async (r) => {
        // ISSUE-009: only accept successful loads
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<ModelsJson & { error?: string }>;
      })
      .then((d) => {
        if (d.error) throw new Error(d.error);
        const normalized = d.providers ? d : { ...d, providers: {} };
        setConfig(normalized);
        setConfigLoaded(true);
        const keys = Object.keys(normalized.providers ?? {});
        if (keys.length > 0) setSelection({ type: "provider", name: keys[0] });
      })
      .catch((e) => {
        setLoadFailed(true);
        setSaveError(e instanceof Error ? e.message : String(e));
        // Do NOT reset to empty providers — keep prior state / block save
      })
      .finally(() => setLoading(false));
    loadOAuthProviders();
    loadApiKeyProviders();
    loadBuiltinProviders();
  }, [loadOAuthProviders, loadApiKeyProviders, loadBuiltinProviders]);

  const addCustomProvider = useCallback(() => {
    let finalName = "new-provider";
    let n = 1;
    while (config.providers?.[finalName]) finalName = `new-provider-${n++}`;
    setConfig((prev) => ({
      ...prev,
      providers: { ...(prev.providers ?? {}), [finalName]: { api: "openai-completions" } },
    }));
    setSelection({ type: "provider", name: finalName });
  }, [config.providers]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  const renameProvider = useCallback(
    (oldName: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === oldName) return;
      const exists = Boolean(config.providers?.[trimmed]) || builtinProviders.some((p) => p.id === trimmed);
      if (exists) {
        showToast(t("providerIdExists", "A provider with this identifier already exists"), "error");
        return;
      }
      setConfig((prev) => {
        const entries = Object.entries(prev.providers ?? {});
        const idx = entries.findIndex(([k]) => k === oldName);
        if (idx === -1) return prev;
        entries[idx] = [trimmed, entries[idx][1]];
        return { ...prev, providers: Object.fromEntries(entries) };
      });
      setSelection((prev) => {
        if (!prev) return prev;
        if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: trimmed };
        if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: trimmed };
        return prev;
      });
    },
    [config.providers, builtinProviders, showToast, t],
  );

  const deleteProvider = useCallback((name: string) => {
    setConfig((prev) => {
      const providers = { ...(prev.providers ?? {}) };
      delete providers[name];
      return { ...prev, providers };
    });
    setConfig((prev) => {
      const remaining = Object.keys(prev.providers ?? {});
      setSelection(remaining.length > 0 ? { type: "provider", name: remaining[0] } : null);
      return prev;
    });
  }, []);

  const addModel = useCallback((providerName: string) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "" }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    setConfig((prev) => {
      const idx = (prev.providers?.[providerName]?.models?.length ?? 1) - 1;
      setSelection({ type: "model", providerName, index: idx });
      return prev;
    });
  }, []);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => replaceModelEntry(prev, providerName, index, m));
  }, []);

  const removeModel = useCallback((providerName: string, index: number) => {
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
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) setSaveError(d.error ?? `HTTP ${res.status}`);
      else {
        setSavedOk(true);
        onChanged?.();
        setTimeout(() => setSavedOk(false), 2000);
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config, onChanged]);

  const providers = Object.entries(config.providers ?? {});
  // Built-in provider overlays (Base URL / enabled models) are stored under the
  // provider's id in models.json; they are managed by the "Providers" section
  // above and must not be listed here as if they were user-created providers.
  const builtinIds = new Set(builtinProviders.map((p) => p.id));
  const customProviders = providers.filter(([name]) => !builtinIds.has(name));
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured);

  // Only show built-in providers that are actually usable (credentials present) or
  // carry an existing overlay, so the model list stays focused instead of listing
  // every built-in provider the user has never configured.
  const visibleBuiltin = builtinProviders.filter(
    (p) => p.configured || p.enabledModels !== undefined || p.customBaseUrl !== undefined,
  );

  const renderBuiltinDetail = (providerId: string) => (
    <BuiltinProviderDetail
      key={providerId}
      providerId={providerId}
      onChanged={() => {
        onChanged?.();
        loadBuiltinProviders();
      }}
      onApplied={({ providerId: pid, baseUrl, enabledModels }) => {
        // Keep the config snapshot in sync with auto-saved built-in overlays so
        // a later full-config save cannot revert them to stale values.
        setConfig((prev) => {
          const providers = { ...(prev.providers ?? {}) };
          const existing = { ...(providers[pid] ?? {}) };
          if (baseUrl) existing.baseUrl = baseUrl;
          else delete existing.baseUrl;
          if (enabledModels === null) delete existing.enabledModels;
          else existing.enabledModels = enabledModels;
          if (Object.keys(existing).length === 0) delete providers[pid];
          else providers[pid] = existing;
          return { ...prev, providers };
        });
      }}
      showToast={showToast}
    />
  );

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
          onRefresh={() => {
            loadOAuthProviders();
            // Connect/disconnect changes which built-in providers have credentials,
            // so refresh the configured list to show/hide the model selection.
            loadBuiltinProviders();
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
          onRefresh={() => {
            loadApiKeyProviders();
            // Connect/disconnect changes which built-in providers have credentials,
            // so refresh the configured list to show/hide the model selection.
            loadBuiltinProviders();
          }}
        />
      );
    }
    if (selection.type === "builtin") {
      return renderBuiltinDetail(selection.providerId);
    }
    if (selection.type === "provider") {
      if (builtinIds.has(selection.name)) {
        // Built-in overlays used to surface here as pseudo custom providers;
        // route any stale selection to the built-in detail instead.
        return renderBuiltinDetail(selection.name);
      }
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
          showToast={showToast}
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
                title={t("closeModels", "Close models")}
                aria-label={t("closeModels", "Close models")}
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

                {/* Divider before built-in provider settings */}
                {(activeOAuth.length > 0 || activeApiKey.length > 0) && visibleBuiltin.length > 0 && (
                  <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
                )}

                {/* Built-in provider settings (custom Base URL + enabled models) */}
                {visibleBuiltin.length > 0 && (
                  <div
                    style={{
                      padding: "6px 8px 2px",
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--text-dim)",
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                    }}
                  >
                    Providers ({visibleBuiltin.length})
                  </div>
                )}
                {visibleBuiltin.map((p) => {
                  const isSelected = selection?.type === "builtin" && selection.providerId === p.id;
                  const configured = p.enabledModels !== undefined || p.customBaseUrl !== undefined;
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelection({ type: "builtin", providerId: p.id })}
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
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                      </svg>
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
                      {configured && (
                        <span
                          style={{
                            fontSize: 9,
                            padding: "1px 5px",
                            background: "rgba(74,222,128,0.12)",
                            color: "#4ade80",
                            borderRadius: 3,
                            flexShrink: 0,
                          }}
                        >
                          {p.enabledModels !== undefined
                            ? `${p.enabledModels.length}/${p.modelCount}`
                            : t("custom", "Custom")}
                        </span>
                      )}
                      <ProviderIcon id={p.id} size={16} />
                    </div>
                  );
                })}

                {/* Divider before custom providers, only when there are active managed providers */}
                {(activeOAuth.length > 0 || activeApiKey.length > 0 || visibleBuiltin.length > 0) &&
                  customProviders.length > 0 && (
                    <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
                  )}

                {/* Custom providers */}
                {loading ? (
                  <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                    {t("loading", "Loading…")}
                  </div>
                ) : (
                  customProviders.map(([pName, pData]) => {
                    const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                    const models = pData.models ?? [];
                    const providerLabel = pData.name || pName;
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
                              fontFamily: pData.name && pData.name !== pName ? "inherit" : "var(--font-mono)",
                              flex: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={pData.name && pData.name !== pName ? `${pData.name} (${pName})` : pName}
                          >
                            {providerLabel}
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
                                {m.id || t("newModel", "new model")}
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
                          <span style={{ fontSize: 11 }}>{t("addModelShort", "+ model")}</span>
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
              disabled={saving || savedOk || loading || loadFailed || !configLoaded}
              title={loadFailed ? t("cannotSaveUntilLoaded", "Cannot save until config loads successfully") : undefined}
              style={{
                position: "relative",
                padding: "6px 16px",
                minWidth: 92,
                background: savedOk
                  ? "#16a34a"
                  : saving || loadFailed || !configLoaded
                    ? "var(--bg-panel)"
                    : "var(--accent)",
                border: "none",
                borderRadius: 6,
                color: savedOk ? "#fff" : saving || loadFailed || !configLoaded ? "var(--text-muted)" : "#fff",
                cursor: saving || savedOk || loading || loadFailed || !configLoaded ? "default" : "pointer",
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
      <ToastStack toasts={toasts} />
    </>
  );
}
