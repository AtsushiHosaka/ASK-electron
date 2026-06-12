-- Product usage event storage for source-backed analytics.
-- Keep payloads small and redacted: no code, raw errors, secrets, emails, tokens, or raw paths.

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.users (id) on delete cascade,
  actor_role public.app_user_role,
  event_name text not null,
  event_version integer not null default 1,
  session_id uuid not null,
  screen text,
  class_id uuid references public.classes (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  thread_id uuid references public.threads (id) on delete set null,
  patch_proposal_id uuid references public.patch_proposals (id) on delete set null,
  app_version text,
  platform text,
  duration_ms integer,
  success boolean,
  error_code text,
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  constraint usage_events_event_name_format check (event_name ~ '^[a-z][a-z0-9_]{1,79}$'),
  constraint usage_events_event_version_positive check (
    event_version between 1 and 99
  ),
  constraint usage_events_session_not_nil check (
    session_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint usage_events_screen_safe check (public.audit_text_is_safe(screen)),
  constraint usage_events_app_version_safe check (public.audit_text_is_safe(app_version)),
  constraint usage_events_platform_safe check (public.audit_text_is_safe(platform)),
  constraint usage_events_duration_ms_non_negative check (
    duration_ms is null or duration_ms >= 0
  ),
  constraint usage_events_error_code_safe check (public.audit_text_is_safe(error_code)),
  constraint usage_events_properties_object check (jsonb_typeof(properties) = 'object'),
  constraint usage_events_properties_safe check (public.audit_jsonb_is_safe(properties)),
  constraint usage_events_received_after_occurred check (
    received_at >= occurred_at - interval '1 day'
  )
);

create index if not exists usage_events_occurred_at_idx
  on public.usage_events (occurred_at desc);
create index if not exists usage_events_event_name_occurred_at_idx
  on public.usage_events (event_name, occurred_at desc);
create index if not exists usage_events_actor_user_id_occurred_at_idx
  on public.usage_events (actor_user_id, occurred_at desc);
create index if not exists usage_events_class_id_occurred_at_idx
  on public.usage_events (class_id, occurred_at desc);
create index if not exists usage_events_project_id_occurred_at_idx
  on public.usage_events (project_id, occurred_at desc);
create index if not exists usage_events_thread_id_occurred_at_idx
  on public.usage_events (thread_id, occurred_at desc);
create index if not exists usage_events_session_id_idx
  on public.usage_events (session_id);

alter table public.usage_events enable row level security;

revoke all on public.usage_events from anon;
revoke all on public.usage_events from authenticated;
grant select, insert, update, delete on public.usage_events to service_role;

create or replace function private.insert_usage_event(
  p_actor_user_id uuid,
  p_event_name text,
  p_event_version integer default 1,
  p_session_id uuid default gen_random_uuid(),
  p_screen text default null,
  p_class_id uuid default null,
  p_project_id uuid default null,
  p_thread_id uuid default null,
  p_patch_proposal_id uuid default null,
  p_app_version text default null,
  p_platform text default null,
  p_duration_ms integer default null,
  p_success boolean default null,
  p_error_code text default null,
  p_properties jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_actor_role public.app_user_role;
  v_event_id uuid;
  v_class_id uuid := p_class_id;
  v_project_id uuid := p_project_id;
  v_thread_project_id uuid;
  v_project_class_id uuid;
  v_patch_thread_id uuid;
begin
  if p_actor_user_id is null or p_actor_user_id <> auth.uid() then
    raise exception 'usage event actor must match authenticated user'
      using errcode = '42501';
  end if;

  if p_event_name is null or p_event_name !~ '^[a-z][a-z0-9_]{1,79}$' then
    raise exception 'invalid usage event name'
      using errcode = '22023';
  end if;

  if coalesce(p_event_version, 0) not between 1 and 99 then
    raise exception 'invalid usage event version'
      using errcode = '22023';
  end if;

  if coalesce(
    p_session_id,
    '00000000-0000-0000-0000-000000000000'::uuid
  ) = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'invalid usage event session'
      using errcode = '22023';
  end if;

  if not public.audit_text_is_safe(p_screen)
    or not public.audit_text_is_safe(p_app_version)
    or not public.audit_text_is_safe(p_platform)
    or coalesce(p_duration_ms, 0) < 0
    or not public.audit_text_is_safe(p_error_code)
    or not public.audit_jsonb_is_safe(coalesce(p_properties, '{}'::jsonb))
    or coalesce(jsonb_typeof(coalesce(p_properties, '{}'::jsonb)), 'object') <> 'object'
  then
    raise exception 'unsafe usage event payload'
      using errcode = '22023';
  end if;

  if p_patch_proposal_id is not null then
    select pp.thread_id
    into v_patch_thread_id
    from public.patch_proposals pp
    where pp.id = p_patch_proposal_id;

    if v_patch_thread_id is null then
      raise exception 'usage event patch proposal was not found'
        using errcode = '23503';
    end if;

    if p_thread_id is not null and p_thread_id <> v_patch_thread_id then
      raise exception 'usage event patch proposal does not belong to thread'
        using errcode = '23514';
    end if;

    p_thread_id := v_patch_thread_id;
  end if;

  if p_thread_id is not null then
    select t.project_id
    into v_thread_project_id
    from public.threads t
    where t.id = p_thread_id;

    if v_thread_project_id is null then
      raise exception 'usage event thread was not found'
        using errcode = '23503';
    end if;

    if v_project_id is not null and v_project_id <> v_thread_project_id then
      raise exception 'usage event thread does not belong to project'
        using errcode = '23514';
    end if;

    v_project_id := v_thread_project_id;
  end if;

  if v_project_id is not null then
    select p.class_id
    into v_project_class_id
    from public.projects p
    where p.id = v_project_id;

    if v_project_class_id is null then
      raise exception 'usage event project was not found'
        using errcode = '23503';
    end if;

    if v_class_id is not null and v_class_id <> v_project_class_id then
      raise exception 'usage event project does not belong to class'
        using errcode = '23514';
    end if;

    v_class_id := v_project_class_id;
  end if;

  if v_class_id is not null and not public.can_access_class(v_class_id) then
    raise exception 'not allowed to record usage for class'
      using errcode = '42501';
  end if;

  if v_project_id is not null and not public.can_access_project(v_project_id) then
    raise exception 'not allowed to record usage for project'
      using errcode = '42501';
  end if;

  if p_thread_id is not null and not public.can_access_thread(p_thread_id) then
    raise exception 'not allowed to record usage for thread'
      using errcode = '42501';
  end if;

  select u.role
  into v_actor_role
  from public.users u
  where u.id = p_actor_user_id;

  if v_actor_role is null then
    raise exception 'usage event actor profile was not found'
      using errcode = '23503';
  end if;

  insert into public.usage_events (
    actor_user_id,
    actor_role,
    event_name,
    event_version,
    session_id,
    screen,
    class_id,
    project_id,
    thread_id,
    patch_proposal_id,
    app_version,
    platform,
    duration_ms,
    success,
    error_code,
    properties,
    occurred_at
  )
  values (
    p_actor_user_id,
    v_actor_role,
    p_event_name,
    p_event_version,
    p_session_id,
    p_screen,
    v_class_id,
    v_project_id,
    p_thread_id,
    p_patch_proposal_id,
    p_app_version,
    p_platform,
    p_duration_ms,
    p_success,
    p_error_code,
    coalesce(p_properties, '{}'::jsonb),
    coalesce(p_occurred_at, now())
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

create or replace function public.track_usage_event(
  p_event_name text,
  p_event_version integer default 1,
  p_session_id uuid default gen_random_uuid(),
  p_screen text default null,
  p_class_id uuid default null,
  p_project_id uuid default null,
  p_thread_id uuid default null,
  p_patch_proposal_id uuid default null,
  p_app_version text default null,
  p_platform text default null,
  p_duration_ms integer default null,
  p_success boolean default null,
  p_error_code text default null,
  p_properties jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default now()
)
returns uuid
language sql
set search_path = public, pg_temp
as $$
  select private.insert_usage_event(
    p_actor_user_id => auth.uid(),
    p_event_name => p_event_name,
    p_event_version => p_event_version,
    p_session_id => p_session_id,
    p_screen => p_screen,
    p_class_id => p_class_id,
    p_project_id => p_project_id,
    p_thread_id => p_thread_id,
    p_patch_proposal_id => p_patch_proposal_id,
    p_app_version => p_app_version,
    p_platform => p_platform,
    p_duration_ms => p_duration_ms,
    p_success => p_success,
    p_error_code => p_error_code,
    p_properties => p_properties,
    p_occurred_at => p_occurred_at
  )
$$;

create or replace view public.usage_daily_metrics
with (security_invoker = true)
as
select
  date_trunc('day', occurred_at)::date as usage_date,
  actor_role,
  event_name,
  class_id,
  count(*)::bigint as event_count,
  count(distinct actor_user_id)::bigint as unique_users,
  count(distinct session_id)::bigint as unique_sessions
from public.usage_events
group by 1, 2, 3, 4;

revoke all on function private.insert_usage_event(
  uuid,
  text,
  integer,
  uuid,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  boolean,
  text,
  jsonb,
  timestamptz
) from public;
revoke all on function public.track_usage_event(
  text,
  integer,
  uuid,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  boolean,
  text,
  jsonb,
  timestamptz
) from public;

grant usage on schema private to authenticated;
grant execute on function private.insert_usage_event(
  uuid,
  text,
  integer,
  uuid,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  boolean,
  text,
  jsonb,
  timestamptz
) to authenticated;
grant execute on function public.track_usage_event(
  text,
  integer,
  uuid,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  boolean,
  text,
  jsonb,
  timestamptz
) to authenticated;

revoke all on public.usage_daily_metrics from anon;
revoke all on public.usage_daily_metrics from authenticated;
grant select on public.usage_daily_metrics to service_role;
