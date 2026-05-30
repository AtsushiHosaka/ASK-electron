-- Patch proposal updates are limited to student-owned status transitions.
-- Proposal metadata is immutable after creation.

create or replace function public.enforce_patch_proposal_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.id is distinct from new.id
    or old.thread_id is distinct from new.thread_id
    or old.message_id is distinct from new.message_id
    or old.created_by is distinct from new.created_by
    or old.created_by_type is distinct from new.created_by_type
    or old.target_file_path is distinct from new.target_file_path
    or old.base_commit_sha is distinct from new.base_commit_sha
    or old.patch_text is distinct from new.patch_text
    or old.explanation is distinct from new.explanation
    or old.created_at is distinct from new.created_at
  then
    raise exception 'Patch proposal metadata is immutable after creation.'
      using errcode = '42501';
  end if;

  if old.status is distinct from new.status then
    if public.current_user_role() <> 'student'::public.app_user_role
      or not public.owns_thread_project(old.thread_id)
    then
      raise exception 'Only the student project owner can update patch proposal status.'
        using errcode = '42501';
    end if;

    if not (
      (old.status = 'proposed'::public.patch_status
        and new.status in (
          'applied'::public.patch_status,
          'failed'::public.patch_status,
          'dismissed'::public.patch_status
        ))
      or (old.status = 'failed'::public.patch_status
        and new.status in (
          'applied'::public.patch_status,
          'dismissed'::public.patch_status
        ))
      or (old.status = 'applied'::public.patch_status
        and new.status = 'reverted'::public.patch_status)
    ) then
      raise exception 'Invalid patch proposal status transition from % to %.', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_patch_proposal_update_guard on public.patch_proposals;
create trigger enforce_patch_proposal_update_guard
before update on public.patch_proposals
for each row
execute function public.enforce_patch_proposal_update_guard();

drop policy if exists "patch_proposals_update_thread_participant" on public.patch_proposals;
drop policy if exists "patch_proposals_update_student_status" on public.patch_proposals;
create policy "patch_proposals_update_student_status"
on public.patch_proposals
for update
to authenticated
using (
  public.current_user_role() = 'student'::public.app_user_role
  and public.owns_thread_project(thread_id)
  and public.message_thread_id(message_id) = thread_id
)
with check (
  public.current_user_role() = 'student'::public.app_user_role
  and public.owns_thread_project(thread_id)
  and public.message_thread_id(message_id) = thread_id
);
