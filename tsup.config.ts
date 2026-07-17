import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      main: "src/main/main.ts",
    },
    format: ["cjs"],
    platform: "node",
    target: "node22",
    outDir: "out/main",
    clean: true,
    sourcemap: true,
    external: ["electron"],
    splitting: false,
    treeshake: true,
    outExtension() {
      return { js: ".js" };
    },
  },
  {
    // ESM — pi-coding-agent only exports "import" condition
    entry: {
      "agent-host": "src/agent-host/index.ts",
    },
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "out/main",
    clean: false,
    sourcemap: true,
    external: [
      "electron",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-tui",
      // Keep the adjacent silk.wasm asset resolvable from the packaged dependency.
      "silk-wasm",
    ],
    splitting: false,
    treeshake: true,
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
    clean: true,
    sourcemap: true,
    external: ["electron"],
    splitting: false,
    treeshake: true,
    outExtension() {
      return { js: ".js" };
    },
  },
]);
