import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** True once both env vars are set — checked before any push is attempted. */
export const supabaseConfigured = Boolean(url && key);

export const supabase = supabaseConfigured ? createClient(url as string, key as string) : null;
