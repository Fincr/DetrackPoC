// Comprehensive backend test suite: RLS isolation, lifecycle invariants,
// sync idempotency, the attempts model, and storage policies — exercised
// through supabase-js exactly the way the app talks to the backend.
// Run with the local stack up + auth seeded:
//   node scripts/test-system.mjs
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => l.split('=', 2).map((s) => s.trim())),
)
const URL = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY

const mk = () => createClient(URL, ANON, { auth: { persistSession: false } })
const anon = mk()
const admin = mk()
const sam = mk()
const priya = mk()

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function signIn(client, email) {
  const { error } = await client.auth.signInWithPassword({ email, password: 'citipost' })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
}

console.log('— auth —')
await signIn(admin, 'admin@citipost.test')
await signIn(sam, 'sam@citipost.test')
await signIn(priya, 'priya@citipost.test')
check('admin + sam + priya signed in', true)

// ── B1-B5: RLS isolation ────────────────────────────────────────────────────
console.log('— RLS isolation —')

{
  const { data } = await anon.from('parcels').select('id')
  check('B1 anonymous sees no parcels', (data ?? []).length === 0)
}

const { data: routes } = await admin.from('routes').select('*')
const samRoutes = new Set(routes.filter((r) => r.driver_id === 'drv_demo').map((r) => r.id))
const priyaRoutes = new Set(routes.filter((r) => r.driver_id === 'drv_priya').map((r) => r.id))

// ── fixtures ────────────────────────────────────────────────────────────────
// The suite creates its OWN parcels and removes them at the end, so it is
// repeatable: earlier versions mutated seeded parcels into terminal states
// (delivered/returned), which made every second run fail B6. The service-role
// key (env var → .env → local CLI, same lookup as seed-auth.mjs) is used only
// for fixture setup/teardown — every assertion still runs as anon/driver/admin.
function serviceKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY
  if (env.SUPABASE_SERVICE_ROLE_KEY) return env.SUPABASE_SERVICE_ROLE_KEY
  const tries = [
    ['node_modules/@supabase/cli-windows-x64/bin/supabase.exe', ['status', '-o', 'env']],
    ['npx', ['supabase', 'status', '-o', 'env']],
  ]
  for (const [cmd, args] of tries) {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' })
      const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/SERVICE_ROLE_KEY="?([^"\r\n]+)"?/)
      if (m) return m[1].trim()
    } catch {
      /* try the next */
    }
  }
  return null
}
const SVC = serviceKey()
if (!SVC) {
  console.error('✗ No service-role key. Set SUPABASE_SERVICE_ROLE_KEY (find it via `npx supabase status`).')
  process.exit(1)
}
const svc = createClient(URL, SVC, { auth: { persistSession: false } })

async function mkParcel(tracking, routeId) {
  const { data, error } = await svc
    .from('parcels')
    .insert({ tracking_number: tracking, recipient_name: 'System Test', address_line: '1 Test Way', route_id: routeId })
    .select()
    .single()
  if (error) throw new Error(`fixture ${tracking}: ${error.message}`)
  return data
}
const RUN = Date.now()
const samParcel = await mkParcel(`TSYS-${RUN}-A`, routes.find((r) => r.driver_id === 'drv_demo').id)
const failTarget = await mkParcel(`TSYS-${RUN}-B`, routes.find((r) => r.driver_id === 'drv_demo').id)
const priyaParcel = await mkParcel(`TSYS-${RUN}-P`, routes.find((r) => r.driver_id === 'drv_priya').id)

{
  const { data } = await sam.from('parcels').select('*')
  const leaked = (data ?? []).filter((p) => !samRoutes.has(p.route_id))
  check('B2 sam sees only his route parcels', (data ?? []).length > 0 && leaked.length === 0,
    `${(data ?? []).length} rows, ${leaked.length} leaked`)
}

{
  const { error } = await sam.from('parcels').insert({
    tracking_number: `HACK-${Date.now()}`,
    recipient_name: 'x',
    address_line: 'x',
  })
  check('B3 sam cannot insert parcels', !!error)
}

{
  await sam.from('parcels').update({ recipient_name: 'TAMPERED' }).eq('id', priyaParcel.id)
  const { data: after } = await admin.from('parcels').select('recipient_name').eq('id', priyaParcel.id).single()
  check("B4 sam cannot update another route's parcel", after.recipient_name !== 'TAMPERED')
}

