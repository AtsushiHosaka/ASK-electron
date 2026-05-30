# Electron Security Review Checklist

Use this checklist before release and when reviewing changes to main, preload, renderer boot, IPC, or local command execution.

## Automated Check

Run:

```sh
npm run security:electron
```

The check fails when:

- `BrowserWindow` enables `nodeIntegration`, disables `contextIsolation`, disables sandboxing, disables web security, or allows insecure content.
- The preload exposes `ipcRenderer`, generic IPC listeners/senders, `process.env`, or mutable privileged objects.
- The shared IPC contract adds arbitrary command execution channels.
- Renderer source imports Electron or Node built-ins, references `ipcRenderer`, or reads `process.env`.
- `.env.example` introduces secret-shaped values.

## Manual Review

- Confirm every new IPC channel is listed in `docs/architecture/electron-ipc-preload-contract.md`.
- Confirm privileged main handlers validate payload shape and use fixed command presets.
- Confirm renderer-visible environment variables are documented in `docs/security/renderer-env-and-secrets.md`.
- Confirm external URLs are opened only through a reviewed allowlist and `https:` URLs.
- Confirm no token, private key, service role key, database password, or raw local path is returned to renderer or written to logs.
