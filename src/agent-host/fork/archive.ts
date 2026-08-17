import { SESSION_ARCHIVE_CUSTOM_TYPE } from "../../shared/session-archive";

export function forkAppendArchived(
  manager: { appendCustomEntry: (customType: string, data?: unknown) => string },
  archived: boolean,
): void {
  manager.appendCustomEntry(SESSION_ARCHIVE_CUSTOM_TYPE, { archived });
}
