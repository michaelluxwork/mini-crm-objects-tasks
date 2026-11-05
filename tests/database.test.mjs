import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Independent users and data, never connected to a cloud project.
const manager = '10000000-0000-4000-8000-000000000001';
const executorA = '10000000-0000-4000-8000-000000000002';
const executorB = '10000000-0000-4000-8000-000000000003';
const managerB = '10000000-0000-4000-8000-000000000004';
const unprofiled = '10000000-0000-4000-8000-000000000005';
async function migrate(db) {
  const dir = new URL('../supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(file=>file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'));
}

test('SQL migration and access boundaries on isolated PostgreSQL', async t => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    grant usage on schema auth to authenticated;
    insert into auth.users values ('${manager}'),('${executorA}'),('${executorB}'),('${managerB}'),('${unprofiled}');
  `);
  await migrate(db);
  await db.query(`insert into public.profiles(id,display_name,role) values ($1,'Тестовый постановщик','manager'),($2,'Исполнитель А','executor'),($3,'Исполнитель Б','executor'),($4,'Второй постановщик','manager')`, [manager,executorA,executorB,managerB]);
  const asUser = async (id, role = 'authenticated') => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
    await db.exec(`set role ${role}`);
  };
  const admin = async () => { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); };
  const scalar = async (sql, params=[]) => Object.values((await db.query(sql,params)).rows[0])[0];
  await asUser(manager);
  const objectA = await scalar("select public.create_object('Объект Альфа','Вымышленная улица, 1')");
  const objectB = await scalar("select public.create_object('Объект Бета','Вымышленная улица, 2')");
  const taskA = await scalar("select public.create_task($1,'Задача А','Тестовое описание',$2)",[objectA,executorA]);
  const taskB = await scalar("select public.create_task($1,'Задача Б','',$2)",[objectB,executorB]);
  const transition = (id, from, to, comment = null) => db.query('select public.transition_task($1,$2,$3,$4)',[id,from,to,comment]);

  try {
    await t.test('manager creates tasks, author/time/history come from DB', async () => {
      const row = (await db.query('select * from public.tasks where id=$1',[taskA])).rows[0];
      assert.equal(row.status,'new'); assert.equal(row.author_id,manager); assert.ok(row.created_at);
      assert.equal(await scalar('select count(*)::int from public.task_history where task_id=$1',[taskA]),1);
    });
    await t.test('executor sees only assigned tasks, related objects and history', async () => {
      await asUser(executorA);
      assert.deepEqual((await db.query('select id from public.tasks')).rows.map(row => row.id),[taskA]);
      assert.deepEqual((await db.query('select id from public.objects')).rows.map(row => row.id),[objectA]);
      assert.deepEqual((await db.query('select distinct task_id from public.task_history')).rows.map(row => row.task_id),[taskA]);
      assert.equal(await scalar('select count(*)::int from public.tasks where id=$1',[taskB]),0);
    });
    await t.test('anonymous cannot read or call RPC', async () => {
      await asUser('', 'anon');
      for (const table of ['profiles','objects','tasks','task_history']) await assert.rejects(db.query(`select * from public.${table}`), /permission denied/);
      await assert.rejects(db.query("select public.create_object('X','Y')"),/permission denied/);
      await assert.rejects(transition(taskA,'new','in_progress'),/permission denied/);
    });
    await t.test('direct writes, history forgery and self-escalation denied to both roles', async () => {
      for (const id of [manager,executorA]) {
        await asUser(id);
        for (const sql of [
          "update public.tasks set status='accepted'", "delete from public.tasks", "update public.tasks set assignee_id = author_id",
          "update public.tasks set author_id = assignee_id", "update public.tasks set created_at = now()",
          "insert into public.tasks(title) values('forged')", "update public.task_history set comment='forged'",
          "delete from public.task_history", "insert into public.task_history(to_status) values('accepted')",
          "update public.profiles set role='manager'", "delete from public.objects", "update public.objects set name='forged'"
        ]) await assert.rejects(db.query(sql),/permission denied/);
      }
    });
    await t.test('executor cannot create/edit objects or task details and cannot operate on foreign task', async () => {
      await asUser(executorA);
      await assert.rejects(db.query("select public.create_object('X','Y')"),/Нет доступа/);
      await assert.rejects(db.query("select public.update_object($1,'X','Y')",[objectA]),/Нет доступа/);
      await assert.rejects(db.query("select public.create_task($1,'X','',$2)",[objectA,executorA]),/Нет доступа/);
      await assert.rejects(db.query("select public.update_task_details($1,'X','')",[taskA]),/Нет доступа/);
      await assert.rejects(transition(taskB,'new','in_progress'),/недоступна/);
    });
    await t.test('unprofiled user cannot gain manager role using own JWT metadata', async () => {
      await asUser(unprofiled);
      await db.query("select set_config('request.jwt.claims', '{\"user_metadata\":{\"role\":\"manager\"}}', false)");
      await assert.rejects(db.query("select public.create_object('X','Y')"),/Нет доступа/);
      assert.equal(await scalar('select count(*)::int from public.tasks'),0);
    });
    await t.test('every role/from/to combination respects transition matrix', async () => {
      const statuses = ['new','in_progress','review','accepted','rework'];
      for (const [id, allowed] of [
        [manager,new Set(['review:accepted','review:rework'])],
        [executorA,new Set(['new:in_progress','in_progress:review','rework:in_progress'])],
        [executorB,new Set()]
      ]) for (const from of statuses) for (const to of statuses) {
        await admin(); await db.query('update public.tasks set status=$1 where id=$2',[from,taskA]);
        const before = await scalar('select count(*)::int from public.task_history where task_id=$1',[taskA]);
        await asUser(id);
        if (allowed.has(`${from}:${to}`)) {
          await transition(taskA,from,to,'Тестовый комментарий');
          assert.equal(await scalar('select status from public.tasks where id=$1',[taskA]),to);
          assert.equal(await scalar('select count(*)::int from public.task_history where task_id=$1',[taskA]),before+1);
        } else await assert.rejects(transition(taskA,from,to,'Комментарий'),/запрещён|недоступна/);
      }
    });
    await t.test('rework requires nonblank comment, failed attempts preserve task/history', async () => {
      await admin(); await db.query("update public.tasks set status='review' where id=$1",[taskA]);
      await asUser(manager);
      const before = await scalar('select count(*)::int from public.task_history where task_id=$1',[taskA]);
      for (const comment of [null,'','   ']) await assert.rejects(transition(taskA,'review','rework',comment),/причину/);
      await assert.rejects(transition(taskA,'review','rework','x'.repeat(2001)),/2000/);
      assert.equal(await scalar('select status from public.tasks where id=$1',[taskA]),'review');
      assert.equal(await scalar('select count(*)::int from public.task_history where task_id=$1',[taskA]),before);
      await transition(taskA,'review','rework','Исправить тестовое замечание');
    });
    await t.test('stale repeated transition rejected without duplicate event', async () => {
      await asUser(executorA); await transition(taskA,'rework','in_progress');
      const before = await scalar('select count(*)::int from public.task_history where task_id=$1',[taskA]);
      await assert.rejects(transition(taskA,'rework','in_progress'),/уже изменён/);
      assert.equal(await scalar('select count(*)::int from public.task_history where task_id=$1',[taskA]),before);
    });
    await t.test('history failure rolls status back in same transaction', async () => {
      await admin(); await db.exec(`create function private.fail_history() returns trigger language plpgsql as $$ begin raise exception 'fixture history failure'; end; $$; create trigger fail_history before insert on public.task_history for each row execute function private.fail_history();`);
      await asUser(executorA); await assert.rejects(transition(taskA,'in_progress','review'),/fixture history failure/);
      assert.equal(await scalar('select status from public.tasks where id=$1',[taskA]),'in_progress');
      await admin(); await db.exec('drop trigger fail_history on public.task_history; drop function private.fail_history();');
    });
    await t.test('second manager can edit, constraints reject invalid values or manager assignee', async () => {
      await asUser(managerB);
      await db.query("select public.update_task_details($1,'Обновлённая задача','Описание')",[taskA]);
      await db.query("select public.update_object($1,'Новое название','Новый тестовый адрес')",[objectA]);
      await assert.rejects(db.query("select public.create_object('   ','Адрес')"),/check constraint/);
      await assert.rejects(db.query("select public.create_task($1,'X','',$2)",[objectA,manager]),/исполнителя/);
      assert.equal(await scalar('select count(*)::int from public.tasks'),2);
    });
    await t.test('task lifecycle RPCs exist but standalone history deletion is not exposed', async () => {
      const names = (await db.query("select routine_name from information_schema.routines where routine_schema='public'")).rows.map(row => row.routine_name);
      for(const name of ['delete_task','delete_object','reassign_task'])assert.ok(names.includes(name));
      assert.equal(names.some(name => /delete.*history|history.*delete/.test(name)),false);
    });
    await t.test('manager moves task; object visibility recalculates and invalid destination rolls back',async()=>{
      await asUser(manager);
      const before=(await db.query('select * from public.tasks where id=$1',[taskA])).rows[0];
      const count=await scalar('select count(*)::int from public.task_history where task_id=$1',[taskA]);
      await db.query("select public.update_task_details($1,'Перенесённая задача','Описание',$2)",[taskA,objectB]);
      await asUser(executorA);
      assert.equal(await scalar('select count(*)::int from public.objects where id=$1',[objectA]),0);
      assert.equal(await scalar('select count(*)::int from public.objects where id=$1',[objectB]),1);
      assert.equal(await scalar('select count(*)::int from public.tasks where id=$1',[taskB]),0);
      await assert.rejects(db.query("select public.update_task_details($1,'X','',$2)",[taskA,objectA]),/Нет доступа/);
      await asUser(manager);
      await db.query("select public.update_task_details($1,'Старый вызов','Описание')",[taskA]);
      await assert.rejects(db.query("select public.update_task_details($1,'Не сохранять','',$2)",[taskA,'99999999-9999-4999-8999-999999999999']),/foreign key/);
      const after=(await db.query('select * from public.tasks where id=$1',[taskA])).rows[0];
      assert.equal(after.object_id,objectB);assert.equal(after.title,'Старый вызов');
      for(const key of ['status','author_id','assignee_id'])assert.equal(after[key],before[key]);
      assert.equal(await scalar('select count(*)::int from public.task_history where task_id=$1',[taskA]),count);
      await db.query("select public.update_task_details($1,'Вернуть','',$2)",[taskA,objectA]);
    });
    await t.test('reassignment immediately closes former executor access and preserves history/status',async()=>{
      await asUser(manager);
      const object=await scalar("select public.create_object('Смена исполнителя','Вымышленный адрес')");
      const id=await scalar("select public.create_task($1,'Переназначение','',$2)",[object,executorA]);
      await asUser(executorA);await transition(id,'new','in_progress');
      await asUser(manager);
      await db.query('select public.reassign_task($1,$2,$3)',[id,executorA,executorB]);
      await assert.rejects(db.query('select public.reassign_task($1,$2,$3)',[id,executorA,executorB]),/уже изменён/);
      await assert.rejects(db.query('select public.reassign_task($1,$2,$3)',[id,executorB,manager]),/исполнителя/);
      await asUser(executorA);
      for(const [table,column] of [['tasks','id'],['task_history','task_id'],['objects','id']])assert.equal(await scalar(`select count(*)::int from public.${table} where ${column}=$1`,[table==='objects'?object:id]),0);
      await asUser(executorB);
      assert.equal(await scalar('select status from public.tasks where id=$1',[id]),'in_progress');
      assert.equal(await scalar('select count(*)::int from public.task_history where task_id=$1',[id]),2);
      for(const sql of ['select public.delete_task($1)','select public.delete_object($1)'])await assert.rejects(db.query(sql,[id]),/Нет доступа/);
      await assert.rejects(db.query('select public.reassign_task($1,$2,$3)',[id,executorB,executorA]),/Нет доступа/);
      await asUser(manager);
      await assert.rejects(db.query('select public.delete_object($1)',[object]),/Сначала удалите/);
      await admin();await db.exec(`create function private.fail_delete() returns trigger language plpgsql as $$ begin raise exception 'fixture delete failure'; end; $$; create trigger fail_delete before delete on public.tasks for each row execute function private.fail_delete();`);
      await asUser(manager);await assert.rejects(db.query('select public.delete_task($1)',[id]),/fixture delete failure/);
      assert.equal(await scalar('select count(*)::int from public.task_history where task_id=$1',[id]),2);
      assert.equal(await scalar('select count(*)::int from public.tasks where id=$1',[id]),1);
      await admin();await db.exec('drop trigger fail_delete on public.tasks; drop function private.fail_delete();');
      await asUser(manager);await db.query('select public.delete_task($1)',[id]);
      assert.equal(await scalar('select count(*)::int from public.task_history where task_id=$1',[id]),0);
      assert.equal(await scalar('select count(*)::int from public.tasks where id=$1',[id]),0);
      await db.query('select public.delete_object($1)',[object]);
      assert.equal(await scalar('select count(*)::int from public.objects where id=$1',[object]),0);
    });
  } finally { await db.close(); }
});

test('seed creates exactly three fake profiles, two objects and all five statuses, refuses repeat', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key,email text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; $$;
      grant usage on schema auth to authenticated;
      insert into auth.users values ('${manager}','crm.manager@example.com'),('${executorA}','crm.executor.a@example.com'),('${executorB}','crm.executor.b@example.com');`);
    await migrate(db);
    const seed = await readFile(new URL('../supabase/seed.sql',import.meta.url),'utf8');
    await db.exec(seed);
    const count = async table => (await db.query(`select count(*)::int as count from public.${table}`)).rows[0].count;
    assert.equal(await count('profiles'),3); assert.equal(await count('objects'),2); assert.equal(await count('tasks'),5);
    assert.equal((await db.query('select count(distinct status)::int as count from public.tasks')).rows[0].count,5);
    await assert.rejects(db.exec(seed),/только один раз/);
    await db.exec('rollback');
    assert.equal(await count('tasks'),5);
  } finally { await db.close(); }
});
