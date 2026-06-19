import type { Area } from './types.ts'
import type { ParcelInput } from './manifest.ts'

/** The shipment columns the enrich-shipments Edge Function returns (a subset of
 *  Lens's public.shipments — only what we need to build a parcel). */
export interface ShipmentRow {
  tracking_number: string
  recipient_full_name: string | null
  recipient_company: string | null
  recipient_address1: string | null
  recipient_address2: string | null
  recipient_address3: string | null
  recipient_city: string | null
  recipient_county: string | null
  recipient_postcode: string | null
  sender_company: string | null
  sender_address1: string | null
  sender_address2: string | null
  sender_address3: string | null
  sender_city: string | null
  sender_county: string | null
  sender_postcode: string | null
}

/** GWOptical splits the address across several columns; ePOD stores one line.
 *  Join the non-empty parts in postal order. */
export function composeAddressLine(row: ShipmentRow): string {
  return [
    row.recipient_address1, row.recipient_address2, row.recipient_address3,
    row.recipient_city, row.recipient_county,
  ]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ')
}

/** Prefer a person's name, then the company, then a clear placeholder. */
export function composeRecipient(row: ShipmentRow): string {
  return (row.recipient_full_name ?? '').trim()
    || (row.recipient_company ?? '').trim()
    || '(no name)'
}

/** UK postcode → area = the outward letter prefix, upper-cased. "SL4 1DE" → "SL",
 *  "B2 4RQ" → "B". Blank / unparseable → "" (the dispatcher's unknown bucket).
 *  The leading letters ARE the postcode area; we never strip 2→1 (WA≠W, NE≠N). */
export function postcodeArea(postcode: string | null | undefined): Area {
  const pc = (postcode ?? '').trim().toUpperCase()
  return (pc.match(/^[A-Z]{1,2}/) ?? [''])[0]
}

/** GWOptical splits the sender address across columns; join the non-empty parts. */
export function composeSenderAddress(row: ShipmentRow): string {
  return [row.sender_address1, row.sender_address2, row.sender_address3, row.sender_city, row.sender_county]
    .map((p) => (p ?? '').trim()).filter(Boolean).join(', ')
}

/** Friendly shop name: Sender_Company, else the collection_points lookup by
 *  postcode, else null (the address still renders). `names` is postcode→name. */
export function senderName(row: ShipmentRow, names?: Record<string, string>): string | null {
  const company = (row.sender_company ?? '').trim()
  if (company) return company
  const pc = (row.sender_postcode ?? '').trim()
  return names && pc && names[pc] ? names[pc] : null
}

/** A matched shipment row → the ParcelInput the importer/commit path expects.
 *  The raw row is stashed in meta for traceability. */
export function shipmentToParcelInput(row: ShipmentRow, names?: Record<string, string>): ParcelInput {
  return {
    tracking_number: row.tracking_number,
    recipient_name: composeRecipient(row),
    address_line: composeAddressLine(row),
    postcode: (row.recipient_postcode ?? '').trim() || null,
    delivery_area: postcodeArea(row.recipient_postcode),
    sender_name: senderName(row, names),
    sender_address_line: composeSenderAddress(row) || null,
    sender_postcode: (row.sender_postcode ?? '').trim() || null,
    collection_area: postcodeArea(row.sender_postcode),
    meta: { ...(row as unknown as Record<string, string | null>) },
  }
}
