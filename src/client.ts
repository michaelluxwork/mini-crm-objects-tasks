import { createClient } from '@supabase/supabase-js';
import { isPublicKey, isAllowedSupabaseUrl } from './public-key';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
export const configured = !!url && isAllowedSupabaseUrl(url) && !url.includes('YOUR-PROJECT') && !!key && isPublicKey(key);
export const client = configured ? createClient(url!, key!, { auth: { persistSession: false, detectSessionInUrl: false } }) : null;
