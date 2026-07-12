import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/smoke/main.ts",
  },
  format: ["cjs"],
  platform: "node",
  target: "node20",
  outDir: ".artifacts/smoke",
  clean: true,
  sourcemap: true,
  external: ["electron"],
  splitting: false,
  treeshake: true,
  outExtension() {
    return { js: ".js" };
  },
});
