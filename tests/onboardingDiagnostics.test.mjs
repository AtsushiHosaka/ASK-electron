import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const onboardingSource = readFileSync(
  "src/renderer/src/features/onboarding/StudentOnboardingPage.tsx",
  "utf8"
);

describe("student onboarding diagnostics wiring", () => {
  it("runs real local diagnostics instead of simulated step completion", () => {
    assert.match(onboardingSource, /window\.ask\.diagnostics\.runLocal\(\)/);
    assert.doesNotMatch(onboardingSource, /simulateCheck/);
    assert.doesNotMatch(onboardingSource, /開発用ステータス/);
  });

  it("persists successful GitHub CLI and SSH diagnostics", () => {
    assert.match(onboardingSource, /\.from\("github_connections"\)\.upsert/);
    assert.match(onboardingSource, /auth_method: "gh_cli"/);
    assert.match(onboardingSource, /ssh_status: "ok"/);
    assert.match(onboardingSource, /onConflict: "user_id"/);
  });

  it("uses real repository inspection for the repository onboarding step", () => {
    assert.match(onboardingSource, /window\.ask\.project\.inspectGit/);
    assert.match(onboardingSource, /activeStep\.id === "repository"/);
    assert.match(onboardingSource, /repositoryInspection\.normalizedGithubRepoUrl/);
  });
});
