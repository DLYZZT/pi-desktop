import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};
const expectedPiVersion = packageJson.dependencies?.["@earendil-works/pi-coding-agent"];
if (!expectedPiVersion || !/^\d+\.\d+\.\d+$/.test(expectedPiVersion)) {
  throw new Error("@earendil-works/pi-coding-agent must be an exact dependency");
}
const piVersionDefine = {
  "process.env.PI_DESKTOP_EXPECTED_PI_VERSION": JSON.stringify(expectedPiVersion),
};

// The three watch instances run concurrently and share the out/ tree, so:
// - each must ignore build output, otherwise writing main.js / agent-host.mjs
//   from one instance triggers a rebuild in the others; and
// - none of them may clean their outDir while watching, otherwise a clean:true
//   instance wipes the artifacts a sibling instance is building and Electron
//   fails with "Cannot find module out/main/main.js".
// The initial (non-watch) build in scripts/dev.mjs removes out/ beforehand.
const ignoreWatch = ["**/out/**", "**/.git/**", "**/node_modules/**"];

export default defineConfig([
  {
    entry: {
      main: "src/main/main.ts",
    },
    format: ["cjs"],
    platform: "node",
    target: "node22",
    outDir: "out/main",
    clean: false,
    ignoreWatch,
    sourcemap: true,
    // electron-updater is a production runtime dependency and resolves its
    // provider/platform implementation dynamically from the packaged app.
    external: ["electron", "electron-updater"],
    splitting: false,
    treeshake: true,
    define: piVersionDefine,
    outExtension() {
      return { js: ".js" };
    },
  },
  {
    // ESM — pi-coding-agent only exports "import" condition
    entry: {
      "agent-host": "src/agent-host/index.ts",
      "plugin-worker": "src/agent-host/plugin-worker.ts",
    },
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "out/main",
    clean: false,
    ignoreWatch,
    sourcemap: true,
    external: [
      "electron",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-tui",
      // Keep the adjacent silk.wasm asset resolvable from the packaged dependency.
      "silk-wasm",
      // undici uses dynamic require() internally, which breaks when inlined
      // into an ESM bundle; it already ships with pi-coding-agent's runtime.
      "undici",
    ],
    splitting: false,
    treeshake: true,
    define: piVersionDefine,
    banner: {
      // utilityProcess doesn't set import.meta.url the same way; help CJS interop
      js: "",
    },
    outExtension() {
      return { js: ".mjs" };
    },
  },
  {
    entry: {
      preload: "src/preload/preload.ts",
    },
    format: ["cjs"],
    platform: "browser",
    target: "es2022",
    outDir: "out/preload",
    clean: false,
    ignoreWatch,
    sourcemap: true,
    external: ["electron"],
    splitting: false,
    treeshake: true,
    outExtension() {
      return { js: ".js" };
    },
  },
]);
