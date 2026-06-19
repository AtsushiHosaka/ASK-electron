import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const docPaths = [
  "spec.md",
  "docs/qa/test-accounts-and-login-fixtures.md",
  "docs/qa/macos-windows-e2e-release-checklist.md",
  "docs/qa/product-smoke-check-2026-05-31.md",
  "docs/qa/macos-windows-e2e-release-record-2026-05-31.md",
  "docs/specs/student-friendly-pop-ui/requirements.md",
  "docs/specs/student-friendly-pop-ui/design.md",
  "docs/specs/student-friendly-pop-ui/tasks.md"
];

const docs = Object.fromEntries(docPaths.map((path) => [path, readFileSync(path, "utf8")]));
const combinedDocs = Object.entries(docs)
  .map(([path, source]) => `\n--- ${path} ---\n${source}`)
  .join("\n");

describe("class project question documentation hierarchy", () => {
  it("does not document a standalone teacher question queue", () => {
    assert.doesNotMatch(
      combinedDocs,
      /質問キュー|先生キュー|Questions Queue|teacher queue|Teacher queue|\bqueue\b/
    );
    assert.doesNotMatch(combinedDocs, /\/threads\/new/);
  });

  it("documents question access through class, project, and question context", () => {
    assert.match(docs["spec.md"], /先生向けクラス詳細のプロジェクト別質問一覧/);
    assert.match(docs["spec.md"], /先生が担当クラスのプロジェクトごとに未対応質問を確認できる/);
    assert.match(
      docs["docs/qa/test-accounts-and-login-fixtures.md"],
      /Open `Intro Programming`, then `Student A Calculator`/
    );
    assert.match(
      docs["docs/qa/macos-windows-e2e-release-checklist.md"],
      /Teacher sees unanswered questions by opening class detail, then the related project/
    );
    assert.match(
      docs["docs/specs/student-friendly-pop-ui/requirements.md"],
      /project-scoped question density/
    );
  });
});
