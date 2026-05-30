import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const threadDetailSource = readFileSync(
  "src/renderer/src/features/threads/ThreadDetailPage.tsx",
  "utf8"
);

describe("thread AI escalation flow", () => {
  it("keeps escalation behind the student owner guard", () => {
    assert.match(
      threadDetailSource,
      /const canEscalateAiToTeacher =[\s\S]*profile\?\.role === "student" && state\.thread\?\.created_by === profile\.id/
    );
    assert.match(threadDetailSource, /先生にエスカレーション/);
    assert.match(threadDetailSource, /先生への確認メモ/);
  });

  it("builds a teacher-visible AI context message instead of a final answer", () => {
    assert.match(threadDetailSource, /const buildAiEscalationMessageBody = \(\): string =>/);
    assert.match(threadDetailSource, /## 先生へのエスカレーション/);
    assert.match(threadDetailSource, /## AI補助コンテキスト/);
    assert.match(threadDetailSource, /## 直近AIエラー/);
    assert.match(
      threadDetailSource,
      /AI 出力は補助情報です。確定回答ではなく、先生が確認してから判断してください。/
    );
  });

  it("requires send-before-preview and secret scanning before inserting the escalation", () => {
    assert.match(threadDetailSource, /const openAiEscalationReview = \(\): void =>/);
    assert.match(threadDetailSource, /送信前プレビューで内容を確認してください。/);
    assert.match(
      threadDetailSource,
      /const aiEscalationSecretScan = scanSecrets\(\{[\s\S]*label: "AIエスカレーション本文"[\s\S]*allowedFindingIds: aiEscalationAllowedFindingIds/
    );
    assert.match(
      threadDetailSource,
      /aiEscalationSecretScan\.blocked \|\| aiEscalationSecretScan\.hasWarnings/
    );
    assert.match(threadDetailSource, /setAiEscalationFindingAllowed/);
  });

  it("persists escalation as ai_summary and reopens teacher-visible thread states", () => {
    assert.match(
      threadDetailSource,
      /const submitAiEscalationToTeacher = async \(\): Promise<void>/
    );
    assert.match(
      threadDetailSource,
      /status === "resolved" \|\| status === "waiting_student" \|\| status === "patch_proposed"[\s\S]*return "reopened"/
    );
    assert.match(
      threadDetailSource,
      /\.from\("threads"\)[\s\S]*\.update\(\{\s*status: nextStatus,\s*ai_used: true,\s*updated_at: changedAt\s*\}/
    );
    assert.match(
      threadDetailSource,
      /\.from\("messages"\)[\s\S]*sender_type: "student"[\s\S]*message_type: "ai_summary"/
    );
  });
});
