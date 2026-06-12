-- Avoid a self-referential threads lookup during INSERT ... RETURNING.
-- Supabase clients commonly call .insert(...).select(), which evaluates the
-- SELECT policy for the newly inserted row. Using the row's project_id directly
-- keeps the policy equivalent for reads while allowing the returning row.

drop policy if exists "threads_select_accessible" on public.threads;
create policy "threads_select_accessible"
on public.threads
for select
to authenticated
using (public.can_access_project(project_id));
