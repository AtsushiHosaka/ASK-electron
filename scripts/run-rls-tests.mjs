import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sqlFile = resolve(repoRoot, "tests/rls/permission-boundaries.sql");
const databaseUrl =
  process.env.ASK_RLS_DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "Set ASK_RLS_DATABASE_URL to a local Supabase Postgres URL before running RLS tests."
  );
  console.error(
    "Example: ASK_RLS_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:rls"
  );
  process.exit(1);
}

let parsedUrl;

try {
  parsedUrl = new URL(databaseUrl);
} catch {
  console.error("ASK_RLS_DATABASE_URL is not a valid Postgres URL.");
  process.exit(1);
}

const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);

if (!localHosts.has(parsedUrl.hostname) && process.env.ASK_RLS_ALLOW_REMOTE !== "1") {
  console.error("Refusing to run RLS tests against a non-local database.");
  console.error("Set ASK_RLS_ALLOW_REMOTE=1 only for an isolated CI database.");
  process.exit(1);
}

if (!existsSync(sqlFile)) {
  console.error(`RLS SQL test file not found: ${sqlFile}`);
  process.exit(1);
}

const child = spawn(
  "psql",
  ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--file", sqlFile, databaseUrl],
  {
    cwd: repoRoot,
    stdio: "inherit"
  }
);

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error("psql was not found. Install PostgreSQL client tools before running RLS tests.");
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`RLS tests stopped by signal ${signal}.`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
