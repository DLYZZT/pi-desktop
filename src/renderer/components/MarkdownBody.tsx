import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ImgHTMLAttributes,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { SyntaxHighlighter, vs, vscDarkPlus } from "@/lib/syntax-highlight";
import { useTheme } from "@/hooks/useTheme";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { resolveLocalFileHref } from "@/lib/file-links";
import { markdownRehypePlugins, markdownRemarkPlugins } from "@/lib/markdown";
import { shouldHighlightCode } from "@/lib/code-highlight-policy";
import { mermaidCacheKey, renderMermaidSvg } from "@/lib/mermaid-renderer";
import { SessionProfiler } from "./SessionProfiler";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  imageBasePath?: string;
  sourceSessionId?: string | null;
  onOpenFile?: (filePath: string) => void;
}

type MarkdownRenderContextValue = Pick<
  MarkdownBodyProps,
  "isStreaming" | "cwd" | "imageBasePath" | "sourceSessionId" | "onOpenFile"
>;

const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({});

type MarkdownComponentProps<Tag extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[Tag] & {
  node?: unknown;
};

function MarkdownCode({ className, children, node: _node, ...props }: MarkdownComponentProps<"code">) {
  const { isStreaming } = useContext(MarkdownRenderContext);
  const lang = className?.replace("language-", "").toLowerCase() ?? "";
  const raw = String(children);
  const isBlock = className?.includes("language-") || raw.includes("\n");
  if (isBlock) {
    if (lang === "mermaid") {
      return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
    }
    return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
  }
  return (
    <code className="markdown-inline-code" {...props}>
      {children}
    </code>
  );
}

function MarkdownPre({ children }: MarkdownComponentProps<"pre">) {
  return <>{children}</>;
}

function MarkdownAnchor({ href, children, node: _node, ...props }: MarkdownComponentProps<"a">) {
  const { cwd, onOpenFile } = useContext(MarkdownRenderContext);
  const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
  if (!filePath || !onOpenFile) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.currentTarget.getAttribute("target");
    if (target && target !== "_self") return;
    event.preventDefault();
    onOpenFile(filePath);
  };

  return (
    <a href={href} {...props} onClick={handleClick}>
      {children}
    </a>
  );
}

function MarkdownImg({ src, alt, node: _node, ...props }: MarkdownComponentProps<"img">) {
  const { cwd, imageBasePath, sourceSessionId } = useContext(MarkdownRenderContext);
  return (
    <MarkdownImage
      src={src}
      alt={alt}
      cwd={cwd}
      relativeBase={imageBasePath ?? cwd}
      sourceSessionId={sourceSessionId}
      {...props}
    />
  );
}

function MarkdownTable({ children }: MarkdownComponentProps<"table">) {
  return (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  );
}

const markdownComponents: Components = {
  code: MarkdownCode,
  pre: MarkdownPre,
  a: MarkdownAnchor,
  img: MarkdownImg,
  table: MarkdownTable,
};

export function MarkdownBody({
  children,
  className,
  isStreaming,
  cwd,
  imageBasePath,
  sourceSessionId,
  onOpenFile,
}: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  const renderContext = useMemo(
    () => ({ isStreaming, cwd, imageBasePath, sourceSessionId, onOpenFile }),
    [cwd, imageBasePath, isStreaming, onOpenFile, sourceSessionId],
  );

  return (
    <SessionProfiler id="MarkdownBody">
      <MarkdownRenderContext.Provider value={renderContext}>
        <div className={["markdown-body", className].filter(Boolean).join(" ")}>
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={markdownComponents}
          >
            {normalizedMarkdown}
          </ReactMarkdown>
        </div>
      </MarkdownRenderContext.Provider>
    </SessionProfiler>
  );
}

export function getMarkdownComponentIdentityForTest(): Components {
  return markdownComponents;
}

