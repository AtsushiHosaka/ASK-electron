import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const threadDetailSource = readFileSync(
  "src/renderer/src/features/threads/ThreadDetailPage.tsx",
  "utf8"
);
const markdownSource = readFileSync("src/renderer/src/components/MarkdownMessage.tsx", "utf8");
const stylesSource = readFileSync("src/renderer/src/styles.css", "utf8");

describe("thread detail chat UI", () => {
  it("keeps replies in the conversation panel instead of a right-side inspector", () => {
    assert.match(threadDetailSource, /className="chat-composer"/);
    assert.match(threadDetailSource, /className="chat-message-list"/);
    assert.match(threadDetailSource, /isOwnMessage=\{message\.sender_user_id === profile\?\.id\}/);
    assert.doesNotMatch(threadDetailSource, /className="detail-panel composer-panel"/);
    assert.match(
      stylesSource,
      /\.thread-detail-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
    assert.match(stylesSource, /\.chat-message\.own/);
  });

  it("renders message text as markdown with syntax highlighting", () => {
    assert.match(markdownSource, /ReactMarkdown/);
    assert.match(markdownSource, /remarkGfm/);
    assert.match(markdownSource, /rehypeHighlight/);
    assert.match(markdownSource, /skipHtml/);
    assert.doesNotMatch(markdownSource, /rehypeRaw|rehype-raw/);
    assert.match(stylesSource, /\.markdown-message pre/);
    assert.match(stylesSource, /\.markdown-message \.hljs/);
  });
});
