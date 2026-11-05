import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

test('Vite refuses private key before bundling, without printing its value', () => {
  const marker = 'sb_secret_SYNTHETIC_DO_NOT_BUNDLE';
  const result = spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{
    cwd:new URL('..',import.meta.url),encoding:'utf8',
    env:{...process.env,VITE_SUPABASE_URL:'https://crm-test.example.com',VITE_SUPABASE_PUBLISHABLE_KEY:marker}
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Приватные ключи запрещены/);
  assert.equal((result.stdout+result.stderr).includes(marker),false);
});
