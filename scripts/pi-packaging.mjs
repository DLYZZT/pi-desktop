import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
    if (manifest.name === "@earendil-works/pi-schema") {
      for (const entry of ["README.md", "dist/formats/index.d.ts", "LICENSES/typebox-LICENSE"])
        required.add(`${root}/${entry}`);
    }
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
        ...(nested
          ? [
              "package.json",
              "dist/**/*.js",
              "dist/**/*.mjs",
              "dist/**/*.json",
              "native/**/*",
              "LICENSE",
              "LICENSES/**/*",
            ]
          : []),
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
  validatePiNotices({
    graph,
    readPackage,
    readFile: (entry) => readFileSync(path.join(projectRoot, entry), "utf8"),
    notice: readFileSync(path.join(projectRoot, "THIRD_PARTY_NOTICES.md"), "utf8"),
  });
  const typeboxRoot = resolvePackage("", "typebox", exists);
  const files = [
    ...createPiAuthoringFileSets({ graph, readPackage }),
    { from: typeboxRoot, to: typeboxRoot, filter: ["build/**/*.d.ts", "build/**/*.d.mts", "build/**/*.d.cts"] },
  ];
  assertFileSetSources(projectRoot, files);
  return { graph, files };
}

/** Check both declared attribution and the complete vendored license in the actual resolved package. */
export function validatePiNotices({ graph, readPackage, readFile, notice }) {
  const rows = notice.split(/\r?\n/u).map((line) => line.split("|").map((cell) => cell.trim()));
  for (const root of graph.keys()) {
    const { name, version } = readPackage(`${root}/package.json`);
    const row = rows.find((cells) => cells[1] === `\`${name}\``);
    if (
      !row ||
      row[2] !== version ||
      !row[4]?.includes(`https://github.com/earendil-works/pi/blob/v${version}/LICENSE`) ||
      !row[5]?.includes(`https://github.com/earendil-works/pi/tree/v${version}`)
    )
      throw new Error(`Pi third-party notice is missing or stale: ${name} ${version}`);
    if (name === "@earendil-works/pi-schema") {
      const license = readFile(`${root}/LICENSES/typebox-LICENSE`).replace(/\r\n/gu, "\n").trim();
      if (
        createHash("sha256").update(license).digest("hex") !==
        "e8a7cc256941a26ba8234f04390165243a4d42f74fd6491934140605bf7eae2d"
      )
        throw new Error("Pi schema TypeBox license text is missing or changed");
      if (
        !notice.includes("Copyright (c) 2017-2026 Haydn Paterson") ||
        !notice.includes(
          `https://github.com/earendil-works/pi/blob/v${version}/packages/schema/LICENSES/typebox-LICENSE`,
        )
      )
        throw new Error("Pi schema TypeBox attribution is missing or stale");
    }
  }
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
