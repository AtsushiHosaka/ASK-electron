# Supabase Foundation

Status: foundation notes for issues #3, #4, #6, and #11.

## Client Boundary

The Electron renderer uses Supabase with only public project config:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Do not put database passwords, `sb_secret_...`, service role keys, GitHub client secrets, or AI provider keys in Electron `.env` files. Packaged Electron apps are inspectable by users, including main and preload output.

## Migrations

Foundation migrations live in `supabase/migrations`:

- `20260530000100_mvp_schema.sql`: enums, MVP tables, indexes, triggers, and realtime publication setup.
- `20260530000200_mvp_rls.sql`: helper functions, grants, RLS enablement, and baseline policies.

`supabase/seed.sql` provides local fixtures for future RLS and UI checks.

## Auth Profiles

`auth.users` inserts and email/profile updates are mirrored into `public.users` by `public.handle_new_auth_user()`. New users default to the `student` role. Teacher/admin promotion is intentionally separate and should happen through trusted admin tooling or server-side operations.

## RLS Model

The MVP access model is class-centered:

- Students can access their own projects, threads, messages, environment snapshots, and patch proposals.
- Teachers and mentors can access records for classes where they are staff.
- Admins can access all MVP records.
- Project creation requires the student to own the project, belong to the class as a student, and have a GitHub connection record.

Run the migrations against a local Supabase instance before relying on the policies in production.
