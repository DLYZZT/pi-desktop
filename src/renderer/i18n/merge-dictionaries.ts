/** Reject accidental cross-domain overrides instead of depending on spread order. */
export function mergeDictionaries(...domains: Readonly<Record<string, string>>[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const domain of domains) {
    for (const [key, value] of Object.entries(domain)) {
      if (Object.hasOwn(result, key)) throw new Error(`Duplicate translation key: ${key}`);
      result[key] = value;
    }
  }
  return result;
}
