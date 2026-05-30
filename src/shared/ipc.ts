export const IpcChannel = {
  AppGetRuntimeInfo: "ask:v1:app:get-runtime-info",
  DiagnosticsRunLocal: "ask:v1:diagnostics:run-local",
  ProjectSelectRoot: "ask:v1:project:select-root",
  ProjectInspectGit: "ask:v1:project:inspect-git",
  GitDiffCollect: "ask:v1:git-diff:collect",
  EnvironmentSnapshotCollect: "ask:v1:environment-snapshot:collect",
  GitignorePreview: "ask:v1:gitignore:preview",
  GitignoreApply: "ask:v1:gitignore:apply"
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

export interface IpcAuditMetadata {
  channel: IpcChannelName;
  requestedAt: string;
  requestId: string;
}

export interface IpcError {
  code: string;
  message: string;
  retryable: boolean;
}

export type IpcResult<T> =
  | {
      ok: true;
      data: T;
      meta: IpcAuditMetadata;
    }
  | {
      ok: false;
      error: IpcError;
      meta: IpcAuditMetadata;
    };

export interface AppRuntimeInfoResponse {
  contractVersion: "v1";
  appVersion: string;
  platform:
    | "aix"
    | "android"
    | "darwin"
    | "freebsd"
    | "haiku"
    | "linux"
    | "openbsd"
    | "sunos"
    | "win32"
    | "cygwin"
    | "netbsd";
  isPackaged: boolean;
}

export type DiagnosticStatus =
  | "ok"
  | "missing"
  | "unauthenticated"
  | "auth_failed"
  | "network_error"
  | "timeout"
  | "host_key_failed"
  | "error"
  | "unknown";

export interface GitDiagnostic {
  status: Extract<DiagnosticStatus, "ok" | "missing" | "timeout" | "error" | "unknown">;
  installed: boolean;
  version: string | null;
  message: string;
}

export interface GitHubCliDiagnostic {
  status: Extract<
    DiagnosticStatus,
    "ok" | "missing" | "unauthenticated" | "network_error" | "timeout" | "error" | "unknown"
  >;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  account: string | null;
  message: string;
}

export interface SshKeyCandidate {
  name: string;
  keyType: "ed25519" | "ecdsa" | "rsa" | "dsa" | "unknown";
  hasPublicKey: boolean;
  hasPrivateKeyCandidate: boolean;
}

export interface SshKeyDiagnostic {
  status: Extract<DiagnosticStatus, "ok" | "missing" | "error" | "unknown">;
  candidateCount: number;
  candidates: SshKeyCandidate[];
  message: string;
}

export interface SshConnectionDiagnostic {
  status: Extract<
    DiagnosticStatus,
    | "ok"
    | "missing"
    | "auth_failed"
    | "network_error"
    | "timeout"
    | "host_key_failed"
    | "error"
    | "unknown"
  >;
  authenticated: boolean;
  account: string | null;
  message: string;
}

export interface LocalDiagnosticsResponse {
  contractVersion: "v1";
  checkedAt: string;
  timeoutMs: number;
  git: GitDiagnostic;
  githubCli: GitHubCliDiagnostic;
  ssh: {
    keys: SshKeyDiagnostic;
    connection: SshConnectionDiagnostic;
  };
  summary: {
    ready: boolean;
    blockingChecks: Array<"git" | "githubCli" | "githubAuth" | "sshKeys" | "sshConnection">;
  };
}

export interface ProjectRootSelectionResponse {
  contractVersion: "v1";
  selected: boolean;
  projectRootId: string | null;
  displayName: string | null;
  selectedAt: string | null;
}

export type ProjectGitInspectionStatus =
  | "ready"
  | "git_missing"
  | "git_timeout"
  | "not_git_repository"
  | "not_git_root"
  | "remote_missing"
  | "remote_not_github";

export interface ProjectGitInspectionRequest {
  projectRootId: string;
}

export interface ProjectGitInspectionResponse {
  contractVersion: "v1";
  projectRootId: string;
  displayName: string;
  status: ProjectGitInspectionStatus;
  isGitRepository: boolean;
  remoteOriginUrl: string | null;
  normalizedGithubRepoUrl: string | null;
  defaultBranch: string | null;
  localPathHash: string | null;
  canRegister: boolean;
  message: string;
}

export type GitDiffCollectionStatus =
  | "ready"
  | "empty"
  | "root_missing"
  | "git_missing"
  | "git_timeout"
  | "not_git_repository"
  | "diff_failed";

export type GitDiffOmissionReason = "binary" | "lockfile" | "secret_candidate" | "too_many_files";

export interface GitDiffCollectionRequest {
  projectRootId?: string;
  localPathHash?: string | null;
}

export interface GitChangedFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
  stagedStatus: string | null;
  unstagedStatus: string | null;
  isBinary: boolean;
  isLockfile: boolean;
  requiresSecretScan: boolean;
  includedInDiff: boolean;
  omissionReason: GitDiffOmissionReason | null;
}

export interface GitDiffTextSection {
  text: string;
  includedFileCount: number;
  omittedFileCount: number;
  truncated: boolean;
}

export interface GitDiffCollectionResponse {
  contractVersion: "v1";
  status: GitDiffCollectionStatus;
  canContinue: boolean;
  projectRootId: string | null;
  displayName: string | null;
  collectedAt: string;
  branch: string | null;
  headCommit: string | null;
  headShortCommit: string | null;
  changedFiles: GitChangedFile[];
  stagedDiff: GitDiffTextSection;
  unstagedDiff: GitDiffTextSection;
  omittedFiles: Array<Pick<GitChangedFile, "path" | "omissionReason">>;
  sensitiveFilePaths: string[];
  limits: {
    timeoutMs: number;
    maxDiffChars: number;
    maxDiffCharsPerSection: number;
    maxIncludedFilesPerSection: number;
  };
  message: string;
}

