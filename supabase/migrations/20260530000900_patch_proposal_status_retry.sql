-- Keep the immutable patch proposal guard from 20260530000700, but allow
-- students to retry a proposal after a failed local apply and mark it applied.

create or replace function public.enforce_patch_proposal_update_guard()
returns trigger
language plpgsql
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
    raise exception 'patch proposal metadata is immutable after creation'
      using errcode = '42501';
  end if;

  if old.status is not distinct from new.status then
    return new;
  end if;

  if not (
    (old.status = 'proposed'::public.patch_status and new.status in (
      'applied'::public.patch_status,
      'failed'::public.patch_status,
      'dismissed'::public.patch_status
    ))
    or (old.status = 'failed'::public.patch_status and new.status in (
      'applied'::public.patch_status,
      'dismissed'::public.patch_status
    ))
    or (old.status = 'applied'::public.patch_status and new.status = 'reverted'::public.patch_status)
  ) then
    raise exception 'invalid patch proposal status transition from % to %', old.status, new.status
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_patch_proposal_update_guard() from public;

drop trigger if exists enforce_patch_proposal_update_guard on public.patch_proposals;
create trigger enforce_patch_proposal_update_guard
before update on public.patch_proposals
for each row
execute function public.enforce_patch_proposal_update_guard();
