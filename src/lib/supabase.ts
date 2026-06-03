import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  // Fail loudly at startup — a missing .env is the most likely setup mistake.
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy .env.example to .env ' +
      'and paste the values printed by `npx supabase start` (or `npx supabase status`).',
  )
}

export const supabase = createClient(url, anonKey)

/** Storage bucket holding photos + signatures (public read in this PoC). */
export const EVIDENCE_BUCKET = 'pod-evidence'
