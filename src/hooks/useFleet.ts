import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../lib/db'
import { supabase } from '../lib/supabase'
import type { Driver, Route } from '../lib/types'

export interface Fleet {
  routes: Route[]
  drivers: Driver[]
}

/** Drivers + routes with a read-through Dexie cache, mirroring useParcels: the
 *  cache renders immediately (so a cold offline start can still filter to a
 *  driver's run and switch driver), then every successful fetch replaces both
 *  state and cache. The dispatcher allocates against the same data. */
export function useFleet() {
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasData = useRef(false)

  const reload = useCallback(async () => {
    const [routesRes, driversRes] = await Promise.all([
      supabase.from('routes').select('*').order('name'),
      supabase.from('drivers').select('*').order('name'),
    ])
    const err = routesRes.error ?? driversRes.error
    if (err) {
      if (!hasData.current) setError(err.message)
      return
    }
    const routes = routesRes.data as Route[]
    const drivers = driversRes.data as Driver[]
    hasData.current = true
    setFleet({ routes, drivers })
    setError(null)
    // Refresh the offline cache (server is the source of truth)
    await db
      .transaction('rw', db.routes, db.drivers, async () => {
        await db.routes.clear()
        await db.routes.bulkAdd(routes)
        await db.drivers.clear()
        await db.drivers.bulkAdd(drivers)
      })
      .catch(() => {}) // cache failures must never break the live fleet
  }, [])

  useEffect(() => {
    let live = true
    // Serve the cache first…
    void Promise.all([db.routes.toArray(), db.drivers.toArray()]).then(([routes, drivers]) => {
      if (live && (routes.length || drivers.length) && !hasData.current) {
        setFleet({ routes, drivers })
        hasData.current = true
      }
    })
    // …then the network
    void reload()
    // Allocations change server-side; keep the fleet/routes fresh when they do.
    const channel = supabase
      .channel('fleet-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'routes' }, () => void reload())
      .subscribe()
    return () => {
      live = false
      void supabase.removeChannel(channel)
    }
  }, [reload])

  return { fleet, error, reload }
}
