-- Test platform helper, separate from application migration.
-- GoTrue's early migrations create a legacy helper; modern PostgREST uses JWT JSON.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'sub'
  )::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
