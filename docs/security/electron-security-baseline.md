# Electron Security Baseline

Status: foundation security requirements for issue #1 and issue #2.

This document defines the minimum Electron security posture for the ASK desktop app. The renderer is an untrusted UI surface. Main and preload code are the only places allowed to touch privileged Electron and Node capabilities.

## Required BrowserWindow Settings

Every application window that loads ASK renderer code must use these settings:

```ts
new BrowserWindow({
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false
  }
});
```

Requirements:

- `contextIsolation` must be `true`.
- `nodeIntegration` must be `false`.
- `preload` must point to the audited ASK preload entrypoint.
- `sandbox` should be `true`. If a platform or dependency blocks sandboxing, document the reason and keep the exception local to the affected window.
- `webSecurity` must remain `true`.
- `allowRunningInsecureContent` must remain `false`.

## Renderer Restrictions

Renderer code must not:

- Import `electron`, `fs`, `path`, `child_process`, or other Node modules.
- Read `process.env`.
- Receive `ipcRenderer` or any generic IPC helper from preload.
- Execute local commands.
- Read or write arbitrary local files.
- Store Supabase service role keys, AI provider keys, GitHub tokens, SSH private keys, or local credential material.

Renderer code may:

- Use the typed `window.ask` preload API.
- Use explicitly public runtime config, such as the Supabase URL and publishable key.
- Render local diagnostic results returned by main after redaction.
- Ask the student to confirm sensitive local writes, such as patch application.

## Preload Restrictions

Preload must be small, typed, and defensive.

Required rules:

- Use `contextBridge.exposeInMainWorld`.
- Freeze or otherwise avoid exposing mutable privileged objects.
- Map public methods to fixed channel constants.
- Validate obvious payload shape before invoking main.
- Return `AskResult<T>` envelopes only.
- Never expose `ipcRenderer`, raw Node modules, `process`, or `process.env`.
- Never embed secrets in the exposed API.

Preload is not the final trust boundary. Main must still validate every request.

## Main Process Restrictions

Main process handlers own privileged behavior and must enforce the contract.

Required rules:

- Register only documented IPC channels.
- Reject unknown channels and malformed payloads.
- Run local diagnostics through command presets, not renderer-provided command strings.
- Use no-shell process execution.
- Apply per-operation timeouts and output limits.
- Redact command output before returning it to renderer or audit logs.
- Resolve local project roots from trusted app state.
- Require student confirmation for any local patch write.

## Navigation and Window Controls

Renderer navigation should be constrained.

Requirements:

- Block unexpected top-level navigation away from the app origin.
- Deny or intercept `window.open`.
- Open external URLs through the OS browser only after validating the URL scheme and host.
- Allow only `https:` external links unless a documented local development exception applies.
- Do not allow remote content to inject or replace preload code.

## Content Security Policy

The renderer should ship with a restrictive CSP.

Baseline policy intent:

- Scripts load from the packaged app or local dev server only.
- Inline script execution is disallowed in production.
- Connections are limited to the Supabase project, approved AI/Supabase Function endpoints, and local dev server during development.
- Images, fonts, and styles are limited to app-controlled sources unless a feature needs a reviewed exception.

Production builds should not require `unsafe-eval`.

## Local Command Execution

ASK must not contain an arbitrary command runner.

Allowed local commands are represented as command presets in the IPC contract. Each preset defines:

- Executable.
- Fixed arguments.
- Allowed dynamic arguments, if any.
- Working directory policy.
- Timeout.
- Output size limit.
- Redaction policy.

Renderer input can select a preset through a typed method, but it cannot supply a command line.

## Patch Application Safety

Patch application writes to local files and must be treated as a high-risk operation.

Requirements:

- Only the student can initiate local apply.
- Teacher and AI patches are proposals until the student confirms.
- Patch validation must run before patch application.
- Patch targets must be relative to the trusted project root.
- Denied paths, secret-like files, path traversal, and project escape attempts must be blocked.
- Main must create backup metadata before writing.
- Apply, failure, and revert events must be audited after redaction.

## Secret Scanning

ASK must run the shared secret scanner before content leaves the student workflow.

Requirements:

- Block `.env`, SSH private keys, GitHub tokens, private key material, and high-confidence API key values.
- Treat low-confidence secret keywords and filenames as warnings that require explicit false-positive confirmation.
- Show finding locations and redacted previews in the send-before preview.
- Reuse the same scanner for question messages, Git diff context, environment summaries, and future AI request payloads.
- Do not include raw matched secret values in UI copy, logs, audit metadata, or AI prompts.

## Development Checks

Before merging Electron foundation work, verify:

- No renderer code imports Node or Electron modules.
- No preload code exposes generic IPC.
- Unknown IPC channels are denied.
- `contextIsolation: true` and `nodeIntegration: false` are present for every app window.
- Public environment variables are explicitly allowlisted.
- Sensitive local operations produce audit metadata.

These checks can start as documentation and code review requirements, then become automated tests once the Electron shell exists.
