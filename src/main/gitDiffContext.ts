import { execFile } from "node:child_process";
import { basename } from "node:path";
import type {
  GitDiffContextFile,
  GitDiffContextOmittedFile,
  GitDiffContextRequest,
  GitDiffContextResponse,
  GitDiffContextSection,
  GitDiffKind,
  GitDiffOmissionReason,
  GitDiffContextStatus
} from "../shared/ipc";
import { getSelectedProjectRootByLocalPathHash } from "./projectRoots";

const GIT_DIFF_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_LENGTH = 240_000;
const MAX_DIFF_CHARS_PER_SECTION = 12_000;
const MAX_DIFF_FILES_PER_SECTION = 24;
const MAX_DIFF_CHARS = MAX_DIFF_CHARS_PER_SECTION * 2;

interface GitCommandResult {
  status: "completed" | "missing" | "timeout" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface RunGitOptions {
  maxBuffer?: number;
  trimOutput?: boolean;
}

interface DiffPathClassification {
  path: string;
  binary: boolean;
  lockfile: boolean;
  sensitivePath: boolean;
}

interface DiffSectionResult {
  section: GitDiffContextSection | null;
  omittedFiles: GitDiffContextOmittedFile[];
  failed: boolean;
  timedOut: boolean;
}

const lockFileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock"
]);

const sanitizeOutput = (
  value: string,
  maxLength = MAX_GIT_OUTPUT_LENGTH,
  trimOutput = true
): string => {
  const sanitized = value
    .split("")
    .filter((char) => {
      const codePoint = char.charCodeAt(0);
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint >= 32 && codePoint !== 127)
      );
    })
    .join("")
    .slice(0, maxLength);

  return trimOutput ? sanitized.trim() : sanitized;
};

const runGit = (
  rootPath: string,
  args: string[],
  { maxBuffer = 8 * 1024 * 1024, trimOutput = true }: RunGitOptions = {}
): Promise<GitCommandResult> => {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", rootPath, ...args],
      {
        encoding: "utf8",
        maxBuffer,
        shell: false,
        timeout: GIT_DIFF_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const cleanStdout = sanitizeOutput(stdout, MAX_GIT_OUTPUT_LENGTH, trimOutput);
        const cleanStderr = sanitizeOutput(stderr);

        if (!error) {
          resolve({
            status: "completed",
            exitCode: 0,
            stdout: cleanStdout,
            stderr: cleanStderr
          });
          return;
        }

        const commandError = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
          code?: string | number | null;
        };

        if (commandError.code === "ENOENT") {
          resolve({
            status: "missing",
            exitCode: null,
            stdout: cleanStdout,
            stderr: cleanStderr
          });
          return;
        }

        if (commandError.killed || commandError.signal === "SIGTERM") {
          resolve({
            status: "timeout",
            exitCode: null,
            stdout: cleanStdout,
            stderr: cleanStderr
          });
          return;
        }

        resolve({
          status: typeof commandError.code === "number" ? "completed" : "error",
          exitCode: typeof commandError.code === "number" ? commandError.code : null,
          stdout: cleanStdout,
          stderr: cleanStderr
        });
      }
    );
  });
};

const createResponse = (
  input: GitDiffContextRequest,
  status: GitDiffContextStatus,
  message: string,
  overrides: Partial<GitDiffContextResponse> = {}
): GitDiffContextResponse => ({
  contractVersion: "v1",
  localPathHash: input.localPathHash,
  status,
  message,
  branch: null,
  headCommit: null,
  hasChanges: false,
  files: [],
  sections: [],
  omittedFiles: [],
  secretScanValues: [],
  totalDiffChars: 0,
  maxDiffChars: MAX_DIFF_CHARS,
  timeoutMs: GIT_DIFF_TIMEOUT_MS,
  ...overrides
});

const parsePathList = (stdout: string): string[] => {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const parseBinaryPaths = (stdout: string): Set<string> => {
  const binaryPaths = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t").trim();

    if (path && added === "-" && deleted === "-") {
      binaryPaths.add(path);
    }
  }

  return binaryPaths;
};

const isLockfilePath = (path: string): boolean => {
  const fileName = basename(path).toLowerCase();
  return lockFileNames.has(fileName) || fileName.endsWith(".lock");
};

const isSensitivePath = (path: string): boolean => {
  const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
  const fileName = basename(normalizedPath);

  return (
    fileName === ".env" ||
    (fileName.startsWith(".env.") && fileName !== ".env.example") ||
    fileName === ".npmrc" ||
    fileName === ".pypirc" ||
    fileName === ".netrc" ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".p12") ||
    fileName.endsWith(".pfx") ||
    fileName.endsWith(".key") ||
    normalizedPath.includes("/.ssh/") ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(fileName)
  );
};

const classifyPath = (path: string, binary: boolean): DiffPathClassification => ({
  path,
  binary,
  lockfile: isLockfilePath(path),
  sensitivePath: isSensitivePath(path)
});

