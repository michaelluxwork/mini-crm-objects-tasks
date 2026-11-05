// Test-only gateway. Never deploy this file; no static files or logging.
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export function startProxy() {
  const handle = async (req,res) => {
    req.setTimeout(5000,()=>req.destroy());
    const origin = req.headers.origin;
    if (origin && origin !== 'http://127.0.0.1:4376') { res.writeHead(403); res.end(); return; }
    const cors = {'Access-Control-Allow-Origin':'http://127.0.0.1:4376','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info,prefer','Access-Control-Allow-Methods':'GET,POST,PATCH,PUT,DELETE,OPTIONS','Vary':'Origin'};
    if (req.method === 'OPTIONS') { res.writeHead(204,cors); res.end(); return; }
    if (!['GET','POST','PATCH','PUT','DELETE'].includes(req.method)) {res.writeHead(405,cors);res.end();return;}
    const route = req.url?.match(/^\/(auth|rest)\/v1(\/.*|\?.*|$)/);
    if (!route) {res.writeHead(404,cors);res.end();return;}
    const chunks=[]; let size=0;
    for await (const chunk of req) {size += chunk.length; if(size>16384){res.writeHead(413,cors);res.end();return;} chunks.push(chunk);}
    const body = Buffer.concat(chunks);
    req.setTimeout(0);
    const headers = {};
    for (const name of ['authorization','apikey','content-type','x-client-info','prefer','accept']) if(req.headers[name]) headers[name]=req.headers[name];
    if(body.length)headers['content-length']=String(body.length);
    const upstream = http.request({hostname:'127.0.0.1',port:route[1]==='auth'?54791:54792,path:route[2] || '/',method:req.method,headers,timeout:10000},response => {
      res.writeHead(response.statusCode || 502,{...cors,'content-type':response.headers['content-type'] || 'application/json',...(response.headers['content-range']?{'content-range':response.headers['content-range']}:{})});response.on('error',()=>res.destroy());response.pipe(res);
    });
    upstream.on('timeout',()=>upstream.destroy());
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{...cors,'content-type':'application/json'});res.end('{"message":"Local API unavailable"}');});
    upstream.end(body);
  };
  const server = http.createServer((req,res) => {
    void handle(req,res).catch(()=>{
      if(res.destroyed)return;
      if(!res.headersSent)res.writeHead(400,{'content-type':'application/json'});
      res.end('{"message":"Invalid local test request"}');
    });
  });
  server.headersTimeout=5000;server.requestTimeout=10000;server.maxHeadersCount=32;
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4377,'127.0.0.1',()=>resolve(server));});
}
if(process.argv[1] === fileURLToPath(import.meta.url)) {await startProxy();console.log('Local test gateway: http://127.0.0.1:4377');}
