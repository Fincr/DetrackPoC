// One-off: unallocate every parcel on a driver's route(s), as the admin user.
//   node scripts/unallocate-driver.mjs <SUPABASE_URL> <ANON_KEY> <driver_id>
import { createClient } from '@supabase/supabase-js'

const [url, anonKey, driverId = 'drv_demo'] = process.argv.slice(2)
const supabase = createClient(url, anonKey, { auth: { persistSession: false } })
const { error: authErr } = await supabase.auth.signInWithPassword({
  email: 'admin@citipost.test',
  password: 'citipost',
})
if (authErr) {
  console.error('admin sign-in failed:', authErr.message)
  process.exit(1)
}

const { data: routes } = await supabase.from('routes').select('id,name').eq('driver_id', driverId)
const routeIds = (routes ?? []).map((r) => r.id)
console.log(`routes for ${driverId}: ${(routes ?? []).map((r) => r.name).join(', ') || 'none'}`)

const { data: before } = await supabase
  .from('parcels')
  .select('tracking_number,status')
  .in('route_id', routeIds)
console.log(`parcels on the run: ${(before ?? []).length}`)

const { error } = await supabase.from('parcels').update({ route_id: null }).in('route_id', routeIds)
if (error) {
  console.error('unallocate failed:', error.message)
  process.exit(1)
}
for (const p of before ?? []) console.log(`  unallocated ${p.tracking_number} (${p.status})`)
console.log('done')
