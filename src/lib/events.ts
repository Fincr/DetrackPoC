import { db, type QueuedEvent } from './db'
import { supabase } from './supabase'
import { emitSync } from './syncEvents'
import {
  STAGE_STATUS,
  STATUS_RANK,
  type Fix,
  type Parcel,
  type ParcelStatus,
  type Stage,
} from './types'

/** Everything a quick stage scan captures (collection / warehouse). */
export interface StageScan {
  parcel: Parcel
  trackingScanned: string
  stage: Stage
  capturedAt: Date
  location: Fix | null
  driverId: string
}

/**
 * Local-first, like queuePod: the scan lands in IndexedDB and returns
 * immediately — nothing blocks on the network. The sync worker uploads it
 * when the network allows.
 */
export async function queueEvent(scan: StageScan): Promise<QueuedEvent> {
  const event: QueuedEvent = {
    eventId: crypto.randomUUID(),
    parcelId: scan.parcel.id,
    parcelRef: scan.parcel.tracking_number,
    trackingScanned: scan.trackingScanned,
    stage: scan.stage,
    capturedAt: scan.capturedAt.toISOString(),
    location: scan.location,
    driverId: scan.driverId,
    synced: 0,
    syncedAt: null,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  }
  await db.events.add(event)
  emitSync()
  return event
}

/**
 * Push one queued stage event to Supabase. Idempotent on the client UUID
 * (upsert onConflict id) — a retry never duplicates. synced_at is omitted so
 * the DB default stamps the server receive time, untouched on retry.
 */
export async function uploadEvent(event: QueuedEvent): Promise<string | null> {
  const { data: record, error } = await supabase
    .from('parcel_events')
    .upsert(
      {
        id: event.eventId,
        parcel_id: event.parcelId,
        tracking_scanned: event.trackingScanned,
        stage: event.stage,
        captured_at: event.capturedAt,
        location: event.location ? `POINT(${event.location.lng} ${event.location.lat})` : null,
        gps_accuracy_m: event.location?.accuracyM ?? null,
        gps_source: event.location?.source ?? null, // null = no fix at the scan
        driver_id: event.driverId,
      },
      { onConflict: 'id' },
    )
    .select('synced_at')
    .single()
  if (error) throw new Error(`stage event insert failed: ${error.message}`)

  await advanceParcelStatus(event.parcelId, STAGE_STATUS[event.stage])

  return (record as { synced_at: string | null } | null)?.synced_at ?? null
}

/**
 * Move parcels.status FORWARD only. Events are recorded as scanned even out
 * of order (warn-but-allow), but the status — what every screen shows — can
 * never regress: a late-syncing collection scan leaves a delivered parcel
 * delivered. Read-modify-write is acceptable for this PoC (same pattern as
 * the attempts counter); production would use an RPC.
 */
export async function advanceParcelStatus(parcelId: string, to: ParcelStatus): Promise<void> {
  const { data } = await supabase.from('parcels').select('status').eq('id', parcelId).single()
  const current = (data as { status: ParcelStatus } | null)?.status
  if (!current || STATUS_RANK[to] <= STATUS_RANK[current]) return
  await supabase.from('parcels').update({ status: to }).eq('id', parcelId)
}
