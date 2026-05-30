-- ASK MVP row-level security.
-- Access is class-centered: students see only their own project/thread data,
-- while teachers and mentors see records for classes they are assigned to.

create or replace function public.current_user_role()
returns public.app_user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.role
  from public.users u
  where u.id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.current_user_role() = 'admin'::public.app_user_role, false)
$$;

create or replace function public.membership_role_for(p_class_id uuid, p_user_id uuid)
returns public.class_member_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select cm.role
  from public.class_members cm
  where cm.class_id = p_class_id
    and cm.user_id = p_user_id
  order by case cm.role
    when 'teacher' then 1
    when 'mentor' then 2
    when 'student' then 3
  end
  limit 1
$$;

create or replace function public.user_is_class_member(p_class_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
    and exists (
      select 1
      from public.class_members cm
      where cm.class_id = p_class_id
        and cm.user_id = p_user_id
    )
$$;

create or replace function public.user_is_class_staff(p_class_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
    and (
      exists (
        select 1
        from public.class_members cm
        where cm.class_id = p_class_id
          and cm.user_id = p_user_id
          and cm.role in ('teacher', 'mentor')
      )
      or exists (
        select 1
        from public.classes c
        where c.id = p_class_id
          and c.created_by = p_user_id
      )
    )
$$;

create or replace function public.is_class_creator(p_class_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
    and exists (
      select 1
      from public.classes c
      where c.id = p_class_id
        and c.created_by = p_user_id
    )
$$;

create or replace function public.can_access_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_admin()
    or public.user_is_class_member(p_class_id, auth.uid())
    or public.is_class_creator(p_class_id, auth.uid())
$$;

create or replace function public.can_manage_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_admin()
    or public.is_class_creator(p_class_id, auth.uid())
    or public.membership_role_for(p_class_id, auth.uid()) = 'teacher'::public.class_member_role
$$;

create or replace function public.shares_class_with_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1
      from public.class_members me
      join public.class_members other_member
        on other_member.class_id = me.class_id
      where me.user_id = auth.uid()
        and other_member.user_id = p_user_id
    )
$$;

create or replace function public.staff_shares_class_with_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_admin()
    or exists (
      select 1
      from public.class_members target_member
      where target_member.user_id = p_user_id
        and public.user_is_class_staff(target_member.class_id, auth.uid())
    )
$$;

create or replace function public.has_github_connection(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
    and exists (
      select 1
      from public.github_connections gc
      where gc.user_id = p_user_id
    )
$$;

create or replace function public.owns_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = p_project_id
      and p.owner_user_id = auth.uid()
  )
$$;

create or replace function public.is_project_staff(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = p_project_id
      and public.user_is_class_staff(p.class_id, auth.uid())
  )
$$;

create or replace function public.can_access_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = p_project_id
      and (
        p.owner_user_id = auth.uid()
        or public.is_admin()
        or public.user_is_class_staff(p.class_id, auth.uid())
      )
  )
$$;

create or replace function public.thread_project_id(p_thread_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.project_id
  from public.threads t
  where t.id = p_thread_id
$$;

create or replace function public.owns_thread_project(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.owns_project(public.thread_project_id(p_thread_id))
$$;

create or replace function public.is_thread_staff(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_project_staff(public.thread_project_id(p_thread_id))
$$;

create or replace function public.can_access_thread(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_access_project(public.thread_project_id(p_thread_id))
$$;

create or replace function public.message_thread_id(p_message_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.thread_id
  from public.messages m
  where m.id = p_message_id
$$;

create or replace function public.prevent_unsafe_user_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.id is distinct from new.id then
    raise exception 'users.id cannot be changed';
  end if;

  if old.role is distinct from new.role
    and auth.uid() is not null
    and not public.is_admin()
  then
    raise exception 'only admins can change user roles';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_unsafe_user_role_change on public.users;
create trigger prevent_unsafe_user_role_change
before update on public.users
for each row
execute function public.prevent_unsafe_user_role_change();

alter table public.users enable row level security;
alter table public.classes enable row level security;
alter table public.class_members enable row level security;
alter table public.projects enable row level security;
alter table public.github_connections enable row level security;
alter table public.threads enable row level security;
alter table public.messages enable row level security;
alter table public.environment_snapshots enable row level security;
alter table public.patch_proposals enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.users,
  public.classes,
  public.class_members,
  public.projects,
  public.github_connections,
  public.threads,
  public.messages,
  public.environment_snapshots,
  public.patch_proposals
to authenticated;

revoke execute on function public.current_user_role() from public;
revoke execute on function public.is_admin() from public;
revoke execute on function public.membership_role_for(uuid, uuid) from public;
revoke execute on function public.user_is_class_member(uuid, uuid) from public;
revoke execute on function public.user_is_class_staff(uuid, uuid) from public;
revoke execute on function public.is_class_creator(uuid, uuid) from public;
revoke execute on function public.can_access_class(uuid) from public;
revoke execute on function public.can_manage_class(uuid) from public;
revoke execute on function public.shares_class_with_user(uuid) from public;
revoke execute on function public.staff_shares_class_with_user(uuid) from public;
revoke execute on function public.has_github_connection(uuid) from public;
revoke execute on function public.owns_project(uuid) from public;
revoke execute on function public.is_project_staff(uuid) from public;
revoke execute on function public.can_access_project(uuid) from public;
revoke execute on function public.thread_project_id(uuid) from public;
revoke execute on function public.owns_thread_project(uuid) from public;
revoke execute on function public.is_thread_staff(uuid) from public;
revoke execute on function public.can_access_thread(uuid) from public;
revoke execute on function public.message_thread_id(uuid) from public;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.membership_role_for(uuid, uuid) to authenticated;
grant execute on function public.user_is_class_member(uuid, uuid) to authenticated;
grant execute on function public.user_is_class_staff(uuid, uuid) to authenticated;
grant execute on function public.is_class_creator(uuid, uuid) to authenticated;
grant execute on function public.can_access_class(uuid) to authenticated;
grant execute on function public.can_manage_class(uuid) to authenticated;
grant execute on function public.shares_class_with_user(uuid) to authenticated;
grant execute on function public.staff_shares_class_with_user(uuid) to authenticated;
grant execute on function public.has_github_connection(uuid) to authenticated;
grant execute on function public.owns_project(uuid) to authenticated;
grant execute on function public.is_project_staff(uuid) to authenticated;
grant execute on function public.can_access_project(uuid) to authenticated;
grant execute on function public.thread_project_id(uuid) to authenticated;
grant execute on function public.owns_thread_project(uuid) to authenticated;
grant execute on function public.is_thread_staff(uuid) to authenticated;
grant execute on function public.can_access_thread(uuid) to authenticated;
grant execute on function public.message_thread_id(uuid) to authenticated;

drop policy if exists "users_select_accessible_profiles" on public.users;
create policy "users_select_accessible_profiles"
on public.users
for select
to authenticated
using (public.shares_class_with_user(id));

drop policy if exists "users_insert_own_student_profile" on public.users;
create policy "users_insert_own_student_profile"
on public.users
for insert
to authenticated
with check (id = auth.uid() and role = 'student'::public.app_user_role);

drop policy if exists "users_update_own_or_admin" on public.users;
create policy "users_update_own_or_admin"
on public.users
for update
to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

drop policy if exists "users_delete_admin_only" on public.users;
create policy "users_delete_admin_only"
on public.users
for delete
to authenticated
using (public.is_admin());

drop policy if exists "classes_select_accessible" on public.classes;
create policy "classes_select_accessible"
on public.classes
for select
to authenticated
using (public.can_access_class(id));

drop policy if exists "classes_insert_teacher_or_admin" on public.classes;
create policy "classes_insert_teacher_or_admin"
on public.classes
for insert
to authenticated
with check (
  created_by = auth.uid()
  and public.current_user_role() in (
    'teacher'::public.app_user_role,
    'admin'::public.app_user_role
  )
);

drop policy if exists "classes_update_manager" on public.classes;
create policy "classes_update_manager"
on public.classes
for update
to authenticated
using (public.can_manage_class(id))
with check (public.can_manage_class(id));

drop policy if exists "classes_delete_manager" on public.classes;
create policy "classes_delete_manager"
on public.classes
for delete
to authenticated
using (public.can_manage_class(id));

drop policy if exists "class_members_select_class_access" on public.class_members;
create policy "class_members_select_class_access"
on public.class_members
for select
to authenticated
using (public.can_access_class(class_id));

drop policy if exists "class_members_insert_class_manager" on public.class_members;
create policy "class_members_insert_class_manager"
on public.class_members
for insert
to authenticated
with check (public.can_manage_class(class_id));

drop policy if exists "class_members_update_class_manager" on public.class_members;
create policy "class_members_update_class_manager"
on public.class_members
for update
to authenticated
using (public.can_manage_class(class_id))
with check (public.can_manage_class(class_id));

drop policy if exists "class_members_delete_class_manager" on public.class_members;
create policy "class_members_delete_class_manager"
on public.class_members
for delete
to authenticated
using (public.can_manage_class(class_id));

drop policy if exists "github_connections_select_accessible" on public.github_connections;
create policy "github_connections_select_accessible"
on public.github_connections
for select
to authenticated
using (
  user_id = auth.uid()
  or public.staff_shares_class_with_user(user_id)
);

drop policy if exists "github_connections_insert_own" on public.github_connections;
create policy "github_connections_insert_own"
on public.github_connections
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "github_connections_update_own_or_admin" on public.github_connections;
create policy "github_connections_update_own_or_admin"
on public.github_connections
for update
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "github_connections_delete_own_or_admin" on public.github_connections;
create policy "github_connections_delete_own_or_admin"
on public.github_connections
for delete
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "projects_select_accessible" on public.projects;
create policy "projects_select_accessible"
on public.projects
for select
to authenticated
using (public.can_access_project(id));

drop policy if exists "projects_insert_student_own_with_github" on public.projects;
create policy "projects_insert_student_own_with_github"
on public.projects
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  and public.current_user_role() = 'student'::public.app_user_role
  and public.membership_role_for(class_id, auth.uid()) = 'student'::public.class_member_role
  and public.has_github_connection(auth.uid())
);

drop policy if exists "projects_update_owner_or_admin" on public.projects;
create policy "projects_update_owner_or_admin"
on public.projects
for update
to authenticated
using (owner_user_id = auth.uid() or public.is_admin())
with check (
  public.is_admin()
  or (
    owner_user_id = auth.uid()
    and public.membership_role_for(class_id, auth.uid()) = 'student'::public.class_member_role
    and public.has_github_connection(auth.uid())
  )
);

drop policy if exists "projects_delete_owner_or_admin" on public.projects;
create policy "projects_delete_owner_or_admin"
on public.projects
for delete
to authenticated
using (owner_user_id = auth.uid() or public.is_admin());

drop policy if exists "threads_select_accessible" on public.threads;
create policy "threads_select_accessible"
on public.threads
for select
to authenticated
using (public.can_access_thread(id));

drop policy if exists "threads_insert_student_or_teacher" on public.threads;
create policy "threads_insert_student_or_teacher"
on public.threads
for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    public.owns_project(project_id)
    or (
      public.current_user_role() = 'teacher'::public.app_user_role
      and public.is_project_staff(project_id)
    )
  )
);

drop policy if exists "threads_update_participant" on public.threads;
create policy "threads_update_participant"
on public.threads
for update
to authenticated
using (public.can_access_thread(id))
with check (public.can_access_thread(id));

drop policy if exists "threads_delete_creator_or_admin" on public.threads;
create policy "threads_delete_creator_or_admin"
on public.threads
for delete
to authenticated
using (created_by = auth.uid() or public.is_admin());

drop policy if exists "messages_select_accessible_thread" on public.messages;
create policy "messages_select_accessible_thread"
on public.messages
for select
to authenticated
using (public.can_access_thread(thread_id));

drop policy if exists "messages_insert_thread_participant" on public.messages;
create policy "messages_insert_thread_participant"
on public.messages
for insert
to authenticated
with check (
  public.can_access_thread(thread_id)
  and (
    (
      sender_type = 'student'::public.message_sender_type
      and sender_user_id = auth.uid()
      and public.owns_thread_project(thread_id)
    )
    or (
      sender_type = 'teacher'::public.message_sender_type
      and sender_user_id = auth.uid()
      and (
        (
          public.current_user_role() = 'teacher'::public.app_user_role
          and public.is_thread_staff(thread_id)
        )
        or public.is_admin()
      )
    )
  )
);

drop policy if exists "environment_snapshots_select_accessible_thread" on public.environment_snapshots;
create policy "environment_snapshots_select_accessible_thread"
on public.environment_snapshots
for select
to authenticated
using (
  project_id = public.thread_project_id(thread_id)
  and public.can_access_thread(thread_id)
);

drop policy if exists "environment_snapshots_insert_project_owner" on public.environment_snapshots;
create policy "environment_snapshots_insert_project_owner"
on public.environment_snapshots
for insert
to authenticated
with check (
  project_id = public.thread_project_id(thread_id)
  and public.owns_project(project_id)
);

drop policy if exists "patch_proposals_select_accessible_thread" on public.patch_proposals;
create policy "patch_proposals_select_accessible_thread"
on public.patch_proposals
for select
to authenticated
using (
  message_id is not null
  and public.message_thread_id(message_id) = thread_id
  and public.can_access_thread(thread_id)
);

drop policy if exists "patch_proposals_insert_teacher_staff" on public.patch_proposals;
create policy "patch_proposals_insert_teacher_staff"
on public.patch_proposals
for insert
to authenticated
with check (
  created_by_type = 'teacher'::public.patch_creator_type
  and created_by = auth.uid()
  and public.current_user_role() = 'teacher'::public.app_user_role
  and public.is_thread_staff(thread_id)
  and public.message_thread_id(message_id) = thread_id
);

drop policy if exists "patch_proposals_update_thread_participant" on public.patch_proposals;
create policy "patch_proposals_update_thread_participant"
on public.patch_proposals
for update
to authenticated
using (public.can_access_thread(thread_id))
with check (
  public.can_access_thread(thread_id)
  and public.message_thread_id(message_id) = thread_id
);

drop policy if exists "patch_proposals_delete_creator_or_admin" on public.patch_proposals;
create policy "patch_proposals_delete_creator_or_admin"
on public.patch_proposals
for delete
to authenticated
using (created_by = auth.uid() or public.is_admin());
