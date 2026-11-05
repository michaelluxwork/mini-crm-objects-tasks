export function isPublicKey(value: string): boolean {
  if (value.startsWith('sb_publishable_')) return true;
  try { return JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; }
  catch { return false; }
}

export function isAllowedSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  } catch { return false; }
}
