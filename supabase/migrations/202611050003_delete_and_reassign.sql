begin;

create function public.reassign_task(p_task_id uuid, p_expected_assignee_id uuid, p_assignee_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks%rowtype;
begin
  if not private.is_manager() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  select * into t from public.tasks where id=p_task_id for update;
  if not found then raise exception 'Задача недоступна'; end if;
  if t.assignee_id is distinct from p_expected_assignee_id then raise exception 'Исполнитель уже изменён. Обновите карточку' using errcode='40001'; end if;
  if not exists(select 1 from public.profiles where id=p_assignee_id and role='executor') then raise exception 'Выберите исполнителя'; end if;
  update public.tasks set assignee_id=p_assignee_id where id=t.id;
end; $$;

create function public.delete_task(p_task_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_manager() then raise exception 'Нет доступа' using errcode='42501'; end if;
  perform 1 from public.tasks where id=p_task_id for update;
  if not found then raise exception 'Задача недоступна'; end if;
  -- Employer confirmed deletion of the whole task together with its history.
  delete from public.task_history where task_id=p_task_id;
  delete from public.tasks where id=p_task_id;
end; $$;

create function public.delete_object(p_object_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_manager() then raise exception 'Нет доступа' using errcode='42501'; end if;
  -- FK RESTRICT prevents deleting an object with tasks, including concurrent inserts.
  if exists(select 1 from public.tasks where object_id=p_object_id) then
    raise exception 'Сначала удалите задачи объекта или перенесите их в другой объект';
  end if;
  delete from public.objects where id=p_object_id;
  if not found then raise exception 'Объект недоступен'; end if;
exception when foreign_key_violation or restrict_violation then
  raise exception 'Сначала удалите задачи объекта или перенесите их в другой объект';
end; $$;

revoke all on function public.reassign_task(uuid,uuid,uuid), public.delete_task(uuid), public.delete_object(uuid) from public,anon;
grant execute on function public.reassign_task(uuid,uuid,uuid), public.delete_task(uuid), public.delete_object(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
