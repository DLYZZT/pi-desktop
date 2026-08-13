import type { PluginPackageInfo } from "./api-types.ts";
import type { AppLanguage } from "../i18n.ts";
import { formatNumber } from "./locale-format.ts";

type Translate = (key: string, fallback: string) => string;

export function pluginResourceSummary(pkg: PluginPackageInfo, language: AppLanguage, t: Translate): string {
  if (pkg.disabled) return t("pluginStatusDisabled", "Disabled");
  const parts = [
    pkg.counts.extensions
      ? t("pluginExtensionCount", "{count} ext").replace("{count}", formatNumber(pkg.counts.extensions, language))
      : "",
    pkg.counts.skills
      ? t("pluginSkillCount", "{count} skills").replace("{count}", formatNumber(pkg.counts.skills, language))
      : "",
    pkg.counts.prompts
      ? t("pluginPromptCount", "{count} prompts").replace("{count}", formatNumber(pkg.counts.prompts, language))
      : "",
    pkg.counts.themes
      ? t("pluginThemeCount", "{count} themes").replace("{count}", formatNumber(pkg.counts.themes, language))
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("pluginNoResources", "No resources");
}

export function pluginVersionSummary(pkg: PluginPackageInfo, t: Translate): string {
  const parts = [];
  if (pkg.version) parts.push(t("pluginInstalledVersion", "installed {version}").replace("{version}", pkg.version));
  if (pkg.configuredVersion) {
    parts.push(t("pluginConfiguredVersion", "configured {version}").replace("{version}", pkg.configuredVersion));
  }
  return parts.length ? parts.join(" · ") : t("unknown", "unknown");
}

export function pluginStatusLabel(status: PluginPackageInfo["status"], t: Translate): string {
  if (status === "loaded") return t("pluginStatusLoaded", "loaded");
  if (status === "installed") return t("pluginStatusInstalled", "installed");
  if (status === "disabled") return t("pluginStatusDisabled", "Disabled");
  return t("pluginStatusMissing", "missing");
}