function MarkdownImage({
  src,
  alt,
  cwd,
  relativeBase,
  sourceSessionId,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  cwd?: string;
  relativeBase?: string;
  sourceSessionId?: string | null;
}) {
  const localPath = useMemo(
    () => resolveLocalFileHref(typeof src === "string" ? src : undefined, cwd, relativeBase),
    [cwd, relativeBase, src],
  );
  const [previewSrc, setPreviewSrc] = useState<string | null>(localPath ? null : typeof src === "string" ? src : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!localPath) {
      setPreviewSrc(typeof src === "string" ? src : null);
      setFailed(false);
      return;
    }

    let disposed = false;
    let revoke: (() => void) | null = null;
    setPreviewSrc(null);
    setFailed(false);

    void import("@/lib/file-blob")
      .then(({ fileToObjectUrl }) => fileToObjectUrl(localPath, sourceSessionId))
      .then((result) => {
        if (disposed) {
          result.revoke();
          return;
        }
        revoke = result.revoke;
        setPreviewSrc(result.url);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      revoke?.();
    };
  }, [localPath, sourceSessionId, src]);

  if (failed) {
    return (
      <span className="markdown-image-error" title={localPath ?? undefined}>
        {alt || "Image failed to load"}
      </span>
    );
  }

  if (!previewSrc) {
    return <span className="markdown-image-loading" aria-label={alt || "Loading image"} />;
  }

  return <img src={previewSrc} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" {...props} />;
}

function normalizeDisplayMath(markdown: string): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  let fence: { marker: string; size: number } | null = null;

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        const size = fenceMatch[1].length;
        if (!fence) fence = { marker, size };
        else if (marker === fence.marker && size >= fence.size) fence = null;
        return line;
      }

      if (fence) return line;

      const displayMathMatch = line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/);
      if (!displayMathMatch) return line;

      const math = displayMathMatch[2].trim();
      if (!math) return line;

      return `${displayMathMatch[1]}$$${lineBreak}${math}${lineBreak}${displayMathMatch[1]}$$`;
    })
    .join(lineBreak);
}

function MermaidBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const { isDark } = useTheme();
  const [showPreview, setShowPreview] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [renderedKey, setRenderedKey] = useState("");
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const currentKey = mermaidCacheKey(code, isDark);

  useEffect(() => {
    if (!showPreview || isStreaming) return;

    let cancelled = false;
    setFailedKey(null);

    const render = async () => {
      const rendered = await renderMermaidSvg(code, isDark);
      if (!cancelled) {
        setSvg(rendered);
        setRenderedKey(currentKey);
      }
    };

    render().catch(() => {
      if (!cancelled) setFailedKey(currentKey);
    });

    return () => {
      cancelled = true;
    };
  }, [code, currentKey, isDark, isStreaming, showPreview]);

  const previewButton = (
    <button
      onClick={() => setShowPreview((v) => !v)}
      disabled={isStreaming}
      title={
        isStreaming
          ? "Preview available after streaming"
          : showPreview
            ? "Show Mermaid source"
            : "Preview Mermaid diagram"
      }
      className={["markdown-code-action", showPreview ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {showPreview ? "Source" : "Preview"}
    </button>
  );

  if (!showPreview || isStreaming) {
    return <CodeBlock code={code} lang="mermaid" headerAction={previewButton} />;
  }

  const body =
    failedKey === currentKey ? (
      <div className="mermaid-block mermaid-block-error">Invalid Mermaid diagram</div>
    ) : !svg || renderedKey !== currentKey ? (
      <div className="mermaid-block mermaid-block-loading" aria-label="Rendering Mermaid diagram" />
    ) : (
      <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />
    );

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">mermaid</span>
        {previewButton}
      </div>
      {body}
    </div>
  );
}

function CodeBlock({ code, lang, headerAction }: { code: string; lang: string; headerAction?: ReactNode }) {
  const { isDark } = useTheme();
  const { copied, copy } = useCopyFeedback();

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang || "text"}</span>
        <div className="markdown-code-actions">
          {headerAction}
          <button onClick={() => void copy(code)} className="markdown-code-action">
            {copied ? "copied" : "copy"}
          </button>
        </div>
      </div>
      {shouldHighlightCode(code) ? (
        <SyntaxHighlighter
          language={lang || "text"}
          style={isDark ? vscDarkPlus : vs}
          showLineNumbers
          lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
          customStyle={{
            margin: 0,
            padding: "11px 13px",
            fontSize: 12.5,
            lineHeight: 1.62,
            borderRadius: 0,
            background: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
        >
          {code}
        </SyntaxHighlighter>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: "11px 13px",
            fontSize: 12.5,
            lineHeight: 1.62,
            overflow: "auto",
            whiteSpace: "pre",
            fontFamily: "var(--font-mono)",
            background: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
          }}
        >
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
