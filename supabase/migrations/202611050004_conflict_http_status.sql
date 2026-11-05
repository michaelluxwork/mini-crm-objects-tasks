-- Logical stale-state conflicts must not trigger PostgreSQL serialization retries.
-- https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions
begin;

create or replace function public.transition_task(p_task_id uuid, p_expected_status text, p_to_status text, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks%rowtype; manager boolean; allowed boolean := false;
begin
  manager := private.is_manager();
  select * into t from public.tasks where id = p_task_id for update;
  if not found or auth.uid() is null or not (manager or t.assignee_id = auth.uid()) then
    raise exception 'Задача недоступна' using errcode = '42501';
  end if;
  if t.status is distinct from p_expected_status then raise exception 'Статус уже изменён. Обновите карточку' using errcode = 'PT409'; end if;
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

create or replace function public.reassign_task(p_task_id uuid, p_expected_assignee_id uuid, p_assignee_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks%rowtype;
begin
  if not private.is_manager() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  select * into t from public.tasks where id=p_task_id for update;
  if not found then raise exception 'Задача недоступна'; end if;
  if t.assignee_id is distinct from p_expected_assignee_id then raise exception 'Исполнитель уже изменён. Обновите карточку' using errcode='PT409'; end if;
  if not exists(select 1 from public.profiles where id=p_assignee_id and role='executor') then raise exception 'Выберите исполнителя'; end if;
  update public.tasks set assignee_id=p_assignee_id where id=t.id;
end; $$;

revoke all on function public.transition_task(uuid,text,text,text), public.reassign_task(uuid,uuid,uuid) from public,anon;
grant execute on function public.transition_task(uuid,text,text,text), public.reassign_task(uuid,uuid,uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
