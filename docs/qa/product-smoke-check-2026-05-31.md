# Product Smoke Check - 2026-05-31

Issue: #89

Scope: daily MVP product smoke check. This is separate from the macOS / Windows release E2E
checklist tracked by #78.

## Run Metadata

| Field                      | Value                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Date                       | 2026-05-31 03:20 JST                                                                        |
| Commit                     | `79d5d18d4fac0deae527b5bd8d9a540bd1e29bdc` (`79d5d18 Add thread lifecycle controls (#100)`) |
| Machine                    | macOS 26.4.1 (25E253), Apple Silicon                                                        |
| Node                       | v22.22.3                                                                                    |
| App command                | `npm run dev`                                                                               |
| Supabase target            | `.env` configured with hosted Supabase URL and publishable key                              |
| Fixture accounts attempted | `student-a@example.test` / local-only fixture password                                      |

## Result Summary

| Area                        | Result  | Notes                                                                                                              |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Electron dev launch         | Pass    | `npm run dev` built main, preload, and renderer, then opened the ASK window.                                       |
| Login screen                | Pass    | Window title was `ASK`; renderer loaded `localhost:5173/#/login` without a blank window.                           |
| Account creation screen     | Pass    | The login form toggled to account creation mode without a renderer crash. No account was submitted.                |
| Fixture login               | Blocked | `student-a@example.test` sign-in returned `メールアドレスまたはパスワードを確認してください。`                     |
| Authenticated student flows | Blocked | Could not reach student home, onboarding, project registration, question creation, thread detail, or patch review. |
| Authenticated teacher flows | Blocked | Could not verify teacher home, class management, teacher queue, chat, or status updates.                           |
| Local fixture fallback      | Blocked | `supabase status` cannot inspect local Supabase because Docker daemon is unavailable on this machine.              |

## Commands Run

```sh
npm run dev
supabase status
node -v
sw_vers
git rev-parse HEAD
```

The broader automated regression suite was also green on this commit while landing #100:

```sh
node --test tests/threadLifecycleControls.test.mjs
npm run typecheck
npm run lint
npm test
npm run format
npm run security:electron
npm run build
git diff --check
```

## Observations

- The unauthenticated shell rendered correctly with the expected Japanese product copy, email field,
  password field, login action, and account creation toggle.
- Login failure stayed in-place and preserved the form values, with a visible error message.
- The hosted Supabase project configured in `.env` does not currently accept the documented local
  fixture account.
- A local Supabase fixture reset was not possible because the Docker daemon is not available:
  `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`.

## Blockers

| Blocker                                                           | Tracking | Required before completing #89                                                                                                                                    |
| ----------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No seeded QA Supabase environment is available from this machine. | #101     | Provide either a local Docker-backed Supabase stack seeded with `supabase/seed.sql`, or an isolated hosted QA project containing the documented fixture accounts. |

## Not Run

- Student fixture login success and student home.
- Teacher fixture login success and teacher dashboard.
- Class creation, invite creation, and invite acceptance.
- Project registration folder picker, Git repository validation, and GitHub remote display.
- Question creation preview, related files, Git diff, environment snapshot, secret blocking, and AI fallback.
- Thread detail chat, code/diff rendering, lifecycle controls, teacher queue realtime reflection, and patch review/apply/revert.

These remain blocked by #101 rather than #78. #78 should continue to cover cross-platform release
sign-off once a seeded QA environment is available.
