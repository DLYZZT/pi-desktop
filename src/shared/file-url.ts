export interface LocalFileReference {
  name: string;
  path: string;
}

function containsUnsafePathText(value: string): boolean {
  return !value || value.includes("\0") || /[\r\n]/.test(value);
}

export function isAbsoluteLocalFilePath(value: string): boolean {
  if (containsUnsafePathText(value)) return false;
  return value.startsWith("/") || value.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

export function normalizeLocalFilePath(value: string): string | null {
  if (!isAbsoluteLocalFilePath(value)) return null;
  const slashed = value.replace(/\\/g, "/");
  const isDrive = /^[a-zA-Z]:\//.test(slashed);
  const isUnc = slashed.startsWith("//") && !isDrive;
  const rootPrefix = isDrive ? `${slashed.slice(0, 2)}/` : isUnc ? "//" : "/";
  const body = isDrive ? slashed.slice(3) : isUnc ? slashed.slice(2) : slashed.slice(1);
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (isUnc && parts.length < 2) return null;
  return `${rootPrefix}${parts.join("/")}`;
}

export function localFilePathKey(value: string): string {
  const normalized = normalizeLocalFilePath(value);
  if (!normalized) return "";
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePathSegments(value: string): string {
  return value.split("/").map(encodePathSegment).join("/");
}

export function localFilePathToUrl(value: string): string | null {
  const normalized = normalizeLocalFilePath(value);
  if (!normalized) return null;
  if (normalized.startsWith("//")) {
    const [host, ...parts] = normalized.slice(2).split("/");
    if (!host || parts.length === 0) return null;
    return `file://${encodePathSegment(host)}/${encodePathSegments(parts.join("/"))}`;
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${normalized.slice(0, 2)}/${encodePathSegments(normalized.slice(3))}`;
  }
  return `file://${encodePathSegments(normalized)}`;
}

export function fileUrlToLocalPath(value: string): string | null {
  if (!/^file:\/\//i.test(value) || value.includes("\0")) return null;
  // Four slash file URLs are ambiguous between a malformed POSIX URL and a
  // hostless UNC path. Only canonical file:/// and file://host forms are accepted.
  if (/^file:\/{4,}/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.username || url.password || url.port || url.search || url.hash) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\0")) return null;
    if (url.hostname) return normalizeLocalFilePath(`//${decodeURIComponent(url.hostname)}${pathname}`);
    if (/^\/[a-zA-Z]:\//.test(pathname)) return normalizeLocalFilePath(pathname.slice(1));
    return normalizeLocalFilePath(pathname);
  } catch {
    return null;
  }
}

export function localFileReferenceToMarkdown(file: LocalFileReference): string | null {
  const href = localFilePathToUrl(file.path);
  if (!href) return null;
  const safeName = file.name.replace(/([\\[\]])/g, "\\$1");
  return `[${safeName}](${href})`;
}

export type LocalFileMarkdownSegment = { text: string; file: null } | { text: string; file: LocalFileReference };

export function splitLocalFileReferenceMarkdown(value: string): LocalFileMarkdownSegment[] {
  const segments: LocalFileMarkdownSegment[] = [];
  const pattern = /\[((?:\\.|[^\]])*)\]\((file:\/\/[^)\s]+)\)/gi;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: value.slice(cursor, index), file: null });
    const filePath = fileUrlToLocalPath(match[2]);
    if (filePath) {
      const name = match[1].replace(/\\([\\[\]])/g, "$1");
      segments.push({ text: name, file: { name, path: filePath } });
    } else {
      segments.push({ text: match[0], file: null });
    }
    cursor = index + match[0].length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), file: null });
  return segments.length > 0 ? segments : [{ text: value, file: null }];
}

export function isLocalFilePathWithin(candidate: string, root: string): boolean {
  const candidateKey = localFilePathKey(candidate).replace(/\/+$/, "");
  const rootKey = localFilePathKey(root).replace(/\/+$/, "");
  if (!candidateKey || !rootKey) return false;
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}/`);
}
