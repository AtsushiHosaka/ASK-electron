# Electron IPC and Preload Contract

Status: foundation decision for issues #1, #2, and #3.

This document defines the first secure boundary between Electron main, preload, and renderer code. It is intentionally strict: renderer code is treated as untrusted UI code, and every local operation must pass through a typed, allowlisted preload API.

## Goals

- Renderer code cannot access Node APIs, `ipcRenderer`, `child_process`, `fs`, `process.env`, shell execution, or raw filesystem paths directly.
- Preload exposes a small `window.ask` API through `contextBridge`.
- Main process owns all local Git, environment, secret scanning, file selection, and patch operations.
- IPC channels are explicit, versioned, and deny-by-default.
- Request and response envelopes are shared across main, preload, and renderer type definitions.
- Audit metadata is captured for sensitive local operations without storing secrets or raw private path data.

## Process Boundary

### Renderer

Renderer code may only call methods on `window.ask`. It must not import Electron, Node, Supabase service credentials, filesystem helpers, or command helpers.

Renderer requests must be declarative. For example, it asks for `git.getStatus({ projectId })`; it never sends `git status` as a command string.

### Preload

Preload is the only bridge exposed to the renderer.

Required rules:

- Use `contextBridge.exposeInMainWorld("ask", api)`.
- Do not expose `ipcRenderer`, a generic `invoke(channel, payload)` function, Node modules, or mutable internal objects.
- Validate channel names by mapping each public method to exactly one internal channel constant.
- Validate basic payload shape before invoking main.
- Return only serializable data.
- Do not read or forward secrets from `process.env`.

### Main

Main is responsible for all privileged work.

Required rules:

- Register handlers only for channels listed in this document.
- Validate payloads again in main, even when preload already validates them.
- Resolve project roots from trusted app state, not arbitrary renderer-provided paths.
- Use fixed command presets and `spawn`/equivalent argument arrays. Do not use a shell.
- Apply timeouts, output size limits, and redaction before returning results or writing audit logs.
- Treat every failed validation as a denied operation and audit it.

## Public Preload API

The public renderer API should be shaped like this when implemented:

```ts
declare global {
  interface Window {
    ask: {
      app: {
        getRuntimeInfo(): Promise<AskResult<AppRuntimeInfo>>;
      };
      project: {
        selectRoot(): Promise<AskResult<ProjectRootSelection>>;
      };
      git: {
        diagnose(input: ProjectScopedInput): Promise<AskResult<GitDiagnostic>>;
        getStatus(input: ProjectScopedInput): Promise<AskResult<GitStatus>>;
        getDiffSummary(input: DiffSummaryInput): Promise<AskResult<GitDiffSummary>>;
        getFileDiff(input: FileDiffInput): Promise<AskResult<FileDiff>>;
        getRemoteInfo(input: ProjectScopedInput): Promise<AskResult<GitRemoteInfo>>;
      };
      github: {
        checkAuth(input: GithubAuthCheckInput): Promise<AskResult<GithubAuthState>>;
      };
      ssh: {
        checkGithub(input: SshGithubCheckInput): Promise<AskResult<SshGithubCheck>>;
      };
      env: {
        collect(input: EnvCollectInput): Promise<AskResult<EnvironmentSnapshot>>;
        checkTool(input: ToolCheckInput): Promise<AskResult<ToolCheck>>;
      };
      secrets: {
        scanText(input: SecretScanTextInput): Promise<AskResult<SecretScanResult>>;
        scanFiles(input: SecretScanFilesInput): Promise<AskResult<SecretScanResult>>;
      };
      patch: {
        validate(input: PatchValidateInput): Promise<AskResult<PatchValidation>>;
        apply(input: PatchApplyInput): Promise<AskResult<PatchApplyResult>>;
        revert(input: PatchRevertInput): Promise<AskResult<PatchRevertResult>>;
      };
    };
  }
}
```

No generic command runner, generic file reader, generic file writer, or generic IPC method is part of the renderer API.

## Channel Naming

Channels use this format:

```text
ask:v1:<domain>:<action>
```

Rules:

- `ask` identifies the app namespace.
- `v1` is the contract version.
- `<domain>` is a stable capability group.
- `<action>` is an imperative, kebab-case operation.
- Any channel not listed below is rejected.
- Channel names are constants shared by main and preload. Renderer code should not pass channel strings.

## Allowed Channels

