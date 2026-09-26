import { RpcError } from "../contract/types";
import { getAllowedFileRoots, isFilePathAllowed } from "./file-access";
import { isFilePathReferencedBySession } from "./session-file-references";

export async function assertPathAllowed(target: string, sourceSessionId?: string): Promise<void> {
  const allowed = await getAllowedFileRoots();
  if (isFilePathAllowed(target, allowed)) return;
  if (sourceSessionId && (await isFilePathReferencedBySession(target, sourceSessionId))) return;
  throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
}
