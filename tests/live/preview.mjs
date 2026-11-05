import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { startProxy } from './proxy.mjs';

const env=readFileSync(new URL('../../.env.local',import.meta.url),'utf8');
if(!env.includes('VITE_SUPABASE_URL=http://127.0.0.1:4377\n'))throw new Error('Сначала выполните test:live для локального тестового окружения.');
const proxy=await startProxy();
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4376','--strictPort'],{cwd:new URL('../..',import.meta.url),stdio:'inherit'});
let closing=false;
const stop=()=>{if(closing)return;closing=true;vite.kill();proxy.close(()=>process.exit());};
process.on('SIGINT',stop);process.on('SIGTERM',stop);vite.on('exit',stop);
console.log('Локальная CRM: http://127.0.0.1:4376 · вымышленные доступы: .local-access.local.json');
