import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startProxy } from './proxy.mjs';
import { sql } from './start.mjs';

const root = new URL('../..',import.meta.url);
const credentials = JSON.parse(readFileSync(new URL('../../.local-access.local.json',import.meta.url),'utf8'));
const result = {status:'RUNNING',scope:'real browser to local GoTrue/PostgREST/PostgreSQL, no API mocks',checks:[],at:new Date().toISOString()};
const errors=[];const outside=[];let taskId;let objectId;let browser;let server;let proxy;
const uuid=value=>{assert.match(value,/^[a-f0-9-]{36}$/);return value;};
try {
  proxy=await startProxy();
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4376','--strictPort'],{cwd:root,env:{...process.env},stdio:'pipe'});
  let ready=false;
  for(let i=0;i<80;i++){try{if((await fetch('http://127.0.0.1:4376')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready,'local Vite ready');
  for(const path of ['/.local-access.local.json','/tests/live/.env.local','/tests/live/compose.yml',`/@fs/${decodeURIComponent(new URL('../../.local-access.local.json',import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1')}`]){
    const response=await fetch(`http://127.0.0.1:4376${path}`);
    assert.ok([403,404].includes(response.status),'Vite must not serve local credentials or test infrastructure');
  }
  result.checks.push('Vite denies credential and test-infrastructure file requests');
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
    const origin=new URL(route.request().url()).origin;
    if(!['http://127.0.0.1:4376','http://127.0.0.1:4377'].includes(origin)){outside.push(origin);return route.abort();}
    return route.continue();
  });
  const login=async index=>{
    await page.getByLabel('Email',{exact:true}).fill(credentials.users[index].email);
    await page.getByLabel('Пароль',{exact:true}).fill(credentials.users[index].password);
    await page.getByRole('button',{name:'Войти',exact:true}).click();
    await page.getByRole('button',{name:'Выйти',exact:true}).waitFor();
    await page.getByText('Загружаем данные…',{exact:true}).waitFor({state:'hidden'});
  };
  const logout=async()=>{await page.getByRole('button',{name:'Выйти',exact:true}).click();await page.getByRole('button',{name:'Войти',exact:true}).waitFor();};
  const act=async name=>{await page.getByRole('button',{name,exact:true}).click();await page.getByText('Изменения сохранены',{exact:true}).waitFor();await page.getByText('Загружаем данные…',{exact:true}).waitFor({state:'hidden'});};
  await page.goto('http://127.0.0.1:4376');await login(0);
  await page.getByLabel('Название',{exact:true}).fill('Браузерный учебный объект');await page.getByLabel('Адрес',{exact:true}).fill('Вымышленный проезд, 10');
  let response=page.waitForResponse(response=>response.url().endsWith('/rpc/create_object')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Создать объект',exact:true}).click();objectId=uuid(await (await response).json());
  await page.getByRole('heading',{name:'Новая задача',exact:true}).waitFor();
  await page.getByLabel('Название',{exact:true}).first().fill('Проверка полного пути');await page.getByLabel('Описание',{exact:true}).fill('Исключительно синтетическая проверка');
  await page.getByRole('combobox',{name:/Исполнитель/}).selectOption(credentials.users[1].id);
  response=page.waitForResponse(response=>response.url().endsWith('/rpc/create_task')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Создать задачу',exact:true}).click();taskId=uuid(await (await response).json());
  await page.getByRole('heading',{name:'История задачи',exact:true}).waitFor();result.checks.push('manager creates object and task using real forms/RPC');
  await logout();await login(1);await act('Взять в работу');await act('Отправить на проверку');
  await page.getByText('Ожидается проверка постановщиком.',{exact:true}).waitFor();result.checks.push('assigned executor takes task and submits for review');
  await logout();await login(0);
  assert.ok(await page.getByRole('button',{name:'Вернуть на доработку',exact:true}).isDisabled());
  await page.getByLabel(/Комментарий/).fill('Добавить учебное пояснение');await act('Вернуть на доработку');result.checks.push('manager returns task with mandatory comment recorded in history');
  await logout();await login(1);await act('Взять в работу');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'quality/live-executor-mobile.png',fullPage:true});await act('Отправить на проверку');
  await logout();await login(0);await act('Принять');
  await page.getByText('Задача завершена.',{exact:true}).waitFor();
  const events=page.locator('.history li');assert.equal(await events.count(),7);result.checks.push('rework to acceptance; seven ordered history events');
  await page.getByText('Редактировать задачу',{exact:true}).click();
  const select=page.getByRole('combobox',{name:/Объект задачи/});
  const target=await select.locator('option').evaluateAll(options=>options.find(option=>!option.selected)?.value);
  assert.ok(target);await select.selectOption(target);await act('Сохранить задачу');
  assert.equal(await page.locator(`a[href="#object/${target}"]`).count(),1);
  assert.equal(await page.locator('.history li').count(),7);await page.getByText('Задача завершена.',{exact:true}).waitFor();
  result.checks.push('manager edits task object in UI; status and seven history events preserved');
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'quality/live-manager-desktop.png',fullPage:true});
  await page.getByText('Редактировать задачу',{exact:true}).click();
  await page.getByRole('combobox',{name:/Новый исполнитель/}).selectOption(credentials.users[2].id);await act('Переназначить задачу');
  await logout();await login(1);await page.getByRole('heading',{name:'Страница недоступна',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Проверка полного пути',exact:true}).count(),0);result.checks.push('former executor loses task deep-link after reassignment; no stale task');
  await logout();await login(2);await page.getByRole('heading',{name:'Проверка полного пути',exact:true}).waitFor();
  assert.equal(await page.locator('.history li').count(),7);result.checks.push('new executor sees task with all prior history');
  await logout();await login(0);await page.getByText('Редактировать задачу',{exact:true}).click();
  page.once('dialog',async dialog=>{assert.match(dialog.message(),/Проверка полного пути.*историей/);await dialog.accept();});
  await act('Удалить задачу');
  await page.evaluate(id=>{location.hash=`task/${id}`;},taskId);
  await page.getByRole('heading',{name:'Страница недоступна',exact:true}).waitFor();result.checks.push('manager deletes task and history with explicit confirmation');
  await page.evaluate(id=>{location.hash=`object/${id}`;},objectId);await page.getByText('Редактировать объект',{exact:true}).click();
  page.once('dialog',async dialog=>{assert.match(dialog.message(),/Браузерный учебный объект/);await dialog.accept();});
  await act('Удалить объект');await page.getByRole('heading',{name:'Объекты',exact:true}).waitFor();result.checks.push('manager deletes empty object with confirmation');
  await page.reload();await page.getByRole('heading',{name:'Вход в CRM',exact:true}).waitFor();result.checks.push('reload returns to login per in-memory session contract');
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);result.checks.push('mobile layout; no JS errors or non-loopback requests');
  result.status='LOCAL_BROWSER_INTEGRATION_PASS';console.log(JSON.stringify(result,null,2));
}catch(error){result.status='FAIL';result.error=error.message;console.error(error.message);process.exitCode=1;}
finally{
  await browser?.close();server?.kill();await new Promise(resolve=>proxy?proxy.close(resolve):resolve());
  if(taskId)sql(`delete from public.task_history where task_id='${uuid(taskId)}'; delete from public.tasks where id='${uuid(taskId)}';`);
  if(objectId)sql(`delete from public.objects where id='${uuid(objectId)}';`);
  writeFileSync(new URL('../../quality/live-browser-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
}
