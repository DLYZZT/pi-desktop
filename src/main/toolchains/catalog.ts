import fs from "node:fs";
import path from "node:path";
import {
  parseRuntimeCatalog,
  type RuntimeCatalog,
  type RuntimeCatalogComponent,
  type RuntimeCatalogVariant,
} from "../../shared/toolchains/catalog-schema.ts";
import type { ManagedComponentId } from "../../shared/toolchains/types.ts";

export function loadRuntimeCatalog(catalogPath: string): RuntimeCatalog {
  if (!path.isAbsolute(catalogPath)) throw new Error("Toolchain catalog path must be absolute");
  const raw = fs.readFileSync(catalogPath, "utf8");
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("Toolchain catalog is too large");
  return parseRuntimeCatalog(JSON.parse(raw));
}

export function resolveRuntimeCatalogPath(options: {
  isPackaged: boolean;
  resourcesRoot: string;
  applicationRoot?: string;
}): string {
  return options.isPackaged
    ? path.join(options.resourcesRoot, "toolchains", "runtime-catalog.json")
    : path.join(options.applicationRoot ?? process.cwd(), "build", "toolchains", "runtime-catalog.json");
}

export function findCatalogComponent(
  catalog: RuntimeCatalog,
  componentId: ManagedComponentId,
  version?: string,
): RuntimeCatalogComponent {
  const component = catalog.components.find(
    (entry) => entry.id === componentId && (version === undefined || entry.version === version),
  );
  if (!component) throw new Error(`Managed component is unavailable in this release: ${componentId}`);
  return component;
}

export function findCatalogVariant(
  component: RuntimeCatalogComponent,
  platform: NodeJS.Platform,
  arch: string,
): RuntimeCatalogVariant {
  const variant = component.variants.find((entry) => entry.platform === platform && entry.arch === arch);
  if (!variant) throw new Error(`Managed component is unavailable for ${platform}-${arch}: ${component.id}`);
  return variant;
}
