import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const teacherDashboardSource = readFileSync(
  "src/renderer/src/features/teacher/TeacherDashboard.tsx",
  "utf8"
);
const stylesSource = readFileSync("src/renderer/src/styles.css", "utf8");

const classJoinPageMatch = teacherDashboardSource.match(
  /export const ClassJoinPage = \(\): ReactElement => \{([\s\S]*?)const ClassJoinMembersPanel =/
);

describe("class join completion", () => {
  it("loads class context after redeeming an invite", () => {
    assert.ok(classJoinPageMatch);
    assert.match(classJoinPageMatch[1], /\.rpc\("redeem_class_invite"/);
    assert.match(classJoinPageMatch[1], /\.from\("classes"\)/);
    assert.match(classJoinPageMatch[1], /\.from\("class_members"\)/);
    assert.match(classJoinPageMatch[1], /\.from\("users"\)/);
    assert.match(classJoinPageMatch[1], /\.from\("projects"\)/);
  });

  it("shows useful class details without exposing classmate email addresses", () => {
    assert.ok(classJoinPageMatch);
    assert.match(classJoinPageMatch[1], /className="class-join-confirmation"/);
    assert.match(classJoinPageMatch[1], />クラス概要</);
    assert.match(classJoinPageMatch[1], /title="先生 \/ メンター"/);
    assert.match(classJoinPageMatch[1], /title="ほかの生徒"/);
    assert.match(classJoinPageMatch[1], /primaryProjectAction/);
    assert.doesNotMatch(classJoinPageMatch[1], /\.email|メール/);
    assert.match(teacherDashboardSource, /const classJoinMemberDisplayName/);
    assert.match(teacherDashboardSource, /const classJoinMemberMeta/);
  });

  it("adds responsive join completion layout styles", () => {
    assert.match(stylesSource, /\.class-join-confirmation/);
    assert.match(stylesSource, /\.class-join-grid/);
    assert.match(stylesSource, /\.class-join-member-list/);
    assert.match(stylesSource, /@media \(max-width: 720px\)/);
  });
});
