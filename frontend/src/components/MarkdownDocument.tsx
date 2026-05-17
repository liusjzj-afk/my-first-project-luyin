import { isValidElement, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { hashString, loadMermaid } from "../utils/mermaid";
import { stripSectionMarkers } from "../utils/markdown";

export function MarkdownDocument({ content }: { content: string }) {
  return (
    <article className="markdown-card prose prose-slate max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: MarkdownPre, code: MarkdownCode }}>
        {stripSectionMarkers(content)}
      </ReactMarkdown>
    </article>
  );
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  if (isValidElement<{ className?: string }>(child) && child.props.className?.includes("language-mermaid")) {
    return <>{children}</>;
  }
  return <pre>{children}</pre>;
}

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const language = /language-(\w+)/.exec(className || "")?.[1];
  const code = String(children || "").replace(/\n$/, "");
  if (language === "mermaid") {
    return <MermaidDiagram chart={code} />;
  }
  return <code className={className}>{children}</code>;
}

function MermaidDiagram({ chart }: { chart: string }) {
  const reactId = useId();
  const diagramId = useMemo(() => `meeting-ia-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}-${hashString(chart)}`, [chart, reactId]);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const source = chart.trim();
    let isCancelled = false;

    if (!source) {
      setSvg("");
      setError("图表内容为空");
      return undefined;
    }

    setSvg("");
    setError("");

    void loadMermaid()
      .then((mermaidApi) => mermaidApi.render(diagramId, source))
      .then((result) => {
        if (isCancelled) return;
        setSvg(result.svg);
      })
      .catch((renderError: unknown) => {
        if (isCancelled) return;
        setError(renderError instanceof Error ? renderError.message : "Mermaid 图表渲染失败");
      });

    return () => {
      isCancelled = true;
    };
  }, [chart, diagramId]);

  return (
    <div className="mermaid-panel" role="img" aria-label="信息架构图">
      <div className="mermaid-panel-chrome" aria-hidden="true">
        <span />
        <span />
        <span />
        <strong>IA RENDER</strong>
      </div>
      {error ? (
        <pre className="mermaid-error">{error}</pre>
      ) : svg ? (
        <div className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="mermaid-loading">图表渲染中...</div>
      )}
    </div>
  );
}
