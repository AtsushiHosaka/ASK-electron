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
    assert.match(threadDetailSource, /message\.message_type !== "ai_summary"/);
    assert.match(threadDetailSource, /message\.sender_user_id === profileId/);
    assert.doesNotMatch(threadDetailSource, /className="detail-panel composer-panel"/);
    assert.match(
      stylesSource,
      /\.thread-detail-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
    assert.match(stylesSource, /\.chat-message\.own/);
  });

  it("keeps navigation and manual type labels out of the chat UI", () => {
    assert.match(threadDetailSource, /aria-label="パンくずリスト"/);
    assert.doesNotMatch(threadDetailSource, /manualMessageTypes|メッセージ形式/);
    assert.doesNotMatch(threadDetailSource, /setMessageType|messageTypeLabels/);
    assert.match(threadDetailSource, /messageType: "text"/);
    assert.doesNotMatch(threadDetailSource, /"AI Summary"/);
    assert.match(threadDetailSource, /message\.message_type !== "ai_summary"/);
  });

  it("previews manual replies as markdown while typing", () => {
    assert.match(threadDetailSource, /className="chat-composer-preview"/);
    assert.match(threadDetailSource, /aria-label="返信プレビュー"/);
    assert.match(threadDetailSource, /<MarkdownMessage>\{body\}<\/MarkdownMessage>/);
    assert.match(stylesSource, /\.chat-composer-preview/);
  });

  it("keeps chat rows compact and opens full content in a modal", () => {
    assert.match(threadDetailSource, /buildMessageSummary/);
    assert.match(threadDetailSource, /className="chat-summary-preview"/);
    assert.match(threadDetailSource, /onOpenDetails/);
    assert.match(threadDetailSource, /const MessageDetailModal/);
    assert.match(threadDetailSource, /aria-labelledby="message-detail-title"/);
    assert.match(stylesSource, /\.message-detail-modal/);
    assert.match(stylesSource, /\.message-detail-body\s*\{[\s\S]*overflow:\s*auto/);
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
