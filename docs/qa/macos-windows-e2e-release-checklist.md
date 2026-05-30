# macOS / Windows E2E Release Checklist

Issue: #34

Status: MVP release checklist

## Purpose

This checklist verifies that ASK's MVP flow works on macOS and Windows before a
release. It is intentionally written so a reviewer can run the same checks
without knowing the implementation details.

## Test Matrix

| Area                      | macOS  | Windows | Automation target                                            |
| ------------------------- | ------ | ------- | ------------------------------------------------------------ |
| App launch                | Manual | Manual  | Playwright or Spectron-style smoke test after harness exists |
| Supabase login            | Manual | Manual  | Renderer integration test                                    |
| Class invite acceptance   | Manual | Manual  | Supabase integration test                                    |
| Git detection             | Manual | Manual  | Main-process IPC test                                        |
| GitHub CLI auth detection | Manual | Manual  | Main-process IPC test with command fixtures                  |
| SSH connectivity check    | Manual | Manual  | Main-process IPC test with mocked process output             |
| Project registration      | Manual | Manual  | Renderer + Supabase integration test                         |
| Question creation         | Manual | Manual  | E2E test with seeded project                                 |
| Teacher queue             | Manual | Manual  | Supabase RLS + renderer integration test                     |
| Chat realtime             | Manual | Manual  | Supabase Realtime integration test                           |
| AI fallback               | Manual | Manual  | Provider mock integration test                               |
| Patch proposal and apply  | Manual | Manual  | Main-process patch fixture test                              |
| Secret blocking           | Manual | Manual  | Unit and integration tests                                   |

## Prerequisites

- A clean macOS test user and a clean Windows test user.
- Test GitHub accounts for student and teacher.
- Test Supabase project or local Supabase stack.
- Git installed.
- GitHub CLI installed for the primary path.
- A small fixture repository with:
  - `package.json`
  - one source file with an intentional error
  - `.env.example`
  - no committed `.env`
