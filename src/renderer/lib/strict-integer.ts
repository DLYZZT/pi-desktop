export type StrictIntegerParseResult = { kind: "empty" } | { kind: "valid"; value: number } | { kind: "invalid" };

export function parseStrictDecimalInteger(
  input: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): StrictIntegerParseResult {
  if (input === "") return { kind: "empty" };
  if (!/^[0-9]+$/.test(input)) return { kind: "invalid" };
  const value = Number.parseInt(input, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) return { kind: "invalid" };
  return { kind: "valid", value };
}

export function applyStrictOptionalPositiveInteger(current: number | undefined, input: string): number | undefined {
  const result = parseStrictDecimalInteger(input);
  if (result.kind === "empty") return undefined;
  return result.kind === "valid" ? result.value : current;
}
