import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";

export async function resolveModelCredentialPath(filename: string): Promise<string> {
  try {
    // Pi's file store locks the resolved file. Commit to that path as well so rename preserves the link.
    return await realpath(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entry = await lstat(filename).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    });
    if (!entry?.isSymbolicLink()) return filename;
    // A dangling link can name a store that has yet to be created.
    const target = await readlink(filename);
    const directory = await realpath(path.dirname(filename));
    return resolveModelCredentialPath(path.resolve(directory, target));
  }
}
