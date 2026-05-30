import { execFile } from "node:child_process";
import type {
  ProjectGitInspectionRequest,
  ProjectGitInspectionResponse,
  ProjectGitInspectionStatus
} from "../shared/ipc";
import { canonicalizePath, createLocalPathHash } from "./projectPathIdentity";
import { getSelectedProjectRoot } from "./projectRoots";

const GIT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_LENGTH = 2_000;

interface GitCommandResult {
  status: "completed" | "missing" | "timeout" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const sanitizeOutput = (value: string): string => {
  return value
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
    .slice(0, MAX_OUTPUT_LENGTH)
    .trim();
};

const runGit = (rootPath: string, args: string[]): Promise<GitCommandResult> => {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", rootPath, ...args],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const cleanStdout = sanitizeOutput(stdout);
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

const stripGitSuffix = (value: string): string => {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
};

const redactRemoteUrl = (remoteUrl: string): string => {
  try {
    const parsedUrl = new URL(remoteUrl);
    parsedUrl.username = "";
    parsedUrl.password = "";
    return parsedUrl.toString();
  } catch {
    return remoteUrl;
  }
};

export const normalizeGithubRepoUrl = (remoteUrl: string): string | null => {
  const trimmedUrl = remoteUrl.trim();

  if (!trimmedUrl) {
    return null;
  }

  const scpLikeMatch = /^git@github\.com:([^/]+)\/(.+)$/i.exec(trimmedUrl);

  if (scpLikeMatch) {
    const [, owner, repo] = scpLikeMatch;
    return `https://github.com/${owner}/${stripGitSuffix(repo)}`;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);
    const isGithubHost = parsedUrl.hostname.toLowerCase() === "github.com";
    const isSupportedProtocol = ["https:", "http:", "ssh:", "git:"].includes(parsedUrl.protocol);

    if (!isGithubHost || !isSupportedProtocol) {
      return null;
    }

    const [owner, repo] = parsedUrl.pathname.split("/").filter(Boolean);

    if (!owner || !repo) {
      return null;
    }

    return `https://github.com/${owner}/${stripGitSuffix(repo)}`;
  } catch {
    return null;
  }
};

const createResponse = (
  input: ProjectGitInspectionRequest,
  displayName: string,
  status: ProjectGitInspectionStatus,
  message: string,
  overrides: Partial<ProjectGitInspectionResponse> = {}
): ProjectGitInspectionResponse => ({
  contractVersion: "v1",
  projectRootId: input.projectRootId,
  displayName,
  status,
  isGitRepository: false,
  remoteOriginUrl: null,
  normalizedGithubRepoUrl: null,
  defaultBranch: null,
  localPathHash: null,
  canRegister: false,
  message,
  ...overrides
});

export const inspectProjectGit = async (
  input: ProjectGitInspectionRequest
): Promise<ProjectGitInspectionResponse> => {
  const record = getSelectedProjectRoot(input.projectRootId);

  if (!record) {
    throw new Error("PROJECT_ROOT_NOT_FOUND");
  }

  const canonicalRootPath = await canonicalizePath(record.rootPath);
  const insideWorkTree = await runGit(record.rootPath, ["rev-parse", "--is-inside-work-tree"]);

  if (insideWorkTree.status === "missing") {
    return createResponse(input, record.displayName, "git_missing", "Git が見つかりません。");
  }

  if (insideWorkTree.status === "timeout") {
    return createResponse(
      input,
      record.displayName,
      "git_timeout",
      "Git の確認がタイムアウトしました。"
    );
  }

  if (insideWorkTree.status !== "completed" || insideWorkTree.exitCode !== 0) {
    return createResponse(
      input,
      record.displayName,
      "not_git_repository",
      ".git がないフォルダはプロジェクト登録できません。"
    );
  }

  const topLevel = await runGit(record.rootPath, ["rev-parse", "--show-toplevel"]);
  const canonicalTopLevelPath = topLevel.stdout ? await canonicalizePath(topLevel.stdout) : null;

  if (
    topLevel.status === "completed" &&
    topLevel.exitCode === 0 &&
    canonicalTopLevelPath &&
    canonicalTopLevelPath !== canonicalRootPath
  ) {
    return createResponse(
      input,
      record.displayName,
      "not_git_root",
      "Git repository のルートフォルダを選択してください。",
      {
        isGitRepository: true
      }
    );
  }

  const remoteOrigin = await runGit(record.rootPath, ["remote", "get-url", "origin"]);

  if (remoteOrigin.status === "timeout") {
    return createResponse(
      input,
      record.displayName,
      "git_timeout",
      "Git remote の確認がタイムアウトしました。",
      {
        isGitRepository: true
      }
    );
  }

  if (remoteOrigin.status !== "completed" || remoteOrigin.exitCode !== 0 || !remoteOrigin.stdout) {
    return createResponse(
      input,
      record.displayName,
      "remote_missing",
      "remote origin がありません。GitHub repository を設定してから登録してください。",
      {
        isGitRepository: true
      }
    );
  }

  const normalizedGithubRepoUrl = normalizeGithubRepoUrl(remoteOrigin.stdout);

  if (!normalizedGithubRepoUrl) {
    return createResponse(
      input,
      record.displayName,
      "remote_not_github",
      "remote origin が GitHub repository ではありません。",
      {
        isGitRepository: true,
        remoteOriginUrl: redactRemoteUrl(remoteOrigin.stdout)
      }
    );
  }

  const branch = await runGit(record.rootPath, ["symbolic-ref", "--short", "HEAD"]);

  return createResponse(
    input,
    record.displayName,
    "ready",
    "GitHub repository と紐付けできます。",
    {
      isGitRepository: true,
      remoteOriginUrl: redactRemoteUrl(remoteOrigin.stdout),
      normalizedGithubRepoUrl,
      defaultBranch: branch.status === "completed" && branch.exitCode === 0 ? branch.stdout : null,
      localPathHash: createLocalPathHash(canonicalRootPath),
      canRegister: true
    }
  );
};
