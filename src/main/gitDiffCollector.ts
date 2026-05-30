import { basename } from "node:path";
import type {
  GitChangedFile,
  GitDiffCollectionRequest,
  GitDiffCollectionResponse,
  GitDiffCollectionStatus,
  GitDiffOmissionReason,
  GitDiffTextSection
} from "../shared/ipc";
import { scanSecretPaths } from "../shared/secretScanner";
import { runGit, type GitCommandResult } from "./gitCommand";
import {
  findSelectedProjectRootByLocalPathHash,
  getSelectedProjectRoot,
  type ProjectRootRecord
} from "./projectRoots";

const GIT_DIFF_TIMEOUT_MS = 5_000;
const MAX_DIFF_CHARS = 16_000;
const MAX_DIFF_CHARS_PER_SECTION = 8_000;
const MAX_INCLUDED_FILES_PER_SECTION = 40;
const MAX_GIT_DIFF_BUFFER_BYTES = 512 * 1024;

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
  "yarn.lock"
]);

const emptyDiffSection = (): GitDiffTextSection => ({
  text: "",
  includedFileCount: 0,
  omittedFileCount: 0,
  truncated: false
});

const createBaseResponse = (
  status: GitDiffCollectionStatus,
  message: string,
  overrides: Partial<GitDiffCollectionResponse> = {}
): GitDiffCollectionResponse => ({
  contractVersion: "v1",
  status,
  canContinue: true,
  projectRootId: null,
  displayName: null,
  collectedAt: new Date().toISOString(),
  branch: null,
  headCommit: null,
  headShortCommit: null,
  changedFiles: [],
  stagedDiff: emptyDiffSection(),
  unstagedDiff: emptyDiffSection(),
  omittedFiles: [],
  sensitiveFilePaths: [],
  limits: {
    timeoutMs: GIT_DIFF_TIMEOUT_MS,
    maxDiffChars: MAX_DIFF_CHARS,
    maxDiffCharsPerSection: MAX_DIFF_CHARS_PER_SECTION,
    maxIncludedFilesPerSection: MAX_INCLUDED_FILES_PER_SECTION
  },
  message,
  ...overrides
});

const isCompleted = (result: GitCommandResult): boolean => {
  return result.status === "completed" && result.exitCode === 0;
};

const isLockfilePath = (path: string): boolean => {
  return LOCKFILE_NAMES.has(basename(path));
};

const requiresSecretScan = (path: string): boolean => {
  return scanSecretPaths([path]).activeFindings.length > 0;
};

const parseNameStatus = (
  output: string,
  side: "staged" | "unstaged",
  filesByPath: Map<string, GitChangedFile>
): void => {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split("\t");
    const status = parts[0] ?? "";
    const path = parts.at(-1)?.trim();

    if (!path) {
      continue;
    }

    const existing = filesByPath.get(path);
    const file: GitChangedFile =
      existing ??
      ({
        path,
        staged: false,
        unstaged: false,
        stagedStatus: null,
        unstagedStatus: null,
        isBinary: false,
        isLockfile: isLockfilePath(path),
        requiresSecretScan: requiresSecretScan(path),
        includedInDiff: true,
        omissionReason: null
      } satisfies GitChangedFile);

    if (side === "staged") {
      file.staged = true;
      file.stagedStatus = status;
    } else {
      file.unstaged = true;
      file.unstagedStatus = status;
    }

    filesByPath.set(path, file);
  }
};

const parseBinaryFlags = (output: string, filesByPath: Map<string, GitChangedFile>): void => {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const [additions, deletions, ...pathParts] = trimmed.split("\t");
    const path = pathParts.at(-1)?.trim();

    if (!path || (additions !== "-" && deletions !== "-")) {
      continue;
    }

    const file = filesByPath.get(path);

    if (file) {
      file.isBinary = true;
    }
  }
};

const classifyOmission = (file: GitChangedFile): GitDiffOmissionReason | null => {
  if (file.requiresSecretScan) {
    return "secret_candidate";
  }

  if (file.isLockfile) {
    return "lockfile";
  }

  if (file.isBinary) {
    return "binary";
  }

  return null;
};

