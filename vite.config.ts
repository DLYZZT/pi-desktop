import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};

function readPiVersion(): string {
  const candidates = [
    path.resolve(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json"),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const piPkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (piPkg.version) return piPkg.version;
    } catch {
      /* try next */
    }
  }
  return "0.80.0";
}

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  plugins: [react()],
  base: "./",
  envPrefix: ["VITE_"],
  define: {
    // Guard any accidental process.env.* left in migrated Next.js code
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(pkg.version),
    "process.env.NEXT_PUBLIC_PI_VERSION": JSON.stringify(readPiVersion()),
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
