begin;

create or replace function pg_temp.assert_eq(actual bigint, expected bigint, label text)
returns void
language plpgsql
as $$
begin
  if actual is distinct from expected then
    raise exception '% expected %, got %', label, expected, actual;
  end if;
end;
$$;

create or replace function pg_temp.assert_rejected(statement text, label text)
returns void
language plpgsql
as $$
declare
  rejected boolean := false;
begin
  begin
    execute statement;
  exception
    when insufficient_privilege
      or check_violation
      or foreign_key_violation
      or not_null_violation
      or with_check_option_violation
      or raise_exception
    then
      rejected := true;
  end;

  if not rejected then
    raise exception '% expected statement to be rejected', label;
  end if;
end;
$$;

-- Service-role/admin connection checks fixture completeness separately from
-- authenticated-client RLS behavior.
reset role;
select pg_temp.assert_eq((select count(*) from public.users), 6, 'service fixtures users');
select pg_temp.assert_eq((select count(*) from public.classes), 2, 'service fixtures classes');
select pg_temp.assert_eq((select count(*) from public.projects), 2, 'service fixtures projects');
select pg_temp.assert_eq((select count(*) from public.threads), 2, 'service fixtures threads');
select pg_temp.assert_eq((select count(*) from public.messages), 4, 'service fixtures messages');
select pg_temp.assert_eq(
  (select count(*) from public.environment_snapshots),
  1,
  'service fixtures environment snapshots'
);
select pg_temp.assert_eq(
  (select count(*) from public.patch_proposals),
  1,
  'service fixtures patch proposals'
);

-- Admin can read across classes.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select pg_temp.assert_eq((select count(*) from public.classes), 2, 'admin reads all classes');
select pg_temp.assert_eq((select count(*) from public.projects), 2, 'admin reads all projects');
select pg_temp.assert_eq((select count(*) from public.threads), 2, 'admin reads all threads');
select pg_temp.assert_eq((select count(*) from public.messages), 4, 'admin reads all messages');

-- Assigned teacher can read only their class boundary.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
select pg_temp.assert_eq(
  (select count(*) from public.classes where id = '10000000-0000-4000-8000-000000000001'),
  1,
  'teacher reads assigned class'
);
select pg_temp.assert_eq(
  (select count(*) from public.classes where id = '10000000-0000-4000-8000-000000000002'),
  0,
  'teacher cannot read unassigned class'
);
select pg_temp.assert_eq(
  (select count(*) from public.projects where id = '40000000-0000-4000-8000-000000000001'),
  1,
  'teacher reads assigned student project'
);
select pg_temp.assert_eq(
  (select count(*) from public.projects where id = '40000000-0000-4000-8000-000000000002'),
  0,
  'teacher cannot read outside student project'
);
select pg_temp.assert_eq(
  (select count(*) from public.threads where id = '50000000-0000-4000-8000-000000000001'),
  1,
  'teacher reads assigned class thread'
);
select pg_temp.assert_eq(
  (select count(*) from public.threads where id = '50000000-0000-4000-8000-000000000002'),
  0,
  'teacher cannot read outside class thread'
);
select pg_temp.assert_eq(
  (select count(*) from public.messages where thread_id = '50000000-0000-4000-8000-000000000001'),
  3,
  'teacher reads assigned class messages'
);
select pg_temp.assert_eq(
  (select count(*) from public.messages where id = '60000000-0000-4000-8000-000000000004'),
  0,
  'teacher cannot read outside class message'
);
select pg_temp.assert_eq(
  (select count(*) from public.environment_snapshots where id = '70000000-0000-4000-8000-000000000001'),
  1,
  'teacher reads assigned class environment snapshot'
);
select pg_temp.assert_eq(
  (select count(*) from public.patch_proposals where id = '80000000-0000-4000-8000-000000000001'),
  1,
  'teacher reads assigned class patch proposal'
);

insert into public.patch_proposals (
  id,
  thread_id,
  message_id,
  created_by,
  created_by_type,
  target_file_path,
  patch_text
)
values (
  '80000000-0000-4000-8000-000000000101',
  '50000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000002',
  'teacher',
  'src/calculator.ts',
  'diff --git a/src/calculator.ts b/src/calculator.ts'
);

select pg_temp.assert_eq(
  (select count(*) from public.patch_proposals where id = '80000000-0000-4000-8000-000000000101'),
  1,
  'teacher creates patch proposal in assigned class'
);

select pg_temp.assert_rejected(
  $statement$
    insert into public.patch_proposals (
      id,
      thread_id,
      message_id,
      created_by,
      created_by_type,
      target_file_path,
      patch_text
    )
    values (
      '80000000-0000-4000-8000-000000000102',
      '50000000-0000-4000-8000-000000000002',
      '60000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000002',
      'teacher',
      'src/todo.ts',
      'diff --git a/src/todo.ts b/src/todo.ts'
    )
  $statement$,
  'teacher cannot create patch proposal outside assigned class'
);

