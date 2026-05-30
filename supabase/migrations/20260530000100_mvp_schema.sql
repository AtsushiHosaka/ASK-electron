-- ASK MVP foundation schema.
-- This migration follows spec.md section 9 and keeps local machine details
-- limited to hashes, environment summaries, and patch metadata.

create extension if not exists pgcrypto;

do $$
begin
  create type public.app_user_role as enum ('student', 'teacher', 'admin');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.class_member_role as enum ('student', 'teacher', 'mentor');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.github_auth_method as enum ('gh_cli', 'device_flow', 'oauth', 'pat');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.github_ssh_status as enum ('unknown', 'ok', 'failed');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.thread_status as enum (
    'open',
    'in_progress',
    'waiting_student',
    'patch_proposed',
    'resolved',
    'reopened'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.thread_priority as enum ('low', 'normal', 'high');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.message_sender_type as enum ('student', 'teacher', 'ai', 'system');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.message_type as enum ('text', 'code', 'patch', 'environment', 'ai_summary');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.patch_creator_type as enum ('teacher', 'ai');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.patch_status as enum (
    'proposed',
    'applied',
    'failed',
    'reverted',
    'dismissed'
  );
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text not null,
  role public.app_user_role not null default 'student',
  github_username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_not_blank check (length(btrim(email)) > 0),
  constraint users_display_name_not_blank check (length(btrim(display_name)) > 0),
  constraint users_github_username_not_blank check (
    github_username is null or length(btrim(github_username)) > 0
  )
);

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  description text,
  created_by uuid not null references public.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint classes_name_not_blank check (length(btrim(name)) > 0),
  constraint classes_organization_name_unique unique (organization_id, name)
);

create table if not exists public.class_members (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role public.class_member_role not null,
  joined_at timestamptz not null default now(),
  constraint class_members_class_user_unique unique (class_id, user_id)
);

create table if not exists public.github_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  github_username text not null,
  auth_method public.github_auth_method not null,
  ssh_status public.github_ssh_status not null default 'unknown',
  last_checked_at timestamptz,
  constraint github_connections_user_unique unique (user_id),
  constraint github_connections_username_not_blank check (length(btrim(github_username)) > 0)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users (id) on delete cascade,
  class_id uuid not null references public.classes (id) on delete cascade,
  name text not null,
  local_path_hash text,
  github_repo_url text not null,
  default_branch text,
  created_at timestamptz not null default now(),
  constraint projects_name_not_blank check (length(btrim(name)) > 0),
  constraint projects_github_repo_url_not_blank check (length(btrim(github_repo_url)) > 0),
  constraint projects_local_path_hash_not_blank check (
    local_path_hash is null or length(btrim(local_path_hash)) > 0
  ),
  constraint projects_owner_repo_unique unique (owner_user_id, github_repo_url)
);

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  created_by uuid not null references public.users (id) on delete restrict,
  title text not null,
  status public.thread_status not null default 'open',
  priority public.thread_priority default 'normal',
  ai_used boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint threads_title_not_blank check (length(btrim(title)) > 0)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  sender_user_id uuid references public.users (id) on delete set null,
  sender_type public.message_sender_type not null,
  body text not null,
  message_type public.message_type not null default 'text',
  reply_to_message_id uuid references public.messages (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint messages_body_not_blank check (length(btrim(body)) > 0),
  constraint messages_human_sender_has_user check (
    (sender_type in ('student', 'teacher') and sender_user_id is not null)
    or sender_type in ('ai', 'system')
  )
);

create table if not exists public.environment_snapshots (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  os_name text,
  os_version text,
  arch text,
  git_version text,
  editor_name text,
  editor_version text,
  runtimes jsonb,
  package_managers jsonb,
  dependencies_summary jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.patch_proposals (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  created_by uuid references public.users (id) on delete set null,
  created_by_type public.patch_creator_type not null,
  target_file_path text not null,
  base_commit_sha text,
  patch_text text not null,
  explanation text,
  status public.patch_status not null default 'proposed',
  created_at timestamptz not null default now(),
  constraint patch_proposals_target_file_path_not_blank check (
    length(btrim(target_file_path)) > 0
  ),
  constraint patch_proposals_patch_text_not_blank check (length(btrim(patch_text)) > 0),
  constraint patch_proposals_teacher_creator_has_user check (
    (created_by_type = 'teacher' and created_by is not null)
    or created_by_type = 'ai'
  )
);

create index if not exists users_role_idx on public.users (role);
create index if not exists users_github_username_idx on public.users (github_username);

create index if not exists classes_created_by_idx on public.classes (created_by);
create index if not exists classes_organization_id_idx on public.classes (organization_id);

create index if not exists class_members_class_id_idx on public.class_members (class_id);
create index if not exists class_members_user_id_idx on public.class_members (user_id);
create index if not exists class_members_class_role_idx on public.class_members (class_id, role);

create index if not exists github_connections_github_username_idx
  on public.github_connections (github_username);

create index if not exists projects_owner_user_id_idx on public.projects (owner_user_id);
create index if not exists projects_class_id_idx on public.projects (class_id);

create index if not exists threads_project_id_idx on public.threads (project_id);
create index if not exists threads_created_by_idx on public.threads (created_by);
create index if not exists threads_status_updated_at_idx
  on public.threads (status, updated_at desc);

create index if not exists messages_thread_created_at_idx
  on public.messages (thread_id, created_at);
create index if not exists messages_sender_user_id_idx on public.messages (sender_user_id);
create index if not exists messages_reply_to_message_id_idx
  on public.messages (reply_to_message_id);

create index if not exists environment_snapshots_thread_id_idx
  on public.environment_snapshots (thread_id);
create index if not exists environment_snapshots_project_id_idx
  on public.environment_snapshots (project_id);

create index if not exists patch_proposals_thread_id_idx
  on public.patch_proposals (thread_id);
create index if not exists patch_proposals_message_id_idx
  on public.patch_proposals (message_id);
create index if not exists patch_proposals_status_idx
  on public.patch_proposals (status);
create index if not exists patch_proposals_created_by_idx
  on public.patch_proposals (created_by);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at
before update on public.users
for each row
execute function public.set_updated_at();

drop trigger if exists set_threads_updated_at on public.threads;
create trigger set_threads_updated_at
before update on public.threads
for each row
execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  profile_display_name text;
begin
  profile_display_name := nullif(
    btrim(
      coalesce(
        new.raw_user_meta_data ->> 'display_name',
        new.raw_user_meta_data ->> 'name',
        split_part(new.email, '@', 1)
      )
    ),
    ''
  );

  insert into public.users (id, email, display_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(profile_display_name, 'ASK User'),
    'student'
  )
  on conflict (id) do update
  set
    email = excluded.email,
    display_name = coalesce(nullif(public.users.display_name, ''), excluded.display_name),
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_auth_user();

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
after update of email, raw_user_meta_data on auth.users
for each row
execute function public.handle_new_auth_user();

create or replace function public.add_class_creator_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.class_members (class_id, user_id, role)
  values (new.id, new.created_by, 'teacher')
  on conflict (class_id, user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists add_class_creator_membership on public.classes;
create trigger add_class_creator_membership
after insert on public.classes
for each row
execute function public.add_class_creator_membership();

do $$
declare
  table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array[
      'threads',
      'messages',
      'environment_snapshots',
      'patch_proposals'
    ]
    loop
      if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end loop;
  end if;
end
$$;
