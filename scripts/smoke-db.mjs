// Checkpoint-2 smoke test: proves the local stack is up, the migration +
// seed ran, and the anon key can do exactly what the app will do —
// read parcels and upload to the pod-evidence bucket.
// Usage: node scripts/smoke-db.mjs   (reads .env in the repo root)
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
let failed = false

// 1. Seeded parcels readable via anon
const { data: parcels, error: pErr } = await supabase
  .from('parcels')
  .select('tracking_number, recipient_name, area, status')
  .order('tracking_number')
if (pErr || !parcels?.length) {
  console.error('✗ parcels query failed:', pErr?.message ?? 'no rows')
  failed = true
} else {
  console.log(`✓ ${parcels.length} parcels seeded:`)
  for (const p of parcels) console.log(`    ${p.tracking_number}  ${p.area.padEnd(13)} ${p.recipient_name}`)
}

// 2. Bucket exists and anon can upload + read back (public bucket)
const probe = `smoke/probe-${Date.now()}.txt`
const { error: upErr } = await supabase.storage
  .from('pod-evidence')
  .upload(probe, new Blob(['smoke']), { contentType: 'text/plain' })
if (upErr) {
  console.error('✗ upload to pod-evidence failed:', upErr.message)
  failed = true
} else {
  const { data } = supabase.storage.from('pod-evidence').getPublicUrl(probe)
  const res = await fetch(data.publicUrl)
  if (res.ok) console.log('✓ pod-evidence bucket: upload + public read OK')
  else {
    console.error(`✗ public read failed (${res.status}) for ${data.publicUrl}`)
    failed = true
  }
}

// 3. pod_records insert + idempotency shape (same client-generated id twice)
const podId = crypto.randomUUID()
const row = {
  id: podId,
  tracking_scanned: 'SMOKE-TEST',
  status: 'delivered',
  received_by: 'smoke test',
  captured_at: new Date().toISOString(),
  gps_simulated: true,
}
const first = await supabase.from('pod_records').insert(row)
const second = await supabase.from('pod_records').upsert(row, { onConflict: 'id' })
if (first.error || second.error) {
  console.error('✗ pod_records insert/upsert failed:', (first.error ?? second.error).message)
  failed = true
} else {
  console.log('✓ pod_records insert + idempotent upsert OK')
  await supabase.from('pod_records').delete().eq('id', podId) // tidy up
}

process.exit(failed ? 1 : 0)
