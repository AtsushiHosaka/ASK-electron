export const IpcChannel = {
  AppGetRuntimeInfo: "ask:v1:app:get-runtime-info",
  DiagnosticsRunLocal: "ask:v1:diagnostics:run-local"
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

export interface IpcRequestMap {
  [IpcChannel.AppGetRuntimeInfo]: [];
  [IpcChannel.DiagnosticsRunLocal]: [];
}

export interface IpcResponseMap {
  [IpcChannel.AppGetRuntimeInfo]: IpcResult<AppRuntimeInfoResponse>;
  [IpcChannel.DiagnosticsRunLocal]: IpcResult<LocalDiagnosticsResponse>;
}

export interface RendererApi {
  app: {
    getRuntimeInfo: () => Promise<IpcResponseMap[typeof IpcChannel.AppGetRuntimeInfo]>;
  };
  diagnostics: {
    runLocal: () => Promise<IpcResponseMap[typeof IpcChannel.DiagnosticsRunLocal]>;
  };
}
