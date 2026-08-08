import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
};

function readPiVersion(): string {
  const packagePath = path.resolve(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  const expected = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
  if (!expected || !/^\d+\.\d+\.\d+$/.test(expected)) {
    throw new Error("@earendil-works/pi-coding-agent must be an exact dependency");
  }
  if (!existsSync(packagePath)) {
    throw new Error(`Missing installed Pi package: ${packagePath}`);
  }
  const piPkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  if (piPkg.version !== expected) {
    throw new Error(`Installed Pi version ${piPkg.version ?? "unknown"} does not match package.json ${expected}`);
  }
  return piPkg.version;
}

const piVersion = readPiVersion();

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  plugins: [react()],
  base: "./",
  envPrefix: ["VITE_"],
  define: {
    // Renderer version constants. Keep these aligned with app-version.ts.
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
    "import.meta.env.VITE_PI_VERSION": JSON.stringify(piVersion),
    // Guard any accidental process.env.* left in migrated Next.js code
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(pkg.version),
    "process.env.NEXT_PUBLIC_PI_VERSION": JSON.stringify(piVersion),
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
      "@contract": path.resolve(__dirname, "src/contract"),
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, "out/renderer"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
