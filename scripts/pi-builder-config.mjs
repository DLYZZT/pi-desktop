import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedPiPackaging } from "./pi-packaging.mjs";

/** Loaded by electron-builder.yml for every local and CI packaging entrypoint. */
export default function piBuilderConfig({
  projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
} = {}) {
  return { files: installedPiPackaging(projectDir).files };
}