const getOmissionReason = (
  classification: DiffPathClassification
): GitDiffOmissionReason | null => {
  if (classification.sensitivePath) {
    return "sensitive_path";
  }

  if (classification.binary) {
    return "binary";
  }

  if (classification.lockfile) {
    return "lockfile";
  }

  return null;
};

const addFileEntry = (
  filesByPath: Map<string, GitDiffContextFile>,
  classification: DiffPathClassification,
  kind: GitDiffKind
): void => {
  const current =
    filesByPath.get(classification.path) ??
    ({
      path: classification.path,
      staged: false,
      unstaged: false,
      binary: false,
      lockfile: false,
      sensitivePath: false
    } satisfies GitDiffContextFile);

  filesByPath.set(classification.path, {
    ...current,
    staged: current.staged || kind === "staged",
    unstaged: current.unstaged || kind === "unstaged",
    binary: current.binary || classification.binary,
    lockfile: current.lockfile || classification.lockfile,
    sensitivePath: current.sensitivePath || classification.sensitivePath
  });
};

const truncateDiffText = (
  text: string
): { text: string; truncated: boolean; originalLength: number } => {
  const originalLength = text.length;

  if (originalLength <= MAX_DIFF_CHARS_PER_SECTION) {
    return {
      text,
      truncated: false,
      originalLength
    };
  }

  return {
    text: `${text.slice(0, MAX_DIFF_CHARS_PER_SECTION).trimEnd()}\n\n[ASK: diff truncated at ${MAX_DIFF_CHARS_PER_SECTION} characters]`,
    truncated: true,
    originalLength
  };
};

const buildDiffSection = async ({
  rootPath,
  kind,
  paths,
  binaryPaths,
  filesByPath
}: {
  rootPath: string;
  kind: GitDiffKind;
  paths: string[];
  binaryPaths: Set<string>;
  filesByPath: Map<string, GitDiffContextFile>;
}): Promise<DiffSectionResult> => {
  const includedFiles: string[] = [];
  const omittedFiles: GitDiffContextOmittedFile[] = [];

  for (const path of paths) {
    const classification = classifyPath(path, binaryPaths.has(path));
    const omissionReason = getOmissionReason(classification);

    addFileEntry(filesByPath, classification, kind);

    if (omissionReason) {
      omittedFiles.push({
        path,
        kind,
        reason: omissionReason
      });
      continue;
    }

    if (includedFiles.length >= MAX_DIFF_FILES_PER_SECTION) {
      omittedFiles.push({
        path,
        kind,
        reason: "file_limit"
      });
      continue;
    }

    includedFiles.push(path);
  }

  if (includedFiles.length === 0) {
    return {
      section: {
        kind,
        text: "",
        includedFiles,
        truncated: false,
        originalLength: 0
      },
      omittedFiles,
      failed: false,
      timedOut: false
    };
  }

  const args =
    kind === "staged"
      ? ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", ...includedFiles]
      : ["diff", "--no-ext-diff", "--unified=3", "--", ...includedFiles];
  const diffResult = await runGit(rootPath, args, { trimOutput: false });

  if (diffResult.status === "timeout") {
    return {
      section: null,
      omittedFiles,
      failed: true,
      timedOut: true
    };
  }

  if (diffResult.status !== "completed" || diffResult.exitCode !== 0) {
    return {
      section: null,
      omittedFiles,
      failed: true,
      timedOut: false
    };
  }

  const truncated = truncateDiffText(diffResult.stdout);

  return {
    section: {
      kind,
      text: truncated.text,
      includedFiles,
      truncated: truncated.truncated,
      originalLength: truncated.originalLength
    },
    omittedFiles,
    failed: false,
    timedOut: false
  };
};

const sortFiles = (files: GitDiffContextFile[]): GitDiffContextFile[] => {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
};

const createSecretScanValues = (
  files: GitDiffContextFile[],
  omittedFiles: GitDiffContextOmittedFile[]
): string[] => {
  return [
    ...new Set([
      ...files.filter((file) => file.sensitivePath).map((file) => file.path),
      ...omittedFiles.filter((file) => file.reason === "sensitive_path").map((file) => file.path)
    ])
  ];
};

const hasCommandFailure = (result: GitCommandResult): boolean => {
  return result.status !== "completed" || (result.exitCode !== null && result.exitCode !== 0);
};

