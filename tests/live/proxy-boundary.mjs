import net from 'node:net';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { startProxy } from './proxy.mjs';

const proxy=await startProxy();
const result={status:'RUNNING',checks:[],scope:'local test gateway only',at:new Date().toISOString()};
try{
  const socket=net.connect(4377,'127.0.0.1',()=>{
    socket.write('POST /rest/v1/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000\r\n\r\npartial');setTimeout(()=>socket.destroy(),30);
  });socket.on('error',()=>{});
  await new Promise(resolve=>setTimeout(resolve,150));
  for(const [path,options,status] of [
    ['/rest/v1/tasks',{headers:{Origin:'https://untrusted.example.com'}},403],
    ['/not-an-api',{},404],
    ['/rest/v1/tasks',{method:'HEAD'},405],
    ['/rest/v1/tasks',{method:'POST',body:'x'.repeat(20000)},413]
  ])assert.equal((await fetch(`http://127.0.0.1:4377${path}`,options)).status,status);
  result.checks.push('aborted body does not stop gateway','foreign origin rejected','non-API route rejected','unsupported method rejected','oversize body rejected');
  result.status='LOCAL_PROXY_BOUNDARY_PASS';console.log(JSON.stringify(result,null,2));
}catch(error){result.status='FAIL';result.error=error.message;process.exitCode=1;console.error(error.message);}
finally{await new Promise(resolve=>proxy.close(resolve));writeFileSync(new URL('../../quality/live-proxy-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');}
