import type { Parcel, Route } from './types'

type Areas = Pick<Parcel, 'collection_area' | 'delivery_area'>

/** A parcel matches route R when its collection_area ∈ R.collection_areas AND its
 *  delivery_area ∈ R.delivery_areas. On overlap, first route by name wins
 *  (deterministic); dispatchers keep a day's sets non-overlapping. */
export function matchRoute<R extends Route>(p: Areas, routes: R[]): R | null {
  const hits = routes.filter(
    (r) => r.collection_areas.includes(p.collection_area) && r.delivery_areas.includes(p.delivery_area),
  )
  return hits.length ? [...hits].sort((a, b) => a.name.localeCompare(b.name))[0] : null
}

/** Why a parcel didn't auto-allocate — which side has no home (two-part hint). */
export function unallocatedReason(p: Areas, routes: Route[]): string | null {
  if (matchRoute(p, routes)) return null
  const coll = routes.some((r) => r.collection_areas.includes(p.collection_area))
  const deliv = routes.some((r) => r.delivery_areas.includes(p.delivery_area))
  const c = p.collection_area || '?'
  const d = p.delivery_area || '?'
  if (!coll && !deliv) return `No route covers ${c} → ${d}`
  if (!coll) return `No route collects ${c}`
  if (!deliv) return `No route delivers ${d}`
  return `${c} and ${d} aren't on the same route`
}
