# Test Accounts And Login Fixtures

Use these fixtures only with local Supabase or an isolated non-production QA project. They are
designed for repeatable login, role, and RLS checks without real email addresses or secrets.

## Reset Local Fixtures

Start Supabase and reset the local database:

```sh
supabase start
supabase db reset
```

Copy the local API URL and anon key from `supabase status` into `.env`:

```env
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=<local anon key from supabase status>
```

Then start the app:

```sh
npm run dev
```

## Fixture Accounts

Local-only fixture password: `ask-password`

| Email                    | App role  | Membership fixture                                            | QA use                                                       |
| ------------------------ | --------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| `admin@example.test`     | `admin`   | No class membership                                           | Admin login smoke test and class creation visibility         |
| `teacher@example.test`   | `teacher` | Teacher in `Intro Programming`                                | Teacher dashboard, class detail, and project question checks |
| `mentor@example.test`    | `teacher` | Mentor in `Intro Programming`, teacher in `Other Programming` | Staff boundary checks across multiple classes                |
| `student-a@example.test` | `student` | Student in `Intro Programming`                                | Student project, question, thread, and patch review checks   |
| `student-b@example.test` | `student` | Student in `Other Programming`                                | Cross-class isolation checks                                 |
| `outsider@example.test`  | `student` | No class membership                                           | Empty-state and RLS negative checks                          |

The `.example.test` domain is reserved for fixtures. Do not replace it with personal, school, or
production email addresses in committed seed data.

## Auth/Profile Verification

After `supabase db reset`, verify that Supabase Auth rows and `public.users` profiles are paired:

```sql
select
  au.id,
  au.email as auth_email,
  pu.email as profile_email,
  pu.display_name,
  pu.role
from auth.users au
join public.users pu on pu.id = au.id
where au.email like '%@example.test'
order by au.email;
```

Expected result: six rows, matching emails in both columns, with `admin`, `teacher`, and `student`
roles represented. `mentor@example.test` intentionally has the app role `teacher` and class
membership role `mentor`.

## QA Login Matrix

1. Log in as `student-a@example.test`.
2. Confirm the sidebar shows role `student`.
3. Open `Projects` and confirm `Student A Calculator` is visible.
4. Open the seeded thread `Calculator returns NaN` from the project detail page.
5. Log out.
6. Log in as `teacher@example.test`.
7. Confirm `Intro Programming` is visible on the teacher home page.
8. Open `Intro Programming`, then `Student A Calculator`, and confirm `Calculator returns NaN` is visible.
9. Log out.
10. Log in as `admin@example.test`.
11. Confirm login succeeds and the class creation form is visible.
12. Log out.
13. Log in as `outsider@example.test`.
14. Confirm project/class lists do not expose the seeded Intro or Other Programming records.

## RLS Boundary Checks

Run the static and database-backed RLS checks after resetting fixtures:

```sh
npm run test:rls:static
ASK_RLS_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:rls
```

The database-backed suite uses the same fixture accounts and rolls writes back at the end.

## Staging Fixture Policy

For staging, apply these same shapes only to an isolated QA Supabase project:

- Keep all fixture emails under `.example.test`.
- Use a local or generated QA-only password, never a real user password.
- Do not commit service role keys, database URLs, invite tokens, personal emails, or provider keys.
- Reset the staging QA data before demos that depend on a known state.
