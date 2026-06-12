import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const migrationsDir = "supabase/migrations";
const migrationSql = readdirSync(migrationsDir)
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort()
  .map((fileName) => readFileSync(`${migrationsDir}/${fileName}`, "utf8"))
  .join("\n");
const telemetrySource = readFileSync("src/renderer/src/lib/telemetry.ts", "utf8");

describe("usage analytics schema", () => {
  it("stores product usage in a dedicated RLS-protected table", () => {
    assert.match(migrationSql, /create table if not exists public\.usage_events/);
    assert.match(migrationSql, /alter table public\.usage_events enable row level security;/);
    assert.match(migrationSql, /revoke all on public\.usage_events from authenticated;/);
    assert.match(migrationSql, /grant select, insert, update, delete on public\.usage_events to service_role;/);
    assert.match(migrationSql, /constraint usage_events_properties_safe/);
    assert.match(migrationSql, /constraint usage_events_event_name_format/);
  });

  it("exposes only the product analytics RPC to authenticated renderer clients", () => {
    assert.match(migrationSql, /create or replace function private\.insert_usage_event/);
    assert.match(migrationSql, /security definer/);
    assert.match(migrationSql, /create or replace function public\.track_usage_event/);
    assert.match(migrationSql, /grant execute on function public\.track_usage_event/);
    assert.match(migrationSql, /to authenticated;/);
    assert.match(migrationSql, /from anon;/);
    assert.match(migrationSql, /p_actor_user_id is null or p_actor_user_id <> auth\.uid\(\)/);
    assert.doesNotMatch(
      migrationSql,
      /grant\s+(select,\s*)?insert[^;]+on public\.usage_events to authenticated/i
    );
  });

  it("provides a service-role analytical rollup view without exposing it to renderer users", () => {
    assert.match(migrationSql, /create or replace view public\.usage_daily_metrics/);
    assert.match(migrationSql, /with \(security_invoker = true\)/);
    assert.match(migrationSql, /revoke all on public\.usage_daily_metrics from authenticated;/);
    assert.match(migrationSql, /grant select on public\.usage_daily_metrics to service_role;/);
  });
});

describe("usage analytics client", () => {
  it("redacts sensitive product payload fields before sending telemetry", () => {
    assert.match(telemetrySource, /unsafeKeyPattern/);
    assert.match(telemetrySource, /password\|passwd\|token\|secret/);
    assert.match(telemetrySource, /body\|message\|code\|patch\|diff\|error\.\?text/);
    assert.match(telemetrySource, /supabase\.rpc\("track_usage_event"/);
  });
});
