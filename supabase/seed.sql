-- ONLY a new dedicated test project with these three manually created fake accounts.
-- Run once after the migration. Never run against client/production data.
begin;
do $$
declare m uuid; a uuid; b uuid; o1 uuid; o2 uuid; t uuid;
begin
  select id into m from auth.users where email = 'crm.manager@example.com';
  select id into a from auth.users where email = 'crm.executor.a@example.com';
  select id into b from auth.users where email = 'crm.executor.b@example.com';
  if m is null or a is null or b is null then raise exception 'Создайте три тестовые учётные записи из README'; end if;
  if exists(select 1 from public.profiles) or exists(select 1 from public.objects) then
    raise exception 'Seed допускается только один раз в пустой тестовой базе';
  end if;
  insert into public.profiles(id,display_name,role) values
    (m,'Тестовый постановщик','manager'),(a,'Исполнитель А','executor'),(b,'Исполнитель Б','executor');
  perform set_config('request.jwt.claim.sub',m::text,true);
  o1 := public.create_object('Учебный объект Альфа','Вымышленная улица, 1');
  o2 := public.create_object('Учебный объект Бета','Вымышленная улица, 2');
  perform public.create_task(o1,'Проверить план работ','Вымышленная новая задача для исполнителя А',a);
  t := public.create_task(o1,'Подготовить список материалов','Учебная задача в работе',b);
  perform set_config('request.jwt.claim.sub',b::text,true);
  perform public.transition_task(t,'new','in_progress');
  perform set_config('request.jwt.claim.sub',m::text,true);
  t := public.create_task(o2,'Проверить схему помещения','Учебная задача на проверке',a);
  perform set_config('request.jwt.claim.sub',a::text,true);
  perform public.transition_task(t,'new','in_progress');
  perform public.transition_task(t,'in_progress','review');
  perform set_config('request.jwt.claim.sub',m::text,true);
  t := public.create_task(o2,'Сверить учебную ведомость','Пример возврата на доработку',b);
  perform set_config('request.jwt.claim.sub',b::text,true);
  perform public.transition_task(t,'new','in_progress');
  perform public.transition_task(t,'in_progress','review');
  perform set_config('request.jwt.claim.sub',m::text,true);
  perform public.transition_task(t,'review','rework','Добавить недостающие позиции в учебную ведомость');
  t := public.create_task(o1,'Согласовать учебный чек-лист','Пример завершённой задачи',a);
  perform set_config('request.jwt.claim.sub',a::text,true);
  perform public.transition_task(t,'new','in_progress');
  perform public.transition_task(t,'in_progress','review');
  perform set_config('request.jwt.claim.sub',m::text,true);
  perform public.transition_task(t,'review','accepted','Проверено на вымышленных данных');
end; $$;
commit;
