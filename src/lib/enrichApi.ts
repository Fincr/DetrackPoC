import { supabase } from './supabase'
import type { ShipmentRow } from './enrich'

export interface EnrichResult {
  found: ShipmentRow[]
  notFound: string[]
  counts: { submitted: number; found: number; notFound: number }
}

/** Call the enrich-shipments Edge Function. functions.invoke attaches the
 *  caller's JWT; the function enforces admin-only. Throws with the function's
 *  own error message. */
export async function enrichShipments(trackingNumbers: string[]): Promise<EnrichResult> {
  const { data, error } = await supabase.functions.invoke('enrich-shipments', {
    body: { tracking_numbers: trackingNumbers },
  })
  if (error) {
    const ctx = (error as { context?: unknown }).context
    if (ctx instanceof Response) {
      try {
        const b = await ctx.clone().json()
        if (b && typeof b === 'object' && 'error' in b) throw new Error(String(b.error))
      } catch { /* not JSON */ }
    }
    throw new Error(error instanceof Error ? error.message : 'Enrichment failed')
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error(String((data as { error: string }).error))
  }
  return (data as { data: EnrichResult }).data
}
