import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const onboardingSource = readFileSync(
  "src/renderer/src/features/onboarding/StudentOnboardingPage.tsx",
  "utf8"
);
const projectSource = readFileSync(
  "src/renderer/src/features/projects/ProjectRegistrationPage.tsx",
  "utf8"
);
const stylesSource = readFileSync("src/renderer/src/styles.css", "utf8");
const threadCreateSource = readFileSync(
  "src/renderer/src/features/threads/ThreadCreatePage.tsx",
  "utf8"
);
const threadDetailSource = readFileSync(
  "src/renderer/src/features/threads/ThreadDetailPage.tsx",
  "utf8"
);
const threadCreateMessageSource = readFileSync(
  "src/renderer/src/features/threads/threadCreateMessage.ts",
  "utf8"
);

describe("student-facing UI clarity regressions", () => {
  it("keeps decorative gradients out of the app chrome", () => {
    assert.doesNotMatch(stylesSource, /linear-gradient|radial-gradient/);
    assert.doesNotMatch(stylesSource, /background-size\s*:/);
    assert.match(stylesSource, /body\s*\{[\s\S]*background:\s*var\(--color-page\)/);
  });

  it("hides redundant eyebrow labels except the login brand mark", () => {
    assert.match(stylesSource, /\.eyebrow\s*\{[\s\S]*display:\s*none/);
    assert.match(stylesSource, /\.auth-panel \.eyebrow\s*\{[\s\S]*display:\s*block/);
  });

  it("uses localized role labels in the sidebar", () => {
    assert.match(appSource, /const roleLabels: Record<AppRole, string>/);
    assert.match(appSource, /student:\s*"生徒"/);
    assert.match(appSource, /teacher:\s*"講師"/);
    assert.doesNotMatch(appSource, /<span className="role-badge">\{profile\.role\}<\/span>/);
  });

  it("keeps setup out of the primary sidebar menu after completion", () => {
    const navMatch = appSource.match(/<nav className="nav-list">([\s\S]*?)<\/nav>/);

    assert.ok(navMatch);
    assert.doesNotMatch(navMatch[1], /\/onboarding|初期設定/);
    assert.match(appSource, /type StudentSetupStatus = "unknown" \| "complete" \| "incomplete"/);
    assert.match(appSource, /studentSetupStatus === "incomplete"/);
    assert.match(appSource, /className="sidebar-setup-shortcut"/);
    assert.match(stylesSource, /\.sidebar-nav-stack/);
    assert.match(stylesSource, /\.sidebar-setup-link/);
  });

  it("keeps student question actions inside project screens", () => {
    const navMatch = appSource.match(/<nav className="nav-list">([\s\S]*?)<\/nav>/);

    assert.ok(navMatch);
    assert.doesNotMatch(navMatch[1], /\/threads|質問を作成|質問一覧/);
    assert.match(appSource, /path="\/projects\/:projectId\/threads\/new"/);
    assert.match(projectSource, /\.from\("threads"\)/);
    assert.match(projectSource, /to=\{`\/projects\/\$\{project\.id\}\/threads\/new`\}/);
    assert.match(projectSource, />質問一覧</);
    assert.match(threadCreateSource, /routeProjectId/);
    assert.match(threadCreateSource, /projectLocked/);
  });

  it("keeps project detail free of internal local identifiers", () => {
    const detailMatch = projectSource.match(
      /export const ProjectDetailPage = \(\): ReactElement => \{([\s\S]*)const ProjectPageState/
    );

    assert.ok(detailMatch);
    assert.doesNotMatch(detailMatch[1], />ローカル識別子</);
    assert.doesNotMatch(detailMatch[1], /localPathHash\?\.slice|local_path_hash\?\.slice/);
    assert.match(detailMatch[1], /className="project-detail-actions"/);
    assert.match(stylesSource, /\.workspace-page/);
    assert.match(stylesSource, /\.project-detail-actions/);
  });

  it("keeps obsolete verbose labels out of question and chat screens", () => {
    const screenSources = [threadCreateSource, threadDetailSource].join("\n");

    assert.doesNotMatch(screenSources, /ASK ELECTRON|CREATE CLASS|AI Summary/);
    assert.doesNotMatch(screenSources, /状況説明|コード差分|生徒ユーザー|先生ユーザー/);
    assert.match(threadCreateSource, /質問内容/);
    assert.match(threadDetailSource, /aria-label="パンくずリスト"/);
  });

  it("shows send-preview review details only when they need attention", () => {
    const screenSources = [threadCreateSource, threadDetailSource].join("\n");

    assert.doesNotMatch(screenSources, /送信対象に秘密情報候補はありません/);
    assert.doesNotMatch(screenSources, /最終 payload/);
    assert.doesNotMatch(threadCreateSource, /className="project-summary-list"/);
    assert.match(threadCreateSource, /hasReviewSecretFindings/);
    assert.match(threadDetailSource, /hasAiEscalationSecretFindings/);
    assert.match(screenSources, /className="review-section review-payload-details"/);
  });

  it("uses clear labels instead of raw internal repository names", () => {
    const screenSources = [
      onboardingSource,
      projectSource,
      threadCreateSource,
      threadDetailSource,
      threadCreateMessageSource
    ]
      .join("\n")
      .replace(/\\.select\\([\\s\\S]*?\\)/g, "");

    assert.doesNotMatch(
      screenSources,
      />\s*(remote origin|GitHub repository|default branch|local_path_hash|branch|HEAD|scanner 候補|Base commit)\s*</
    );
    assert.doesNotMatch(
      screenSources,
      /GitHub remote|Git repository|remote origin|GitHub repository|local_path_hash と|local_path_hash が|scanner 候補/
    );
    assert.match(screenSources, />GitHubリポジトリ</);
    assert.match(screenSources, />既定ブランチ</);
    assert.match(screenSources, />ローカル識別子</);
    assert.match(threadDetailSource, /aria-label="パッチ適用確認"/);
  });
});
