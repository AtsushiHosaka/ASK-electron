# ADR 0001: GitHub Auth Onboarding for MVP

Status: accepted for MVP

Issue: #7

## Context

ASK requires GitHub integration before a student can register a project. The
onboarding flow must work for students who are new to Git and GitHub, while also
avoiding long-lived secrets in the Electron app.

Official references used for this decision:

- GitHub CLI `gh auth login`: https://cli.github.com/manual/gh_auth_login
- GitHub CLI `gh auth status`: https://cli.github.com/manual/gh_auth_status
- GitHub OAuth app authorization and Device Flow:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

## Decision

Use `gh auth login` as the primary MVP path.

Use GitHub OAuth Device Flow as the fallback path when GitHub CLI is missing,
broken, or blocked by class setup constraints.

Treat personal access token input as a last-resort manual recovery path, not a
normal onboarding option.

## Primary Path: GitHub CLI

ASK should guide the student through GitHub CLI instead of collecting tokens in
the app.

Recommended app checks:

1. Check whether `gh` is installed.
2. Run `gh auth status` to detect whether the user is already authenticated.
3. If not authenticated, guide the student to run `gh auth login`.
4. Prefer browser-based login.
5. Prefer SSH as the Git protocol for local project work.
6. After login, run `gh auth status` again.
7. Continue to SSH key detection and `ssh -T git@github.com` style connectivity
   checks.

The app should not wrap this as a generic command runner. It should expose fixed
diagnostic operations through the secure IPC contract.

## Fallback Path: Device Flow

Device Flow is appropriate when:

- `gh` is not installed.
- Installing `gh` is too difficult in a classroom setting.
- The app needs a guided browser/device-code flow without asking for a client
  secret on the user's machine.

ASK should use Device Flow only through a trusted server-side boundary or a
reviewed OAuth app configuration. The Electron app must not ship a GitHub client
secret.

Minimum UX shape:

1. Show a short code and GitHub verification URL.
2. Provide a copy button for the code.
3. Poll for completion with a clear timeout.
4. Store resulting tokens only in an OS credential store or a trusted backend
   flow, never in renderer state or plain files.
5. If the flow expires, return to the same step with a retry button.

## Last Resort: PAT

PAT input should be hidden behind an "advanced / teacher help" path.

If PAT input is ever enabled:

- Explain that this is not the normal path.
- Request the minimum scopes needed for the concrete operation.
- Never log the token.
- Never store it in renderer state, Supabase rows, audit logs, or app config.
- Prefer OS credential storage over local files.
- Offer a clear "remove token" action.

## Initial Student Copy

Use short, action-oriented language:

> ASK needs GitHub so your teacher can see the code history and changed files for
> this project. We will check your GitHub login first. ASK will not ask you to
> paste a GitHub password.

When `gh` is missing:

> GitHub CLI is not installed. Install it first, then come back and press
> "Check again". If you cannot install it, ask your teacher and use the browser
> code login instead.

When `gh auth status` fails:

> GitHub login is not complete on this computer. Run the login step, then press
> "Check again".

When Device Flow is used:

> Open GitHub in your browser, enter this code, then return to ASK. This code
> expires, so press "Retry" if it takes too long.

## Security Requirements

- Renderer never receives GitHub tokens.
- Main/preload never expose a generic command API.
- GitHub auth checks are fixed operations, not arbitrary shell commands.
- Token-like output from `gh` or OAuth errors is redacted before UI or logs.
- SSH private keys are detected by existence/status only; ASK never reads key
  contents.
- GitHub authentication status is stored as state, not as raw credentials.

## Follow-Up Implementation Work

- #8 should render this flow in the student onboarding UI.
- #12 should implement fixed local diagnostics for `gh`, Git, and SSH.
- #10 should block project registration when GitHub connection is incomplete.