- ASK `.env` configured with:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`

## 1. First Launch

- [ ] App launches without a blank window.
- [ ] Window title is ASK.
- [ ] Renderer shows login screen when no session exists.
- [ ] DevTools console has no startup exception.
- [ ] Closing and reopening app preserves expected session state.

macOS notes:

- [ ] App is not blocked by Gatekeeper in the test install path.
- [ ] External links open in the default browser, not inside ASK.

Windows notes:

- [ ] App path with spaces works.
- [ ] External links open in the default browser, not inside ASK.

## 2. Auth and Class Join

- [ ] Student can create or use a test account.
- [ ] Teacher can create or use a test account.
- [ ] Invalid password shows a clear error and keeps the form content.
- [ ] Student can accept a class invite link or code.
- [ ] Reusing the same invite does not create duplicate membership.
- [ ] Student cannot become teacher by editing client state.
- [ ] Teacher can see the class after login.
- [ ] Student only sees their own class context.

Automation target:

- Supabase RLS tests for class membership boundaries.
- Renderer test for login failure and loading states.

## 3. GitHub / Git / SSH Onboarding

- [ ] ASK detects whether Git is installed.
- [ ] ASK detects whether GitHub CLI is installed.
- [ ] `gh auth status` success is shown as GitHub connected.
- [ ] `gh auth status` failure shows the next action.
- [ ] Missing SSH key shows setup guidance.
- [ ] SSH connection success is shown clearly.
- [ ] SSH connection failure distinguishes key setup from network failure when possible.
- [ ] Student cannot register a project before GitHub connection is complete.

macOS notes:

- [ ] Works with Homebrew-installed `git` and `gh`.
- [ ] Works when SSH key is loaded through the default SSH agent.

Windows notes:

- [ ] Works with Git for Windows.
- [ ] Works with PowerShell-launched ASK.
- [ ] Path handling works for repositories under `C:\Users\...\Documents`.

Automation target:

- Main-process IPC tests with fixed command fixtures.
- No-shell command execution assertions.

Abnormal-path coverage:

| Failure state              | Expected result                               | macOS / Windows note                                      |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| Git missing                | Git check blocks onboarding with next action  | Covers missing PATH entries on both OSes                  |
| GitHub CLI missing         | Onboarding continues with fallback guidance   | Covers `gh` CLI not installed fallback                    |
| GitHub CLI unauthenticated | Auth check blocks onboarding, version remains | Covers expired tokens and fresh devices                   |
| SSH key missing            | SSH key check blocks onboarding               | Covers empty `~/.ssh` and Windows user profile migration  |
| SSH public key not trusted | SSH connection reports auth failure           | Covers key not registered on GitHub                       |
| GitHub network failure     | SSH/GitHub CLI report network failure         | Covers DNS, proxy, firewall, and offline classroom states |
| Timeout                    | Timeout state returns without hanging UI      | Covers slow network and blocked process execution         |

## 4. Project Registration

- [ ] Student selects a local project folder.
- [ ] ASK rejects a folder without `.git`.
- [ ] ASK rejects or warns on missing `origin`.
- [ ] ASK detects GitHub repository URL.
- [ ] ASK shows `.gitignore` state.
- [ ] ASK recommends `.env`, `node_modules`, `.DS_Store`, and build output ignores.
- [ ] Existing `.gitignore` is not overwritten without preview.
- [ ] Registered project appears in the student project list.

Automation target:

- Fixture repositories for no `.git`, no remote, remote mismatch, and valid repo.

Abnormal-path coverage:

| Failure state       | Expected result                                  |
| ------------------- | ------------------------------------------------ |
| No `.git` work tree | Registration is blocked with `.git` guidance     |
| Nested folder       | Registration is blocked until repo root selected |
| Missing origin      | Registration is blocked with remote guidance     |
| Non-GitHub origin   | Registration is blocked as repo mismatch         |
| GitHub origin       | GitHub URL, branch, and local path hash resolve  |

## 5. Question Creation

- [ ] Student enters title, situation, error text, and command.
- [ ] Student selects related files.
- [ ] ASK collects Git branch, HEAD commit, and uncommitted diff.
- [ ] ASK collects environment snapshot within the target timeout.
- [ ] Send-before preview shows text, diff, files, and environment info.
- [ ] Student can remove an item from the preview.
- [ ] Secret detection blocks `.env` contents, token-like strings, and private keys.
- [ ] Question sends successfully after the preview is confirmed.
- [ ] Teacher queue shows the new question.

Automation target:

- Unit tests for secret detection.
- Renderer integration test for preview inclusion/exclusion.

## 6. Teacher Response and Chat

- [ ] Teacher sees unanswered questions in the queue.
- [ ] Teacher can open a question.
- [ ] Teacher sees question body, error text, related files, diff, and environment snapshot.
- [ ] Student and teacher can exchange chat messages.
- [ ] Chat updates appear without manual refresh.
- [ ] Code blocks render legibly.
- [ ] Status can move from open to in progress.
- [ ] Resolved status is visible to both student and teacher.

Automation target:

- Supabase Realtime integration tests.
- Renderer component tests for message types.

## 7. AI Assistance

- [ ] Student can request AI question rewrite.
- [ ] Student can edit AI-generated text before sending.
- [ ] AI error summary is shown as assistant output, not as a final answer.
- [ ] AI cause candidates include "next checks".
- [ ] AI failure shows teacher escalation path.
- [ ] AI request is blocked when secret scanner finds high-risk content.
- [ ] AI provider key is not present in Electron renderer or packaged assets.

Automation target:

- Provider mock tests for success, timeout, rate limit, and blocked secret payloads.

## 8. Patch Proposal and Local Apply

- [ ] Teacher can propose a patch in the thread.
- [ ] AI can propose a patch only as a proposal.
- [ ] Student sees target file, explanation, and diff.
- [ ] Student must explicitly confirm before local apply.
- [ ] Teacher cannot directly modify the student's local files.
- [ ] AI cannot directly modify the student's local files.
- [ ] ASK creates a backup before applying.
- [ ] Patch apply success is shown.
- [ ] Patch conflict leaves files unchanged.
- [ ] Student can revert an ASK-applied patch.

Automation target:

- Main-process patch fixture tests for success, conflict, denied path, and revert.

## 9. Security Regression Checks

- [ ] Renderer does not import Node or Electron modules.
- [ ] Preload does not expose `ipcRenderer`.
- [ ] Unknown IPC channels are rejected.
- [ ] No generic command runner exists.
- [ ] External navigation is allowlisted.
- [ ] Supabase secret keys and database passwords are absent from renderer build output.
- [ ] `.env` contents are not stored in Supabase rows or logs.
- [ ] Absolute local paths are not stored in plaintext.

Automation target:

- Static checks for forbidden imports and secret-like build output.
- RLS tests for cross-class access denial.

## Release Sign-Off

Record the result for each OS:

| Field                     | macOS | Windows |
| ------------------------- | ----- | ------- |
| App version               |       |         |
| Commit SHA                |       |         |
| Tester                    |       |         |
| Test date                 |       |         |
| Passed checklist sections |       |         |
| Known blockers            |       |         |
| Known non-blocking issues |       |         |

Release is blocked if any of these fail:

- GitHub connection cannot be completed.
- Project registration can happen without GitHub connection.
- Questions can send `.env`, private keys, or token-like secrets.
- Teacher or AI can directly write to student files.
- Student cannot inspect a patch diff before applying.
- RLS allows cross-class access.