| Channel                       | Public method        | Purpose                                                        | Security notes                                                                                                       |
| ----------------------------- | -------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ask:v1:app:get-runtime-info` | `app.getRuntimeInfo` | Return app version, platform, and contract version.            | Must not include environment variables, absolute paths, tokens, or machine user names.                               |
| `ask:v1:project:select-root`  | `project.selectRoot` | Let the user choose a project root through an OS dialog.       | Main creates or resolves a trusted `projectId`; renderer must not provide arbitrary roots for privileged operations. |
| `ask:v1:git:diagnose`         | `git.diagnose`       | Run a read-only Git health summary for a registered project.   | Uses only read-only Git presets. Redact absolute paths and remote credentials.                                       |
| `ask:v1:git:get-status`       | `git.getStatus`      | Read branch, HEAD, dirty state, and tracked changes.           | Read-only. Output is size-limited.                                                                                   |
| `ask:v1:git:get-diff-summary` | `git.getDiffSummary` | Read changed file names and diff stats for preview.            | Redact denied file names where secret rules require it.                                                              |
| `ask:v1:git:get-file-diff`    | `git.getFileDiff`    | Read a diff for a selected tracked file.                       | File path must be relative to the trusted project root and pass denylist checks.                                     |
| `ask:v1:git:get-remote-info`  | `git.getRemoteInfo`  | Read remote origin metadata needed for GitHub linking.         | Strip credentials from URLs before returning or logging.                                                             |
| `ask:v1:github:check-auth`    | `github.checkAuth`   | Check local GitHub CLI authentication state.                   | Fixed `gh auth status` preset only. Do not return tokens.                                                            |
| `ask:v1:ssh:check-github`     | `ssh.checkGithub`    | Check whether SSH can authenticate to GitHub.                  | Fixed GitHub host only. Do not return private key paths or key material.                                             |
| `ask:v1:env:collect`          | `env.collect`        | Collect a whitelisted environment snapshot.                    | Never collect full environment variables or private file contents.                                                   |
| `ask:v1:env:check-tool`       | `env.checkTool`      | Check one approved tool version, such as Git or Node.          | Tool name must be an enum, not a command string.                                                                     |
| `ask:v1:secrets:scan-text`    | `secrets.scanText`   | Scan renderer-provided text before sending to AI or chat.      | Return findings and redacted preview, not raw matched secret values.                                                 |
| `ask:v1:secrets:scan-files`   | `secrets.scanFiles`  | Scan selected project files before preview or upload.          | Paths must be relative, inside project root, and subject to denylist rules.                                          |
| `ask:v1:patch:validate`       | `patch.validate`     | Parse and validate a proposed patch without writing files.     | Produces a confirmation token only after path, denylist, and conflict checks pass.                                   |
| `ask:v1:patch:apply`          | `patch.apply`        | Apply a previously validated patch after student confirmation. | Requires `patchId` and confirmation token from `patch.validate`; creates backup metadata.                            |
| `ask:v1:patch:revert`         | `patch.revert`       | Revert a patch from app-created backup metadata.               | Can only revert patches that ASK applied and recorded.                                                               |

## Disallowed IPC Patterns

The following must not be added without a security review and a new contract version:

- `shell:run`, `command:execute`, or any generic command channel.
- Generic `fs:read`, `fs:write`, `path:exists`, `open:any`, or recursive directory listing channels.
- Any channel that accepts absolute filesystem paths from renderer for privileged work.
- Any channel that returns `process.env`, raw `.env` contents, tokens, SSH private key paths, private keys, or Supabase service credentials.
- Any channel that applies teacher or AI patches without explicit student confirmation.

## Request Envelope

Every main-process handler receives a normalized envelope:

```ts
export type AskRequest<TPayload> = {
  requestId: string;
  channel: AskIpcChannel;
  contractVersion: "v1";
  payload: TPayload;
  client: {
    rendererRoute?: string;
    appSessionId?: string;
  };
};
```

Rules:

- `requestId` is generated in preload if renderer did not provide one.
- Main must not trust `rendererRoute` or `appSessionId` for authorization.
- Privileged requests should include `projectId`, `threadId`, or `patchId` instead of raw paths where possible.
- All payloads must be JSON-serializable.

## Result Envelope

All preload methods return `AskResult<T>`.

```ts
export type AskResult<TData> =
  | {
      ok: true;
      data: TData;
      meta: AskResponseMeta;
    }
  | {
      ok: false;
      error: AskError;
      meta: AskResponseMeta;
    };

