import { parseEwkbPoint } from './geo'
import type { PodStatus } from './types'

/** Tracking export: emit captured PODs as a carrier tracking-event feed, in the
 *  Evri sample's shape — a `#Provider=Evri` line, then the CSV columns
 *  TrackingNumber,EventCode,EventDescription,EventDateTime,Latitude,Longitude,
 *  Location,AdditionalInfo. The ePOD data maps onto this almost 1:1. */

/** The POD fields the export needs, flattened with a little parcel context. */
export interface TrackingPod {
  parcel_tracking: string | null
  tracking_scanned: string
  status: PodStatus
  failure_reason: string | null
  received_by: string | null
  captured_at: string
  /** EWKB hex from PostgREST (or null when the capture had no fix) */
  location: unknown
  area: string | null
  postcode: string | null
  /** Set for a capture against a site (store/depot) with no parcel — used for
   *  the Location column and so the row isn't anonymous. */
  siteName?: string | null
  sitePostcode?: string | null
}

/** A collection/warehouse lifecycle scan, flattened with parcel context.
 *  (The delivered stage is exported via its POD row, not duplicated here.) */
export interface TrackingScan {
  parcel_tracking: string | null
  tracking_scanned: string
  stage: 'collection' | 'warehouse'
  captured_at: string
  /** EWKB hex from PostgREST (or null when the scan had no fix) */
  location: unknown
  area: string | null
  postcode: string | null
}

/** Outcome → carrier event. Placeholder Evri-style codes — swap for the real
 *  code list when integrating with a specific carrier. */
const EVENT: Record<PodStatus, { code: string; description: string }> = {
  delivered: { code: 'Evri_DEL', description: 'Delivered' },
  failed: { code: 'Evri_ATT', description: 'Delivery attempted' },
}
const SCAN_EVENT: Record<TrackingScan['stage'], { code: string; description: string }> = {
  collection: { code: 'Evri_COL', description: 'Collected from sender' },
  warehouse: { code: 'Evri_HUB', description: 'Arrived at depot' },
}

const HEADERS = [
  'TrackingNumber',
  'EventCode',
  'EventDescription',
  'EventDateTime',
  'Latitude',
  'Longitude',
  'Location',
  'AdditionalInfo',
] as const

/** RFC-4180-ish: quote a field if it contains a comma, quote or newline. */
function csvField(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** captured_at (ISO w/ tz) → "YYYY-MM-DDTHH:mm:ss" in local wall-clock time,
 *  matching the sample (no milliseconds, no timezone suffix). */
function eventDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

export function buildTrackingCsv(
  pods: TrackingPod[],
  scans: TrackingScan[] = [],
  provider = 'Evri',
): string {
  // PODs (delivered/attempted) and lifecycle scans (collected/at depot) merge
  // into one chronological feed — the full journey per parcel.
  const rows = [
    ...pods.map((pod) => {
      const ev = EVENT[pod.status]
      return {
        at: pod.captured_at,
        tracking: pod.parcel_tracking ?? pod.tracking_scanned,
        code: ev.code,
        description: ev.description,
        location: pod.location,
        place: pod.postcode || pod.area || pod.sitePostcode || pod.siteName || '',
        info: (pod.status === 'delivered' ? pod.received_by : pod.failure_reason) ?? '',
      }
    }),
    ...scans.map((scan) => {
      const ev = SCAN_EVENT[scan.stage]
      return {
        at: scan.captured_at,
        tracking: scan.parcel_tracking ?? scan.tracking_scanned,
        code: ev.code,
        description: ev.description,
        location: scan.location,
        place: scan.postcode || scan.area || '',
        info: '',
      }
    }),
  ].sort((a, b) => a.at.localeCompare(b.at))

  const lines = [`#Provider=${provider}`, HEADERS.join(',')]
  for (const row of rows) {
    const pt = parseEwkbPoint(row.location)
    lines.push(
      [
        row.tracking,
        row.code,
        row.description,
        eventDateTime(row.at),
        pt ? pt.lat.toFixed(5) : '',
        pt ? pt.lng.toFixed(5) : '',
        row.place,
        row.info,
      ]
        .map(csvField)
        .join(','),
    )
  }
  // Trailing newline so the file ends cleanly.
  return lines.join('\r\n') + '\r\n'
}

/** Trigger a browser download of a generated CSV. */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
