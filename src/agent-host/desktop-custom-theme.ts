/** ANSI theme facade for the desktop text-panel profile. Unknown semantic colors inherit the panel color. */
const FG: Readonly<Record<string, string>> = Object.freeze({
  accent: "36",
  borderAccent: "36",
  border: "90",
  borderMuted: "90",
  dim: "90",
  muted: "90",
  success: "32",
  error: "31",
  warning: "33",
  text: "39",
  mdHeading: "36",
  mdLink: "34",
  mdLinkUrl: "90",
  mdCode: "33",
  mdQuote: "90",
  toolDiffAdded: "32",
  toolDiffRemoved: "31",
});
const BG: Readonly<Record<string, string>> = Object.freeze({ selectedBg: "100", searchMatchBg: "43" });
const wrap = (open: string, close: string, text: string) =>
  `\x1b[${open}m${text.replaceAll(`\x1b[${close}m`, `\x1b[${open}m`)}\x1b[${close}m`;

export function createDesktopCustomTheme() {
  return Object.freeze({
    name: "pi-desktop-ansi",
    fg: (color: string, text: string) => wrap(FG[color] ?? "39", "39", text),
    bg: (color: string, text: string) => wrap(BG[color] ?? "49", "49", text),
    bold: (text: string) => wrap("1", "22", text),
    italic: (text: string) => wrap("3", "23", text),
    underline: (text: string) => wrap("4", "24", text),
    inverse: (text: string) => wrap("7", "27", text),
    strikethrough: (text: string) => wrap("9", "29", text),
    getFgAnsi: (color: string) => `\x1b[${FG[color] ?? "39"}m`,
    getBgAnsi: (color: string) => `\x1b[${BG[color] ?? "49"}m`,
    getColorMode: () => "256color" as const,
    getThinkingBorderColor: () => (text: string) => wrap("36", "39", text),
    getBashModeBorderColor: () => (text: string) => wrap("33", "39", text),
  });
}