export const collectGitDiffContext = async (
  input: GitDiffContextRequest
): Promise<GitDiffContextResponse> => {
  const record = getSelectedProjectRootByLocalPathHash(input.localPathHash);

  if (!record) {
    return createResponse(
      input,
      "root_not_selected",
      "このプロジェクトのローカルフォルダがこのセッションで未選択です。質問作成は続行できます。"
    );
  }

  const insideWorkTree = await runGit(record.rootPath, ["rev-parse", "--is-inside-work-tree"]);

  if (insideWorkTree.status === "missing") {
    return createResponse(input, "git_missing", "Git が見つかりません。質問作成は続行できます。");
  }

  if (insideWorkTree.status === "timeout") {
    return createResponse(
      input,
      "git_timeout",
      "Git repository の確認がタイムアウトしました。質問作成は続行できます。"
    );
  }

  if (insideWorkTree.status !== "completed" || insideWorkTree.exitCode !== 0) {
    return createResponse(
      input,
      "not_git_repository",
      "選択済みフォルダが Git repository ではありません。質問作成は続行できます。"
    );
  }

  const [
    branchResult,
    headResult,
    stagedPathsResult,
    unstagedPathsResult,
    stagedNumstatResult,
    unstagedNumstatResult
  ] = await Promise.all([
    runGit(record.rootPath, ["branch", "--show-current"]),
    runGit(record.rootPath, ["rev-parse", "HEAD"]),
    runGit(record.rootPath, ["diff", "--cached", "--name-only", "--no-ext-diff"]),
    runGit(record.rootPath, ["diff", "--name-only", "--no-ext-diff"]),
    runGit(record.rootPath, ["diff", "--cached", "--numstat", "--no-ext-diff"]),
    runGit(record.rootPath, ["diff", "--numstat", "--no-ext-diff"])
  ]);

  const requiredResults = [
    stagedPathsResult,
    unstagedPathsResult,
    stagedNumstatResult,
    unstagedNumstatResult
  ];

  if (requiredResults.some((result) => result.status === "missing")) {
    return createResponse(input, "git_missing", "Git が見つかりません。質問作成は続行できます。");
  }

  if (requiredResults.some((result) => result.status === "timeout")) {
    return createResponse(
      input,
      "git_timeout",
      "Git diff の取得がタイムアウトしました。質問作成は続行できます。"
    );
  }

  if (requiredResults.some(hasCommandFailure)) {
    return createResponse(
      input,
      "error",
      "Git diff を取得できませんでした。質問作成は続行できます。"
    );
  }

  const stagedPaths = parsePathList(stagedPathsResult.stdout);
  const unstagedPaths = parsePathList(unstagedPathsResult.stdout);
  const stagedBinaryPaths = parseBinaryPaths(stagedNumstatResult.stdout);
  const unstagedBinaryPaths = parseBinaryPaths(unstagedNumstatResult.stdout);
  const filesByPath = new Map<string, GitDiffContextFile>();

  const [stagedSectionResult, unstagedSectionResult] = await Promise.all([
    buildDiffSection({
      rootPath: record.rootPath,
      kind: "staged",
      paths: stagedPaths,
      binaryPaths: stagedBinaryPaths,
      filesByPath
    }),
    buildDiffSection({
      rootPath: record.rootPath,
      kind: "unstaged",
      paths: unstagedPaths,
      binaryPaths: unstagedBinaryPaths,
      filesByPath
    })
  ]);

  const sectionResults = [stagedSectionResult, unstagedSectionResult];
  const sections = sectionResults
    .map((result) => result.section)
    .filter((section): section is GitDiffContextSection => section !== null);
  const omittedFiles = sectionResults.flatMap((result) => result.omittedFiles);
  const files = sortFiles([...filesByPath.values()]);
  const totalDiffChars = sections.reduce((total, section) => total + section.text.length, 0);
  const hasChanges = stagedPaths.length > 0 || unstagedPaths.length > 0;
  const anySectionFailed = sectionResults.some((result) => result.failed);
  const anySectionTimedOut = sectionResults.some((result) => result.timedOut);
  const anyTruncated = sections.some((section) => section.truncated);
  const hasOmittedFiles = omittedFiles.length > 0;
  const branch =
    branchResult.status === "completed" && branchResult.exitCode === 0
      ? branchResult.stdout || null
      : null;
  const headCommit =
    headResult.status === "completed" && headResult.exitCode === 0
      ? headResult.stdout || null
      : null;
  const secretScanValues = createSecretScanValues(files, omittedFiles);

  if (anySectionTimedOut) {
    return createResponse(
      input,
      "partial",
      "Git diff の一部がタイムアウトしました。質問作成は続行できます。",
      {
        branch,
        headCommit,
        hasChanges,
        files,
        sections,
        omittedFiles,
        secretScanValues,
        totalDiffChars
      }
    );
  }

  if (anySectionFailed) {
    return createResponse(
      input,
      "partial",
      "Git diff の一部を取得できませんでした。質問作成は続行できます。",
      {
        branch,
        headCommit,
        hasChanges,
        files,
        sections,
        omittedFiles,
        secretScanValues,
        totalDiffChars
      }
    );
  }

  if (!hasChanges) {
    return createResponse(input, "empty", "未コミット差分はありません。", {
      branch,
      headCommit,
      files,
      sections,
      omittedFiles,
      secretScanValues,
      totalDiffChars
    });
  }

  return createResponse(
    input,
    "ready",
    anyTruncated || hasOmittedFiles
      ? "Git差分を収集しました。一部のファイルまたは大きな差分は省略されています。"
      : "Git差分を収集しました。",
    {
      branch,
      headCommit,
      hasChanges,
      files,
      sections,
      omittedFiles,
      secretScanValues,
      totalDiffChars
    }
  );
};
