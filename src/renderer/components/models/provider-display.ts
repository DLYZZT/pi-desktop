export function oauthProviderName(id: string, fallback: string, t: (key: string, fallback: string) => string): string {
  if (id === "openai") return t("modelChatGPTLogin", "OpenAI / ChatGPT subscription");
  if (id === "openai-codex") return t("modelCodexLegacy", "OpenAI Codex (legacy)");
  return fallback;
}