{
  const { data } = await sam.from('manifests').select('id')
  const { error: insErr } = await sam.from('manifests').insert({ name: 'hack' })
  check('B5 manifests are admin-only for sam', (data ?? []).length === 0 && !!insErr)
}

// ── B6-B8: lifecycle invariants ─────────────────────────────────────────────
console.log('— lifecycle —')

const POINT = 'POINT(0.16505 51.48132)'

async function insertEvent(client, parcelId, stage, driverId) {
  return client.from('parcel_events').upsert(
    {
      id: randomUUID(),
      parcel_id: parcelId,
      tracking_scanned: 'TEST',
      stage,
      captured_at: new Date().toISOString(),
      location: POINT,
      gps_accuracy_m: 9,
      gps_source: 'device',
      driver_id: driverId,
    },
    { onConflict: 'id' },
  )
}
// Mirror of events.ts advanceParcelStatus — the atomic forward-only RPC
async function advance(client, parcelId, to) {
  const { error } = await client.rpc('advance_parcel_status', { p_id: parcelId, p_to: to })
  if (error) throw new Error(error.message)
}

{
  const { error } = await insertEvent(sam, samParcel.id, 'warehouse', 'drv_demo')
  await advance(sam, samParcel.id, 'at_warehouse')
  const { data } = await admin.from('parcels').select('status').eq('id', samParcel.id).single()
  check('B6a warehouse scan advances status to at_warehouse', !error && data.status === 'at_warehouse')
}
{
  await insertEvent(sam, samParcel.id, 'collection', 'drv_demo')
  await advance(sam, samParcel.id, 'collected')
  const { data } = await admin.from('parcels').select('status').eq('id', samParcel.id).single()
  check('B6b late collection scan cannot regress status', data.status === 'at_warehouse')
}
{
  const { error } = await insertEvent(sam, samParcel.id, 'collection', 'drv_priya')
  check("B7a sam cannot stamp another driver's id on events", !!error)
}
{
  // Tightened policy: the parcel must be ON sam's route, not just his driver_id
  const { error } = await insertEvent(sam, priyaParcel.id, 'collection', 'drv_demo')
  check("B7b sam cannot record events against another route's parcel", !!error)
}
{
  const { data: samEvents } = await sam.from('parcel_events').select('id')
  const { data: priyaEvents } = await priya.from('parcel_events').select('id')
  check("B8 priya cannot read sam's events", (samEvents ?? []).length > 0 && (priyaEvents ?? []).length === 0)
}

// ── B9-B12: POD sync idempotency + attempts model ──────────────────────────
console.log('— POD sync + attempts —')

// Mirrors uploadPod's server writes (record upsert → photos upsert →
// derived-count attempts), so the data-model properties are tested with the
// exact same statements the app issues.
async function uploadFailedPod(client, podId, parcelId, reason) {
  const { data: rec, error } = await client
    .from('pod_records')
    .upsert(
      {
        id: podId,
        parcel_id: parcelId,
        tracking_scanned: 'TEST',
        status: 'failed',
        failure_reason: reason,
        captured_at: new Date().toISOString(),
        location: POINT,
        gps_accuracy_m: 9,
        gps_simulated: false,
        gps_source: 'device',
        driver_id: 'drv_demo',
      },
      { onConflict: 'id' },
    )
    .select('synced_at')
    .single()
  if (error) throw new Error(error.message)
  // Same call the app makes: the atomic derived-count RPC
  const { error: attErr } = await client.rpc('apply_failed_attempt', {
    p_id: parcelId,
    p_reason: reason,
    p_max: 3,
  })
  if (attErr) throw new Error(attErr.message)
  return rec.synced_at
}

const pod1 = randomUUID()

{
  const t1 = await uploadFailedPod(sam, pod1, failTarget.id, 'No access')
  await new Promise((r) => setTimeout(r, 1100))
  const t2 = await uploadFailedPod(sam, pod1, failTarget.id, 'No access') // RETRY of same pod
  const { data: p } = await admin.from('parcels').select('attempts,status').eq('id', failTarget.id).single()
  check('B9 synced_at unchanged on retry (trust boundary)', t1 === t2, `${t1} vs ${t2}`)
  check('B10 retry of the same failed pod does not double-count attempts', p.attempts === 1, `attempts=${p.attempts}`)
}
{
  await uploadFailedPod(sam, randomUUID(), failTarget.id, 'Refused')
  const { data: p2 } = await admin.from('parcels').select('attempts,status').eq('id', failTarget.id).single()
  check('B11a second distinct attempt counts', p2.attempts === 2 && p2.status !== 'returned', `attempts=${p2.attempts}`)
  await uploadFailedPod(sam, randomUUID(), failTarget.id, 'Address not found')
  const { data: p3 } = await admin.from('parcels').select('attempts,status,completed_at').eq('id', failTarget.id).single()
  check('B11b third attempt goes terminal: returned + completed_at', p3.attempts === 3 && p3.status === 'returned' && p3.completed_at != null)
}
{
  const { error } = await sam.from('pod_records').insert({
    id: randomUUID(),
    parcel_id: failTarget.id,
    tracking_scanned: 'TEST',
    status: 'failed',
    failure_reason: null, // must be rejected by the DB check
    captured_at: new Date().toISOString(),
    driver_id: 'drv_demo',
  })
  check('B12 failed POD without a reason is rejected by the DB', !!error)
}

