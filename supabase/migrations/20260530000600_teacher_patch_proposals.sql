-- Teacher-created patch proposals must be review artifacts before any student action.

drop policy if exists "patch_proposals_insert_teacher_staff" on public.patch_proposals;
create policy "patch_proposals_insert_teacher_staff"
on public.patch_proposals
for insert
to authenticated
with check (
  created_by_type = 'teacher'::public.patch_creator_type
  and created_by = auth.uid()
  and status = 'proposed'::public.patch_status
  and public.current_user_role() = 'teacher'::public.app_user_role
  and public.is_thread_staff(thread_id)
  and public.message_thread_id(message_id) = thread_id
);
