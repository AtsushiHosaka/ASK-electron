import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const teacherDashboardSource = readFileSync(
  "src/renderer/src/features/teacher/TeacherDashboard.tsx",
  "utf8"
);
const stylesSource = readFileSync("src/renderer/src/styles.css", "utf8");
const databaseTypesSource = readFileSync("src/shared/database.types.ts", "utf8");
const migrationSource = readFileSync(
  "supabase/migrations/20260619160022_class_student_roster_import.sql",
  "utf8"
);

const classDetailSource = teacherDashboardSource.match(
  /export const ClassDetailPage = \(\): ReactElement => \{[\s\S]*?export const ClassJoinPage/
)?.[0];

describe("class student roster UI", () => {
  it("keeps student addition inside class detail without a persistent invite link panel", () => {
    assert.ok(classDetailSource);
    assert.match(classDetailSource, /<StudentAddModal/);
    assert.match(classDetailSource, /<StudentMemberPanel classSummary=\{classSummary\}/);
    assert.match(classDetailSource, /生徒を追加/);
    assert.doesNotMatch(classDetailSource, /招待リンク|create_class_invite|invite-panel/);
  });

  it("supports both single-student and CSV modal entry with only required always-visible fields", () => {
    assert.match(teacherDashboardSource, /const StudentAddModal =/);
    assert.match(teacherDashboardSource, /type StudentImportMode = "single" \| "csv"/);
    assert.match(teacherDashboardSource, /const parseStudentCsv/);
    assert.match(teacherDashboardSource, /placeholder="名前,email,github"/);
    assert.match(teacherDashboardSource, /\.rpc\("import_class_students"/);
    assert.doesNotMatch(classDetailSource ?? "", /コピー|招待/);
  });

  it("renders pending roster rows as students instead of separate instructional UI", () => {
    assert.match(teacherDashboardSource, /const pendingStudentRoster =/);
    assert.match(teacherDashboardSource, /classSummary\.studentRoster/);
    assert.match(teacherDashboardSource, /<span>未参加<\/span>/);
    assert.match(teacherDashboardSource, /<span>参加済み<\/span>/);
    assert.match(stylesSource, /\.member-row\.pending/);
    assert.match(stylesSource, /\.student-add-tabs/);
    assert.match(stylesSource, /\.student-add-preview/);
  });
});

describe("class student roster persistence", () => {
  it("adds a Supabase roster table and import RPC for pending and existing students", () => {
    assert.match(databaseTypesSource, /class_student_roster:/);
    assert.match(databaseTypesSource, /import_class_students:/);
    assert.match(migrationSource, /create table if not exists public\.class_student_roster/);
    assert.match(migrationSource, /class_student_roster_email_normalized/);
    assert.match(migrationSource, /class_student_roster_github_username_normalized/);
    assert.match(migrationSource, /class_student_roster_email_idx/);
    assert.match(migrationSource, /create or replace function public\.import_class_students/);
    assert.match(
      migrationSource,
      /create or replace function public\.sync_class_student_roster_for_user/
    );
    assert.match(migrationSource, /status := 'pending_signup'/);
    assert.match(migrationSource, /status := case when v_inserted_member_id is null/);
  });
});
