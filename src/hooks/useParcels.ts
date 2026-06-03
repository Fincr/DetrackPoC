import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../lib/db'
import { supabase } from '../lib/supabase'
import type { Parcel } from '../lib/types'

/** Today's stops with a read-through Dexie cache: cached rows render
 *  immediately (so a cold start with no signal still shows the run sheet),
 *  then every successful server fetch replaces both state and cache. */
export function useParcels() {
  const [parcels, setParcels] = useState<Parcel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasData = useRef(false)

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('parcels')
      .select('*')
      // Oldest due first → rollovers lead the run, then today's stops
      .order('due_date', { ascending: true })
      .order('tracking_number')
    if (error) {
      // Offline-friendly: keep showing stale stops if we already have data —
      // the local queue, not this list, is the truth for what was captured
      if (!hasData.current) setError(error.message)
      return
    }
    hasData.current = true
    setParcels(data as Parcel[])
    setError(null)
    // Refresh the offline cache (server is the source of truth)
    await db.transaction('rw', db.parcels, async () => {
      await db.parcels.clear()
      await db.parcels.bulkAdd(data as Parcel[])
    }).catch(() => {}) // cache failures must never break the live list
  }, [])

  useEffect(() => {
    let live = true
    // Serve the cache first…
    void db.parcels.toArray().then((cached) => {
      if (live && cached.length && !hasData.current) {
        cached.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.tracking_number.localeCompare(b.tracking_number))
        setParcels(cached)
        hasData.current = true // cached data beats an error banner
      }
    })
    // …then the network
    void reload()
    return () => {
      live = false
    }
  }, [reload])

  return { parcels, error, reload }
}
