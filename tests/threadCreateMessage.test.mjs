import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanSecrets } from "../src/shared/secretScanner.ts";
import {
  buildAiAssistContext,
  buildEnvironmentSnapshotMessage,
  buildGitDiffMessage,
  buildInitialMessage,
  buildRelatedSnippetMessage,
  dedupeRelatedFiles,
  findBlockedRelatedFiles,
  scanAiAssistContextForSecrets,
  splitRelatedFiles
} from "../src/renderer/src/features/threads/threadCreateMessage.ts";

const includedSnippet = (overrides = {}) => ({
  relativePath: "src/App.tsx",
  language: "tsx",
  sizeBytes: 128,
  status: "included",
  omissionReason: null,
  message: "included",
  content: "export const App = () => null;\n",
  truncated: false,
  ...overrides
});

const gitDiffFixture = {
  contractVersion: "v1",
  status: "ready",
  canContinue: true,
  projectRootId: "root-1",
  displayName: "app",
  collectedAt: "2026-06-01T00:00:00.000Z",
  branch: "main",
  headCommit: "abcdef1234567890",
  headShortCommit: "abcdef123456",
  changedFiles: [
    {
      path: "src/App.tsx",
      staged: true,
      unstaged: false,
      stagedStatus: "modified",
      unstagedStatus: null,
      isBinary: false,
      isLockfile: false,
      requiresSecretScan: false,
      includedInDiff: true,
      omissionReason: null
    }
  ],
  stagedDiff: {
    text: "diff --git a/src/App.tsx b/src/App.tsx\n+export const value = 1;",
    includedFileCount: 1,
    omittedFileCount: 0,
    truncated: false
  },
  unstagedDiff: {
    text: "",
    includedFileCount: 0,
    omittedFileCount: 0,
    truncated: false
  },
  omittedFiles: [],
  sensitiveFilePaths: [],
  limits: {
    timeoutMs: 5000,
    maxDiffChars: 20000,
    maxDiffCharsPerSection: 10000,
    maxIncludedFilesPerSection: 20
  },
  message: "差分を収集しました。"
};

const environmentSnapshotFixture = {
  contractVersion: "v1",
  status: "ready",
  collectedAt: "2026-06-01T00:00:00.000Z",
  canContinue: true,
  projectRootId: "root-1",
  displayName: "app",
  os: {
    name: "macOS",
    version: "15.0",
    arch: "arm64"
  },
  gitVersion: "git version 2.45.0",
  editor: {
    name: "VS Code",
    version: "1.99.0"
  },
  runtimes: {
    node: { available: true, version: "v22.0.0" },
    python: { available: false, version: null }
  },
  packageManagers: {
    npm: { available: true, version: "10.0.0" },
    pnpm: { available: false, version: null },
    yarn: { available: false, version: null },
    pip: { available: false, version: null }
  },
  dependenciesSummary: {
    projectDetected: true,
    manifests: [
      {
        file: "package.json",
        kind: "node",
        name: "ask-electron",
        dependencies: { count: 2, sample: ["react"] },
        devDependencies: { count: 1, sample: ["typescript"] }
      }
    ],
    lockfiles: ["package-lock.json"],
    warnings: []
  },
  warnings: [],
  limits: {
    timeoutMs: 5000,
    dependencySampleLimit: 10
  },
  message: "環境情報を収集しました。"
};

describe("thread creation message helpers", () => {
  it("splits, deduplicates, and blocks unsafe related file paths", () => {
    const files = splitRelatedFiles(" src/App.tsx\n\n.env\nsrc/App.tsx ");

    assert.deepEqual(files, ["src/App.tsx", ".env", "src/App.tsx"]);
    assert.deepEqual(dedupeRelatedFiles(files), ["src/App.tsx", ".env"]);
    assert.deepEqual(findBlockedRelatedFiles(files), [".env"]);
  });

  it("formats related snippets with a safe markdown fence and language label", () => {
    const output = buildRelatedSnippetMessage([
      includedSnippet({
        relativePath: "src/example.ts",
        language: "ts<script>",
        content: "const value = `code`;\n```\n",
        sizeBytes: 2048,
        truncated: true
      }),
      includedSnippet({
        relativePath: "src/empty.ts",
        content: "   "
      })
    ]);

    assert.match(output, /^## 関連ファイルスニペット/);
    assert.match(output, /### src\/example\.ts/);
    assert.match(output, /size: 2 KB \/ truncated/);
    assert.match(output, /````\nconst value/);
    assert.doesNotMatch(output, /ts<script>/);
    assert.doesNotMatch(output, /src\/empty\.ts/);
  });

  it("builds the first chat message with review, context, exclusions, and scan summary", () => {
    const output = buildInitialMessage({
      draftQuestion: "  テストが落ちます。  ",
      aiErrorSummary: "TypeError が出ています。",
      aiCauseCandidates: "依存関係の初期化順を確認します。",
      aiUsed: true,
      situation: "画面を開くと失敗します。",
      errorText: "",
      commandText: "npm test",
      relatedFiles: ["src/App.tsx"],
      relatedSnippets: [includedSnippet()],
      secretScan: scanSecrets({}),
      gitDiff: null,
      environmentSnapshot: null,
      excludedItems: ["Git差分"]
    });

    assert.match(output, /## 質問文\nテストが落ちます。/);
    assert.match(output, /## AIエラー要約\nTypeError が出ています。/);
    assert.match(output, /## AI補助の注意/);
    assert.match(output, /## エラー文\n未入力/);
    assert.match(output, /## 関連ファイル\nsrc\/App\.tsx/);
    assert.match(output, /## Git差分\n未収集/);
    assert.match(output, /## 環境情報\n未収集/);
    assert.match(output, /## 除外した項目\nGit差分/);
    assert.match(output, /## 秘密情報チェック\nチェック通過/);
  });

  it("formats collected git diff and environment context for the first message", () => {
    const gitDiffOutput = buildGitDiffMessage(gitDiffFixture);
    const environmentOutput = buildEnvironmentSnapshotMessage(environmentSnapshotFixture);

    assert.match(gitDiffOutput, /状態: 差分を収集しました。/);
    assert.match(gitDiffOutput, /- src\/App\.tsx \(staged:modified\)/);
    assert.match(gitDiffOutput, /```diff\n/);
    assert.match(environmentOutput, /OS: macOS 15\.0 \(arm64\)/);
    assert.match(environmentOutput, /- Node: v22\.0\.0/);
    assert.match(environmentOutput, /package\.json \(ask-electron\)/);
  });

  it("builds AI assist context and scans file-path entries for secrets", () => {
    const context = buildAiAssistContext({
      title: "ログインできない",
      situation: "ボタン押下後に失敗します。",
      errorText: "",
      commandText: "",
      relatedFiles: [".env"],
      relatedSnippets: [],
      gitDiff: null,
      environmentSnapshot: null
    });
    const scan = scanAiAssistContextForSecrets(context);

    assert.deepEqual(
      context.map((entry) => entry.label),
      ["タイトル", "質問内容", "関連ファイル"]
    );
    assert.equal(scan.blocked, true);
    assert.equal(scan.blockedFindings[0]?.sourceLabel, ".env");
  });
});
