begin;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  role text not null check (role in ('manager','executor'))
);
create table public.objects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  address text not null check (length(btrim(address)) between 1 and 500),
  created_at timestamptz not null default now()
);
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  object_id uuid not null references public.objects(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 5000),
  assignee_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'new' check (status in ('new','in_progress','review','accepted','rework')),
  author_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index tasks_assignee_object on public.tasks(assignee_id, object_id);
create table public.task_history (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  from_status text check (from_status in ('new','in_progress','review','accepted','rework')),
  to_status text not null check (to_status in ('new','in_progress','review','accepted','rework')),
  comment text check (length(comment) <= 2000),
  created_at timestamptz not null default now()
);
create index history_task_time on public.task_history(task_id, created_at, id);

create function private.is_manager() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.profiles where id = auth.uid() and role = 'manager'); $$;
revoke all on function private.is_manager() from public, anon;
grant execute on function private.is_manager() to authenticated;

alter table public.profiles enable row level security;
alter table public.objects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_history enable row level security;
revoke all on public.profiles, public.objects, public.tasks, public.task_history from public, anon, authenticated;
grant select on public.profiles, public.objects, public.tasks, public.task_history to authenticated;

create policy profiles_read on public.profiles for select to authenticated using (true);
create policy tasks_read on public.tasks for select to authenticated
  using ((select private.is_manager()) or assignee_id = (select auth.uid()));
create policy objects_read on public.objects for select to authenticated
  using ((select private.is_manager()) or exists(select 1 from public.tasks t where t.object_id = objects.id and t.assignee_id = (select auth.uid())));
create policy history_read on public.task_history for select to authenticated
  using (exists(select 1 from public.tasks t where t.id = task_history.task_id));

create function public.create_object(p_name text, p_address text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  if not private.is_manager() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  insert into public.objects(name,address) values(btrim(p_name),btrim(p_address)) returning id into result;
  return result;
end; $$;

create function public.update_object(p_id uuid, p_name text, p_address text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_manager() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  update public.objects set name = btrim(p_name), address = btrim(p_address) where id = p_id;
  if not found then raise exception 'Объект недоступен'; end if;
end; $$;

create function public.create_task(p_object_id uuid, p_title text, p_description text, p_assignee_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  if not private.is_manager() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  if not exists(select 1 from public.profiles where id = p_assignee_id and role = 'executor') then
    raise exception 'Выберите исполнителя';
  end if;
  insert into public.tasks(object_id,title,description,assignee_id,author_id)
  values(p_object_id,btrim(p_title),coalesce(p_description,''),p_assignee_id,auth.uid()) returning id into result;
  insert into public.task_history(task_id,actor_id,from_status,to_status)
  values(result,auth.uid(),null,'new');
  return result;
end; $$;

create function public.update_task_details(p_id uuid, p_title text, p_description text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_manager() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  update public.tasks set title = btrim(p_title), description = coalesce(p_description,'') where id = p_id;
  if not found then raise exception 'Задача недоступна'; end if;
end; $$;

create function public.transition_task(p_task_id uuid, p_expected_status text, p_to_status text, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks%rowtype; manager boolean; allowed boolean := false;
begin
  manager := private.is_manager();
  select * into t from public.tasks where id = p_task_id for update;
  if not found or auth.uid() is null or not (manager or t.assignee_id = auth.uid()) then
    raise exception 'Задача недоступна' using errcode = '42501';
  end if;
  if t.status is distinct from p_expected_status then raise exception 'Статус уже изменён. Обновите карточку' using errcode = '40001'; end if;
  if manager then
    allowed := t.status = 'review' and p_to_status in ('accepted','rework');
  elsif exists(select 1 from public.profiles where id = auth.uid() and role = 'executor') then
    allowed := (t.status in ('new','rework') and p_to_status = 'in_progress') or (t.status = 'in_progress' and p_to_status = 'review');
  end if;
  if allowed is distinct from true then raise exception 'Переход запрещён' using errcode = '42501'; end if;
  if p_to_status = 'rework' and nullif(btrim(p_comment),'') is null then raise exception 'Укажите причину доработки'; end if;
  if length(p_comment) > 2000 then raise exception 'Комментарий длиннее 2000 символов'; end if;
  update public.tasks set status = p_to_status where id = t.id;
  insert into public.task_history(task_id,actor_id,from_status,to_status,comment)
  values(t.id,auth.uid(),t.status,p_to_status,nullif(btrim(p_comment),''));
end; $$;

revoke all on function public.create_object(text,text), public.update_object(uuid,text,text),
  public.create_task(uuid,text,text,uuid), public.update_task_details(uuid,text,text),
  public.transition_task(uuid,text,text,text) from public, anon;
grant execute on function public.create_object(text,text), public.update_object(uuid,text,text),
  public.create_task(uuid,text,text,uuid), public.update_task_details(uuid,text,text),
  public.transition_task(uuid,text,text,text) to authenticated;

commit;
