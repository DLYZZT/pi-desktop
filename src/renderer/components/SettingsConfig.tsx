import { useEffect, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n, type AppLanguage } from "@/i18n";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { ChannelsConfig } from "./channels/ChannelsConfig";
import type { ChannelsSnapshot } from "@shared/channel-types";

type SettingsTab = "general" | "channels" | "models" | "skills" | "plugins";

interface SettingsConfigProps {
  cwd: string | null;
  sessionId: string | null;
  onClose: () => void;
  onModelsChanged: () => void;
  onPluginsReloaded: () => void;
  onChannelsChanged: (snapshot: ChannelsSnapshot) => void;
}

export function SettingsConfig({
  cwd,
  sessionId,
  onClose,
  onModelsChanged,
  onPluginsReloaded,
  onChannelsChanged,
}: SettingsConfigProps) {
  const isMobile = useIsMobile();
  const { isDark, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "general", label: t("general", "General") },
    { id: "channels", label: t("channels", "Channels") },
    { id: "models", label: t("models", "Models") },
    { id: "skills", label: t("skills", "Skills") },
    { id: "plugins", label: t("plugins", "Plugins") },
  ];

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("settings", "Settings")}
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 900,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "82vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "13px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{t("settings", "Settings")}</div>
            {!isMobile && (
              <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-dim)" }}>
                {t("settingsDescription", "Manage app preferences, models, skills, and plugins.")}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close", "Close")}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              padding: "4px 7px",
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            overflowX: "auto",
            flexShrink: 0,
            background: "var(--bg-panel)",
          }}
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  minWidth: isMobile ? 88 : 112,
                  height: 34,
                  padding: "0 16px",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 6,
                  background: active ? "var(--accent-soft)" : "var(--bg)",
                  color: active ? "var(--accent)" : "var(--text-muted)",
                  fontSize: 12,
                  fontWeight: active ? 650 : 500,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}>
          {activeTab === "general" && (
            <GeneralSettings
              language={language}
              onLanguageChange={setLanguage}
              isDark={isDark}
              onThemeChange={(nextDark) => {
                if (nextDark !== isDark) toggleTheme();
              }}
            />
          )}
          {activeTab === "models" && <ModelsConfig embedded onClose={() => undefined} onChanged={onModelsChanged} />}
          {activeTab === "channels" && <ChannelsConfig onSnapshotChange={onChannelsChanged} />}
          {activeTab === "skills" &&
            (cwd ? <SkillsConfig embedded cwd={cwd} onClose={() => undefined} /> : <ProjectRequired />)}
          {activeTab === "plugins" &&
            (cwd ? (
              <PluginsConfig
                embedded
                cwd={cwd}
                sessionId={sessionId}
                onClose={() => undefined}
                onReloaded={onPluginsReloaded}
              />
            ) : (
              <ProjectRequired />
            ))}
        </div>
      </div>
    </div>
  );
}

function GeneralSettings({
  language,
  onLanguageChange,
  isDark,
  onThemeChange,
}: {
  language: AppLanguage;
  onLanguageChange: (language: AppLanguage) => void;
  isDark: boolean;
  onThemeChange: (dark: boolean) => void;
}) {
  const { t } = useI18n();
  const [backgroundMode, setBackgroundMode] = useState(true);
  useEffect(() => {
    void window.piBridge.getUiState().then((state) => setBackgroundMode(state.backgroundMode !== false));
  }, []);
  return (
    <div style={{ width: "100%", overflowY: "auto", padding: "28px clamp(18px, 5vw, 52px)" }}>
      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>
          {t("interfaceLanguage", "Interface language")}
        </h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t("interfaceLanguageDescription", "Choose the language used by the app. Changes take effect immediately.")}
        </p>
        <SettingRow label={t("language", "Language")}>
          <select
            value={language}
            onChange={(event) => onLanguageChange(event.target.value as AppLanguage)}
            style={selectStyle}
          >
            <option value="en-US">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </SettingRow>
      </section>

      <div style={{ height: 1, background: "var(--border)", maxWidth: 620, margin: "28px 0" }} />

      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("backgroundMode", "Background mode")}</h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t("backgroundModeDescription", "Keep messaging channels connected when the window is closed.")}
        </p>
        <SettingRow label={t("closeToTray", "Close window to tray")}>
          <input
            type="checkbox"
            checked={backgroundMode}
            onChange={(event) => {
              const next = event.target.checked;
              setBackgroundMode(next);
              void window.piBridge.setUiState({ backgroundMode: next });
            }}
          />
        </SettingRow>
      </section>

      <div style={{ height: 1, background: "var(--border)", maxWidth: 620, margin: "28px 0" }} />

      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("appearance", "Appearance")}</h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t("appearanceDescription", "Choose the color mode used by the app.")}
        </p>
        <SettingRow label={t("theme", "Theme")}>
          <select
            value={isDark ? "dark" : "light"}
            onChange={(event) => onThemeChange(event.target.value === "dark")}
            style={selectStyle}
          >
            <option value="light">{t("light", "Light")}</option>
            <option value="dark">{t("dark", "Dark")}</option>
          </select>
        </SettingRow>
      </section>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        minHeight: 52,
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{label}</span>
      {children}
    </div>
  );
}

function ProjectRequired() {
  const { t } = useI18n();
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 28,
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 380 }}>
        <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text)" }}>
          {t("projectRequiredTitle", "Select a project first")}
        </div>
        <div style={{ marginTop: 7, fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t(
            "projectRequiredDescription",
            "Skills and plugins depend on the current project. Select a project directory from the sidebar first.",
          )}
        </div>
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  minWidth: 160,
  padding: "7px 30px 7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
};
