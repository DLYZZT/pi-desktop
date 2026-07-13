export function splitChannelText(text: string, maxCodePoints = 3_500): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const codePoints = [...normalized];
  if (codePoints.length <= maxCodePoints) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while ([...remaining].length > maxCodePoints) {
    const points = [...remaining];
    const candidate = points.slice(0, maxCodePoints).join("");
    const paragraph = candidate.lastIndexOf("\n\n");
    const line = candidate.lastIndexOf("\n");
    const space = candidate.lastIndexOf(" ");
    const boundary = paragraph >= maxCodePoints / 2 ? paragraph : line >= maxCodePoints / 2 ? line : space;
    const chunk = boundary > 0 ? candidate.slice(0, boundary) : candidate;
    chunks.push(chunk.trimEnd());
    remaining = remaining.slice(chunk.length).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
