// One-shot check: insert a known POINT, read back the EWKB hex PostgREST
// returns, and parse it with the same offsets as src/lib/geo.ts.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const id = crypto.randomUUID()
const ins = await supabase.from('pod_records').insert({
  id,
  tracking_scanned: 'EWKB-TEST',
  status: 'delivered',
  captured_at: new Date().toISOString(),
  location: 'POINT(0.177 51.484)',
  gps_accuracy_m: 35,
  gps_simulated: true,
})
if (ins.error) {
  console.error('insert failed:', ins.error.message)
  process.exit(1)
}

const { data } = await supabase.from('pod_records').select('location').eq('id', id).single()
const hex = data.location
console.log('EWKB hex:', hex)

const readDouble = (off) => {
  const dv = new DataView(new ArrayBuffer(8))
  for (let i = 0; i < 8; i++) dv.setUint8(i, parseInt(hex.slice(off + i * 2, off + i * 2 + 2), 16))
  return dv.getFloat64(0, true)
}
const lng = readDouble(18)
const lat = readDouble(34)
console.log('parsed lng:', lng, 'lat:', lat)

await supabase.from('pod_records').delete().eq('id', id)
const ok = Math.abs(lng - 0.177) < 1e-9 && Math.abs(lat - 51.484) < 1e-9
console.log(ok ? '✓ parser offsets correct' : '✗ MISMATCH')
process.exit(ok ? 0 : 1)
