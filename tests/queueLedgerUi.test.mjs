import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const teacherDashboardSource = readFileSync(
  "src/renderer/src/features/teacher/TeacherDashboard.tsx",
  "utf8"
);
const threadCreateSource = readFileSync(
  "src/renderer/src/features/threads/ThreadCreatePage.tsx",
  "utf8"
);

describe("queue ledger UI", () => {
  it("keeps the teacher queue as a list that opens thread detail pages", () => {
    assert.match(teacherDashboardSource, /className="queue-ledger"/);
    assert.match(teacherDashboardSource, /className="queue-ledger-tools"/);
    assert.match(teacherDashboardSource, /className="queue-compact-controls"/);
    assert.match(
      teacherDashboardSource,
      /className="queue-ledger-row"[\s\S]*to=\{`\/threads\/\$\{item\.thread\.id\}`\}/
    );
    assert.doesNotMatch(teacherDashboardSource, /className="queue-thread-card"/);
    assert.doesNotMatch(teacherDashboardSource, /className="queue-status-grid"/);
    assert.doesNotMatch(teacherDashboardSource, /className="queue-toolbar"/);
  });

  it("does not add recent-message or right-inspector previews to the queue", () => {
    assert.doesNotMatch(teacherDashboardSource, /直近のやりとり/);
    assert.doesNotMatch(teacherDashboardSource, /inspector/i);
    assert.doesNotMatch(teacherDashboardSource, /preview/i);
  });
});

describe("question creation long-form fields", () => {
  it("does not cap visible long-form question textareas", () => {
    const threadForm = threadCreateSource.match(
      /<article className="detail-panel thread-form-panel">[\s\S]*?<\/article>/
    )?.[0];

    assert.ok(threadForm);
    assert.doesNotMatch(threadForm, /maxLength=/);
  });
});
