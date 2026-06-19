import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const teacherDashboardSource = readFileSync(
  "src/renderer/src/features/teacher/TeacherDashboard.tsx",
  "utf8"
);
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const projectSource = readFileSync(
  "src/renderer/src/features/projects/ProjectRegistrationPage.tsx",
  "utf8"
);
const studentHomeSource = readFileSync(
  "src/renderer/src/features/student/StudentHomePage.tsx",
  "utf8"
);
const threadCreateSource = readFileSync(
  "src/renderer/src/features/threads/ThreadCreatePage.tsx",
  "utf8"
);
const threadDetailSource = readFileSync(
  "src/renderer/src/features/threads/ThreadDetailPage.tsx",
  "utf8"
);
const stylesSource = readFileSync("src/renderer/src/styles.css", "utf8");

describe("teacher question hierarchy", () => {
  it("removes the standalone teacher question queue from navigation and routes", () => {
    const navMatch = appSource.match(/<nav className="nav-list">([\s\S]*?)<\/nav>/);

    assert.ok(navMatch);
    assert.doesNotMatch(navMatch[1], /質問キュー|\/teacher\/queue/);
    assert.doesNotMatch(appSource, /TeacherQueuePage|path="\/teacher\/queue"/);
    assert.doesNotMatch(teacherDashboardSource, /TeacherQueuePage|質問キュー|queue-ledger/);
    assert.doesNotMatch(stylesSource, /\.queue-/);
  });

  it("keeps class detail organized by project before showing questions", () => {
    assert.match(teacherDashboardSource, /className="detail-panel class-project-thread-panel"/);
    assert.match(teacherDashboardSource, /projectThreadGroups/);
    assert.match(teacherDashboardSource, /<h2>プロジェクト<\/h2>/);
    assert.match(
      teacherDashboardSource,
      /to=\{`\/projects\/\$\{project\.id\}\/threads\/\$\{thread\.id\}`\}/
    );
    assert.doesNotMatch(
      teacherDashboardSource,
      /className="teacher-thread-row"[\s\S]*to=\{`\/threads\/\$\{thread\.id\}`\}/
    );
  });

  it("routes question entry points through project context", () => {
    const sources = [appSource, projectSource, studentHomeSource, threadCreateSource].join("\n");

    assert.match(appSource, /path="\/projects\/:projectId\/threads\/:threadId"/);
    assert.match(sources, /\/projects\/\$\{project\.id\}\/threads\/\$\{thread\.id\}/);
    assert.match(
      threadCreateSource,
      /navigate\(`\/projects\/\$\{selectedProject\.id\}\/threads\/\$\{thread\.id\}`\)/
    );
    assert.doesNotMatch(threadCreateSource, /navigate\(`\/threads\/\$\{thread\.id\}`\)/);
  });

  it("shows thread breadcrumbs as class to project to question", () => {
    assert.match(threadDetailSource, /\.from\("classes"\)/);
    assert.match(threadDetailSource, /classRow: ClassSummary \| null/);
    assert.match(threadDetailSource, /to=\{`\/classes\/\$\{state\.classRow\.id\}`\}/);
    assert.match(threadDetailSource, /projectBreadcrumbTarget/);
    assert.match(threadDetailSource, /\{state\.thread\.title\}/);
    assert.doesNotMatch(threadDetailSource, /質問キュー|\/teacher\/queue/);
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

  it("shows syntax-highlighted previews for code-like question inputs", () => {
    const threadForm = threadCreateSource.match(
      /<article className="detail-panel thread-form-panel">[\s\S]*?<\/article>/
    )?.[0];

    assert.ok(threadForm);
    assert.match(threadCreateSource, /const errorPreview = errorText\.trim\(\)/);
    assert.match(threadCreateSource, /const commandPreview = commandText\.trim\(\)/);
    assert.match(threadForm, /className="syntax-preview"/);
    assert.match(threadForm, /aria-label="エラー文プレビュー"/);
    assert.match(threadForm, /language="Log"/);
    assert.match(threadForm, /aria-label="実行コマンドプレビュー"/);
    assert.match(threadForm, /language="Shell"/);
    assert.match(threadForm, /<CodeContextViewer/);
    assert.match(stylesSource, /\.syntax-preview/);
    assert.match(stylesSource, /\.syntax-preview \.code-viewer/);
  });
});
