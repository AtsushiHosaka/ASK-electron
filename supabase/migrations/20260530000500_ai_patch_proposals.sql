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
  and status = 'proposed'::public.patch_status
  and public.owns_thread_project(thread_id)
  and public.message_thread_id(message_id) = thread_id
);

-- Used only as a compensating cleanup when the follow-up patch_proposals insert fails.
drop policy if exists "messages_delete_own_unlinked_patch_draft" on public.messages;
create policy "messages_delete_own_unlinked_patch_draft"
on public.messages
for delete
to authenticated
using (
  sender_user_id = auth.uid()
  and sender_type = 'student'::public.message_sender_type
  and message_type = 'patch'::public.message_type
  and public.owns_thread_project(thread_id)
  and not exists (
    select 1
    from public.patch_proposals pp
    where pp.message_id = messages.id
  )
);
