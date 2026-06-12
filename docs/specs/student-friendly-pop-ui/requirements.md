# Requirements: Student Friendly Pop UI

## Overview

ASK の既存 Electron UI を、中高生が怖がらずに使える学習支援ツールとして見える状態へ改善する。機能追加ではなく、画面のわかりやすさ、状態の判別、質問作成導線を高める UI/UX 改善を対象にする。UI 文言は必要最小限にし、操作に不要な説明チップや飾り文言は追加しない。

## Goals

- 生徒がログイン後すぐに「質問を作成」へ進めること。
- 初回の生徒が、必要な準備を短い画面で確認して次の行動へ進めること。
- 先生と生徒が、成功、未完了、警告、エラー、AI/先生/自分のメッセージを色と配置で見分けられること。
- 中高生向けに、堅すぎないポップな印象を持たせること。
- UI文言を操作に必要な最小限へ抑えること。
- 既存の Electron / React / CSS 構成を保ち、実装範囲を UI 表現に閉じること。

## Non-Goals

- 新しいDBスキーマ、API、認証フローを追加しない。
- ゲーム風、幼児向け、過度なイラスト主体のUIにはしない。
- モバイル最適化を主目的にしない。MVPはデスクトップ Electron を前提にする。
- Product Design の生成物を仕様の唯一の正解にはしない。
- 操作に不要な説明チップ、タグライン、応援文、機能説明文を追加しない。

## Users

- 生徒: エラーや詰まりを、安心して先生へ送れる質問にしたい。
- 先生: クラスと質問キューを、状態ごとにすばやく確認したい。
- 管理者/メンター: 先生画面と同じ情報構造で、運用状態を見たい。

## User Stories

- As a student, I want the home screen to show the next action clearly, so that I can ask for help without searching the navigation.
- As a first-time student, I want a short setup entry screen, so that I can move to the next required setup action without reading a long guide.
- As a student, I want warnings and blocked states to look different from success states, so that I know what needs attention.
- As a teacher, I want queue rows and chat messages to remain readable while feeling approachable, so that I can respond quickly.
- As a new user, I want the login screen to feel like a learning support app, so that I understand ASK is for guided coding help.

## Functional Requirements

| ID      | Requirement                                                                                                                                 | Priority | Source                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------- |
| REQ-001 | The system shall keep all existing routes, authentication behavior, data loading behavior, and IPC behavior unchanged.                      | Must     | Constraint                 |
| REQ-002 | The system shall make the student home primary question creation action visible in the first viewport after login.                          | Must     | User input                 |
| REQ-003 | The system shall display role and user identity in the sidebar without extra explanatory or supportive copy.                                | Should   | Product design exploration |
| REQ-004 | The system shall distinguish success, pending, warning, error, teacher, AI, and own-message states with consistent visual treatment.        | Must     | User input                 |
| REQ-005 | The system shall preserve existing accessibility semantics for navigation, forms, alerts, links, and buttons.                               | Must     | Constraint                 |
| REQ-006 | The system shall not add UI text unless it is required for navigation, form completion, status, error recovery, or an explicit user action. | Must     | User correction            |
| REQ-007 | The system shall show an initial student onboarding screen only while core setup is incomplete and the local user has not dismissed it.     | Should   | User input                 |

## Acceptance Criteria

### REQ-001

- When a user navigates through existing screens, the system shall keep the same route destinations and data operations as before.
- If Supabase configuration is missing or a request fails, then the system shall continue to show the existing error behavior.

### REQ-002

- When a student opens the home screen, the system shall show a primary "質問を作成" action in the page header.
- When the student activates the action, the system shall navigate to `/threads/new`.

### REQ-003

- When an authenticated user opens the app shell, the system shall show the user role and display name in the sidebar.
- The system shall not add motivational copy, taglines, or feature explanations to the sidebar.
- The system shall not show access tokens, email secrets, local paths, or environment values in sidebar copy.

### REQ-004

- When a status is success, the system shall use a green success treatment.
- When a status is warning or pending, the system shall use a yellow/amber attention treatment.
- When a status is error or blocked, the system shall use a red/rose treatment.
- When chat messages are rendered, the system shall visually distinguish own, teacher, AI, and system messages.

### REQ-005