export type AskResponseMeta = {
  requestId: string;
  channel: AskIpcChannel;
  contractVersion: "v1";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type AskError = {
  code: AskErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};
```

Renderer-facing `message` values are safe UI strings. Developer diagnostics, command stderr, stack traces, absolute paths, and raw secret matches must not be included in `message`.

## Error Codes

| Code                  | Meaning                                                            | Retryable          |
| --------------------- | ------------------------------------------------------------------ | ------------------ |
| `VALIDATION_FAILED`   | Payload shape, enum, path, patch, or size validation failed.       | No                 |
| `CHANNEL_NOT_ALLOWED` | Channel is not registered in the allowlist.                        | No                 |
| `AUTH_REQUIRED`       | User or GitHub authentication is required.                         | Yes                |
| `FORBIDDEN`           | User, role, project, or thread scope does not allow the operation. | No                 |
| `PROJECT_NOT_FOUND`   | The trusted project record is missing or unavailable.              | No                 |
| `TOOL_NOT_FOUND`      | Required local tool is not installed or not on PATH.               | Yes                |
| `TIMEOUT`             | A local diagnostic command exceeded its timeout.                   | Yes                |
| `COMMAND_FAILED`      | An approved local command returned a non-zero exit status.         | Depends on handler |
| `SECRET_DETECTED`     | Secret scanning found blocked content.                             | No                 |
| `PATCH_CONFLICT`      | Patch does not apply cleanly to current files.                     | No                 |
| `PATCH_REJECTED`      | Patch targets denied paths or violates patch policy.               | No                 |
| `INTERNAL`            | Unexpected application error after redaction.                      | Yes                |

## Command Presets

Main may run only named presets. A preset defines executable, fixed arguments, allowed dynamic arguments, timeout, maximum output size, and redaction policy.

Allowed initial presets:

| Preset            | Dynamic input                    | Notes                                                     |
| ----------------- | -------------------------------- | --------------------------------------------------------- |
| `git.version`     | none                             | Executes Git version check only.                          |
| `git.status`      | `projectId`                      | Uses trusted project root as cwd.                         |
| `git.revParse`    | `projectId`, fixed ref enum      | No arbitrary rev strings from renderer.                   |
| `git.remote`      | `projectId`                      | Redacts credentials from remote URLs.                     |
| `git.diffSummary` | `projectId`, optional base enum  | Summary only.                                             |
| `git.fileDiff`    | `projectId`, relative file path  | Path must be inside project root and not denied.          |
| `git.checkIgnore` | `projectId`, relative file paths | Used before preview/upload decisions.                     |
| `gh.authStatus`   | optional account hint            | Fixed host `github.com`; no token output.                 |
| `ssh.githubTest`  | none                             | Fixed target `git@github.com`; timeout required.          |
| `tool.version`    | approved tool enum               | Examples: `node`, `npm`, `pnpm`, `yarn`, `python`, `pip`. |

Patch validation and application should use structured patch parsing where possible. They must not shell out to arbitrary commands assembled from renderer input.

## Path Rules

- Main stores canonical project roots in trusted app state.
- Renderer may display a root label, but privileged handlers must resolve by `projectId`.
- File inputs from renderer are relative paths only.
- Reject absolute paths, `..` traversal, empty paths, home-directory expansion, drive-root paths, symlinks that escape the project, and paths outside the trusted project root.
- Deny patching or uploading `.env`, private keys, credential stores, dependency directories, build outputs, and other paths blocked by the secret policy.
- Audit logs should store `projectRootHash` and relative paths. Do not store raw absolute paths unless a future privacy review explicitly allows it.

## Patch Safety Rules

Patch application is sensitive because it writes to a student's local project.

Required flow:

1. `patch.validate` parses the patch, normalizes paths, checks denied files, detects conflicts, and produces a `patchId`.
2. Renderer shows the diff and requires explicit student confirmation.
3. `patch.apply` receives the `patchId` plus a confirmation token minted by validation.
4. Main revalidates the patch against current file contents.
5. Main creates backup metadata before writing.
6. Main writes only the files listed in the validated patch.
7. Main records audit metadata for success, failure, and revert.

Teachers and AI systems can propose patches, but only the student can trigger local apply on their machine.

## Audit Metadata

Every IPC handler should produce an audit candidate. Sensitive handlers must persist an audit record after redaction.

Sensitive handlers:

- Git diagnostics and diff reads.
- Environment collection.
- Secret scanning.
- GitHub and SSH checks.
- Patch validation, application, and revert.

Expected audit fields:

```ts
export type AskAuditMetadata = {
  eventId: string;
  requestId: string;
  channel: AskIpcChannel;
  operation: string;
  actorUserId?: string;
  actorRole?: "student" | "teacher" | "admin" | "system";
  appSessionId?: string;
  projectId?: string;
  threadId?: string;
  patchId?: string;
  projectRootHash?: string;
  relativePaths?: string[];
  commandPreset?: string;
  decision: "allowed" | "denied" | "blocked" | "failed" | "succeeded";
  errorCode?: AskErrorCode;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  redaction: {
    absolutePathsRedacted: boolean;
    secretsRedacted: boolean;
    outputTruncated: boolean;
  };
};
```

Do not store:

- Raw `.env` values.
- GitHub tokens, Supabase service keys, AI provider keys, SSH key material, or private key paths.
- Full command stdout/stderr when it can contain user files, secrets, or absolute paths.
- Raw absolute paths to student projects.

## Implementation Checklist

- Electron window uses `contextIsolation: true` and `nodeIntegration: false`.
- Preload exposes `window.ask` only through method groups, not generic IPC.
- Main registers only the allowed channel constants above.
- Payload validation exists in both preload and main.
- Command execution uses named presets, no shell, timeouts, and output limits.
- Patch apply requires validation output and explicit student confirmation.
- Renderer public config is allowlisted and contains no secrets.
- Audit records redact paths, command output, and secret-like values before storage.
