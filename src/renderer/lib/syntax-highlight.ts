/**
 * Shared Prism highlighter that keeps the full language compatibility of the
 * original `Prism` export while moving refractor/all into an async chunk.
 */
import { createElement, type ComponentProps } from "react";
import { PrismAsync } from "react-syntax-highlighter";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";

import { normalizePrismLanguage } from "./syntax-highlight-data";

type SyntaxHighlighterProps = ComponentProps<typeof PrismAsync>;
type AsyncPrismHighlighter = typeof PrismAsync & { preload(): Promise<unknown> };

function SyntaxHighlighter({ language, ...props }: SyntaxHighlighterProps) {
  return createElement(PrismAsync, { ...props, language: normalizePrismLanguage(language) });
}

/** Exposed for the real-module SSR test; the app loads this automatically on mount. */
export function preloadSyntaxHighlighter(): Promise<unknown> {
  return (PrismAsync as AsyncPrismHighlighter).preload();
}

export { SyntaxHighlighter, vs, vscDarkPlus };
