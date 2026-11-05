import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { compose, sql } from './start.mjs';
import { startProxy } from './proxy.mjs';

const api = 'http://127.0.0.1:4377';
const localEnv = Object.fromEntries(readFileSync(new URL('.env.local',import.meta.url),'utf8').trim().split('\n').map(line => line.split('=')));
const jwt = (role, expires = 3600) => {
  const head = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const body = Buffer.from(JSON.stringify({role,aud:'authenticated',iss:'local-crm-test',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+expires})).toString('base64url');
  return `${head}.${body}.${createHmac('sha256',localEnv.JWT_SECRET).update(`${head}.${body}`).digest('base64url')}`;
};
const anon = jwt('anon',86400*30); const service = jwt('service_role');
const makeClient = key => createClient(api,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const admin = makeClient(service);
const result = {status:'RUNNING',scope:'local GoTrue + PostgREST + PostgreSQL, real HTTP/JWT; cloud not tested',checks:[],at:new Date().toISOString()};
const check = async (name, fn) => {await fn(); result.checks.push(name);console.log(`PASS: ${name}`);};
const ok = response => {if(response.error)throw new Error(response.error.message);return response.data;};
const denied = response => assert.ok(response.error,'request must be denied');
const uuid = value => {assert.match(value,/^[0-9a-f-]{36}$/);return value;};
let gateway;
const createdTasks=[]; let testObject; let moveTarget; let faultInjected=false;
try {
  for(let attempt=0;attempt<80;attempt++) {
    try {if((await fetch('http://127.0.0.1:54791/health')).ok)break;}catch{}
    if(attempt===79)throw new Error('Local Auth health timeout');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  gateway = await startProxy();
  sql(readFileSync(new URL('auth-helpers.sql',import.meta.url),'utf8'));
  const applied = sql("select to_regclass('public.tasks') is not null;");
  if(!/\bt\b/.test(applied)) sql(readFileSync(new URL('../../supabase/migrations/202611050001_initial.sql',import.meta.url),'utf8'));
  if(!/\bt\b/.test(sql("select to_regprocedure('public.update_task_details(uuid,text,text,uuid)') is not null;"))) sql(readFileSync(new URL('../../supabase/migrations/202611050002_edit_task_object.sql',import.meta.url),'utf8'));
  if(!/\bt\b/.test(sql("select to_regprocedure('public.reassign_task(uuid,uuid,uuid)') is not null;"))) sql(readFileSync(new URL('../../supabase/migrations/202611050003_delete_and_reassign.sql',import.meta.url),'utf8'));
  sql("notify pgrst, 'reload schema';");
  const accessPath = new URL('../../.local-access.local.json',import.meta.url);
  const credentials = existsSync(accessPath) ? JSON.parse(readFileSync(accessPath,'utf8')) : {
    apiUrl:api, users:['crm.manager@example.com','crm.executor.a@example.com','crm.executor.b@example.com'].map(email=>({email,password:randomBytes(18).toString('base64url')}))
  };
  const users = ok(await admin.auth.admin.listUsers()).users;
  for(const user of credentials.users) {
    const existing = users.find(item=>item.email===user.email);
    user.id = existing?.id || ok(await admin.auth.admin.createUser({email:user.email,password:user.password,email_confirm:true})).user.id;
  }
  writeFileSync(accessPath,JSON.stringify(credentials,null,2)+'\n');
  if(!/\bt\b/.test(sql('select exists(select 1 from public.profiles);'))) sql(readFileSync(new URL('../../supabase/seed.sql',import.meta.url),'utf8'));
  const clients = credentials.users.map(()=>makeClient(anon));
  const [manager,executorA,executorB] = clients;
  await check('real email/password login for manager and two executors',async()=>{
    for(let i=0;i<clients.length;i++)ok(await clients[i].auth.signInWithPassword(credentials.users[i]));
  });
  await check('bad password and public signup refused',async()=>{
    const client = makeClient(anon);
    denied(await client.auth.signInWithPassword({email:credentials.users[0].email,password:'wrong-synthetic-password'}));
    const signup = await client.auth.signUp({email:'crm.forbidden@example.com',password:randomBytes(18).toString('hex')});
    denied(signup); assert.match(signup.error.message,/disabled|not allowed/i);
  });
  let rowsA, rowsB;
  await check('real JWT enforces separate task, object and history visibility',async()=>{
    rowsA=ok(await executorA.from('tasks').select('*'));rowsB=ok(await executorB.from('tasks').select('*'));
    assert.ok(rowsA.length && rowsB.length);
    assert.ok(rowsA.every(row=>row.assignee_id===credentials.users[1].id));
    assert.ok(rowsB.every(row=>row.assignee_id===credentials.users[2].id));
    assert.equal(ok(await executorA.from('tasks').select('*').eq('id',rowsB[0].id)).length,0);
    assert.equal(ok(await executorA.from('task_history').select('*').eq('task_id',rowsB[0].id)).length,0);
    const embedded=ok(await executorA.from('objects').select('id,tasks(id,assignee_id)'));
    assert.ok(embedded.every(object=>object.tasks.every(task=>task.assignee_id===credentials.users[1].id)));
    const histories=ok(await executorA.from('task_history').select('*'));
    assert.ok(histories.every(event=>rowsA.some(task=>task.id===event.task_id)));
  });
  await check('anonymous/tampered/expired JWT and forged identity header do not bypass access',async()=>{
    denied(await makeClient(anon).from('tasks').select('*'));
    for(const token of [jwt('authenticated',-3600),'e30.e30.invalid']) {
      const response=await fetch(`${api}/rest/v1/tasks`,{headers:{apikey:anon,Authorization:`Bearer ${token}`}});
      assert.equal(response.status,401);
    }
    const session=ok(await executorA.auth.getSession()).session;
    const response=await fetch(`${api}/rest/v1/tasks`,{headers:{apikey:anon,Authorization:`Bearer ${session.access_token}`,'x-user-id':credentials.users[2].id}});
    assert.ok(response.ok); const rows=await response.json();assert.ok(rows.every(row=>row.assignee_id===credentials.users[1].id));
  });
  await check('direct API writes, history forgery and privilege escalation denied',async()=>{
    for(const client of [manager,executorA]) {
      denied(await client.from('profiles').update({role:'manager'}).eq('id',credentials.users[1].id));
      denied(await client.from('tasks').update({status:'accepted'}).eq('id',rowsA[0].id));
      denied(await client.from('tasks').insert({title:'forged'}));
      denied(await client.from('tasks').delete().eq('id',rowsA[0].id));
      denied(await client.from('task_history').insert({task_id:rowsA[0].id,actor_id:credentials.users[0].id,to_status:'accepted'}));
      denied(await client.from('task_history').update({comment:'forged'}).eq('task_id',rowsA[0].id));
      denied(await client.from('task_history').delete().eq('task_id',rowsA[0].id));
    }
    ok(await executorA.auth.updateUser({data:{role:'manager'}}));
    denied(await executorA.rpc('create_object',{p_name:'Forbidden',p_address:'Fixture'}));
  });
  let taskId;
  await check('manager creates object/task over RPC with DB author and creation event',async()=>{
    testObject=uuid(ok(await manager.rpc('create_object',{p_name:'Integration fixture',p_address:'Fictional address'})));
    taskId=uuid(ok(await manager.rpc('create_task',{p_object_id:testObject,p_title:'Integration task',p_description:'Synthetic only',p_assignee_id:credentials.users[1].id}))); createdTasks.push(taskId);
    const task=ok(await manager.from('tasks').select('*').eq('id',taskId).single());
    assert.equal(task.author_id,credentials.users[0].id);assert.equal(task.status,'new');
    assert.equal(ok(await manager.from('task_history').select('*').eq('task_id',taskId)).length,1);
    denied(await executorB.rpc('transition_task',{p_task_id:taskId,p_expected_status:'new',p_to_status:'in_progress'}));
    denied(await manager.rpc('transition_task',{p_task_id:taskId,p_expected_status:'new',p_to_status:'accepted'}));
    assert.equal(ok(await executorB.from('objects').select('*').eq('id',testObject)).length,0);
  });
  await check('two concurrent RPC requests produce one transition and one history event',async()=>{
    const args={p_task_id:taskId,p_expected_status:'new',p_to_status:'in_progress'};
    const responses=await Promise.all([executorA.rpc('transition_task',args),executorA.rpc('transition_task',args)]);
    assert.equal(responses.filter(response=>!response.error).length,1);
    assert.equal(responses.filter(response=>response.error).length,1);
    assert.equal(ok(await manager.from('task_history').select('*').eq('task_id',taskId)).length,2);
  });
  await check('full status flow, mandatory comment and exact history via real REST',async()=>{
    const go=(client,from,to,comment=null)=>client.rpc('transition_task',{p_task_id:taskId,p_expected_status:from,p_to_status:to,p_comment:comment});
    ok(await go(executorA,'in_progress','review'));
    denied(await go(manager,'review','rework','   '));
    assert.equal(ok(await manager.from('tasks').select('status').eq('id',taskId).single()).status,'review');
    ok(await go(manager,'review','rework','Synthetic correction'));
    ok(await go(executorA,'rework','in_progress'));ok(await go(executorA,'in_progress','review'));ok(await go(manager,'review','accepted'));
    const history=ok(await manager.from('task_history').select('*').eq('task_id',taskId).order('id'));
    assert.deepEqual(history.map(event=>event.to_status),['new','in_progress','review','rework','in_progress','review','accepted']);
    assert.equal(history[3].actor_id,credentials.users[0].id);
  });
  await check('manager moves task, object visibility updates and old three-argument RPC remains compatible',async()=>{
    moveTarget=uuid(ok(await manager.rpc('create_object',{p_name:'Move target fixture',p_address:'Fictional address'})));
    const before=ok(await manager.from('task_history').select('*').eq('task_id',taskId)).length;
    ok(await manager.rpc('update_task_details',{p_id:taskId,p_title:'Moved fixture',p_description:'Synthetic',p_object_id:moveTarget}));
    assert.equal(ok(await executorA.from('objects').select('*').eq('id',testObject)).length,0);
    assert.equal(ok(await executorA.from('objects').select('*').eq('id',moveTarget)).length,1);
    denied(await executorA.rpc('update_task_details',{p_id:taskId,p_title:'Forbidden',p_description:'',p_object_id:testObject}));
    ok(await manager.rpc('update_task_details',{p_id:taskId,p_title:'Legacy fixture',p_description:'Synthetic'}));
    denied(await manager.rpc('update_task_details',{p_id:taskId,p_title:'Must not save',p_description:'',p_object_id:'99999999-9999-4999-8999-999999999999'}));
    const task=ok(await manager.from('tasks').select('*').eq('id',taskId).single());
    assert.equal(task.object_id,moveTarget);assert.equal(task.title,'Legacy fixture');assert.equal(task.status,'accepted');
    assert.equal(ok(await manager.from('task_history').select('*').eq('task_id',taskId)).length,before);
    ok(await manager.rpc('update_task_details',{p_id:taskId,p_title:'Restored fixture',p_description:'',p_object_id:testObject}));
    assert.equal(ok(await executorA.from('objects').select('*').eq('id',testObject)).length,1);
  });
  await check('real transaction rolls status back if history insert fails',async()=>{
    const id=uuid(ok(await manager.rpc('create_task',{p_object_id:testObject,p_title:'Atomic rollback fixture',p_description:'Synthetic only',p_assignee_id:credentials.users[1].id})));createdTasks.push(id);
    sql(`create function private.crm_fixture_fail() returns trigger language plpgsql as $$ begin if NEW.task_id='${id}'::uuid then raise exception 'synthetic history failure'; end if; return NEW; end; $$;
      create trigger crm_fixture_fail before insert on public.task_history for each row execute procedure private.crm_fixture_fail();`);faultInjected=true;
    denied(await executorA.rpc('transition_task',{p_task_id:id,p_expected_status:'new',p_to_status:'in_progress'}));
    assert.equal(ok(await manager.from('tasks').select('status').eq('id',id).single()).status,'new');
    assert.equal(ok(await manager.from('task_history').select('*').eq('task_id',id)).length,1);
    sql('drop trigger crm_fixture_fail on public.task_history; drop function private.crm_fixture_fail();');faultInjected=false;
  });
  await check('session refresh and logout work against GoTrue',async()=>{
    const client=makeClient(anon);ok(await client.auth.signInWithPassword(credentials.users[2]));
    assert.ok(ok(await client.auth.refreshSession()).session);ok(await client.auth.signOut());
    assert.equal(ok(await client.auth.getSession()).session,null);
  });
  await check('concurrent reassignment closes former access immediately and preserves history',async()=>{
    const id=uuid(ok(await manager.rpc('create_task',{p_object_id:moveTarget,p_title:'Reassign fixture',p_description:'Synthetic',p_assignee_id:credentials.users[1].id})));createdTasks.push(id);
    const args={p_task_id:id,p_expected_assignee_id:credentials.users[1].id,p_assignee_id:credentials.users[2].id};
    const outcomes=await Promise.all([manager.rpc('reassign_task',args),manager.rpc('reassign_task',args)]);
    assert.equal(outcomes.filter(outcome=>!outcome.error).length,1);
    assert.equal(ok(await executorA.from('tasks').select('*').eq('id',id)).length,0);
    assert.equal(ok(await executorA.from('task_history').select('*').eq('task_id',id)).length,0);
    assert.equal(ok(await executorA.from('objects').select('*').eq('id',moveTarget)).length,0);
    assert.equal(ok(await executorB.from('tasks').select('status').eq('id',id).single()).status,'new');
    assert.equal(ok(await executorB.from('task_history').select('*').eq('task_id',id)).length,1);
    denied(await manager.rpc('reassign_task',{p_task_id:id,p_expected_assignee_id:credentials.users[2].id,p_assignee_id:credentials.users[0].id}));
    denied(await executorB.rpc('delete_task',{p_task_id:id}));
    denied(await executorB.rpc('reassign_task',{p_task_id:id,p_expected_assignee_id:credentials.users[2].id,p_assignee_id:credentials.users[1].id}));
    denied(await makeClient(anon).rpc('delete_task',{p_task_id:id}));
    denied(await manager.rpc('delete_object',{p_object_id:moveTarget}));
    ok(await manager.rpc('delete_task',{p_task_id:id}));
    assert.equal(ok(await manager.from('task_history').select('*').eq('task_id',id)).length,0);
    assert.equal(ok(await manager.from('tasks').select('*').eq('id',id)).length,0);
  });
  await check('deletion concurrent with transition leaves no orphan history; empty object deletable',async()=>{
    const id=uuid(ok(await manager.rpc('create_task',{p_object_id:moveTarget,p_title:'Delete race fixture',p_description:'',p_assignee_id:credentials.users[1].id})));createdTasks.push(id);
    const [deletion]=await Promise.all([manager.rpc('delete_task',{p_task_id:id}),executorA.rpc('transition_task',{p_task_id:id,p_expected_status:'new',p_to_status:'in_progress'})]);ok(deletion);
    assert.equal(ok(await manager.from('tasks').select('*').eq('id',id)).length,0);
    assert.equal(ok(await manager.from('task_history').select('*').eq('task_id',id)).length,0);
    ok(await manager.rpc('delete_object',{p_object_id:moveTarget}));moveTarget=null;
  });
  await check('all published container ports are loopback; database not published',async()=>{
    const output=compose(['ps','--format','json']).trim();
    const containers=JSON.parse(output.startsWith('[')?output:'['+output.split('\n').join(',')+']');
    const list=Array.isArray(containers)?containers:[containers];
    for(const container of list)for(const binding of container.Publishers||[])if(binding.PublishedPort)assert.equal(binding.URL,'127.0.0.1');
  });
  writeFileSync(new URL('../../.env.local',import.meta.url),`VITE_SUPABASE_URL=${api}\nVITE_SUPABASE_PUBLISHABLE_KEY=${anon}\n`);
  result.status='LOCAL_INTEGRATION_PASS';
} catch(error) {result.status='FAIL';result.error=error.message;process.exitCode=1;console.error(error.message);}
finally {
  if(faultInjected)sql('drop trigger if exists crm_fixture_fail on public.task_history; drop function if exists private.crm_fixture_fail();');
  // Remove only the explicitly created synthetic test rows, preserving demo fixtures.
  if(createdTasks.length)for(const id of createdTasks)sql(`delete from public.task_history where task_id='${uuid(id)}'; delete from public.tasks where id='${uuid(id)}';`);
  if(testObject)sql(`delete from public.objects where id='${uuid(testObject)}';`);
  if(moveTarget)sql(`delete from public.objects where id='${uuid(moveTarget)}';`);
  writeFileSync(new URL('../../quality/live-integration-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  await new Promise(resolve=>gateway?gateway.close(resolve):resolve());
}
