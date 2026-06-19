// Pure-function tests for two-dimensional allocation. node scripts/test-allocate.mjs
import { matchRoute, unallocatedReason } from '../src/lib/allocate.ts'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`) }

const routes = [
  { id: 'r1', name: 'Alpha', driver_id: null, collection_areas: ['DY'], delivery_areas: ['EH', 'G'] },
  { id: 'r2', name: 'Bravo', driver_id: null, collection_areas: ['NN'], delivery_areas: ['B'] },
]

check('both-in → matched', matchRoute({ collection_area: 'DY', delivery_area: 'EH' }, routes)?.id === 'r1')
check('delivery not in set → no match', matchRoute({ collection_area: 'DY', delivery_area: 'B' }, routes) === null)
check('collection not in set → no match', matchRoute({ collection_area: 'NN', delivery_area: 'EH' }, routes) === null)
check('overlap → first route by name', matchRoute({ collection_area: 'DY', delivery_area: 'EH' },
  [{ id: 'rZ', name: 'Zeta', driver_id: null, collection_areas: ['DY'], delivery_areas: ['EH'] }, ...routes])?.name === 'Alpha')
check('matched → no reason', unallocatedReason({ collection_area: 'DY', delivery_area: 'EH' }, routes) === null)
check('collection missing → says so', unallocatedReason({ collection_area: 'ZZ', delivery_area: 'EH' }, routes) === 'No route collects ZZ')
check('delivery missing → says so', unallocatedReason({ collection_area: 'DY', delivery_area: 'ZZ' }, routes) === 'No route delivers ZZ')
check('both on different routes → not-together', unallocatedReason({ collection_area: 'NN', delivery_area: 'EH' }, routes) === "NN and EH aren't on the same route")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