const finalizeChangedFiles = (filesByPath: Map<string, GitChangedFile>): GitChangedFile[] => {
  return [...filesByPath.values()]
    .map((file) => {
      const omissionReason = classifyOmission(file);
      return {
        ...file,
        includedInDiff: omissionReason === null,
        omissionReason
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
};

const truncateDiff = (text: string): { text: string; truncated: boolean } => {
  if (text.length <= MAX_DIFF_CHARS_PER_SECTION) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, MAX_DIFF_CHARS_PER_SECTION)}\n\n[diff truncated at ${MAX_DIFF_CHARS_PER_SECTION} chars]`,
    truncated: true
  };
};

const collectDiffText = async (
  rootPath: string,
  side: "staged" | "unstaged",
  files: GitChangedFile[]
): Promise<GitDiffTextSection | null> => {
  const sideFiles = files.filter((file) => file[side]);
  const includedPaths = sideFiles
    .filter((file) => file.includedInDiff)
    .slice(0, MAX_INCLUDED_FILES_PER_SECTION)
    .map((file) => file.path);
  const omittedByCount = Math.max(
    0,
    sideFiles.filter((file) => file.includedInDiff).length - MAX_INCLUDED_FILES_PER_SECTION
  );
  const omittedFileCount = sideFiles.filter((file) => !file.includedInDiff).length + omittedByCount;

  if (includedPaths.length === 0) {
    return {
      text: "",
      includedFileCount: 0,
      omittedFileCount,
      truncated: false
    };
  }

  const args = [
    "diff",
    ...(side === "staged" ? ["--cached"] : []),
    "--no-ext-diff",
    "--",
    ...includedPaths
  ];
  const result = await runGit(rootPath, args, {
    maxBufferBytes: MAX_GIT_DIFF_BUFFER_BYTES,
    maxOutputLength: MAX_DIFF_CHARS_PER_SECTION + 1_000,
    timeoutMs: GIT_DIFF_TIMEOUT_MS
  });

  if (!isCompleted(result)) {
    return null;
  }

  const truncated = truncateDiff(result.stdout);

  return {
    text: truncated.text,
    includedFileCount: includedPaths.length,
    omittedFileCount,
    truncated: truncated.truncated || result.stdoutTruncated || omittedByCount > 0
  };
};

const resolveProjectRoot = async (
  input: GitDiffCollectionRequest
): Promise<ProjectRootRecord | null> => {
  const projectRootId = input.projectRootId?.trim();

  if (projectRootId) {
    return getSelectedProjectRoot(projectRootId);
  }

  const localPathHash = input.localPathHash?.trim();

  if (localPathHash) {
    return findSelectedProjectRootByLocalPathHash(localPathHash);
  }

  return null;
};

export const collectGitDiff = async (
  input: GitDiffCollectionRequest
): Promise<GitDiffCollectionResponse> => {
  const record = await resolveProjectRoot(input);

  if (!record) {
    return createBaseResponse(
      "root_missing",
      "ローカルフォルダが未選択です。質問作成は継続できます。"
    );
  }

  const rootOverrides = {
    projectRootId: record.id,
    displayName: record.displayName
  };
  const insideWorkTree = await runGit(record.rootPath, ["rev-parse", "--is-inside-work-tree"], {
    timeoutMs: GIT_DIFF_TIMEOUT_MS
  });

  if (insideWorkTree.status === "missing") {
    return createBaseResponse("git_missing", "Git が見つからないため差分を収集できません。", {
      ...rootOverrides
    });
  }

  if (insideWorkTree.status === "timeout") {
    return createBaseResponse("git_timeout", "Git の確認がタイムアウトしました。", {
      ...rootOverrides
    });
  }

  if (!isCompleted(insideWorkTree)) {
    return createBaseResponse(
      "not_git_repository",
      "選択フォルダは Git repository として確認できませんでした。",
      {
        ...rootOverrides
      }
    );
  }

  const [branchResult, headResult, stagedStatus, unstagedStatus, stagedNumstat, unstagedNumstat] =
    await Promise.all([
      runGit(record.rootPath, ["symbolic-ref", "--short", "HEAD"], {
        timeoutMs: GIT_DIFF_TIMEOUT_MS
      }),
      runGit(record.rootPath, ["rev-parse", "HEAD"], { timeoutMs: GIT_DIFF_TIMEOUT_MS }),
      runGit(record.rootPath, ["diff", "--cached", "--no-ext-diff", "--name-status"], {
        timeoutMs: GIT_DIFF_TIMEOUT_MS
      }),
      runGit(record.rootPath, ["diff", "--no-ext-diff", "--name-status"], {
        timeoutMs: GIT_DIFF_TIMEOUT_MS
      }),
      runGit(record.rootPath, ["diff", "--cached", "--no-ext-diff", "--numstat"], {
        timeoutMs: GIT_DIFF_TIMEOUT_MS
      }),
      runGit(record.rootPath, ["diff", "--no-ext-diff", "--numstat"], {
        timeoutMs: GIT_DIFF_TIMEOUT_MS
      })
    ]);

  if (
    branchResult.status === "timeout" ||
    headResult.status === "timeout" ||
    stagedStatus.status === "timeout" ||
    unstagedStatus.status === "timeout"
  ) {
    return createBaseResponse("git_timeout", "Git 差分の収集がタイムアウトしました。", {
      ...rootOverrides,
      branch: isCompleted(branchResult) ? branchResult.stdout : null,
      headCommit: isCompleted(headResult) ? headResult.stdout : null,
      headShortCommit: isCompleted(headResult) ? headResult.stdout.slice(0, 12) : null
    });
  }

  if (!isCompleted(stagedStatus) || !isCompleted(unstagedStatus)) {
    return createBaseResponse("diff_failed", "Git 差分を取得できませんでした。", {
      ...rootOverrides,
      branch: isCompleted(branchResult) ? branchResult.stdout : null,
      headCommit: isCompleted(headResult) ? headResult.stdout : null,
      headShortCommit: isCompleted(headResult) ? headResult.stdout.slice(0, 12) : null
    });
  }

  const filesByPath = new Map<string, GitChangedFile>();
  parseNameStatus(stagedStatus.stdout, "staged", filesByPath);
  parseNameStatus(unstagedStatus.stdout, "unstaged", filesByPath);

  if (isCompleted(stagedNumstat)) {
    parseBinaryFlags(stagedNumstat.stdout, filesByPath);
  }

  if (isCompleted(unstagedNumstat)) {
    parseBinaryFlags(unstagedNumstat.stdout, filesByPath);
  }

  const changedFiles = finalizeChangedFiles(filesByPath);
  const [stagedDiff, unstagedDiff] = await Promise.all([
    collectDiffText(record.rootPath, "staged", changedFiles),
    collectDiffText(record.rootPath, "unstaged", changedFiles)
  ]);

  if (!stagedDiff || !unstagedDiff) {
    return createBaseResponse("diff_failed", "Git 差分本文の取得に失敗しました。", {
      ...rootOverrides,
      branch: isCompleted(branchResult) ? branchResult.stdout : null,
      headCommit: isCompleted(headResult) ? headResult.stdout : null,
      headShortCommit: isCompleted(headResult) ? headResult.stdout.slice(0, 12) : null,
      changedFiles
    });
  }

  const omittedFiles = changedFiles
    .filter((file) => file.omissionReason)
    .map((file) => ({
      path: file.path,
      omissionReason: file.omissionReason
    }));
  const sensitiveFilePaths = changedFiles
    .filter((file) => file.requiresSecretScan)
    .map((file) => file.path);
  const status = changedFiles.length > 0 ? "ready" : "empty";
  const message =
    status === "ready"
      ? "Git branch、HEAD、未コミット差分を収集しました。"
      : "未コミット差分はありません。branch と HEAD のみ記録します。";

  return createBaseResponse(status, message, {
    ...rootOverrides,
    branch: isCompleted(branchResult) ? branchResult.stdout : "detached HEAD",
    headCommit: isCompleted(headResult) ? headResult.stdout : null,
    headShortCommit: isCompleted(headResult) ? headResult.stdout.slice(0, 12) : null,
    changedFiles,
    stagedDiff,
    unstagedDiff,
    omittedFiles,
    sensitiveFilePaths
  });
};