-- Student A can read and write their own project/thread boundary only.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000004';
select pg_temp.assert_eq(
  (select count(*) from public.projects where id = '40000000-0000-4000-8000-000000000001'),
  1,
  'student reads own project'
);
select pg_temp.assert_eq(
  (select count(*) from public.projects where id = '40000000-0000-4000-8000-000000000002'),
  0,
  'student cannot read other student project'
);
select pg_temp.assert_eq(
  (select count(*) from public.threads where id = '50000000-0000-4000-8000-000000000001'),
  1,
  'student reads own thread'
);
select pg_temp.assert_eq(
  (select count(*) from public.threads where id = '50000000-0000-4000-8000-000000000002'),
  0,
  'student cannot read other student thread'
);
select pg_temp.assert_eq(
  (select count(*) from public.messages where thread_id = '50000000-0000-4000-8000-000000000001'),
  3,
  'student reads own-thread messages'
);
select pg_temp.assert_eq(
  (select count(*) from public.messages where id = '60000000-0000-4000-8000-000000000004'),
  0,
  'student cannot read other student message'
);
select pg_temp.assert_eq(
  (select count(*) from public.environment_snapshots where id = '70000000-0000-4000-8000-000000000001'),
  1,
  'student reads own environment snapshot'
);
select pg_temp.assert_eq(
  (select count(*) from public.patch_proposals where id = '80000000-0000-4000-8000-000000000001'),
  1,
  'student reads own-thread patch proposal'
);
select pg_temp.assert_rejected(
  $statement$
    insert into public.patch_proposals (
      id,
      thread_id,
      message_id,
      created_by,
      created_by_type,
      target_file_path,
      patch_text
    )
    values (
      '80000000-0000-4000-8000-000000000103',
      '50000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000004',
      'teacher',
      'src/calculator.ts',
      'diff --git a/src/calculator.ts b/src/calculator.ts'
    )
  $statement$,
  'student cannot create teacher patch proposal'
);
insert into public.patch_proposals (
  id,
  thread_id,
  message_id,
  created_by,
  created_by_type,
  target_file_path,
  patch_text
)
values (
  '80000000-0000-4000-8000-000000000104',
  '50000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000004',
  'ai',
  'src/calculator.ts',
  'diff --git a/src/calculator.ts b/src/calculator.ts'
);
select pg_temp.assert_eq(
  (select count(*) from public.patch_proposals where id = '80000000-0000-4000-8000-000000000104' and status = 'proposed'),
  1,
  'student creates AI patch proposal for own thread'
);
select pg_temp.assert_rejected(
  $statement$
    insert into public.patch_proposals (
      id,
      thread_id,
      message_id,
      created_by,
      created_by_type,
      target_file_path,
      patch_text
    )
    values (
      '80000000-0000-4000-8000-000000000105',
      '50000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      'ai',
      'src/calculator.ts',
      'diff --git a/src/calculator.ts b/src/calculator.ts'
    )
  $statement$,
  'student cannot forge created_by for AI patch proposal'
);
update public.patch_proposals
set status = 'dismissed'
where id = '80000000-0000-4000-8000-000000000001';
select pg_temp.assert_eq(
  (select count(*) from public.patch_proposals where id = '80000000-0000-4000-8000-000000000001' and status = 'dismissed'),
  1,
  'student updates own-thread patch proposal status'
);

-- Student B and an outsider cannot cross into Student A's class/project/thread.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000005';
select pg_temp.assert_eq(
  (select count(*) from public.projects where id = '40000000-0000-4000-8000-000000000001'),
  0,
  'other student cannot read student A project'
);
select pg_temp.assert_eq(
  (select count(*) from public.messages where id = '60000000-0000-4000-8000-000000000001'),
  0,
  'other student cannot read student A message'
);
select pg_temp.assert_eq(
  (select count(*) from public.environment_snapshots where id = '70000000-0000-4000-8000-000000000001'),
  0,
  'other student cannot read student A environment snapshot'
);
select pg_temp.assert_eq(
  (select count(*) from public.patch_proposals where id = '80000000-0000-4000-8000-000000000001'),
  0,
  'other student cannot read student A patch proposal'
);
update public.patch_proposals
set status = 'accepted'
where id = '80000000-0000-4000-8000-000000000001';
reset role;
select pg_temp.assert_eq(
  (select count(*) from public.patch_proposals where id = '80000000-0000-4000-8000-000000000001' and status = 'dismissed'),
  1,
  'other student cannot update student A patch proposal'
);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000006';
select pg_temp.assert_eq((select count(*) from public.classes), 0, 'outsider reads no classes');
select pg_temp.assert_eq((select count(*) from public.projects), 0, 'outsider reads no projects');
select pg_temp.assert_eq((select count(*) from public.threads), 0, 'outsider reads no threads');
select pg_temp.assert_eq((select count(*) from public.messages), 0, 'outsider reads no messages');
select pg_temp.assert_eq(
  (select count(*) from public.environment_snapshots),
  0,
  'outsider reads no environment snapshots'
);
select pg_temp.assert_eq(
  (select count(*) from public.patch_proposals),
  0,
  'outsider reads no patch proposals'
);

rollback;
