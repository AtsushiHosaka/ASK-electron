import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const studentHomeSource = readFileSync(
  "src/renderer/src/features/student/StudentHomePage.tsx",
  "utf8"
);
const styleSource = readFileSync("src/renderer/src/styles.css", "utf8");

describe("student home real data", () => {
  it("removes the demo thread route and placeholder workspace from the app shell", () => {
    assert.doesNotMatch(appSource, /\/threads\/demo/);
    assert.doesNotMatch(appSource, /WorkspacePage/);
    assert.match(appSource, /StudentHomePage/);
    assert.match(appSource, /path="\/threads"/);
    assert.match(appSource, /質問一覧/);
  });

  it("loads student home data from Supabase tables", () => {
    assert.match(studentHomeSource, /\.from\("github_connections"\)/);
    assert.match(studentHomeSource, /\.from\("class_members"\)/);
    assert.match(studentHomeSource, /\.from\("projects"\)/);
    assert.match(studentHomeSource, /\.from\("threads"\)/);
    assert.match(studentHomeSource, /id="threads"/);
    assert.match(studentHomeSource, /\/threads\/new/);
    assert.match(studentHomeSource, /\/projects/);
    assert.match(studentHomeSource, /\/onboarding/);
  });

  it("shows first-run onboarding from real setup state and stores dismissal locally", () => {
    assert.match(studentHomeSource, /firstRunOnboardingStoragePrefix/);
    assert.match(studentHomeSource, /window\.localStorage\.getItem/);
    assert.match(studentHomeSource, /window\.localStorage\.setItem/);
    assert.match(
      studentHomeSource,
      /const setupComplete = completedSetupCount === setupItems\.length/
    );
    assert.match(studentHomeSource, /const FirstRunOnboardingPage = /);
    assert.match(studentHomeSource, /profile\?\.role === "student"/);
    assert.match(styleSource, /\.first-run-onboarding/);
    assert.match(styleSource, /\.first-run-step-list/);
  });

  it("keeps the student home action hierarchy focused", () => {
    assert.match(studentHomeSource, /const nextSetupAction = setupItems\.find/);
    assert.match(studentHomeSource, /const homePrimaryAction = nextSetupAction/);
    assert.match(studentHomeSource, /className="page-actions home-actions"/);
    assert.match(studentHomeSource, /className="primary-button home-primary-action"/);
    assert.match(studentHomeSource, /className="setup-action-link"/);
    assert.match(styleSource, /\.setup-check-row\.needs-action/);
    assert.match(styleSource, /\.home-primary-action/);
    assert.doesNotMatch(
      studentHomeSource,
      /<Link className="secondary-link" to="\/threads\/new">\s*質問を作成\s*<\/Link>/
    );
  });

  it("keeps product code free of obsolete demo and placeholder implementation markers", () => {
    const productSources = [appSource, studentHomeSource, styleSource].join("\n");

    assert.doesNotMatch(productSources, /demo|placeholder|WorkspacePage/);
    assert.doesNotMatch(styleSource, /\.placeholder-grid|\.placeholder-panel/);
  });
});
