import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { isPublicKey, isAllowedSupabaseUrl } from './src/public-key.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  // Reject private keys before Vite can inline them into a browser bundle.
  if ((url || key) && (!url || !isAllowedSupabaseUrl(url) || !key || !isPublicKey(key))) {
    throw new Error('Нужны HTTPS Supabase URL (HTTP только для loopback) и публичный publishable/anon key. Приватные ключи запрещены.');
  }
  return { server: {
    host: '127.0.0.1', port: 4376, strictPort: true,
    fs: {
      allow: [fileURLToPath(new URL('.',import.meta.url))],
      deny: ['.env','.env.*','*.{crt,pem,key,p12,pfx,cer,der}','.npmrc','.yarnrc.yml','**/.git/**','**/*.local.json','**/tests/live/**']
    }
  } };
});
