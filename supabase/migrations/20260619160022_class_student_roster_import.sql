create table if not exists public.class_student_roster (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes (id) on delete cascade,
  email text not null,
  display_name text not null,
  github_username text,
  linked_user_id uuid references public.users (id) on delete set null,
  added_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint class_student_roster_class_email_unique unique (class_id, email),
  constraint class_student_roster_email_not_blank check (length(btrim(email)) > 0),
  constraint class_student_roster_email_normalized check (email = lower(btrim(email))),
  constraint class_student_roster_display_name_not_blank check (length(btrim(display_name)) > 0),
  constraint class_student_roster_github_username_not_blank check (
    github_username is null or length(btrim(github_username)) > 0
  ),
  constraint class_student_roster_github_username_normalized check (
    github_username is null or github_username = regexp_replace(btrim(github_username), '^@+', '')
  )
);

create index if not exists class_student_roster_class_id_idx
  on public.class_student_roster (class_id);

create index if not exists class_student_roster_linked_user_id_idx
  on public.class_student_roster (linked_user_id);

create index if not exists class_student_roster_email_idx
  on public.class_student_roster (email);

drop trigger if exists set_class_student_roster_updated_at on public.class_student_roster;
create trigger set_class_student_roster_updated_at
before update on public.class_student_roster
for each row
execute function public.set_updated_at();

alter table public.class_student_roster enable row level security;

grant select, insert, update, delete on public.class_student_roster to authenticated;

drop policy if exists "class_student_roster_select_class_access" on public.class_student_roster;
create policy "class_student_roster_select_class_access"
on public.class_student_roster
for select
to authenticated
using (public.can_access_class(class_id));

drop policy if exists "class_student_roster_insert_class_manager" on public.class_student_roster;
create policy "class_student_roster_insert_class_manager"
on public.class_student_roster
for insert
to authenticated
with check (public.can_manage_class(class_id));

drop policy if exists "class_student_roster_update_class_manager" on public.class_student_roster;
create policy "class_student_roster_update_class_manager"
on public.class_student_roster
for update
to authenticated
using (public.can_manage_class(class_id))
with check (public.can_manage_class(class_id));

drop policy if exists "class_student_roster_delete_class_manager" on public.class_student_roster;
create policy "class_student_roster_delete_class_manager"
on public.class_student_roster
for delete
to authenticated
using (public.can_manage_class(class_id));

create or replace function public.import_class_students(
  p_class_id uuid,
  p_students jsonb
)
returns table (
  email text,
  display_name text,
  github_username text,
  status text,
  user_id uuid,
  roster_id uuid,
  error text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student jsonb;
  v_email text;
  v_display_name text;
  v_github_username text;
  v_user_id uuid;
  v_user_role public.app_user_role;
  v_roster_id uuid;
  v_inserted_member_id uuid;
begin
  if not public.can_manage_class(p_class_id) then
    raise exception 'not allowed to import class students'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_students) is distinct from 'array' then
    raise exception 'students must be an array'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_students) = 0 or jsonb_array_length(p_students) > 200 then
    raise exception 'student import must contain 1 to 200 rows'
      using errcode = '22023';
  end if;

  for v_student in select value from jsonb_array_elements(p_students)
  loop
    v_email := lower(btrim(coalesce(v_student ->> 'email', '')));
    v_display_name := btrim(coalesce(v_student ->> 'display_name', ''));
    v_github_username := nullif(
      regexp_replace(btrim(coalesce(v_student ->> 'github_username', '')), '^@+', ''),
      ''
    );
    v_user_id := null;
    v_user_role := null;
    v_roster_id := null;
    v_inserted_member_id := null;

    if v_email = '' or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      email := v_email;
      display_name := v_display_name;
      github_username := v_github_username;
      status := 'invalid';
      user_id := null;
      roster_id := null;
      error := 'メールアドレスを確認してください。';
      return next;
      continue;
    end if;

    if v_display_name = '' then
      email := v_email;
      display_name := v_display_name;
      github_username := v_github_username;
      status := 'invalid';
      user_id := null;
      roster_id := null;
      error := '名前を入力してください。';
      return next;
      continue;
    end if;

    select u.id, u.role
    into v_user_id, v_user_role
    from public.users u
    where lower(u.email) = v_email
    limit 1;

    if v_user_id is not null and v_user_role <> 'student'::public.app_user_role then
      email := v_email;
      display_name := v_display_name;
      github_username := v_github_username;
      status := 'invalid';
      user_id := v_user_id;
      roster_id := null;
      error := 'このメールアドレスは生徒アカウントではありません。';
      return next;
      continue;
    end if;

    insert into public.class_student_roster (
      class_id,
      email,
      display_name,
      github_username,
      linked_user_id,
      added_by
    )
    values (
      p_class_id,
      v_email,
      v_display_name,
      v_github_username,
      v_user_id,
      auth.uid()
    )
    on conflict (class_id, email) do update
    set
      display_name = excluded.display_name,
      github_username = excluded.github_username,
      linked_user_id = coalesce(excluded.linked_user_id, public.class_student_roster.linked_user_id),
      added_by = excluded.added_by,
      updated_at = now()
    returning id into v_roster_id;

    if v_user_id is not null then
      insert into public.class_members (class_id, user_id, role)
      values (p_class_id, v_user_id, 'student')
      on conflict (class_id, user_id) do nothing
      returning id into v_inserted_member_id;

      email := v_email;
      display_name := v_display_name;
      github_username := v_github_username;
      status := case when v_inserted_member_id is null then 'already_member' else 'added_member' end;
      user_id := v_user_id;
      roster_id := v_roster_id;
      error := null;
      return next;
    else
      email := v_email;
      display_name := v_display_name;
      github_username := v_github_username;
      status := 'pending_signup';
      user_id := null;
      roster_id := v_roster_id;
      error := null;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function public.sync_class_student_roster_for_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_roster public.class_student_roster%rowtype;
begin
  if new.role <> 'student'::public.app_user_role then
    return new;
  end if;

  for v_roster in
    select *
    from public.class_student_roster csr
    where csr.email = lower(btrim(new.email))
      and (csr.linked_user_id is null or csr.linked_user_id = new.id)
  loop
    insert into public.class_members (class_id, user_id, role)
    values (v_roster.class_id, new.id, 'student')
    on conflict (class_id, user_id) do nothing;

    update public.class_student_roster
    set linked_user_id = new.id,
        updated_at = now()
    where id = v_roster.id;
  end loop;

  return new;
end;
$$;

drop trigger if exists sync_class_student_roster_for_user on public.users;
create trigger sync_class_student_roster_for_user
after insert or update of email, role on public.users
for each row
execute function public.sync_class_student_roster_for_user();

revoke execute on function public.import_class_students(uuid, jsonb) from public;
grant execute on function public.import_class_students(uuid, jsonb) to authenticated;
