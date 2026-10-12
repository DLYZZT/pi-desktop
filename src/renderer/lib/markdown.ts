import { useEffect, useMemo, useState } from "react";
import {
  collectMarkdownFeatures,
  createMarkdownRehypePlugins,
  markdownRemarkPlugins,
  type MarkdownFeatures,
  type OptionalMarkdownPlugins,
} from "@shared/markdown";

export * from "@shared/markdown";

const loaded: OptionalMarkdownPlugins = {};
let mathPromise: Promise<void> | undefined;
let htmlPromise: Promise<void> | undefined;

export async function loadMarkdownPlugins(features: MarkdownFeatures): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (features.math && !loaded.katex) {
    mathPromise ??= import("./markdown-math")
      .then(({ default: katex }) => {
        loaded.katex = katex;
      })
      .catch((error) => {
        mathPromise = undefined;
        throw error;
      });
    tasks.push(mathPromise);
  }
  if (features.html && !loaded.raw) {
    htmlPromise ??= import("rehype-raw")
      .then(({ default: raw }) => {
        loaded.raw = raw;
      })
      .catch((error) => {
        htmlPromise = undefined;
        throw error;
      });
    tasks.push(htmlPromise);
  }
  await Promise.all(tasks);
}

export function useMarkdownPlugins(markdown: string) {
  const [plugins, setPlugins] = useState<OptionalMarkdownPlugins>(() => ({ ...loaded }));
  const rehypePlugins = useMemo(() => createMarkdownRehypePlugins(plugins), [plugins]);
  const detection = useMemo(() => {
    const features: MarkdownFeatures = { math: false, html: false };
    if (!markdown) return { features, remarkPlugins: markdownRemarkPlugins };
    return {
      features,
      remarkPlugins: [
        ...(markdownRemarkPlugins ?? []),
        () => (tree: Parameters<typeof collectMarkdownFeatures>[0]) => collectMarkdownFeatures(tree, features),
      ],
    };
    // Each source gets a fresh collector. The child Markdown parser fills it
    // before the effect runs; long streaming previews never enter the parser.
  }, [markdown]);

  useEffect(() => {
    const { features } = detection;
    if ((!features.math || plugins.katex) && (!features.html || plugins.raw)) return;
    let disposed = false;
    void loadMarkdownPlugins(features)
      .then(() => {
        if (!disposed) setPlugins({ ...loaded });
      })
      .catch((error) => console.error("[pi-desktop] failed to load Markdown plugins:", error));
    return () => {
      disposed = true;
    };
  }, [detection, plugins]);

  return { remarkPlugins: detection.remarkPlugins, rehypePlugins };
}
