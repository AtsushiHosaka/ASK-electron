import { useMemo, useState, type ReactElement, type ReactNode } from "react";

type ViewerKind = "code" | "diff";

interface CodeContextViewerProps {
  content: string;
  kind: ViewerKind;
  language?: string | null;
  maxVisibleLines?: number;
}

type DiffLineKind = "add" | "delete" | "context" | "hunk" | "file";

const codeTokenPattern =
  /(\/\/.*|#.*|\/\*[\s\S]*?\*\/|(["'`])(?:\\.|(?!\2).)*\2|\b(?:const|let|var|function|return|if|else|for|while|await|async|import|export|from|type|interface|class|extends|new|try|catch|throw|def|class|self|None|True|False|echo|export|cd|npm|pnpm|yarn)\b|\b\d+(?:\.\d+)?\b)/g;

const defaultMaxVisibleLines = 180;

const tokenClassName = (token: string): string => {
  if (token.startsWith("//") || token.startsWith("/*") || token.startsWith("#")) {
    return "syntax-comment";
  }

  if (/^["'`]/.test(token)) {
    return "syntax-string";
  }

  if (/^\d/.test(token)) {
    return "syntax-number";
  }

  return "syntax-keyword";
};

const renderHighlightedCode = (source: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of source.matchAll(codeTokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;

    if (index > cursor) {
      nodes.push(source.slice(cursor, index));
    }

    nodes.push(
      <span className={tokenClassName(token)} key={`${index}-${token}`}>
        {token}
      </span>
    );
    cursor = index + token.length;
  }

  if (cursor < source.length) {
    nodes.push(source.slice(cursor));
  }

  return nodes;
};

const classifyDiffLine = (line: string): DiffLineKind => {
  if (line.startsWith("@@")) {
    return "hunk";
  }

  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) {
    return "file";
  }

  if (line.startsWith("+")) {
    return "add";
  }

  if (line.startsWith("-")) {
    return "delete";
  }

  return "context";
};

const diffLabel = (kind: DiffLineKind): string => {
  switch (kind) {
    case "add":
      return "ADD";
    case "delete":
      return "DEL";
    case "hunk":
      return "HUNK";
    case "file":
      return "FILE";
    case "context":
      return "CTX";
  }
};

export const CodeContextViewer = ({
  content,
  kind,
  language,
  maxVisibleLines = defaultMaxVisibleLines
}: CodeContextViewerProps): ReactElement => {
  const lines = useMemo(() => content.replace(/\s+$/, "").split(/\r?\n/), [content]);
  const [expanded, setExpanded] = useState(lines.length <= maxVisibleLines);
  const visibleLines = expanded ? lines : lines.slice(0, maxVisibleLines);
  const hiddenLineCount = Math.max(0, lines.length - visibleLines.length);

  return (
    <div className={`code-context-viewer ${kind}`}>
      <div className="code-context-toolbar">
        <span>{kind === "diff" ? "Diff" : (language ?? "Code")}</span>
        <span>{lines.length} lines</span>
      </div>

      {kind === "diff" ? (
        <pre className="diff-viewer" aria-label="Diff preview">
          {visibleLines.map((line, index) => {
            const lineKind = classifyDiffLine(line);

            return (
              <span className={`diff-line ${lineKind}`} key={`${index}-${line}`}>
                <span className="diff-marker">{line.slice(0, 1) || " "}</span>
                <span className="diff-label">{diffLabel(lineKind)}</span>
                <code>{line}</code>
              </span>
            );
          })}
        </pre>
      ) : (
        <pre className="code-viewer" aria-label="Code preview">
          <code>
            {visibleLines.map((line, index) => (
              <span className="code-line" key={`${index}-${line}`}>
                <span className="line-number">{index + 1}</span>
                <span className="line-code">{renderHighlightedCode(line)}</span>
              </span>
            ))}
          </code>
        </pre>
      )}

      {lines.length > maxVisibleLines ? (
        <button
          className="link-button code-context-toggle"
          type="button"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "折りたたむ" : `すべて表示 (${hiddenLineCount} lines hidden)`}
        </button>
      ) : null}
    </div>
  );
};
