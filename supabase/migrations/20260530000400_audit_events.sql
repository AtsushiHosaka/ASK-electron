-- Audit event storage for MVP security-sensitive actions.
-- Keep values small and redacted: no secrets, raw .env values, tokens, or raw absolute paths.

do $$
begin
  create type public.audit_event_type as enum (
    'auth_login_succeeded',
    'auth_login_failed',
    'auth_signup_succeeded',
    'auth_signout_succeeded',
    'class_created',
    'class_invite_created',
    'class_invite_redeemed',
    'project_created',
    'thread_created',
    'message_sent',
    'ai_used',
    'patch_proposed',
    'patch_applied',
    'patch_failed',
    'patch_reverted',
    'patch_dismissed',
    'ipc_operation',
    'security_blocked'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.audit_decision as enum (
    'allowed',
    'denied',
    'blocked',
    'failed',
    'succeeded'
  );
exception
  when duplicate_object then null;
end
$$;

create or replace function public.audit_text_is_safe(p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_value is null
    or (
      p_value !~* '-----BEGIN [A-Z ]*PRIVATE KEY-----'
      and p_value !~* '(^|[^a-z0-9])(sb_secret_|service_role|github[_ -]?token|access[_ -]?token|api[_ -]?key|secret[_ -]?key|password[[:space:]]*[:=])'
      and p_value !~* '(^|[[:space:]"''])\.env($|[[:space:]./\\])'
      and p_value !~* '(^|[[:space:]"''])/(Users|home|var|tmp|private|Volumes|Applications|etc)(/|[[:space:]"'']|$)'
      and p_value !~* '(^|[[:space:]"''])[A-Za-z]:\\'
    )
$$;

create or replace function public.audit_jsonb_is_safe(p_metadata jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_typeof(p_metadata), 'object') = 'object'
    and length(coalesce(p_metadata::text, '{}')) <= 12000
    and public.audit_text_is_safe(coalesce(p_metadata::text, '{}'))
    and coalesce(p_metadata::text, '{}') !~* $re$"[^"]*(password|passwd|token|secret|private.?key|service.?role|env.?value|raw.?path|absolute.?path|ssh.?key)[^"]*"\s*:$re$
$$;

create or replace function public.audit_relative_paths_are_safe(p_paths text[])
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_length(p_paths, 1), 0) <= 100
    and not exists (
      select 1
      from unnest(coalesce(p_paths, '{}'::text[])) as path(value)
      where value is null
        or length(value) > 240
        or not public.audit_text_is_safe(value)
        or value ~ '(^|/)\.\.(/|$)'
    )
$$;

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.users (id) on delete set null,
  actor_role public.app_user_role,
  event_type public.audit_event_type not null,
  decision public.audit_decision not null,
  operation text not null,
  class_id uuid references public.classes (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  thread_id uuid references public.threads (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  patch_proposal_id uuid references public.patch_proposals (id) on delete set null,
  ipc_channel text,
  request_id text,
  project_root_hash text,
  relative_paths text[] not null default '{}'::text[],
  duration_ms integer,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  redaction jsonb not null default jsonb_build_object(
    'absolute_paths_redacted',
    true,
    'secrets_redacted',
    true,
    'output_truncated',
    false
  ),
  created_at timestamptz not null default now(),
  constraint audit_events_operation_not_blank check (length(btrim(operation)) > 0),
  constraint audit_events_operation_safe check (public.audit_text_is_safe(operation)),
  constraint audit_events_ipc_channel_safe check (public.audit_text_is_safe(ipc_channel)),
  constraint audit_events_request_id_safe check (public.audit_text_is_safe(request_id)),
  constraint audit_events_project_root_hash_safe check (
    project_root_hash is null or project_root_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint audit_events_relative_paths_safe check (
    public.audit_relative_paths_are_safe(relative_paths)
  ),
  constraint audit_events_duration_ms_non_negative check (
    duration_ms is null or duration_ms >= 0
  ),
  constraint audit_events_error_code_safe check (public.audit_text_is_safe(error_code)),
  constraint audit_events_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint audit_events_metadata_safe check (public.audit_jsonb_is_safe(metadata)),
  constraint audit_events_redaction_object check (jsonb_typeof(redaction) = 'object')
);

create index if not exists audit_events_actor_user_id_idx on public.audit_events (actor_user_id);
create index if not exists audit_events_event_type_idx on public.audit_events (event_type);
create index if not exists audit_events_created_at_idx on public.audit_events (created_at desc);
create index if not exists audit_events_class_id_idx on public.audit_events (class_id);
create index if not exists audit_events_project_id_idx on public.audit_events (project_id);
create index if not exists audit_events_thread_id_idx on public.audit_events (thread_id);

alter table public.audit_events enable row level security;

grant select on public.audit_events to authenticated;
revoke insert, update, delete on public.audit_events from authenticated;

drop policy if exists "audit_events_select_scoped" on public.audit_events;
create policy "audit_events_select_scoped"
on public.audit_events
for select
to authenticated
using (
  actor_user_id = auth.uid()
  or public.is_admin()
  or (class_id is not null and public.can_access_class(class_id))
  or (project_id is not null and public.can_access_project(project_id))
  or (thread_id is not null and public.can_access_thread(thread_id))
  or (
    message_id is not null
    and public.can_access_thread(public.message_thread_id(message_id))
  )
  or (
    patch_proposal_id is not null
    and exists (
      select 1
      from public.patch_proposals pp
      where pp.id = patch_proposal_id
        and public.can_access_thread(pp.thread_id)
    )
  )
);

create or replace function public.audit_insert_event(
  p_actor_user_id uuid,
  p_event_type public.audit_event_type,
  p_decision public.audit_decision,
  p_operation text,
  p_class_id uuid default null,
  p_project_id uuid default null,
  p_thread_id uuid default null,
  p_message_id uuid default null,
  p_patch_proposal_id uuid default null,
  p_ipc_channel text default null,
  p_request_id text default null,
  p_project_root_hash text default null,
  p_relative_paths text[] default '{}'::text[],
  p_duration_ms integer default null,
  p_error_code text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_redaction jsonb default jsonb_build_object(
    'absolute_paths_redacted',
    true,
    'secrets_redacted',
    true,
    'output_truncated',
    false
  )
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_actor_role public.app_user_role;
begin
  if not public.audit_text_is_safe(p_operation)
    or not public.audit_text_is_safe(p_ipc_channel)
    or not public.audit_text_is_safe(p_request_id)
    or (p_project_root_hash is not null and p_project_root_hash !~ '^[a-f0-9]{64}$')
    or not public.audit_relative_paths_are_safe(coalesce(p_relative_paths, '{}'::text[]))
    or coalesce(p_duration_ms, 0) < 0
    or not public.audit_text_is_safe(p_error_code)
    or not public.audit_jsonb_is_safe(coalesce(p_metadata, '{}'::jsonb))
    or jsonb_typeof(coalesce(p_redaction, '{}'::jsonb)) <> 'object'
  then
    raise exception 'unsafe audit event payload'
      using errcode = '22023';
  end if;

  select u.role
  into v_actor_role
  from public.users u
  where u.id = p_actor_user_id;

  insert into public.audit_events (
    actor_user_id,
    actor_role,
    event_type,
    decision,
    operation,
    class_id,
    project_id,
    thread_id,
    message_id,
    patch_proposal_id,
    ipc_channel,
    request_id,
    project_root_hash,
    relative_paths,
    duration_ms,
    error_code,
    metadata,
    redaction
  )
  values (
    p_actor_user_id,
    v_actor_role,
    p_event_type,
    p_decision,
    p_operation,
    p_class_id,
    p_project_id,
    p_thread_id,
    p_message_id,
    p_patch_proposal_id,
    p_ipc_channel,
    p_request_id,
    p_project_root_hash,
    coalesce(p_relative_paths, '{}'::text[]),
    p_duration_ms,
    p_error_code,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(
      p_redaction,
      jsonb_build_object(
        'absolute_paths_redacted',
        true,
        'secrets_redacted',
        true,
        'output_truncated',
        false
      )
    )
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

create or replace function public.record_audit_event(
  p_event_type public.audit_event_type,
  p_decision public.audit_decision,
  p_operation text,
  p_class_id uuid default null,
  p_project_id uuid default null,
  p_thread_id uuid default null,
  p_message_id uuid default null,
  p_patch_proposal_id uuid default null,
  p_ipc_channel text default null,
  p_request_id text default null,
  p_project_root_hash text default null,
  p_relative_paths text[] default '{}'::text[],
  p_duration_ms integer default null,
  p_error_code text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_redaction jsonb default jsonb_build_object(
    'absolute_paths_redacted',
    true,
    'secrets_redacted',
    true,
    'output_truncated',
    false
  )
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  if p_class_id is not null and not public.can_access_class(p_class_id) then
    raise exception 'not allowed to audit class event'
      using errcode = '42501';
  end if;

  if p_project_id is not null and not public.can_access_project(p_project_id) then
    raise exception 'not allowed to audit project event'
      using errcode = '42501';
  end if;

  if p_thread_id is not null and not public.can_access_thread(p_thread_id) then
    raise exception 'not allowed to audit thread event'
      using errcode = '42501';
  end if;

  if p_message_id is not null
    and not public.can_access_thread(public.message_thread_id(p_message_id))
  then
    raise exception 'not allowed to audit message event'
      using errcode = '42501';
  end if;

  if p_patch_proposal_id is not null
    and not exists (
      select 1
      from public.patch_proposals pp
      where pp.id = p_patch_proposal_id
        and public.can_access_thread(pp.thread_id)
    )
  then
    raise exception 'not allowed to audit patch event'
      using errcode = '42501';
  end if;

  return public.audit_insert_event(
    p_actor_user_id => auth.uid(),
    p_event_type => p_event_type,
    p_decision => p_decision,
    p_operation => p_operation,
    p_class_id => p_class_id,
    p_project_id => p_project_id,
    p_thread_id => p_thread_id,
    p_message_id => p_message_id,
    p_patch_proposal_id => p_patch_proposal_id,
    p_ipc_channel => p_ipc_channel,
    p_request_id => p_request_id,
    p_project_root_hash => p_project_root_hash,
    p_relative_paths => p_relative_paths,
    p_duration_ms => p_duration_ms,
    p_error_code => p_error_code,
    p_metadata => p_metadata,
    p_redaction => p_redaction
  );
end;
$$;

revoke execute on function public.audit_text_is_safe(text) from public;
revoke execute on function public.audit_jsonb_is_safe(jsonb) from public;
revoke execute on function public.audit_relative_paths_are_safe(text[]) from public;
revoke execute on function public.audit_insert_event(
  uuid,
  public.audit_event_type,
  public.audit_decision,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text[],
  integer,
  text,
  jsonb,
  jsonb
) from public;
revoke execute on function public.record_audit_event(
  public.audit_event_type,
  public.audit_decision,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text[],
  integer,
  text,
  jsonb,
  jsonb
) from public;

grant execute on function public.record_audit_event(
  public.audit_event_type,
  public.audit_decision,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text[],
  integer,
  text,
  jsonb,
  jsonb
) to authenticated;

create or replace function public.audit_class_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.audit_insert_event(
    p_actor_user_id => coalesce(auth.uid(), new.created_by),
    p_event_type => 'class_created',
    p_decision => 'succeeded',
    p_operation => 'classes.insert',
    p_class_id => new.id,
    p_metadata => jsonb_build_object('has_description', new.description is not null)
  );
  return new;
end;
$$;

drop trigger if exists audit_class_created on public.classes;
create trigger audit_class_created
after insert on public.classes
for each row
execute function public.audit_class_created();

create or replace function public.audit_student_class_member_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role = 'student'::public.class_member_role then
    perform public.audit_insert_event(
      p_actor_user_id => coalesce(auth.uid(), new.user_id),
      p_event_type => 'class_invite_redeemed',
      p_decision => 'succeeded',
      p_operation => 'class_members.insert.student',
      p_class_id => new.class_id,
      p_metadata => jsonb_build_object('member_role', new.role)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_student_class_member_created on public.class_members;
create trigger audit_student_class_member_created
after insert on public.class_members
for each row
execute function public.audit_student_class_member_created();

create or replace function public.audit_class_invite_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.audit_insert_event(
    p_actor_user_id => coalesce(auth.uid(), new.created_by),
    p_event_type => 'class_invite_created',
    p_decision => 'succeeded',
    p_operation => 'class_invites.insert',
    p_class_id => new.class_id,
    p_metadata => jsonb_build_object(
      'role',
      new.role,
      'expires_at',
      new.expires_at
    )
  );
  return new;
end;
$$;

drop trigger if exists audit_class_invite_created on public.class_invites;
create trigger audit_class_invite_created
after insert on public.class_invites
for each row
execute function public.audit_class_invite_created();

create or replace function public.audit_project_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.audit_insert_event(
    p_actor_user_id => coalesce(auth.uid(), new.owner_user_id),
    p_event_type => 'project_created',
    p_decision => 'succeeded',
    p_operation => 'projects.insert',
    p_class_id => new.class_id,
    p_project_id => new.id,
    p_metadata => jsonb_build_object(
      'has_local_path_hash',
      new.local_path_hash is not null,
      'has_default_branch',
      new.default_branch is not null
    )
  );
  return new;
end;
$$;

drop trigger if exists audit_project_created on public.projects;
create trigger audit_project_created
after insert on public.projects
for each row
execute function public.audit_project_created();

create or replace function public.audit_thread_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.audit_insert_event(
    p_actor_user_id => coalesce(auth.uid(), new.created_by),
    p_event_type => 'thread_created',
    p_decision => 'succeeded',
    p_operation => 'threads.insert',
    p_project_id => new.project_id,
    p_thread_id => new.id,
    p_metadata => jsonb_build_object(
      'status',
      new.status,
      'priority',
      new.priority,
      'ai_used',
      new.ai_used
    )
  );
  return new;
end;
$$;

drop trigger if exists audit_thread_created on public.threads;
create trigger audit_thread_created
after insert on public.threads
for each row
execute function public.audit_thread_created();

create or replace function public.audit_message_sent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.audit_insert_event(
    p_actor_user_id => coalesce(auth.uid(), new.sender_user_id),
    p_event_type => 'message_sent',
    p_decision => 'succeeded',
    p_operation => 'messages.insert',
    p_thread_id => new.thread_id,
    p_message_id => new.id,
    p_metadata => jsonb_build_object(
      'sender_type',
      new.sender_type,
      'message_type',
      new.message_type,
      'body_length',
      length(new.body)
    )
  );
  return new;
end;
$$;

drop trigger if exists audit_message_sent on public.messages;
create trigger audit_message_sent
after insert on public.messages
for each row
execute function public.audit_message_sent();

create or replace function public.audit_patch_proposal_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.created_by_type = 'ai'::public.patch_creator_type then
    perform public.audit_insert_event(
      p_actor_user_id => null,
      p_event_type => 'ai_used',
      p_decision => 'succeeded',
      p_operation => 'patch_proposals.insert.ai',
      p_thread_id => new.thread_id,
      p_message_id => new.message_id,
      p_patch_proposal_id => new.id,
      p_metadata => jsonb_build_object('result', 'patch_proposal')
    );
  end if;

  perform public.audit_insert_event(
    p_actor_user_id => coalesce(auth.uid(), new.created_by),
    p_event_type => 'patch_proposed',
    p_decision => 'succeeded',
    p_operation => 'patch_proposals.insert',
    p_thread_id => new.thread_id,
    p_message_id => new.message_id,
    p_patch_proposal_id => new.id,
    p_metadata => jsonb_build_object(
      'created_by_type',
      new.created_by_type,
      'status',
      new.status,
      'has_base_commit_sha',
      new.base_commit_sha is not null
    )
  );
  return new;
end;
$$;

drop trigger if exists audit_patch_proposal_created on public.patch_proposals;
create trigger audit_patch_proposal_created
after insert on public.patch_proposals
for each row
execute function public.audit_patch_proposal_created();

create or replace function public.audit_patch_proposal_status_changed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_type public.audit_event_type;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  v_event_type := case new.status
    when 'applied'::public.patch_status then 'patch_applied'::public.audit_event_type
    when 'failed'::public.patch_status then 'patch_failed'::public.audit_event_type
    when 'reverted'::public.patch_status then 'patch_reverted'::public.audit_event_type
    when 'dismissed'::public.patch_status then 'patch_dismissed'::public.audit_event_type
    else null
  end;

  if v_event_type is not null then
    perform public.audit_insert_event(
      p_actor_user_id => coalesce(auth.uid(), new.created_by),
      p_event_type => v_event_type,
      p_decision => case
        when new.status = 'failed'::public.patch_status then 'failed'::public.audit_decision
        else 'succeeded'::public.audit_decision
      end,
      p_operation => 'patch_proposals.update.status',
      p_thread_id => new.thread_id,
      p_message_id => new.message_id,
      p_patch_proposal_id => new.id,
      p_metadata => jsonb_build_object(
        'from_status',
        old.status,
        'to_status',
        new.status
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists audit_patch_proposal_status_changed on public.patch_proposals;
create trigger audit_patch_proposal_status_changed
after update of status on public.patch_proposals
for each row
execute function public.audit_patch_proposal_status_changed();