export type EnvironmentSnapshotStatus = "ready" | "partial";

export interface EnvironmentSnapshotRequest {
  projectRootId?: string;
  localPathHash?: string | null;
}

export interface VersionProbe {
  available: boolean;
  version: string | null;
}

export interface DependencyGroupSummary {
  count: number;
  sample: string[];
}

export interface ManifestDependencySummary {
  file: string;
  kind: "node" | "python";
  name: string | null;
  dependencies: DependencyGroupSummary;
  devDependencies: DependencyGroupSummary;
}

export interface EnvironmentSnapshotResponse {
  contractVersion: "v1";
  status: EnvironmentSnapshotStatus;
  collectedAt: string;
  canContinue: boolean;
  projectRootId: string | null;
  displayName: string | null;
  os: {
    name: string;
    version: string;
    arch: string;
  };
  gitVersion: string | null;
  editor: {
    name: string | null;
    version: string | null;
  };
  runtimes: {
    node: VersionProbe;
    python: VersionProbe;
  };
  packageManagers: {
    npm: VersionProbe;
    pnpm: VersionProbe;
    yarn: VersionProbe;
    pip: VersionProbe;
  };
  dependenciesSummary: {
    projectDetected: boolean;
    manifests: ManifestDependencySummary[];
    lockfiles: string[];
    warnings: string[];
  };
  warnings: string[];
  limits: {
    timeoutMs: number;
    dependencySampleLimit: number;
  };
  message: string;
}

export type GitignoreProjectKind = "node" | "electron" | "python" | "generic";

export interface GitignorePreviewRequest {
  projectRootId: string;
}

export interface GitignoreApplyRequest {
  projectRootId: string;
  recommendationHash: string;
}

export interface GitignoreRecommendationEntry {
  pattern: string;
  reason: string;
  required: boolean;
  alreadyPresent: boolean;
}

export interface GitignorePreviewResponse {
  contractVersion: "v1";
  projectRootId: string;
  displayName: string;
  detectedKinds: GitignoreProjectKind[];
  gitignoreExists: boolean;
  existingLineCount: number;
  recommendationHash: string;
  entries: GitignoreRecommendationEntry[];
  missingPatterns: string[];
  appendBlock: string;
  previewDiff: string;
  manualCopyText: string;
  canApply: boolean;
}

export interface GitignoreApplyResponse {
  contractVersion: "v1";
  projectRootId: string;
  displayName: string;
  status: "applied" | "unchanged" | "stale" | "failed";
  recommendationHash: string;
  appendedLineCount: number;
  manualCopyText: string;
  message: string;
}

export interface IpcRequestMap {
  [IpcChannel.AppGetRuntimeInfo]: [];
  [IpcChannel.DiagnosticsRunLocal]: [];
  [IpcChannel.ProjectSelectRoot]: [];
  [IpcChannel.ProjectInspectGit]: [ProjectGitInspectionRequest];
  [IpcChannel.GitDiffCollect]: [GitDiffCollectionRequest];
  [IpcChannel.EnvironmentSnapshotCollect]: [EnvironmentSnapshotRequest];
  [IpcChannel.GitignorePreview]: [GitignorePreviewRequest];
  [IpcChannel.GitignoreApply]: [GitignoreApplyRequest];
}

export interface IpcResponseMap {
  [IpcChannel.AppGetRuntimeInfo]: IpcResult<AppRuntimeInfoResponse>;
  [IpcChannel.DiagnosticsRunLocal]: IpcResult<LocalDiagnosticsResponse>;
  [IpcChannel.ProjectSelectRoot]: IpcResult<ProjectRootSelectionResponse>;
  [IpcChannel.ProjectInspectGit]: IpcResult<ProjectGitInspectionResponse>;
  [IpcChannel.GitDiffCollect]: IpcResult<GitDiffCollectionResponse>;
  [IpcChannel.EnvironmentSnapshotCollect]: IpcResult<EnvironmentSnapshotResponse>;
  [IpcChannel.GitignorePreview]: IpcResult<GitignorePreviewResponse>;
  [IpcChannel.GitignoreApply]: IpcResult<GitignoreApplyResponse>;
}

export interface RendererApi {
  app: {
    getRuntimeInfo: () => Promise<IpcResponseMap[typeof IpcChannel.AppGetRuntimeInfo]>;
  };
  diagnostics: {
    runLocal: () => Promise<IpcResponseMap[typeof IpcChannel.DiagnosticsRunLocal]>;
  };
  project: {
    selectRoot: () => Promise<IpcResponseMap[typeof IpcChannel.ProjectSelectRoot]>;
    inspectGit: (
      input: ProjectGitInspectionRequest
    ) => Promise<IpcResponseMap[typeof IpcChannel.ProjectInspectGit]>;
  };
  gitDiff: {
    collect: (
      input: GitDiffCollectionRequest
    ) => Promise<IpcResponseMap[typeof IpcChannel.GitDiffCollect]>;
  };
  environment: {
    collectSnapshot: (
      input: EnvironmentSnapshotRequest
    ) => Promise<IpcResponseMap[typeof IpcChannel.EnvironmentSnapshotCollect]>;
  };
  gitignore: {
    preview: (
      input: GitignorePreviewRequest
    ) => Promise<IpcResponseMap[typeof IpcChannel.GitignorePreview]>;
    apply: (
      input: GitignoreApplyRequest
    ) => Promise<IpcResponseMap[typeof IpcChannel.GitignoreApply]>;
  };
}
