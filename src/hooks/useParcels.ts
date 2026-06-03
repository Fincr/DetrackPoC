import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Parcel } from '../lib/types'

/** Today's stops, ordered like the seed. Exposes reload so screens can refresh
 *  after a delivery completes. */
export function useParcels() {
  const [parcels, setParcels] = useState<Parcel[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('parcels')
      .select('*')
      .order('tracking_number')
    if (error) setError(error.message)
    else {
      setParcels(data as Parcel[])
      setError(null)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { parcels, error, reload }
}
