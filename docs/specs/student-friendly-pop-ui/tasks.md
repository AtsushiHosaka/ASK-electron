# Tasks: Student Friendly Pop UI

## Implementation Tasks

- [x] T1. Establish a soft-pop color system in `src/renderer/src/styles.css`.
  - Covers: REQ-004, UI-REQ-001
  - Verify that success, warning, error, primary, and AI/system treatments are visually distinct.

- [x] T2. Refresh shared buttons, form controls, messages, cards, and repeated rows.
  - Covers: REQ-004, REQ-005, UI-REQ-002
  - Verify that hover states do not change layout size and disabled states remain clear.

- [x] T3. Update the app shell sidebar while keeping copy minimal.
  - Covers: REQ-003, UI-REQ-003
  - Verify that active navigation, role badge, user display name, and logout remain visible without motivational or explanatory copy.

- [x] T4. Keep login presentation minimal.
  - Covers: REQ-006, UI-REQ-004, UI-REQ-006
  - Verify that login shows only ASK, the current auth action, required fields, errors, and auth actions.
  - Verify that decorative chips such as "状況 / コード / 先生" are not rendered.

- [x] T5. Add first-viewport student home actions.
  - Covers: REQ-002
  - Verify that the "質問を作成" action keeps students inside the project flow before creating a thread.

- [x] T6. Refresh project-scoped question lists and chat visual states.
  - Covers: REQ-004
  - Verify that own, teacher, AI/system messages remain distinguishable and project-scoped question rows remain scannable.

- [x] T7. Add a student first-run setup screen.
  - Covers: REQ-007, UI-REQ-007
  - Verify that incomplete setup opens the compact first-run screen and dismissal is stored locally.

## Specification Tasks

- [x] T8. Generate SDD `requirements.md`.
  - Covers: SDD workflow

- [x] T9. Record Product Design exploration outcome and selected direction.
  - Covers: SDD workflow, UI-REQ-001 through UI-REQ-005

- [x] T10. Generate SDD `design.md`.
  - Covers: SDD workflow

- [x] T11. Generate SDD `tasks.md`.
  - Covers: SDD workflow

## Verification Tasks

- [x] T12. Run `npm run typecheck`.
  - Covers: REQ-001

- [x] T13. Run `npm run lint`.
  - Covers: REQ-001

- [x] T14. Run `npm run format`.
  - Covers: docs and source formatting

- [x] T15. Run `npm run build`.
  - Covers: Electron/Vite build

- [x] T16. Run `npm run security:electron`.
  - Covers: renderer and IPC security constraints

- [x] T17. Start the local app and visually inspect login/student-facing UI.
  - Covers: UI-REQ-001 through UI-REQ-005
  - Note: Login UI was verified at `http://localhost:5174/`; authenticated first-run UI was covered by build/static checks because local fixture login was not accepted in this environment.

## Follow-Up Tasks

- [ ] T18. Decide whether to extract design tokens from global CSS into a dedicated design-system module.
  - Covers: Open question

- [ ] T19. Decide whether to add an icon library for clearer navigation and button affordances.
  - Covers: Open question

- [ ] T20. Decide whether teacher and student dashboards should have separate density presets.
  - Covers: Open question
