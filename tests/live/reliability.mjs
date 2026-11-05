import { compose, sql } from './start.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const result={status:'RUNNING',scope:'isolated local compose synthetic data only',checks:[],at:new Date().toISOString()};
const snapshot=()=>sql(`select md5(coalesce(string_agg(id::text||':'||status,',' order by id),'')) as task_digest from public.tasks;
  select md5(coalesce(string_agg(id::text||':'||task_id::text||':'||to_status,',' order by id),'')) as history_digest from public.task_history;`);
const health=async()=>{
  for(let i=0;i<100;i++){
    try{if((await fetch('http://127.0.0.1:54791/health')).ok){sql('select 1;');return;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }throw new Error('local restart health timeout');
};
try{
  const before=snapshot();
  compose(['restart','db','auth','rest']);await health();assert.equal(snapshot(),before);result.checks.push('task and history digests unchanged after restart');
  compose(['stop','auth','rest','db']);
  for(const port of [54791,54792]){let reachable=false;try{await fetch(`http://127.0.0.1:${port}/`);reachable=true;}catch{}assert.equal(reachable,false);}
  result.checks.push('all local API endpoints unavailable after stop');
  compose(['up','-d','--wait','db']);compose(['up','-d','auth','rest']);await health();assert.equal(snapshot(),before);result.checks.push('data survives stop/start with named test volume');
  result.status='LOCAL_RELIABILITY_PASS';console.log(JSON.stringify(result,null,2));
}catch(error){result.status='FAIL';result.error=error.message;process.exitCode=1;console.error(error.message);}
finally{writeFileSync(new URL('../../quality/live-reliability-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');}
