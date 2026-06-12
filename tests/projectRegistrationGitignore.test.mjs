import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  "src/renderer/src/features/projects/ProjectRegistrationPage.tsx",
  "utf8"
);
const styleSource = readFileSync("src/renderer/src/styles.css", "utf8");

describe("project registration gitignore gate", () => {
  it("checks and applies gitignore recommendations before registration", () => {
    assert.match(source, /window\.ask\.gitignore\.preview/);
    assert.match(source, /window\.ask\.gitignore\.apply/);
    assert.match(source, /gitignoreCheckedForSelectedRoot/);
    assert.match(source, /登録前に \.gitignore の推奨内容を確認してください/);
  });

  it("requires confirmation when high-risk gitignore patterns are still missing", () => {
    assert.match(source, /highRiskGitignorePatterns/);
    assert.match(source, /requiresGitignoreConfirmation/);
    assert.match(source, /高リスクの不足を確認しました/);
    assert.match(source, /高リスク不足/);
  });

  it("gates project details behind registration readiness", () => {
    assert.match(source, /registrationReadinessItems/);
    assert.match(source, /readyForRegistrationDetails/);
    assert.match(source, /aria-label="登録準備"/);
    assert.match(source, /readyForRegistrationDetails \? \(/);
    assert.match(source, /登録準備/);
    assert.match(source, /登録内容/);
    assert.match(styleSource, /\.registration-readiness-list/);
    assert.match(styleSource, /\.registration-readiness-row\.pending/);
  });
});
