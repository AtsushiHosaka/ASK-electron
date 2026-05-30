import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const threadDetailSource = readFileSync(
  "src/renderer/src/features/threads/ThreadDetailPage.tsx",
  "utf8"
);

describe("teacher patch composer wiring", () => {
  it("keeps the composer behind the teacher role guard", () => {
    assert.match(threadDetailSource, /profile\?\.role === "teacher" \? \(/);
    assert.match(threadDetailSource, /<h2>先生パッチ提案<\/h2>/);
  });

  it("validates drafts before persisting teacher proposals", () => {
    assert.match(threadDetailSource, /const parsed = validatePatchProposalDraft\(/);
    assert.match(threadDetailSource, /送信前に diff を確認してください/);
  });

  it("stores teacher proposals as proposed patch messages without local apply", () => {
    assert.match(threadDetailSource, /created_by_type: "teacher"[\s\S]*status: "proposed"/);
    assert.match(threadDetailSource, /message_type: "patch"/);
    assert.match(threadDetailSource, /生徒のローカル環境には直接適用されません/);
  });
});
