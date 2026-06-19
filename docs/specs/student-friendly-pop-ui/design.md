# Design: Student Friendly Pop UI

## Overview

ASK adopts a restrained "Friendly Learning Dashboard" visual direction: bright but calm surfaces, clear primary actions, and multi-color state semantics. The implementation is intentionally CSS-first and copy-light so the app keeps its current route, data, and security architecture without adding unnecessary explanatory UI.

## Requirements Traceability

| Requirement | Design Coverage                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| REQ-001     | Route and data behavior remain unchanged; edits are presentational React copy/classes and shared CSS.                                |
| REQ-002     | Student home page primary action keeps students in the project flow before thread creation.                                          |
| REQ-003     | Sidebar footer shows only role and display name, without motivational or explanatory copy.                                           |
| REQ-004     | CSS status tokens define blue primary, green success, amber attention, rose error, lavender AI/system.                               |
| REQ-005     | Existing semantic elements, ARIA roles, and form controls are preserved.                                                             |
| REQ-006     | Decorative chips and explanatory taglines are removed; UI text is limited to task-critical labels/actions.                           |
| REQ-007     | Student home derives first-run setup state from real setup data and local dismissal state.                                           |
| UI-REQ-001  | Root CSS variables define a soft-pop palette across buttons, cards, messages, status pills, chat, and project-scoped question lists. |
| UI-REQ-002  | Cards and repeated rows keep 8px radius and add subtle shadows/hover feedback.                                                       |
| UI-REQ-003  | Sidebar gets an active-state marker and role context without extra copy.                                                             |
| UI-REQ-004  | Login renders only ASK, the current auth action, required fields, errors, and auth actions.                                          |
| UI-REQ-005  | Background stays plain and light, without decorative bars, grids, blobs, or mascot art.                                              |
| UI-REQ-006  | Standalone explanatory chips such as "状況 / コード / 先生" are explicitly excluded.                                                 |
| UI-REQ-007  | First-run setup uses a compact screen with status rows and a single next-action CTA.                                                 |

## Product Design Direction

### Visual Artifacts

- Direction A: Friendly Learning Dashboard. Friendly sidebar, clear student home CTA, soft cards, color-coded setup and question states.
- Direction B: Study Studio Chat. Calm chat workspace, code remains readable, AI/teacher/student messages have distinct treatments.
- Direction C: Teacher Command Center. Dense class/project question lists remain readable with compact rows.
- Selected direction: Direction A synthesized with Direction B chat treatment and Direction C question-list density.

The direct `product-design` plugin was unavailable; Creative Production style-intake was used as the visual direction artifact. The text in this document is the normative design.

### Selected Direction Rationale

Friendly Learning Dashboard best matches middle/high school users because it reduces intimidation without weakening the productivity focus. The selected version uses color, spacing, and status treatment for friendliness rather than additional UI copy. Study Studio Chat contributes better role separation in messages. Teacher Command Center contributes compact project-scoped question readability for mentors.

### Rejected Alternatives

| Direction                           | Reason Rejected                                                      |
| ----------------------------------- | -------------------------------------------------------------------- |
| Full marketing hero style           | ASK is an operational desktop app, not a landing page.               |
| Purple/blue gradient dominant style | Risks becoming one-note and less readable for long coding sessions.  |
| Childish mascot/illustration style  | Could make older students and teachers take the tool less seriously. |
| Dense admin dashboard only          | Too intimidating for beginner students.                              |

## Screen Structure

| Screen / Region             | Purpose                                                                   | Primary Actions                                      | States                                                   |
| --------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| Login                       | Authenticate.                                                             | Login, create account.                               | Default, error, disabled, loading.                       |
| Sidebar                     | Persistent navigation and user context.                                   | Navigate, logout.                                    | Active route, role context.                              |
| First-run Setup             | Orient first-time students to the next setup action.                      | Initial setup, project registration, dismiss.        | Incomplete setup, dismissed, complete.                   |
| Student Home                | Show setup progress, projects, recent questions, and primary next action. | 質問を作成, project/thread navigation.               | Empty, setup incomplete, setup complete, loading, error. |
| Teacher Home / Class Detail | Show class, project, and question workload.                               | Create class, open class, open project, open thread. | Empty, loading, error.                                   |
| Thread Create               | Build a structured question.                                              | Collect context, run AI assist, review/send.         | Default, blocked, warning, review modal.                 |
| Thread Detail               | Chat, inspect code context, review/compose patches.                       | Send message, update status, propose/apply patch.    | Own/teacher/AI/system messages, sending, error.          |

