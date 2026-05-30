# macOS / Windows E2E Release Record - 2026-05-31

Issue: #78

Status: blocked before release sign-off. This record captures what was executed on the available
macOS environment and what still needs a seeded QA environment or Windows runner.

## Run Metadata

| Field            | Value                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Date             | 2026-05-31 03:33 JST                                                                                      |
| Commit           | `89205fafb717bf8a5a8a011ca5483a9a1aa61e8b` (`89205fa Add AI escalation flow (#104)`)                      |
| App version      | 0.1.0                                                                                                     |
| Tester           | Codex on local macOS                                                                                      |
| macOS            | 26.4.1 (25E253), Apple Silicon                                                                            |
| Windows          | Not available in this session                                                                             |
| Node             | v22.22.3                                                                                                  |
| Fixture accounts | Documented accounts in `docs/qa/test-accounts-and-login-fixtures.md`; authenticated flows blocked by #101 |

## Automated Checks

| Check                                       | Result  | Notes                                                                           |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `npm test`                                  | Pass    | 96 tests, 24 suites.                                                            |
| `npm run build`                             | Pass    | Typecheck plus Electron Vite main/preload/renderer build.                       |
| `npm run security:electron`                 | Pass    | Electron security checks passed.                                                |
| `npm run format`                            | Pass    | All matched files use Prettier style.                                           |
| `npm run test:rls:static`                   | Pass    | 6 RLS/static fixture tests passed.                                              |
| `ASK_RLS_DATABASE_URL=... npm run test:rls` | Blocked | `psql was not found. Install PostgreSQL client tools before running RLS tests.` |

## Manual macOS Checks

| Area                      | Result  | Notes                                                                                                                                      |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| App launch                | Pass    | `npm run dev` built main/preload and opened an ASK window.                                                                                 |
| Login screen              | Pass    | Window title was `ASK`; renderer loaded `localhost:5173/#/login`; no blank window.                                                         |
| Supabase fixture login    | Blocked | Hosted `.env` target does not accept the documented fixture account. See #101 and `docs/qa/product-smoke-check-2026-05-31.md`.             |
| Authenticated student E2E | Blocked | Cannot verify onboarding, project registration, question creation, AI fallback, thread chat, or patch review without seeded fixture login. |
| Authenticated teacher E2E | Blocked | Cannot verify teacher home, queue, class flows, status changes, or patch proposal without seeded fixture login.                            |
| DB-backed RLS             | Blocked | Local RLS runner needs `psql`; local Supabase fixture stack is also unavailable because Docker daemon is unavailable.                      |

## Windows Checks

| Area                         | Result  | Notes                                                                                         |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| Windows launch and login     | Not run | No Windows runner or VM is available in this session.                                         |
| Windows Git/GitHub/SSH paths | Not run | Needs a Windows QA machine with Git for Windows, GitHub CLI, SSH, and fixture repository.     |
| Windows project registration | Not run | Needs Windows filesystem path coverage, including paths with spaces and `C:\Users\...` roots. |
| Windows patch apply/revert   | Not run | Needs a Windows fixture repository and local write/revert validation.                         |

## MVP Success Conditions

| Condition                                                                   | Result                | Evidence                                                                                                                                                  |
| --------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Student can register GitHub-linked project                                  | Blocked               | Requires authenticated fixture student and seeded QA Supabase (#101).                                                                                     |
| Student can send a question with code, diff, environment, and secret checks | Blocked               | Requires authenticated fixture student and fixture repository (#101).                                                                                     |
| Teacher can see unanswered questions in the queue                           | Blocked               | Requires authenticated fixture teacher and seeded class/thread data (#101).                                                                               |
| Student and teacher can exchange chat messages                              | Blocked               | Requires fixture login and seeded thread (#101).                                                                                                          |
| AI can assist with question text, cause candidates, and patch proposal      | Partially covered     | Automated tests cover AI provider fallback, secret blocking, patch proposal parsing, and thread AI escalation. Manual authenticated flow blocked by #101. |
| Teacher and AI cannot directly write to student files                       | Covered by automation | Patch workflow tests cover explicit local apply/revert paths and protected/dirty/conflict cases.                                                          |
| Student can inspect patch diff before local apply                           | Covered by automation | Patch workflow and static UI wiring tests cover diff/proposal handling; manual authenticated flow blocked by #101.                                        |
| RLS prevents cross-class access                                             | Partially covered     | Static RLS fixture coverage passed; DB-backed RLS runner blocked by missing `psql` and local Supabase environment.                                        |
| Electron renderer keeps secrets out of bundled/runtime boundaries           | Covered by automation | `npm run security:electron`, secret scanner tests, and build completed.                                                                                   |

## Blocking Follow-Ups

| Blocker                                                                                           | Tracking                                                                       |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Seeded QA Supabase environment and fixture login are unavailable.                                 | #101                                                                           |
| Local DB-backed RLS execution cannot run without PostgreSQL client tools and a local/QA database. | #101                                                                           |
| Windows release E2E cannot run without a Windows QA runner.                                       | Keep #78 open until a Windows pass or explicit platform exclusion is recorded. |

## Release Decision

Do not use this run as MVP release sign-off. The automated checks are green and the macOS app can
launch to the login screen, but authenticated macOS flows, DB-backed RLS, and all Windows checks are
still unverified.
