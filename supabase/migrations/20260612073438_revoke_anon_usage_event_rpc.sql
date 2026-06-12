-- Usage tracking requires an authenticated actor profile.
-- Some projects still grant EXECUTE on new public functions to anon by default,
-- so revoke it explicitly after creating the tracking RPC.

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
) from anon;
