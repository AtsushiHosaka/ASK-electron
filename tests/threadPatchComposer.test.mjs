import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const threadDetailSource = readFileSync(
  "src/renderer/src/features/threads/ThreadDetailPage.tsx",
  "utf8"
);

describe("patch authoring UI", () => {
  it("keeps patch authoring controls out of the conversation surface", () => {
    assert.doesNotMatch(threadDetailSource, /teacher-patch-composer/);
    assert.doesNotMatch(threadDetailSource, /先生パッチ提案/);
    assert.doesNotMatch(threadDetailSource, /AIでパッチ案を追加/);
    assert.doesNotMatch(threadDetailSource, /パッチ案を会話に追加/);
  });

  it("keeps existing patch review behind message detail only", () => {
    const messageDetailStart = threadDetailSource.indexOf("const MessageDetailModal =");
    const patchReviewStart = threadDetailSource.indexOf("const PatchReviewPanel =");

    assert.ok(messageDetailStart >= 0);
    assert.ok(patchReviewStart > messageDetailStart);

    const messageDetailBlock = threadDetailSource.slice(messageDetailStart, patchReviewStart);
    const patchReviewUsages = threadDetailSource.match(/<PatchReviewPanel/g) ?? [];

    assert.equal(patchReviewUsages.length, 1);
    assert.match(messageDetailBlock, /message\.message_type === "patch"/);
    assert.match(messageDetailBlock, /<PatchReviewPanel/);
    assert.match(threadDetailSource.slice(patchReviewStart), /aria-label="変更適用確認"/);
  });
});
