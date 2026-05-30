# Supabase Foundation

Status: foundation notes for issues #3, #4, #6, and #11.

## Client Boundary

The Electron renderer uses Supabase with only public project config:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_ASK_APP_BASE_URL=http://localhost:5173
```

Do not put database passwords, `sb_secret_...`, service role keys, GitHub client secrets, or AI provider keys in Electron `.env` files. Packaged Electron apps are inspectable by users, including main and preload output.

## Migrations

Foundation migrations live in `supabase/migrations`:

- `20260530000100_mvp_schema.sql`: enums, MVP tables, indexes, triggers, and realtime publication setup.
- `20260530000200_mvp_rls.sql`: helper functions, grants, RLS enablement, and baseline policies.
- `20260530000300_class_invites.sql`: student invite tokens and RPCs for issuing and redeeming class joins.
- `20260530000400_audit_events.sql`: redacted audit event table, scoped read policy, authenticated audit RPC, and DB triggers for core MVP mutations.

`supabase/seed.sql` provides local fixtures for future RLS and UI checks.

## Auth Profiles

`auth.users` inserts and email/profile updates are mirrored into `public.users` by `public.handle_new_auth_user()`. New users default to the `student` role. Teacher/admin promotion is intentionally separate and should happen through trusted admin tooling or server-side operations.

## Class Creation

Teachers and admins can create classes from the Electron renderer with a user-scoped Supabase client. The MVP schema keeps `classes.organization_id` as a required UUID for future organization support, but there is no organizations table yet. Until that model lands, the renderer writes the class creator's user ID as the organization scope. The `add_class_creator_membership` trigger adds the creator to `class_members` as `teacher`, so the client should not separately insert the creator membership.

## RLS Model

The MVP access model is class-centered:

- Students can access their own projects, threads, messages, environment snapshots, and patch proposals.
- Teachers and mentors can access records for classes where they are staff.
- Admins can access all MVP records.
- Project creation requires the student to own the project, belong to the class as a student, and have a GitHub connection record.

## Audit Events

Audit records are stored in `public.audit_events` through DB triggers and the `record_audit_event` RPC. The table is append-only for authenticated clients: renderer code cannot insert, update, or delete rows directly. Scoped reads are allowed for the actor, admins, and users who can access the related class, project, or thread.

Audit metadata is intentionally small and redacted. The database rejects metadata keys or values that look like passwords, tokens, private keys, `.env` contents, service role secrets, or raw absolute paths. Project roots should be represented by `project_root_hash`, and file references should be relative paths only. Login failures remain in Supabase Auth logs for MVP because unauthenticated clients cannot safely write audit rows without a trusted server or Edge Function.

Run the migrations against a local Supabase instance before relying on the policies in production.
