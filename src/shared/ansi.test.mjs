import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ansi.ts");
}

test("strips ANSI escape sequences", async () => {
  const { stripAnsi } = await loadSubject();

  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
});

test("normalizes boxed custom panel lines while preserving ANSI codes", async () => {
  const { normalizeCustomPanelLines, stripAnsi } = await loadSubject();
  const lines = ["┌──────┐", "│ \x1b[32mOK\x1b[0m   │", "└──────┘"];

  const normalized = normalizeCustomPanelLines(lines);

  assert.equal(normalized.length, 1);
  assert.equal(stripAnsi(normalized[0]), "OK");
  assert.equal(normalized[0].includes(`${String.fromCharCode(27)}[32m`), true);
});

test("parses ANSI style segments and reset codes", async () => {
  const { parseAnsiLine } = await loadSubject();

  assert.deepEqual(parseAnsiLine("\x1b[31;1mhot\x1b[0m cold"), [
    { text: "hot", style: { color: "#dc2626", fontWeight: 700 } },
    { text: " cold", style: {} },
  ]);
});

test("inverse ignores color parameters and restores colors", async () => {
  const { parseAnsiLine } = await loadSubject();
  assert.deepEqual(parseAnsiLine("\x1b[38;5;7mgray\x1b[39mplain"), [
    { text: "gray", style: { color: "#6b7280" } },
    { text: "plain", style: {} },
  ]);
  assert.deepEqual(parseAnsiLine("\x1b[7m\x1b[38;2;0;27;7mx\x1b[27my"), [
    { text: "x", style: { color: "var(--bg-panel)", backgroundColor: "rgb(0, 27, 7)" } },
    { text: "y", style: { color: "rgb(0, 27, 7)" } },
  ]);
});
test("unsupported terminal controls never appear as text", async () => {
  const { parseAnsiLine, stripAnsi } = await loadSubject();
  const text = "a\x1b]8;;https://example.test\x07link\x1b]8;;\x1b\\\x1b[2K\x1b_pi:c\x07b";
  assert.equal(stripAnsi(text), "alinkb");
  assert.equal(
    parseAnsiLine(text)
      .map((segment) => segment.text)
      .join(""),
    "alinkb",
  );
});

test("normalization removes cursor metadata but retains cursor highlight", async () => {
  const { normalizeCustomPanelLines, parseAnsiLine } = await loadSubject();
  const [line] = normalizeCustomPanelLines(["│\x1b_pi:c\x07\x1b[7mx\x1b[27m│"]);
  assert.equal(line.includes("_pi:c"), false);
  assert.equal(parseAnsiLine(line)[0].style.backgroundColor, "var(--text)");
});

test("normalization preserves an inverted trailing-space caret", async () => {
  const { normalizeCustomPanelLines, parseAnsiLine } = await loadSubject();
  const [line] = normalizeCustomPanelLines(["│ > \x1b[7m \x1b[27m│"]);
  assert.ok(
    parseAnsiLine(line).some((segment) => segment.text === " " && segment.style.backgroundColor === "var(--text)"),
  );
});

test("maps 256-color SGR codes", async () => {
  const { ansi256Color, parseAnsiLine } = await loadSubject();

  assert.equal(ansi256Color(196), "rgb(255, 0, 0)");
  assert.deepEqual(parseAnsiLine("\x1b[38;5;196mred"), [{ text: "red", style: { color: "rgb(255, 0, 0)" } }]);
});
