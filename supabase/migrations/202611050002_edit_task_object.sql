begin;
drop function public.update_task_details(uuid,text,text);
create function public.update_task_details(p_id uuid, p_title text, p_description text, p_object_id uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_manager() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  update public.tasks set title = btrim(p_title), description = coalesce(p_description,''), object_id = coalesce(p_object_id,object_id) where id = p_id;
  if not found then raise exception 'Задача недоступна'; end if;
end; $$;
revoke all on function public.update_task_details(uuid,text,text,uuid) from public, anon;
grant execute on function public.update_task_details(uuid,text,text,uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
