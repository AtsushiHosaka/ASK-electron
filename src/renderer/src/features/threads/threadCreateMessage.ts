import type { AiContextEntry } from "../../../../shared/aiPipeline";
import type {
  EnvironmentSnapshotResponse,
  GitDiffCollectionResponse,
  RelatedFileSnippet
} from "../../../../shared/ipc";
import { scanSecrets, type SecretScanResult } from "../../../../shared/secretScanner";

export const splitRelatedFiles = (value: string): string[] => {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

export const findBlockedRelatedFiles = (relatedFiles: string[]): string[] => {
  return relatedFiles.filter((file) => scanSecrets({ filePaths: [file] }).blocked);
};

export const dedupeRelatedFiles = (files: string[]): string[] => {
  return [...new Set(files.filter(Boolean))];
};

export const sanitizeFenceLanguage = (language: string | null): string => {
  return language && /^[a-z0-9_+-]+$/i.test(language) ? language : "";
};

export const createMarkdownFence = (content: string): string => {
  const longestFence = Math.max(
    2,
    ...[...content.matchAll(/`{3,}/g)].map((match) => match[0].length)
  );
  return "`".repeat(longestFence + 1);
};

export const formatSnippetBytes = (sizeBytes: number | null): string => {
  if (sizeBytes === null) {
    return "size unknown";
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  return `${Math.round((sizeBytes / 1024) * 10) / 10} KB`;
};

export const buildRelatedSnippetMessage = (snippets: RelatedFileSnippet[]): string => {
  const includedSnippets = snippets.filter(
    (snippet) => snippet.status === "included" && snippet.content.trim().length > 0
  );

  if (includedSnippets.length === 0) {
    return "## 関連ファイルスニペット\n未選択";
  }

  return [
    "## 関連ファイルスニペット",
    ...includedSnippets.map((snippet) => {
      const fence = createMarkdownFence(snippet.content);
      const language = sanitizeFenceLanguage(snippet.language);
      const meta = [
        `### ${snippet.relativePath}`,
        `size: ${formatSnippetBytes(snippet.sizeBytes)}${snippet.truncated ? " / truncated" : ""}`
      ].join("\n");

      return `${meta}\n${fence}${language}\n${snippet.content.trimEnd()}\n${fence}`;
    })
  ].join("\n\n");
};

export const buildAiAssistContext = ({
  title,
  situation,
  errorText,
  commandText,
  relatedFiles,
  relatedSnippets,
  gitDiff,
  environmentSnapshot
}: {
  title: string;
  situation: string;
  errorText: string;
  commandText: string;
  relatedFiles: string[];
  relatedSnippets: RelatedFileSnippet[];
  gitDiff: GitDiffCollectionResponse | null;
  environmentSnapshot: EnvironmentSnapshotResponse | null;
}): AiContextEntry[] => {
  const entries: AiContextEntry[] = [
    { label: "タイトル", kind: "user_text", value: title },
    { label: "質問内容", kind: "user_text", value: situation },
    { label: "エラー文", kind: "error", value: errorText },
    { label: "実行コマンド", kind: "command", value: commandText },
    { label: "関連ファイル", kind: "file_path", value: relatedFiles.join("\n") },
    {
      label: "関連ファイルスニペット",
      kind: "code",
      value: relatedSnippets.length > 0 ? buildRelatedSnippetMessage(relatedSnippets) : ""
    },
    { label: "Git差分", kind: "diff", value: gitDiff ? buildGitDiffMessage(gitDiff) : "" },
    {
      label: "環境情報",
      kind: "environment",
      value: environmentSnapshot ? buildEnvironmentSnapshotMessage(environmentSnapshot) : ""
    }
  ];

  return entries.filter((entry) => entry.value.trim().length > 0);
};

export const scanAiAssistContextForSecrets = (context: AiContextEntry[]): SecretScanResult => {
  return scanSecrets({
    textEntries: context
      .filter((entry) => entry.kind !== "file_path")
      .map((entry) => ({ label: entry.label, value: entry.value })),
    filePaths: context
      .filter((entry) => entry.kind === "file_path")
      .flatMap((entry) => splitRelatedFiles(entry.value))
  });
};

export const buildInitialMessage = ({
  draftQuestion,
  aiErrorSummary,
  aiCauseCandidates,
  aiUsed,
  situation,
  errorText,
  commandText,
  relatedFiles,
  relatedSnippets,
  secretScan,
  gitDiff,
  environmentSnapshot,
  excludedItems
}: {
  draftQuestion: string;
  aiErrorSummary: string;
  aiCauseCandidates: string;
  aiUsed: boolean;
  situation: string;
  errorText: string;
  commandText: string;
  relatedFiles: string[];
  relatedSnippets: RelatedFileSnippet[];
  secretScan: SecretScanResult;
  gitDiff: GitDiffCollectionResponse | null;
  environmentSnapshot: EnvironmentSnapshotResponse | null;
  excludedItems: string[];
}): string => {
  const sections = [
    `## 質問文\n${draftQuestion.trim() || "未入力"}`,
    aiErrorSummary.trim() ? `## AIエラー要約\n${aiErrorSummary.trim()}` : null,
    aiCauseCandidates.trim() ? `## AI原因候補と次の確認\n${aiCauseCandidates.trim()}` : null,
    aiUsed
      ? "## AI補助の注意\nAI 出力は補助情報です。確定回答ではなく、送信前に内容を確認・編集しています。"
      : null,
    `## 質問内容\n${situation.trim()}`,
    `## エラー文\n${errorText.trim() || "未入力"}`,
    `## 実行コマンド\n${commandText.trim() || "未入力"}`,
    `## 関連ファイル\n${relatedFiles.length > 0 ? relatedFiles.join("\n") : "未選択"}`,
    buildRelatedSnippetMessage(relatedSnippets),
    buildGitDiffMessage(gitDiff),
    buildEnvironmentSnapshotMessage(environmentSnapshot),
    `## 除外した項目\n${excludedItems.length > 0 ? excludedItems.join("\n") : "なし"}`,
    `## 秘密情報チェック\n${formatSecretScanMessage(secretScan)}`
  ].filter((section): section is string => Boolean(section));

  return sections.join("\n\n");
};

export const formatSecretFinding = (finding: SecretScanResult["findings"][number]): string => {
  const line = finding.lineNumber ? `:${finding.lineNumber}` : "";
  return `${finding.severity === "block" ? "BLOCK" : "WARN"} ${finding.sourceLabel}${line} - ${finding.message} (${finding.preview})`;
};

export const formatSecretScanMessage = (secretScan: SecretScanResult): string => {
  if (secretScan.activeFindings.length === 0 && secretScan.allowedFindings.length === 0) {
    return "チェック通過";
  }

  const activeLines = secretScan.activeFindings.map(formatSecretFinding);
  const allowedLines = secretScan.allowedFindings.map(
    (finding) => `ALLOW ${finding.sourceLabel} - ${finding.message} (${finding.preview})`
  );

  return [...activeLines, ...allowedLines].join("\n");
};

export const formatChangedFiles = (gitDiff: GitDiffCollectionResponse): string => {
  if (gitDiff.changedFiles.length === 0) {
    return "未コミット差分なし";
  }

  return gitDiff.changedFiles
    .map((file) => {
      const states = [
        file.staged ? `staged:${file.stagedStatus ?? "changed"}` : null,
        file.unstaged ? `unstaged:${file.unstagedStatus ?? "changed"}` : null
      ].filter(Boolean);
      const flags = [
        file.isBinary ? "binary" : null,
        file.isLockfile ? "lockfile" : null,
        file.requiresSecretScan ? "secret-scan" : null,
        file.omissionReason ? `omitted:${file.omissionReason}` : null
      ].filter(Boolean);

      return `- ${file.path} (${[...states, ...flags].join(", ")})`;
    })
    .join("\n");
};

export const formatDiffSection = (
  title: string,
  section: GitDiffCollectionResponse["stagedDiff"]
): string => {
  if (!section.text) {
    return `### ${title}\n差分本文なし`;
  }

  const note = [
    section.truncated ? "一部切り詰め" : null,
    section.omittedFileCount > 0 ? `${section.omittedFileCount} ファイル省略` : null
  ]
    .filter(Boolean)
    .join(" / ");

  return `### ${title}${note ? ` (${note})` : ""}\n\`\`\`diff\n${section.text}\n\`\`\``;
};

export const buildGitDiffMessage = (gitDiff: GitDiffCollectionResponse | null): string => {
  if (!gitDiff) {
    return "## Git差分\n未収集。ローカルフォルダ未選択または収集中に失敗した場合も質問作成は継続できます。";
  }

  const omittedFiles =
    gitDiff.omittedFiles.length > 0
      ? gitDiff.omittedFiles
          .map((file) => `- ${file.path} (${file.omissionReason ?? "omitted"})`)
          .join("\n")
      : "なし";
  const sensitiveFiles =
    gitDiff.sensitiveFilePaths.length > 0 ? gitDiff.sensitiveFilePaths.join("\n") : "なし";

  return [
    "## Git差分",
    `状態: ${gitDiff.message}`,
    `ブランチ: ${gitDiff.branch ?? "未取得"}`,
    `最新コミット: ${gitDiff.headCommit ?? "未取得"}`,
    `対象フォルダ: ${gitDiff.displayName ?? "未選択"}`,
    "### 変更ファイル",
    formatChangedFiles(gitDiff),
    "### 送信前 秘密情報候補",
    sensitiveFiles,
    "### 差分本文から省略したファイル",
    omittedFiles,
    formatDiffSection("ステージ済み差分", gitDiff.stagedDiff),
    formatDiffSection("未ステージ差分", gitDiff.unstagedDiff)
  ].join("\n");
};

export const formatVersionProbe = (
  label: string,
  probe: { available: boolean; version: string | null }
): string => {
  return `- ${label}: ${probe.available ? (probe.version ?? "available") : "未検出"}`;
};

export const formatManifestSummary = (snapshot: EnvironmentSnapshotResponse): string => {
  if (snapshot.dependenciesSummary.manifests.length === 0) {
    return "manifest 未検出";
  }

  return snapshot.dependenciesSummary.manifests
    .map((manifest) => {
      const parts = [
        `${manifest.file}${manifest.name ? ` (${manifest.name})` : ""}`,
        `dependencies ${manifest.dependencies.count}`,
        `devDependencies ${manifest.devDependencies.count}`
      ];
      const samples = [...manifest.dependencies.sample, ...manifest.devDependencies.sample]
        .slice(0, 10)
        .join(", ");

      return `- ${parts.join(" / ")}${samples ? `\n  sample: ${samples}` : ""}`;
    })
    .join("\n");
};

export const buildEnvironmentSnapshotMessage = (
  snapshot: EnvironmentSnapshotResponse | null
): string => {
  if (!snapshot) {
    return "## 環境情報\n未収集。収集できない場合も質問作成は継続できます。";
  }

  return [
    "## 環境情報",
    `状態: ${snapshot.message}`,
    `OS: ${snapshot.os.name} ${snapshot.os.version} (${snapshot.os.arch})`,
    `Git: ${snapshot.gitVersion ?? "未検出"}`,
    `Editor: ${snapshot.editor.name ?? "未検出"}${snapshot.editor.version ? ` ${snapshot.editor.version}` : ""}`,
    "### Runtimes",
    formatVersionProbe("Node", snapshot.runtimes.node),
    formatVersionProbe("Python", snapshot.runtimes.python),
    "### Package managers",
    formatVersionProbe("npm", snapshot.packageManagers.npm),
    formatVersionProbe("pnpm", snapshot.packageManagers.pnpm),
    formatVersionProbe("yarn", snapshot.packageManagers.yarn),
    formatVersionProbe("pip", snapshot.packageManagers.pip),
    "### Dependencies",
    formatManifestSummary(snapshot),
    `Lockfiles: ${snapshot.dependenciesSummary.lockfiles.length > 0 ? snapshot.dependenciesSummary.lockfiles.join(", ") : "なし"}`,
    `Warnings: ${snapshot.warnings.length > 0 ? snapshot.warnings.join(" / ") : "なし"}`
  ].join("\n");
};
