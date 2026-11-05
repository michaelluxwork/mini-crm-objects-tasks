-- Local integration fixture ONLY. Runs in a new isolated docker volume.
\getenv fixture_password POSTGRES_PASSWORD
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login noinherit password :'fixture_password';
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login createrole password :'fixture_password';
create schema auth authorization supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
