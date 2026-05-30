import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const threadDetailSource = readFileSync(
  "src/renderer/src/features/threads/ThreadDetailPage.tsx",
  "utf8"
);

describe("thread detail lifecycle controls", () => {
  it("offers every MVP status through teacher and admin controls", () => {
    assert.match(
      threadDetailSource,
      /const threadStatuses: ThreadStatus\[\] = \[[\s\S]*"open"[\s\S]*"in_progress"[\s\S]*"waiting_student"[\s\S]*"patch_proposed"[\s\S]*"resolved"[\s\S]*"reopened"[\s\S]*\]/
    );
    assert.match(
      threadDetailSource,
      /profile\?\.role === "teacher" \|\| profile\?\.role === "admin"/
    );
    assert.match(
      threadDetailSource,
      /value=\{state\.thread\.status\}[\s\S]*updateThreadLifecycleStatus\(event\.target\.value as ThreadStatus\)/
    );
  });

  it("limits student lifecycle controls to their own resolved and reopened transitions", () => {
    assert.match(
      threadDetailSource,
      /const studentLifecycleStatuses: ThreadStatus\[\] = \["resolved", "reopened"\]/
    );
    assert.match(
      threadDetailSource,
      /profile\?\.role === "student" && state\.thread\?\.created_by === profile\.id/
    );
    assert.match(threadDetailSource, /studentLifecycleStatuses\.includes\(nextStatus\)/);
    assert.match(threadDetailSource, />\s*解決済みにする\s*<\/button>/);
    assert.match(threadDetailSource, />\s*再オープンする\s*<\/button>/);
  });

  it("persists status changes and records a chat-visible history message", () => {
    assert.match(
      threadDetailSource,
      /const updateThreadLifecycleStatus = async \(nextStatus: ThreadStatus\): Promise<void> =>/
    );
    assert.match(
      threadDetailSource,
      /\.from\("threads"\)[\s\S]*\.update\(\{\s*status: nextStatus,\s*updated_at: changedAt\s*\}/
    );
    assert.match(
      threadDetailSource,
      /\.from\("messages"\)[\s\S]*ステータスを「\$\{statusLabels\[previousThread\.status\]\}」から「\$\{statusLabels\[nextStatus\]\}」に変更しました。/
    );
    assert.match(
      threadDetailSource,
      /status: previousThread\.status,[\s\S]*updated_at: previousThread\.updated_at/
    );
    assert.match(threadDetailSource, /messages: lifecycleHistoryMessage/);
  });
});