- When the UI is operated by keyboard, existing buttons, links, inputs, modals, and navigation targets shall remain focusable.
- If a message is an alert or status, then the system shall retain the existing ARIA role.

### REQ-006

- When adding or changing UI copy, the system shall keep the text necessary for the immediate task only.
- If a proposed UI element only explains a concept already represented by labels, headings, or controls, then the system shall not render that element.
- If Product Design exploration suggests decorative labels or chips, then the implementation shall translate the useful intent into layout, color, spacing, or state treatment instead of extra copy.

### REQ-007

- When a student opens the home flow with incomplete GitHub/SSH, class, or project setup, the system shall show a short first-run setup screen.
- When the student activates the next setup action or closes the screen, the system shall persist dismissal in local storage for that user.
- When all setup items are complete, the system shall not show the first-run setup screen.

## UI Requirements

| ID         | UI Requirement                                                                                                                     | Priority | Source                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------- |
| UI-REQ-001 | The visual system shall use a multi-color soft-pop palette rather than the previous green/gray dominant theme.                     | Must     | User input                 |
| UI-REQ-002 | Cards, panels, and repeated rows shall retain compact 8px-or-less radius while gaining warmer shadows and hover feedback.          | Should   | Product design exploration |
| UI-REQ-003 | The sidebar shall keep navigation labels scannable and avoid decorative explanatory copy.                                          | Should   | Product design exploration |
| UI-REQ-004 | Login shall render only the product name, current auth action, required fields, errors, and auth actions.                          | Must     | User correction            |
| UI-REQ-005 | The page background shall be light and calm, without decorative bars, grids, blobs, mascot art, or heavy hero imagery.             | Must     | Design constraint          |
| UI-REQ-006 | The UI shall not add standalone explanatory chips such as "状況 / コード / 先生" unless the user explicitly asks for that control. | Must     | User correction            |
| UI-REQ-007 | The first-run setup screen shall use a compact step list and one primary next action rather than a long guide or persistent panel. | Should   | User input                 |

## UI States

| State    | Expected Behavior                                                              | Priority |
| -------- | ------------------------------------------------------------------------------ | -------- |
| Default  | Clean, bright surfaces with clear primary and secondary actions.               | Must     |
| Empty    | Existing empty-state messaging remains visible in a friendlier card treatment. | Must     |
| Loading  | Existing loading text remains unchanged and readable.                          | Must     |
| Error    | Error states use rose/red treatment and retain `role="alert"` where present.   | Must     |
| Warning  | Pending setup, review, and secret-scan warnings use amber treatment.           | Must     |
| Success  | Completed setup and successful operations use green treatment.                 | Must     |
| Disabled | Disabled buttons remain visually inactive and do not shift layout.             | Must     |

## Product Design Artifacts

Visual exploration was requested through `product-design`. The direct Product Design tool was not available in this environment, so Creative Production style-intake was used as the supporting exploration surface.

- Direction A: Friendly Learning Dashboard. Selected as the primary direction.
- Direction B: Study Studio Chat. Borrowed for chat and code-context readability.
- Direction C: Teacher Command Center. Borrowed for queue density and status readability.
- Selected direction: Friendly Learning Dashboard with Study Studio Chat details.

These artifacts are supporting references. The normative behavior is defined by the requirements and acceptance criteria above.

## Constraints

- Existing React route and component boundaries should remain intact unless a small presentational change is needed.
- The renderer must not gain Node, filesystem, process, or IPC access beyond existing `window.ask` APIs.
- The UI must avoid a one-note color palette and must not rely on purple/blue gradients as the dominant style.
- UI copy must follow the app guideline: avoid visible in-app text that explains features, visual elements, shortcuts, or how to use the application when the control itself is already clear.
- Desktop Electron minimum width remains the current product assumption.

## Assumptions

- "ポップ" means approachable, colorful, and school-friendly, not childish or game-like.
- The primary student flow is asking a question; therefore that CTA gets first-viewport priority.
- The current green/gray palette is too restrained for the requested audience.
- Minimal UI copy is more important than adding friendly explanatory labels.

## Open Questions

- [ ] Should ASK eventually define a formal brand color system outside `styles.css`?
- [ ] Should teacher and student roles receive separate dashboard density presets?
- [ ] Should future UI work introduce icon assets or a component library?
