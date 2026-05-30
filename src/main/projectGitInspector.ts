import type {
  ProjectGitInspectionRequest,
  ProjectGitInspectionResponse,
  ProjectGitInspectionStatus
} from "../shared/ipc";
import { runGit as defaultRunGit, type GitCommandResult } from "./gitCommand";
import {
  canonicalizePath as defaultCanonicalizePath,
  createLocalPathHash as defaultCreateLocalPathHash
} from "./projectPathIdentity";
import {
  getSelectedProjectRoot as defaultGetSelectedProjectRoot,
  type ProjectRootRecord
} from "./projectRootRegistry";

export interface ProjectGitInspectionDependencies {
  getSelectedProjectRoot?: (projectRootId: string) => ProjectRootRecord | null;
  runGit?: (rootPath: string, args: string[]) => Promise<GitCommandResult>;
  canonicalizePath?: (path: string) => Promise<string>;
  createLocalPathHash?: (path: string) => string;
}

interface ResolvedProjectGitInspectionDependencies {
  getSelectedProjectRoot: (projectRootId: string) => ProjectRootRecord | null;
  runGit: (rootPath: string, args: string[]) => Promise<GitCommandResult>;
  canonicalizePath: (path: string) => Promise<string>;
  createLocalPathHash: (path: string) => string;
}

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

const resolveDependencies = (
  dependencies: ProjectGitInspectionDependencies
): ResolvedProjectGitInspectionDependencies => ({
  getSelectedProjectRoot: dependencies.getSelectedProjectRoot ?? defaultGetSelectedProjectRoot,
  runGit: dependencies.runGit ?? defaultRunGit,
  canonicalizePath: dependencies.canonicalizePath ?? defaultCanonicalizePath,
  createLocalPathHash: dependencies.createLocalPathHash ?? defaultCreateLocalPathHash
});

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
  return inspectProjectGitWithDependencies(input);
};

export const inspectProjectGitWithDependencies = async (
  input: ProjectGitInspectionRequest,
  dependenciesInput: ProjectGitInspectionDependencies = {}
): Promise<ProjectGitInspectionResponse> => {
  const dependencies = resolveDependencies(dependenciesInput);
  const record = dependencies.getSelectedProjectRoot(input.projectRootId);

  if (!record) {
    throw new Error("PROJECT_ROOT_NOT_FOUND");
  }

  const canonicalRootPath = await dependencies.canonicalizePath(record.rootPath);
  const insideWorkTree = await dependencies.runGit(record.rootPath, [
    "rev-parse",
    "--is-inside-work-tree"
  ]);

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

  const topLevel = await dependencies.runGit(record.rootPath, ["rev-parse", "--show-toplevel"]);
  const canonicalTopLevelPath = topLevel.stdout
    ? await dependencies.canonicalizePath(topLevel.stdout)
    : null;

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

  const remoteOrigin = await dependencies.runGit(record.rootPath, ["remote", "get-url", "origin"]);

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

  const branch = await dependencies.runGit(record.rootPath, ["symbolic-ref", "--short", "HEAD"]);

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
      localPathHash: dependencies.createLocalPathHash(canonicalRootPath),
      canRegister: true
    }
  );
};
