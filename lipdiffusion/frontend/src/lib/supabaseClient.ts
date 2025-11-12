import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

let client: SupabaseClient | null = null

if (supabaseUrl && supabaseAnonKey) {
  client = createClient(supabaseUrl, supabaseAnonKey)
} else {
  console.warn(
    '[lipdiffusion] Supabase env vars (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) are missing. Auth is disabled.',
  )
}

export const supabase = client
export const isAuthConfigured = Boolean(client)
