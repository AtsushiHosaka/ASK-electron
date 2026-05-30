-- Allow students to save AI-generated patch proposals for their own threads.
-- Local application remains behind the separate patch review/apply flow.

drop policy if exists "patch_proposals_insert_ai_thread_owner" on public.patch_proposals;
create policy "patch_proposals_insert_ai_thread_owner"
on public.patch_proposals
for insert
to authenticated
with check (
  created_by_type = 'ai'::public.patch_creator_type
  and created_by = auth.uid()
  and public.owns_thread_project(thread_id)
  and public.message_thread_id(message_id) = thread_id
);
