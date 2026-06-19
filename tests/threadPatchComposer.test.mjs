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
    assert.match(threadDetailSource, /const PatchReviewPanel/);
    assert.match(threadDetailSource, /message\.message_type === "patch"/);
    assert.match(threadDetailSource, /aria-label="変更適用確認"/);
  });
});
