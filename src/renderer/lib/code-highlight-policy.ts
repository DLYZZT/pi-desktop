export const MAX_HIGHLIGHT_CODE_BYTES = 50 * 1024;

export function shouldHighlightCode(code: string): boolean {
  return new TextEncoder().encode(code).byteLength <= MAX_HIGHLIGHT_CODE_BYTES;
}
