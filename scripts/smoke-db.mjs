// Smoke test for the authed stack: proves the local stack is up, the
// migrations + seed ran, the demo logins exist (scripts/seed-auth.mjs), RLS is
// actually enforcing, and a signed-in driver can do exactly what the app
// does — read their run, upload evidence, and idempotently upsert a POD.
// Usage: node scripts/smoke-db.mjs   (reads .env in the repo root)
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const PASSWORD = 'citipost' // demo logins from scripts/seed-auth.mjs
const newClient = () =>
  createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
let failed = false

// 1. RLS is on: anonymous reads must come back empty (not an error — empty).
const anon = newClient()
const { data: anonParcels, error: anonErr } = await anon.from('parcels').select('id')
if (anonErr || anonParcels?.length) {
  console.error('✗ anon read should return 0 rows:', anonErr?.message ?? `${anonParcels.length} rows leaked`)
  failed = true
} else {
  console.log('✓ RLS: anonymous client sees no parcels')
}

// 2. A driver signs in and sees their run (sam = drv_demo, Greater London).
const driver = newClient()
const { error: signInErr } = await driver.auth.signInWithPassword({
  email: 'sam@citipost.test',
  password: PASSWORD,
})
if (signInErr) {
  console.error('✗ driver sign-in failed:', signInErr.message)
  console.error('  Run `node scripts/seed-auth.mjs` after every `supabase db reset`.')
  process.exit(1)
}
const { data: parcels, error: pErr } = await driver
  .from('parcels')
  .select('tracking_number, recipient_name, area, status')
  .order('tracking_number')
if (pErr || !parcels?.length) {
  console.error('✗ driver parcels query failed:', pErr?.message ?? 'no rows')
  failed = true
} else {
  console.log(`✓ sam sees ${parcels.length} parcels on his run:`)
  for (const p of parcels) console.log(`    ${p.tracking_number}  ${p.area.padEnd(13)} ${p.recipient_name}`)
}

// 3. Evidence bucket: signed-in upload + authenticated read-back (the bucket
// is private now — no public URLs).
const probe = `smoke/probe-${Date.now()}.txt`
const { error: upErr } = await driver.storage
  .from('pod-evidence')
  .upload(probe, new Blob(['smoke']), { contentType: 'text/plain' })
if (upErr) {
  console.error('✗ upload to pod-evidence failed:', upErr.message)
  failed = true
} else {
  const { data: blob, error: dlErr } = await driver.storage.from('pod-evidence').download(probe)
  if (dlErr || !blob) {
    console.error('✗ authenticated read-back failed:', dlErr?.message)
    failed = true
  } else {
    console.log('✓ pod-evidence bucket: signed-in upload + read-back OK')
  }
}

// 4. pod_records insert + idempotency shape (same client-generated id twice).
// driver_id must match the signed-in driver's profile or RLS rejects the row.
const podId = crypto.randomUUID()
const row = {
  id: podId,
  tracking_scanned: 'SMOKE-TEST',
  status: 'delivered',
  received_by: 'smoke test',
  captured_at: new Date().toISOString(),
  driver_id: 'drv_demo',
}
const first = await driver.from('pod_records').insert(row)
const second = await driver.from('pod_records').upsert(row, { onConflict: 'id' })
if (first.error || second.error) {
  console.error('✗ pod_records insert/upsert failed:', (first.error ?? second.error).message)
  failed = true
} else {
  console.log('✓ pod_records insert + idempotent upsert OK')
}

// Tidy up as admin — drivers have no delete policy (deliberately), so the
// probe row would otherwise linger in the dispatcher's POD list.
const admin = newClient()
const { error: adminErr } = await admin.auth.signInWithPassword({
  email: 'admin@citipost.test',
  password: PASSWORD,
})
if (!adminErr) await admin.from('pod_records').delete().eq('id', podId)

process.exit(failed ? 1 : 0)