// ── B13-B15: photos + storage ───────────────────────────────────────────────
console.log('— photos + storage —')

{
  const photoRow = {
    pod_id: pod1,
    photo_type: 'label',
    storage_path: `${pod1}/label.jpg`,
    orig_kb: 100,
    compressed_kb: 50,
  }
  await sam.from('pod_photos').upsert([photoRow], { onConflict: 'pod_id,photo_type', ignoreDuplicates: true })
  await sam.from('pod_photos').upsert([photoRow], { onConflict: 'pod_id,photo_type', ignoreDuplicates: true })
  const { data } = await admin.from('pod_photos').select('id').eq('pod_id', pod1)
  check('B13 (pod_id, photo_type) stays unique across retries', (data ?? []).length === 1)
}
{
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3])], { type: 'image/jpeg' })
  const { error: upErr } = await sam.storage.from('pod-evidence').upload(`${pod1}/label.jpg`, blob, { upsert: true })
  const { error: anonErr } = await anon.storage.from('pod-evidence').upload(`anon-${Date.now()}.jpg`, blob)
  check('B14 driver can upload evidence; anonymous cannot', !upErr && !!anonErr, upErr?.message ?? '')
  const { data: signed } = await admin.storage.from('pod-evidence').createSignedUrls([`${pod1}/label.jpg`], 60)
  const url = signed?.[0]?.signedUrl
  const res = url ? await fetch(url) : { ok: false }
  check('B15 admin signed URL serves the object', !!url && res.ok)
}

// ── B16: delivered pipeline writes the lifecycle event ──────────────────────
console.log('— delivered event —')
{
  const podId = randomUUID()
  const target = samParcel
  await sam.from('pod_records').upsert(
    {
      id: podId, parcel_id: target.id, tracking_scanned: 'TEST', status: 'delivered',
      captured_at: new Date().toISOString(), location: POINT, gps_accuracy_m: 9,
      gps_simulated: false, gps_source: 'device', driver_id: 'drv_demo',
    },
    { onConflict: 'id' },
  )
  await sam.from('parcel_events').upsert(
    {
      id: podId, parcel_id: target.id, tracking_scanned: 'TEST', stage: 'delivered',
      captured_at: new Date().toISOString(), location: POINT, gps_accuracy_m: 9,
      gps_source: 'device', driver_id: 'drv_demo',
    },
    { onConflict: 'id' },
  )
  await sam.from('parcels').update({ status: 'delivered', completed_at: new Date().toISOString() }).eq('id', target.id)
  const { data: ev } = await admin.from('parcel_events').select('stage').eq('parcel_id', target.id).order('created_at')
  const stages = (ev ?? []).map((e) => e.stage)
  const { data: p } = await admin.from('parcels').select('status').eq('id', target.id).single()
  check('B16 timeline holds warehouse+collection+delivered; parcel delivered',
    stages.includes('warehouse') && stages.includes('collection') && stages.includes('delivered') && p.status === 'delivered',
    stages.join(','))
}

// ── teardown: remove everything the suite created (service role bypasses
// RLS — pod_records/parcel_events have no delete policies by design;
// pod_photos cascade from their pod_records) ─────────────────────────────────
{
  const ids = [samParcel.id, failTarget.id, priyaParcel.id]
  await svc.storage.from('pod-evidence').remove([`${pod1}/label.jpg`])
  await svc.from('pod_records').delete().in('parcel_id', ids)
  await svc.from('parcel_events').delete().in('parcel_id', ids)
  const { error: delErr } = await svc.from('parcels').delete().in('id', ids)
  check('teardown: fixture parcels removed', !delErr, delErr?.message)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
