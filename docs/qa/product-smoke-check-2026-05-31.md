# Product Smoke Check - 2026-05-31

Status: blocked after unauthenticated launch checks.

This is a daily product smoke check record for issue #89. It is separate from the
macOS/Windows release E2E checklist tracked by issue #78.

## Run Metadata

| Field            | Value                    |
| ---------------- | ------------------------ |
| Run date         | 2026-05-31 03:22 JST     |
| Commit           | `79d5d18`                |
| OS               | macOS 26.4.1 (25E253)    |
| Node             | `v22.22.3`               |
| npm              | `10.9.8`                 |
| App command      | `npm run dev`            |
| Renderer URL     | `http://localhost:5174/` |
| Fixture account  | `student-a@example.test` |
| Fixture password | `ask-password`           |

## Automated Verification

| Check                       | Result |
| --------------------------- | ------ |
| `npm run format`            | PASS   |
| `npm run typecheck`         | PASS   |
| `npm test`                  | PASS   |
| `npm run lint`              | PASS   |
| `npm run security:electron` | PASS   |
| `npm run test:rls:static`   | PASS   |
| `npm run build`             | PASS   |

## Manual Smoke Results

| Flow                                                          | Result  | Notes                                                                                                     |
| ------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| Electron app launches with `npm run dev`                      | PASS    | Main and preload built; renderer started on port 5174 after port 5173 was already in use.                 |
| Login / account creation screen is visible                    | PASS    | Electron window loaded `/#/login`; email, password, login, and account creation controls visible.         |
| Fixture student login                                         | BLOCKED | `student-a@example.test` with `ask-password` returned the app's invalid credentials message.              |
| Local Supabase fixture availability                           | BLOCKED | `supabase status` could not connect to Docker daemon, so local fixture reset/login could not be verified. |
| Teacher login and teacher home                                | NOT RUN | Blocked by fixture auth environment.                                                                      |
| Class creation, invite issue, invite redeem                   | NOT RUN | Blocked by fixture auth environment.                                                                      |
| Student home, onboarding, and project registration navigation | NOT RUN | Blocked by fixture auth environment.                                                                      |
| Project folder selection and Git repository validation        | NOT RUN | Blocked by fixture auth environment.                                                                      |
| Question creation, related files, Git diff, environment data  | NOT RUN | Blocked by fixture auth environment.                                                                      |
| Secret candidate send blocking                                | NOT RUN | Blocked by fixture auth environment.                                                                      |
| AI assist fallback during question creation                   | NOT RUN | Blocked by fixture auth environment.                                                                      |
| Thread detail chat, code, diff, and patch displays            | NOT RUN | Blocked by fixture auth environment.                                                                      |
| Teacher queue status views and status changes                 | NOT RUN | Blocked by fixture auth environment.                                                                      |
| Student patch review, apply, and revert guidance              | NOT RUN | Blocked by fixture auth environment.                                                                      |

## Follow-Up

No product blocker was confirmed beyond the unauthenticated login boundary because the local
Supabase fixture environment was unavailable. Continue this smoke check after Docker is running and
the local fixtures have been reset:

```sh
supabase start
supabase db reset
npm run dev
```

Then repeat the fixture login matrix in
[`test-accounts-and-login-fixtures.md`](test-accounts-and-login-fixtures.md) before continuing the
authenticated product flows above.
