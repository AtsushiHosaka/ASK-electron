import type { ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  children: string;
}

export const MarkdownMessage = ({ children }: MarkdownMessageProps): ReactElement => (
  <div className="markdown-message">
    <ReactMarkdown rehypePlugins={[rehypeHighlight]} remarkPlugins={[remarkGfm]} skipHtml>
      {children}
    </ReactMarkdown>
  </div>
);