## Visual System

### Palette

- Primary blue: main CTA, focus ring, active navigation, selected rows.
- Green: completed/success states and positive confirmation.
- Amber: pending, incomplete, warning, attention states.
- Rose: errors, blockers, unsafe content.
- Lavender: AI/system message treatment.
- Neutral ink and soft blue-gray lines: long reading and code-context stability.

### Shape and Density

- Cards and panels keep a maximum 8px radius.
- Repeated rows use compact padding and small hover lift.
- Buttons remain text-based because no icon library is currently installed.
- The page uses a plain light background without adding decorative bars, grids, explanatory chips, taglines, blobs, or mascot art.

## Component Hierarchy

- `AppShell`
  - `.sidebar`
    - `.brand`
    - `.nav-list`
    - `.sidebar-footer`
  - `.content`
    - route pages
- `LoginPage`
  - `.auth-panel`
- `StudentHomePage`
  - `.page-header`
  - `.page-actions`
  - `.learning-summary`
  - setup/project/thread panels
- Shared CSS
  - buttons
  - messages
  - status pills
  - cards/panels
  - project-scoped question lists
  - chat messages
  - markdown/code/diff viewers

## Interaction Model

- Primary actions are blue and visually stronger than secondary actions.
- Hover feedback is small and bounded to rows/buttons. It must not resize content.
- Sidebar active route shows both background color and a vertical marker.
- First-run setup appears only for incomplete student setup until dismissed or completed.
- Chat ownership uses message alignment plus color so users do not rely on color alone.
- Status pills keep text labels, so color is supplementary rather than the only signal.
- Login avoids feature explanation copy. It only shows the product identity, auth mode, required fields, validation/errors, and auth actions.

## State Model

| State                  | Required Behavior                                      | Requirement |
| ---------------------- | ------------------------------------------------------ | ----------- |
| Success                | Green soft background with dark green text.            | REQ-004     |
| Pending / Warning      | Amber soft background with dark amber text.            | REQ-004     |
| Error / Blocked        | Rose soft background with dark rose text.              | REQ-004     |
| Active navigation      | Primary blue soft background, blue text, left marker.  | UI-REQ-003  |
| First-run incomplete   | Compact setup screen with status rows and next action. | REQ-007     |
| Own chat message       | Right-aligned, primary-blue soft background.           | REQ-004     |
| Teacher chat message   | Warm orange soft background.                           | REQ-004     |
| AI/System chat message | Lavender soft background.                              | REQ-004     |

## Validation and Error Handling

No validation logic changes are introduced. Existing error, warning, success, and alert rendering paths remain intact. The design only changes visual treatment for those states.

## Accessibility

- Existing semantic buttons, links, labels, and ARIA roles remain in place.
- Focus rings use primary blue with sufficient visible outline.
- Status text remains visible inside all colored pills.
- The palette is not the sole information channel; labels such as 完了, 未完了, and role/message text remain visible.
- Decorative or explanatory UI copy must not be added as an accessibility substitute; controls should carry clear labels directly.

## Platform Constraints

- Desktop Electron remains the target platform.
- The current minimum body width is retained.
- CSS remains global `styles.css`; no new styling runtime or component library is introduced.

## Implementation Notes

- React changes are limited to safe presentational classes and task-critical actions in `App.tsx`, `LoginPage.tsx`, and `StudentHomePage.tsx`.
- CSS changes are centralized in `src/renderer/src/styles.css`.
- First-run setup state is stored in local storage by user id and does not require schema changes.
- Future design work can extract tokens into a formal design-system file if component reuse grows.
