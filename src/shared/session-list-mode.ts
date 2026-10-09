/**
 * How the sidebar presents the session list.
 *
 * - `independent`: one project (the selected directory) owns the window
 *   context; its sessions are grouped by date. The historical default.
 * - `aggregated`: every project's sessions are visible at once, grouped by
 *   project; clicking any session moves the window context to its project.
 */
export type SessionListMode = "independent" | "aggregated";

export const DEFAULT_SESSION_LIST_MODE: SessionListMode = "independent";

export function isSessionListMode(value: unknown): value is SessionListMode {
  return value === "independent" || value === "aggregated";
}
