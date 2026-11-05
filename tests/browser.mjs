import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Browser contract test only: mock Auth/REST responses, never contact Supabase.
const base = 'http://127.0.0.1:4376';
const api = 'https://crm-test.example.com';
const users = [
  { id:'10000000-0000-4000-8000-000000000001',display_name:'Тестовый постановщик',role:'manager' },
  { id:'10000000-0000-4000-8000-000000000002',display_name:'Исполнитель А',role:'executor' },
  { id:'10000000-0000-4000-8000-000000000003',display_name:'Исполнитель Б',role:'executor' }
];
const objects = [{ id:'o1',name:'Объект Альфа',address:'Вымышленная улица, 1' },{ id:'o2',name:'Объект Бета',address:'Вымышленная улица, 2' }];
const tasks = [
  { id:'t1',object_id:'o1',title:'Задача исполнителя А',description:'Тестовое описание',assignee_id:users[1].id,author_id:users[0].id,status:'new',created_at:'2026-11-05T12:00:00Z' },
  { id:'t2',object_id:'o2',title:'Чужая задача Б',description:'Тест',assignee_id:users[2].id,author_id:users[0].id,status:'review',created_at:'2026-11-05T12:01:00Z' }
];
const history = tasks.map((task,index) => ({id:index+1,task_id:task.id,actor_id:users[0].id,from_status:null,to_status:'new',comment:null,created_at:task.created_at}));
let active = users[0]; let failReads = false; const rpc = []; const errors = [];
const server = spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4376','--strictPort'],{
  cwd:new URL('..',import.meta.url), env:{...process.env,VITE_SUPABASE_URL:api,VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic_browser_fixture'},stdio:'pipe'
});
let serverOutput = ''; server.stderr.on('data',chunk => {serverOutput += chunk;}); server.stdout.on('data',chunk => {serverOutput += chunk;});
let browser;
try {
  let ready = false;
  for (let attempt=0;attempt<80;attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite exited: ${serverOutput}`);
    try { if ((await fetch(base)).ok) {ready = true;break;} } catch {}
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.ok(ready,'Vite ready');
  browser = await chromium.launch({channel:'chrome',headless:true});
  const context = await browser.newContext();
  await context.route('**/*',async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === base) return route.continue();
    if (url.origin !== api) return route.abort();
    const fulfill = (json,status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(json)});
    if (url.pathname.endsWith('/token')) {
      const body = request.postDataJSON(); active = body.email.startsWith('manager') ? users[0] : users[1];
      const user = {id:active.id,email:body.email,aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-11-05T12:00:00Z'};
      const token = `${btoa(JSON.stringify({alg:'HS256',typ:'JWT'}))}.${btoa(JSON.stringify({sub:active.id,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600}))}.fixture`;
      return fulfill({access_token:token,refresh_token:'synthetic',expires_in:3600,token_type:'bearer',user});
    }
    if (url.pathname.endsWith('/logout')) return fulfill({});
    if (url.pathname.includes('/rpc/')) {
      const name = url.pathname.split('/').at(-1); const args = request.postDataJSON(); rpc.push({name,args});
      if (name === 'transition_task') {
        const task = tasks.find(task => task.id === args.p_task_id); const from = task.status;
        task.status = args.p_to_status; history.push({id:history.length+1,task_id:task.id,actor_id:active.id,from_status:from,to_status:task.status,comment:args.p_comment,created_at:new Date().toISOString()});
      }
      return fulfill(null);
    }
    if (failReads) return fulfill({message:'Синтетический сбой чтения',code:'fixture'},503);
    const visible = tasks.filter(task => active.role === 'manager' || task.assignee_id === active.id);
    const rows = { profiles:users,objects:objects.filter(object => active.role === 'manager' || visible.some(task => task.object_id === object.id)),tasks:visible,task_history:history.filter(item => visible.some(task => task.id === item.task_id)) };
    const table = url.pathname.split('/').at(-1);
    return table in rows ? fulfill(rows[table]) : fulfill({message:'Unexpected fixture request'},400);
  });
  const page = await context.newPage(); page.on('pageerror',error => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel('Email').fill('manager@example.com'); await page.getByLabel('Пароль',{exact:true}).fill('Synthetic-only-123'); await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.getByRole('heading',{name:'Объекты',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Добавить объект'}).count(),1);
  await page.getByRole('link',{name:/Объект Бета/}).click(); await page.getByRole('link',{name:'Чужая задача Б'}).click();
  await page.getByRole('button',{name:'Принять',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Вернуть на доработку'}).isDisabled(),true);
  await page.getByLabel(/Комментарий/).fill('Исправить тестовое замечание');
  await page.getByRole('button',{name:'Вернуть на доработку'}).click();
  await page.getByText('Изменения сохранены',{exact:true}).waitFor();
  await page.getByRole('heading',{name:'История задачи'}).waitFor();
  assert.equal(rpc.at(-1).args.p_expected_status,'review'); assert.equal(rpc.at(-1).args.p_to_status,'rework');
  await page.getByRole('button',{name:'Выйти',exact:true}).click();
  await page.getByLabel('Email').fill('executor@example.com'); await page.getByLabel('Пароль',{exact:true}).fill('Synthetic-only-123'); await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.getByRole('link',{name:'Мои задачи',exact:true}).waitFor();
  await page.getByRole('link',{name:'Мои задачи',exact:true}).click();
  await page.getByRole('link',{name:'Задача исполнителя А',exact:true}).click();
  await page.getByRole('button',{name:'Взять в работу',exact:true}).waitFor();
  assert.equal(await page.getByText('Чужая задача Б',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Принять',exact:true}).count(),0);
  await page.getByRole('button',{name:'Взять в работу',exact:true}).click();
  await page.getByRole('button',{name:'Отправить на проверку',exact:true}).waitFor();
  assert.equal(rpc.at(-1).args.p_expected_status,'new'); assert.equal(rpc.at(-1).args.p_to_status,'in_progress');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'no mobile overflow');
  await mkdir('quality',{recursive:true}); await page.screenshot({path:'quality/executor-mobile.png',fullPage:true});
  failReads = true; await page.getByRole('button',{name:'Обновить данные',exact:true}).click();
  await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').textContent(),/Синтетический сбой чтения/);
  assert.equal(await page.getByRole('heading',{name:'История задачи'}).count(),0,'no stale protected data after read failure');
  failReads = false; await page.getByRole('button',{name:'Обновить данные',exact:true}).click();
  await page.getByRole('heading',{name:'История задачи'}).waitFor();
  assert.deepEqual(errors,[]);
  const result={status:'PASS',scope:'browser UI with synthetic mocked Auth/REST; not cloud integration',checks:['manager navigation','review/rework comment','RPC expected status','executor actions','logout/login isolation','mobile overflow','read failure/recovery','no JS errors'],at:new Date().toISOString()};
  await writeFile('quality/browser-result.json',JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result,null,2));
} finally { await browser?.close(); server.kill(); }
