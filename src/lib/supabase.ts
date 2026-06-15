import { createClient } from '@supabase/supabase-js'

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** Phone-on-the-LAN dev: the local stack's 127.0.0.1 URL would point at the
 *  *phone's* loopback, and an HTTPS dev page (npm run dev:https) blocks the
 *  plain-HTTP call as mixed content anyway. Route through the dev server's
 *  same-origin proxy instead (vite.config `server.proxy`). Cloud HTTPS URLs
 *  and same-machine localhost access are untouched. */
const isLoopbackUrl = rawUrl ? /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(rawUrl) : false
const onLoopbackHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
const url =
  import.meta.env.DEV && isLoopbackUrl && !onLoopbackHost ? window.location.origin : rawUrl

/** False when the build had no Supabase env vars (fresh clone, or a deploy
 *  without them configured). The app renders a setup notice instead of a
 *  blank page — never throw at module load, it kills the whole bundle. */
export const supabaseConfigured = Boolean(url && anonKey)

export const supabase = createClient(
  url || 'http://unconfigured.invalid',
  anonKey || 'unconfigured',
)

/** Storage bucket holding photos + signatures. Private: signed-in read/insert
 *  only (RLS on storage.objects); the dispatcher views evidence via short-lived
 *  signed URLs (DispatcherScreen `createSignedUrls`). */
export const EVIDENCE_BUCKET = 'pod-evidence'
