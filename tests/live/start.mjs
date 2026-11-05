import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..',import.meta.url));
const envFile = fileURLToPath(new URL('.env.local',import.meta.url));
if (!existsSync(envFile)) writeFileSync(envFile,`DB_PASSWORD=${randomBytes(24).toString('hex')}\nJWT_SECRET=${randomBytes(32).toString('hex')}\n`);
export const composeArgs = ['compose','--env-file',envFile,'-f',fileURLToPath(new URL('compose.yml',import.meta.url))];
export function compose(args, input) {
  const result = spawnSync('docker',[...composeArgs,...args],{cwd:root,input,encoding:'utf8',maxBuffer:2*1024*1024});
  if (result.status !== 0) throw new Error(`Local compose failed (${args.slice(0,2).join(' ')}): ${result.stderr || result.error?.message}`);
  return result.stdout;
}
export function sql(text) { return compose(['exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],text); }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  compose(['up','-d','--wait','db']);
  const initialized = sql("select exists(select 1 from pg_roles where rolname='authenticator');");
  if (!/\bt\b/.test(initialized)) sql(readFileSync(new URL('bootstrap.sql',import.meta.url),'utf8'));
  compose(['up','-d','auth','rest']);
  console.log('Local PostgreSQL/Auth/PostgREST started; only loopback API ports published.');
}
