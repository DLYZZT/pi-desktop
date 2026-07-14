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
    const boundary =
      paragraph >= maxCodePoints / 2
        ? paragraph
        : line >= maxCodePoints / 2
          ? line
          : space >= maxCodePoints / 2
            ? space
            : -1;
    const separatorLength = boundary === paragraph ? 2 : boundary >= 0 ? 1 : 0;
    const chunk = boundary > 0 ? candidate.slice(0, boundary + separatorLength) : candidate;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
