-- Class invite tokens for teacher-generated student join links.

create table if not exists public.class_invites (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes (id) on delete cascade,
  token text not null unique,
  role public.class_member_role not null default 'student',
  expires_at timestamptz not null,
  created_by uuid not null references public.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint class_invites_token_not_blank check (length(btrim(token)) >= 24),
  constraint class_invites_student_only check (role = 'student'::public.class_member_role)
);

create index if not exists class_invites_class_id_idx on public.class_invites (class_id);
create index if not exists class_invites_expires_at_idx on public.class_invites (expires_at);

alter table public.class_invites enable row level security;

grant select on public.class_invites to authenticated;

drop policy if exists "class_invites_select_manager" on public.class_invites;
create policy "class_invites_select_manager"
on public.class_invites
for select
to authenticated
using (public.can_manage_class(class_id));

create or replace function public.create_class_invite(
  p_class_id uuid,
  p_role public.class_member_role default 'student',
  p_expires_in_seconds integer default 1209600
)
returns table (
  token text,
  class_id uuid,
  role public.class_member_role,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.class_invites%rowtype;
  v_token text;
begin
  if not public.can_manage_class(p_class_id) then
    raise exception 'not allowed to create class invite'
      using errcode = '42501';
  end if;

  if p_role is distinct from 'student'::public.class_member_role then
    raise exception 'only student invites are supported'
      using errcode = '22023';
  end if;

  if p_expires_in_seconds is null
    or p_expires_in_seconds < 3600
    or p_expires_in_seconds > 2592000
  then
    raise exception 'invite expiry must be between 1 hour and 30 days'
      using errcode = '22023';
  end if;

  loop
    v_token := rtrim(translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_'), '=');

    begin
      insert into public.class_invites (
        class_id,
        token,
        role,
        expires_at,
        created_by
      )
      values (
        p_class_id,
        v_token,
        p_role,
        now() + make_interval(secs => p_expires_in_seconds),
        auth.uid()
      )
      returning * into v_invite;

      exit;
    exception
      when unique_violation then null;
    end;
  end loop;

  return query
  select v_invite.token, v_invite.class_id, v_invite.role, v_invite.expires_at;
end;
$$;

create or replace function public.redeem_class_invite(p_token text)
returns table (
  class_id uuid,
  role public.class_member_role,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.class_invites%rowtype;
  v_inserted_member_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  if coalesce(public.current_user_role() <> 'student'::public.app_user_role, true) then
    raise exception 'only student accounts can redeem class invites'
      using errcode = '42501';
  end if;

  select *
  into v_invite
  from public.class_invites ci
  where ci.token = p_token
  limit 1;

  if not found then
    raise exception 'invite not found'
      using errcode = 'P0002';
  end if;

  if v_invite.expires_at <= now() then
    raise exception 'invite expired'
      using errcode = '22023';
  end if;

  insert into public.class_members (class_id, user_id, role)
  values (v_invite.class_id, auth.uid(), v_invite.role)
  on conflict (class_id, user_id) do nothing
  returning id into v_inserted_member_id;

  return query
  select
    v_invite.class_id,
    v_invite.role,
    case
      when v_inserted_member_id is not null then 'joined'
      else 'already_member'
    end;
end;
$$;

revoke execute on function public.create_class_invite(
  uuid,
  public.class_member_role,
  integer
) from public;
revoke execute on function public.redeem_class_invite(text) from public;

grant execute on function public.create_class_invite(
  uuid,
  public.class_member_role,
  integer
) to authenticated;
grant execute on function public.redeem_class_invite(text) to authenticated;
