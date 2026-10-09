export function oauthProviderName(id: string, fallback: string, t: (key: string, fallback: string) => string): string {
  if (id === "openai") return t("modelChatGPTLogin", "OpenAI / ChatGPT subscription");
  if (id === "openai-codex") return t("modelCodexLegacy", "OpenAI Codex (legacy)");
  return fallback;
}

export function authPromptLabel(message: string, t: (key: string, fallback: string) => string): string {
  if (message === "Enter Cloudflare API key") return t("modelCloudflareKey", "Enter Cloudflare API key");
  if (message === "Enter Cloudflare account ID") return t("modelCloudflareAccount", "Enter Cloudflare account ID");
  if (message === "Enter Cloudflare AI Gateway ID")
    return t("modelCloudflareGateway", "Enter Cloudflare AI Gateway ID");
  return message;
}
