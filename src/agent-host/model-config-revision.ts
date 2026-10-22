let revision = 0;

/** Local settings saves invalidate every cwd-bound session runtime without sharing their providers. */
export function markModelConfigChanged(): void {
  revision++;
}

export function getModelConfigRevision(): number {
  return revision;
}
