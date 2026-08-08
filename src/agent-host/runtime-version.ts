import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ResolveEntry = (specifier: string) => string;

export function readPiRuntimeVersion(
  resolveEntry: ResolveEntry = (specifier) => import.meta.resolve(specifier),
): string {
  const entry = fileURLToPath(resolveEntry("@earendil-works/pi-coding-agent"));
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(directory, "package.json");
    try {
      const packageJson = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (packageJson.name === "@earendil-works/pi-coding-agent" && packageJson.version) {
        return packageJson.version;
      }
    } catch {
      // Continue towards the package root. Export maps commonly block direct
      // package.json resolution, while the public ESM entry remains resolvable.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Unable to resolve the Pi runtime package version from its exported ESM entry");
}
