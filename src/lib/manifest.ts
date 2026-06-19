/** This file is imported by Node.js test scripts and by src/lib/enrich.ts.
 *  Parcels enter ePOD via tracking-number enrichment (see enrich.ts /
 *  JobsScreen EnrichCard) — there is no spreadsheet importer. */
import type { Area } from './types.ts'

export interface ParcelInput {
  tracking_number: string
  recipient_name: string
  address_line: string
  postcode: string | null
  area: Area
  /** Raw source row, stashed verbatim into the jsonb column. */
  meta: Record<string, string | null>
}
