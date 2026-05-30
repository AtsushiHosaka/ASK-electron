# Renderer Environment and Secret Separation

Status: foundation security requirements for issue #3, with Electron implications for issue #1.

ASK must keep renderer-visible configuration separate from secrets. Electron renderer bundles are inspectable by users and must be treated like browser code.

## Rule

Anything available to renderer code is public.

Do not place service credentials, API provider secrets, GitHub tokens, SSH key material, database credentials, or admin keys in renderer code, preload API responses, build-time renderer variables, or packaged app assets.

## Public Renderer Config

The renderer may receive only explicit public configuration.

Initial allowlist:

| Variable                        | Renderer visibility | Notes                                                                                               |
| ------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | Public              | Supabase project URL.                                                                               |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public              | Supabase publishable key. It is not a secret, but it must rely on RLS and least-privilege policies. |

Rules:

- The `VITE_` prefix means "bundled into renderer code", not "safe by default".
- Do not add new `VITE_` variables unless they are intended to be public.
- Renderer config should be parsed through an explicit schema or allowlist.
- Missing required public config should fail fast with a safe UI error.
- Public Supabase access still requires RLS on every table and function authorization checks where applicable.

## Secret Locations

Secrets must live outside the renderer.

Examples:

| Secret                              | Location                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`         | Supabase Edge Function secret or trusted server only.                             |
| AI provider keys                    | Supabase Edge Function secrets or trusted server only.                            |
| GitHub OAuth client secret          | Trusted server or Supabase Function secret only.                                  |
| Webhook signing secrets             | Trusted server or Supabase Function secret only.                                  |
| Database URLs and admin credentials | Trusted server or Supabase infrastructure only.                                   |
| GitHub access tokens                | OS credential store or provider-managed auth flow, never renderer bundle or logs. |
| SSH private keys                    | User's SSH agent or OS keychain, never read into renderer or uploaded.            |

Main process code in a packaged Electron app is still distributed to the user's machine. Do not ship long-lived backend secrets in main or preload either.

## Supabase Client Boundary

Renderer may use a Supabase client configured with:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

That client must be treated as a user-scoped client. Authorization is enforced by:

- Supabase Auth session.
- Row Level Security on database tables.
- Function-side authorization checks for privileged operations.

Renderer must never receive:

- Supabase service role key.
- SQL connection strings.
- Admin API keys.
- Function secrets.
- Secrets fetched from `.env` files.

## Main and Preload Environment Use

Main and preload should not expose general environment access.

Rules:

- Do not expose `process.env` through preload.
- Do not return an environment dump through IPC.
- Do not log environment variables.
- If main needs a non-secret runtime value, read it through an explicit allowlist and return only that value.
- If a value is needed by renderer, prefer a clearly public `VITE_` variable and document it here.

## Local `.env` Handling

Local `.env` files are high-risk because students may keep API keys, database URLs, and tokens in project folders.

Requirements:

- `.env` contents must not be sent to chat, AI, Supabase rows, logs, or audit metadata.
- Secret scanning should block or redact `.env`, `.env.*`, private keys, token files, and credential stores by default.
- `.env.example` may contain placeholders only.
- Error messages may mention that a secret-like file was blocked, but must not include matched secret values.

## Audit and Logging Expectations

Audit records should prove that sensitive operations happened without storing sensitive values.

Allowed audit data:

- Operation name.
- IPC channel.
- Actor and project IDs.
- Relative file paths when needed.
- Hash of project root instead of raw absolute path.
- Secret scan finding types and counts.
- Redaction flags.
- Error code.

Forbidden audit data:

- Raw public or secret env values.
- `.env` file contents.
- Supabase service role key.
- AI provider keys.
- GitHub tokens.
- SSH private key contents or private key paths.
- Full command output that may include user files or secrets.

## Adding New Environment Variables

When adding a new variable:

1. Decide whether renderer must see it.
2. If renderer must see it, document it in the public allowlist and ensure it is not a secret.
3. If it is secret, keep it in Supabase Function secrets or another trusted server-side secret store.
4. Update validation so missing or malformed config fails clearly.
5. Confirm logs and audit metadata cannot include the value.

Default decision: secrets do not belong in the Electron app.
