import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const seedSql = readFileSync("supabase/seed.sql", "utf8");
const readme = readFileSync("README.md", "utf8");
const supabaseDoc = readFileSync("docs/supabase.md", "utf8");
const qaDocPath = "docs/qa/test-accounts-and-login-fixtures.md";
const qaDoc = readFileSync(qaDocPath, "utf8");

const expectedAccounts = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@example.test",
    displayName: "ASK Admin",
    role: "admin"
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    email: "teacher@example.test",
    displayName: "ASK Teacher",
    role: "teacher"
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    email: "mentor@example.test",
    displayName: "ASK Mentor",
    role: "teacher"
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    email: "student-a@example.test",
    displayName: "Student A",
    role: "student"
  },
  {
    id: "00000000-0000-4000-8000-000000000005",
    email: "student-b@example.test",
    displayName: "Student B",
    role: "student"
  },
  {
    id: "00000000-0000-4000-8000-000000000006",
    email: "outsider@example.test",
    displayName: "Outside Student",
    role: "student"
  }
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("QA login fixtures", () => {
  it("keeps stable local auth and profile rows for every documented account", () => {
    for (const account of expectedAccounts) {
      assert.match(seedSql, new RegExp(`'${escapeRegExp(account.id)}'`));
      assert.match(seedSql, new RegExp(`'${escapeRegExp(account.email)}'`));
      assert.match(seedSql, new RegExp(`'${escapeRegExp(account.displayName)}'`));
      assert.match(
        seedSql,
        new RegExp(
          `'${escapeRegExp(account.id)}'[\\s\\S]*'${escapeRegExp(
            account.email
          )}'[\\s\\S]*'${escapeRegExp(account.displayName)}'[\\s\\S]*'${account.role}'`
        )
      );
      assert.match(qaDoc, new RegExp(`\\|\\s+\`${escapeRegExp(account.email)}\`\\s+\\|`));
    }
  });

  it("uses reserved fixture emails and excludes obvious committed secrets", () => {
    const fixtureEmails = [...seedSql.matchAll(/'([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)'/g)].map(
      (match) => match[1]
    );

    assert.ok(fixtureEmails.length >= expectedAccounts.length);
    assert.ok(fixtureEmails.every((email) => email.endsWith("@example.test")));
    assert.doesNotMatch(seedSql, /@(gmail|icloud|yahoo|hotmail|outlook)\./i);
    assert.doesNotMatch(seedSql, /\b(sb_secret_|service_role|gh[pousr]_|github_pat_)\b/i);
    assert.doesNotMatch(seedSql, /\bsk-[A-Za-z0-9_-]{24,}\b/);
    assert.match(seedSql, /crypt\('ask-password'/);
    assert.match(qaDoc, /Local-only fixture password: `ask-password`/);
  });

  it("links the QA account guide from primary setup docs", () => {
    assert.match(readme, new RegExp(escapeRegExp(qaDocPath)));
    assert.match(supabaseDoc, /test-accounts-and-login-fixtures\.md/);
    assert.match(qaDoc, /Auth\/Profile Verification/);
    assert.match(qaDoc, /QA Login Matrix/);
    assert.match(qaDoc, /RLS Boundary Checks/);
  });
});
