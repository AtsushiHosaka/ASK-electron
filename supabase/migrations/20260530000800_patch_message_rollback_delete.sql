-- Allow client-side rollback when a patch message is created but its
-- patch_proposals row fails to insert. Only unlinked own patch drafts can be
-- deleted; linked proposals remain protected by the proposal lifecycle.

drop policy if exists "messages_delete_own_unlinked_patch_draft" on public.messages;
create policy "messages_delete_own_unlinked_patch_draft"
on public.messages
for delete
to authenticated
using (
  sender_user_id = auth.uid()
  and message_type = 'patch'::public.message_type
  and not exists (
    select 1
    from public.patch_proposals proposal
    where proposal.message_id = public.messages.id
  )
  and (
    (
      sender_type = 'student'::public.message_sender_type
      and public.owns_thread_project(thread_id)
    )
    or (
      sender_type = 'teacher'::public.message_sender_type
      and public.current_user_role() = 'teacher'::public.app_user_role
      and public.is_thread_staff(thread_id)
    )
  )
);
