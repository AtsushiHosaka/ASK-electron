import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const migrationsDir = "supabase/migrations";
const rlsSql = readdirSync(migrationsDir)
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort()
  .map((fileName) => readFileSync(`${migrationsDir}/${fileName}`, "utf8"))
  .join("\n");
const seedSql = readFileSync("supabase/seed.sql", "utf8");

const fixtureIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "40000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
  "50000000-0000-4000-8000-000000000001",
  "50000000-0000-4000-8000-000000000002",
  "70000000-0000-4000-8000-000000000001",
  "80000000-0000-4000-8000-000000000001"
];

const protectedTables = [
  "users",
  "classes",
  "class_members",
  "projects",
  "github_connections",
  "threads",
  "messages",
  "environment_snapshots",
  "patch_proposals"
];

const policyExpectations = [
  ["classes", "select", "classes_select_accessible"],
  ["classes", "insert", "classes_insert_teacher_or_admin"],
  ["classes", "update", "classes_update_manager"],
  ["projects", "select", "projects_select_accessible"],
  ["projects", "insert", "projects_insert_student_own_with_github"],
  ["projects", "update", "projects_update_owner_or_admin"],
  ["threads", "select", "threads_select_accessible"],
  ["threads", "insert", "threads_insert_student_or_teacher"],
  ["messages", "select", "messages_select_accessible_thread"],
  ["messages", "insert", "messages_insert_thread_participant"],
  ["environment_snapshots", "select", "environment_snapshots_select_accessible_thread"],
  ["environment_snapshots", "insert", "environment_snapshots_insert_project_owner"],
  ["patch_proposals", "select", "patch_proposals_select_accessible_thread"],
  ["patch_proposals", "insert", "patch_proposals_insert_teacher_staff"],
  ["patch_proposals", "insert", "patch_proposals_insert_ai_thread_owner"],
  ["patch_proposals", "update", "patch_proposals_update_thread_participant"]
];

describe("RLS SQL coverage", () => {
  it("enables RLS on every MVP table that renderer clients can touch", () => {
    for (const table of protectedTables) {
      assert.match(rlsSql, new RegExp(`alter table public\\.${table} enable row level security;`));
    }
  });

  it("declares operation-specific policies for class, project, thread, environment, and patch data", () => {
    for (const [table, operation, policyName] of policyExpectations) {
      assert.match(
        rlsSql,
        new RegExp(`create policy "${policyName}"\\s+on public\\.${table}\\s+for ${operation}`, "i")
      );
    }
  });

  it("keeps service-role helper functions separate from client policies", () => {
    assert.match(rlsSql, /security definer/);
    assert.match(
      rlsSql,
      /grant execute on function public\.can_access_project\(uuid\) to authenticated;/
    );
    assert.match(rlsSql, /grant select, insert, update, delete on\s+public\.users,/);
    assert.doesNotMatch(
      rlsSql,
      /create policy "[^"]+"\s+on public\.[\s\S]*using\s*\(\s*true\s*\)/i
    );
  });
});

describe("RLS fixture coverage", () => {
  it("provides stable admin, teacher, student, and outsider fixtures", () => {
    for (const fixtureId of fixtureIds) {
      assert.match(seedSql, new RegExp(fixtureId));
    }

    for (const email of [
      "admin@example.test",
      "teacher@example.test",
      "student-a@example.test",
      "student-b@example.test",
      "outsider@example.test"
    ]) {
      assert.match(seedSql, new RegExp(email));
    }
  });

  it("keeps seed data rerunnable with upserts for every core fixture group", () => {
    assert.match(seedSql, /insert into auth\.users[\s\S]*on conflict \(id\) do update/);
    assert.match(seedSql, /insert into public\.users[\s\S]*on conflict \(id\) do update/);
    assert.match(seedSql, /insert into public\.classes[\s\S]*on conflict \(id\) do update/);
    assert.match(
      seedSql,
      /insert into public\.class_members[\s\S]*on conflict \(class_id, user_id\) do update/
    );
    assert.match(seedSql, /insert into public\.projects[\s\S]*on conflict \(id\) do update/);
    assert.match(seedSql, /insert into public\.threads[\s\S]*on conflict \(id\) do update/);
    assert.match(seedSql, /insert into public\.messages[\s\S]*on conflict \(id\) do update/);
    assert.match(
      seedSql,
      /insert into public\.environment_snapshots[\s\S]*on conflict \(id\) do update/
    );
    assert.match(seedSql, /insert into public\.patch_proposals[\s\S]*on conflict \(id\) do update/);
  });
});
