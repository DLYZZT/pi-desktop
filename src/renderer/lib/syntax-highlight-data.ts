/**
 * Common fence ids normalized before they reach the async Prism highlighter.
 * Most are built-in refractor aliases; the extra aliases preserve the ids the
 * app explicitly supported before switching to lazy loading.
 */
export const PRISM_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  "c++": "cpp",
  cs: "csharp",
  dotnet: "csharp",
  patch: "diff",
  dockerfile: "docker",
  golang: "go",
  js: "javascript",
  jsonl: "json",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  html: "markup",
  xml: "markup",
  svg: "markup",
  py: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  yml: "yaml",
};

export function normalizePrismLanguage(language: string | undefined): string | undefined {
  if (!language) return language;
  const normalized = language.toLowerCase();
  return PRISM_LANGUAGE_ALIASES[normalized] ?? normalized;
}
