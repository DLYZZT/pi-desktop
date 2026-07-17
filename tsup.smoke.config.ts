import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/smoke/main.ts",
  },
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: ".artifacts/smoke",
  clean: true,
  sourcemap: true,
  external: ["electron", "electron-updater"],
  splitting: false,
  treeshake: true,
  outExtension() {
    return { js: ".js" };
  },
});
