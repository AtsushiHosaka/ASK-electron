-- Local development fixtures for ASK Supabase RLS checks.
-- Password for all auth users is: ask-password
-- These IDs are stable so tests can set request.jwt.claim.sub directly.

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'admin@example.test',
    crypt('ask-password', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"ASK Admin"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'teacher@example.test',
    crypt('ask-password', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"ASK Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'mentor@example.test',
    crypt('ask-password', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"ASK Mentor"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'student-a@example.test',
    crypt('ask-password', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Student A"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000005',
    'authenticated',
    'authenticated',
    'student-b@example.test',
    crypt('ask-password', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Student B"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000006',
    'authenticated',
    'authenticated',
    'outsider@example.test',
    crypt('ask-password', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Outside Student"}'::jsonb,
    now(),
    now()
  )
on conflict (id) do update
set
  email = excluded.email,
  encrypted_password = excluded.encrypted_password,
  email_confirmed_at = excluded.email_confirmed_at,
  raw_app_meta_data = excluded.raw_app_meta_data,
  raw_user_meta_data = excluded.raw_user_meta_data,
  updated_at = now();

insert into public.users (id, email, display_name, role, github_username)
values
  (
    '00000000-0000-4000-8000-000000000001',
    'admin@example.test',
    'ASK Admin',
    'admin',
    'ask-admin'
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'teacher@example.test',
    'ASK Teacher',
    'teacher',
    'ask-teacher'
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    'mentor@example.test',
    'ASK Mentor',
    'teacher',
    'ask-mentor'
  ),
  (
    '00000000-0000-4000-8000-000000000004',
    'student-a@example.test',
    'Student A',
    'student',
    'student-a'
  ),
  (
    '00000000-0000-4000-8000-000000000005',
    'student-b@example.test',
    'Student B',
    'student',
    'student-b'
  ),
  (
    '00000000-0000-4000-8000-000000000006',
    'outsider@example.test',
    'Outside Student',
    'student',
    null
  )
on conflict (id) do update
set
  email = excluded.email,
  display_name = excluded.display_name,
  role = excluded.role,
  github_username = excluded.github_username;

insert into public.classes (id, organization_id, name, description, created_by)
values
  (
    '10000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000001',
    'Intro Programming',
    'Fixture class for assigned teacher and student A.',
    '00000000-0000-4000-8000-000000000002'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '90000000-0000-4000-8000-000000000001',
    'Other Programming',
    'Fixture class that assigned teacher should not see.',
    '00000000-0000-4000-8000-000000000003'
  )
on conflict (id) do update
set
  organization_id = excluded.organization_id,
  name = excluded.name,
  description = excluded.description,
  created_by = excluded.created_by;

insert into public.class_members (id, class_id, user_id, role)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    'teacher'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000003',
    'mentor'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000004',
    'student'
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    'teacher'
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000005',
    'student'
  )
on conflict (class_id, user_id) do update
set role = excluded.role;

insert into public.github_connections (
  id,
  user_id,
  github_username,
  auth_method,
  ssh_status,
  last_checked_at
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000004',
    'student-a',
    'gh_cli',
    'ok',
    now()
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000005',
    'student-b',
    'device_flow',
    'failed',
    now()
  )
on conflict (user_id) do update
set
  github_username = excluded.github_username,
  auth_method = excluded.auth_method,
  ssh_status = excluded.ssh_status,
  last_checked_at = excluded.last_checked_at;

insert into public.projects (
  id,
  owner_user_id,
  class_id,
  name,
  local_path_hash,
  github_repo_url,
  default_branch
)
values
  (
    '40000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    'Student A Calculator',
    'sha256:student-a-local-path',
    'https://github.com/student-a/calculator',
    'main'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000002',
    'Student B Todo',
    'sha256:student-b-local-path',
    'https://github.com/student-b/todo',
    'main'
  )
on conflict (id) do update
set
  owner_user_id = excluded.owner_user_id,
  class_id = excluded.class_id,
  name = excluded.name,
  local_path_hash = excluded.local_path_hash,
  github_repo_url = excluded.github_repo_url,
  default_branch = excluded.default_branch;

insert into public.threads (
  id,
  project_id,
  created_by,
  title,
  status,
  priority,
  ai_used
)
values
  (
    '50000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000004',
    'Calculator returns NaN',
    'open',
    'normal',
    true
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000005',
    'Todo app cannot start',
    'open',
    'high',
    false
  )
on conflict (id) do update
set
  project_id = excluded.project_id,
  created_by = excluded.created_by,
  title = excluded.title,
  status = excluded.status,
  priority = excluded.priority,
  ai_used = excluded.ai_used;

insert into public.messages (
  id,
  thread_id,
  sender_user_id,
  sender_type,
  body,
  message_type
)
values
  (
    '60000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000004',
    'student',
    'When I click add, the calculator shows NaN instead of the sum.',
    'text'
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    null,
    'ai',
    'The error may come from parsing an empty input value before addition.',
    'ai_summary'
  ),
  (
    '60000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    'teacher',
    'Try normalizing the input before converting it to a number.',
    'patch'
  ),
  (
    '60000000-0000-4000-8000-000000000004',
    '50000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000005',
    'student',
    'npm start exits immediately with a missing script error.',
    'text'
  )
on conflict (id) do update
set
  thread_id = excluded.thread_id,
  sender_user_id = excluded.sender_user_id,
  sender_type = excluded.sender_type,
  body = excluded.body,
  message_type = excluded.message_type;

insert into public.environment_snapshots (
  id,
  thread_id,
  project_id,
  os_name,
  os_version,
  arch,
  git_version,
  editor_name,
  editor_version,
  runtimes,
  package_managers,
  dependencies_summary
)
values (
  '70000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'macOS',
  '14.x',
  'arm64',
  'git version 2.44.0',
  'Visual Studio Code',
  '1.90.0',
  '{"node":"20.x"}'::jsonb,
  '{"npm":"10.x","pnpm":"9.x"}'::jsonb,
  '{"package_json":true,"lockfile":"pnpm-lock.yaml"}'::jsonb
)
on conflict (id) do update
set
  thread_id = excluded.thread_id,
  project_id = excluded.project_id,
  os_name = excluded.os_name,
  os_version = excluded.os_version,
  arch = excluded.arch,
  git_version = excluded.git_version,
  editor_name = excluded.editor_name,
  editor_version = excluded.editor_version,
  runtimes = excluded.runtimes,
  package_managers = excluded.package_managers,
  dependencies_summary = excluded.dependencies_summary;

insert into public.patch_proposals (
  id,
  thread_id,
  message_id,
  created_by,
  created_by_type,
  target_file_path,
  base_commit_sha,
  patch_text,
  explanation,
  status
)
values (
  '80000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000002',
  'teacher',
  'src/calculator.ts',
  'abcdef1234567890abcdef1234567890abcdef12',
  $$diff --git a/src/calculator.ts b/src/calculator.ts
--- a/src/calculator.ts
+++ b/src/calculator.ts
@@ -1,3 +1,3 @@
-const value = Number(input.value);
+const value = Number(input.value || 0);
 $$,
  'Normalize empty input before converting it to a number.',
  'proposed'
)
on conflict (id) do update
set
  thread_id = excluded.thread_id,
  message_id = excluded.message_id,
  created_by = excluded.created_by,
  created_by_type = excluded.created_by_type,
  target_file_path = excluded.target_file_path,
  base_commit_sha = excluded.base_commit_sha,
  patch_text = excluded.patch_text,
  explanation = excluded.explanation,
  status = excluded.status;
