import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  PI_RUNTIME_ROOTS,
  resolvePackage,
  validatePiPackageGraph,
  validatePiRuntimeAssets,
} from "./pi-runtime-contract.mjs";

const authoringDocuments = ["README.md", "CHANGELOG.md", "docs/sdk.md", "docs/extensions.md", "docs/codemode.md"];

/** Required public assets are located through the same graph as runtime imports. */
export function validatePiAuthoringAssets({ graph, readPackage, exists, platform, arch }) {
  const required = new Set();
  for (const root of graph.keys()) {
    const manifest = readPackage(`${root}/package.json`);
    const types = manifest.exports?.["."]?.types ?? manifest.types;
    if (typeof types === "string") required.add(path.posix.normalize(`${root}/${types}`));
    if (manifest.name === "@earendil-works/pi-coding-agent") {
      for (const entry of authoringDocuments) required.add(`${root}/${entry}`);
    }
    if (manifest.name === "@earendil-works/pi-ai") required.add(`${root}/dist/providers/data/amazon-bedrock.json`);
    if (manifest.name === "@earendil-works/pi-tui" && platform && arch) {
      const filename = {
        darwin: "darwin-platform.node",
        win32: "win32-platform.node",
        linux: "linux-platform-x11.node",
      }[platform];
      if (!filename) throw new Error(`Unsupported Pi native platform: ${platform}`);
      required.add(`${root}/native/${platform}/prebuilds/${platform}-${arch}/${filename}`);
    }
  }
  for (const entry of required) if (!exists(entry)) throw new Error(`Pi authoring/native asset is missing: ${entry}`);
  return required;
}

/** Preserve public declarations without recreating metadata-only shadow packages after ASAR hoisting. */
export function createPiAuthoringFileSets({ graph, readPackage }) {
  return [...graph.keys()].map((root) => {
    const manifest = readPackage(`${root}/package.json`);
    const nested = root.includes("/node_modules/");
    return {
      from: root,
      to: root,
      filter: [
        "README.md",
        "CHANGELOG.md",
        "dist/**/*.d.ts",
        "dist/**/*.d.mts",
        "dist/**/*.d.cts",
        ...(manifest.name === "@earendil-works/pi-coding-agent" ? ["docs/**/*", "examples/**/*"] : []),
        // A nested declaration directory shadows the hoisted root package. It needs the complete runtime.
        ...(nested ? ["package.json", "dist/**/*.js", "dist/**/*.mjs", "dist/**/*.json", "native/**/*"] : []),
      ],
    };
  });
}

/** electron-builder silently skips missing FileSet sources; treat them as a packaging error. */
export function assertFileSetSources(projectRoot, files, exists = existsSync) {
  for (const entry of files ?? []) {
    if (entry && typeof entry === "object" && typeof entry.from === "string") {
      if (!exists(path.resolve(projectRoot, entry.from)))
        throw new Error(`Packaging FileSet source is missing: ${entry.from}`);
    }
  }
}

export function installedPiPackaging(projectRoot) {
  const readPackage = (relative) => JSON.parse(readFileSync(path.join(projectRoot, relative), "utf8"));
  const exists = (relative) => existsSync(path.join(projectRoot, relative));
  const version = readPackage("package.json").dependencies?.["@earendil-works/pi-coding-agent"];
  const graph = validatePiPackageGraph({ readPackage, exists, version, rootPackages: PI_RUNTIME_ROOTS });
  validatePiRuntimeAssets({ graph, readPackage, exists });
  validatePiAuthoringAssets({ graph, readPackage, exists });
  const typeboxRoot = resolvePackage("", "typebox", exists);
  const files = [
    ...createPiAuthoringFileSets({ graph, readPackage }),
    { from: typeboxRoot, to: typeboxRoot, filter: ["build/**/*.d.ts", "build/**/*.d.mts", "build/**/*.d.cts"] },
  ];
  assertFileSetSources(projectRoot, files);
  return { graph, files };
}

/** Builder may hoist dependencies; accept only a version actually present in the audited lockfile. */
export function assertLockedPackage(lockfile, root, manifest) {
  const suffix = `node_modules/${manifest.name}`;
  const matches = Object.entries(lockfile.packages ?? {}).filter(
    ([entry]) => entry === suffix || entry.endsWith(`/${suffix}`),
  );
  const locked = lockfile.packages?.[root];
  if (
    locked
      ? locked.version !== manifest.version
      : !matches.some(([, metadata]) => metadata.version === manifest.version)
  ) {
    throw new Error(`Packaged ${manifest.name} at ${root} differs from the lockfile (${manifest.version})`);
  }
}
