import { useEffect, useState } from 'react'
import { db, type QueuedPod } from '../lib/db'
import { subscribeSync } from '../lib/syncEvents'
import { isSyncing, MAX_AUTO_ATTEMPTS } from '../lib/syncWorker'
import type { PodStatus, Stage } from '../lib/types'

export interface SyncStatus {
  queued: number
  /** Items that exhausted their automatic retries — need a manual retry */
  stuck: number
  synced: number
  online: boolean
  syncing: boolean
  /** parcelId → outcome of its not-yet-synced capture, so the stop list can
   *  show progress even while offline */
  queuedParcels: Map<string, PodStatus>
  /** parcelId → highest not-yet-synced stage scan (collection/warehouse), so
   *  stage chips advance the moment the driver scans — even offline */
  queuedStages: Map<string, Stage>
}

/** Live view of the queue. Re-queries on every sync event and network change. */
export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>({
    queued: 0,
    stuck: 0,
    synced: 0,
    online: navigator.onLine,
    syncing: false,
    queuedParcels: new Map(),
    queuedStages: new Map(),
  })

  useEffect(() => {
    let live = true
    const refresh = async () => {
      const [unsynced, synced, unsyncedEvents, syncedEvents] = await Promise.all([
        db.pods.where('synced').equals(0).toArray(),
        db.pods.where('synced').equals(1).count(),
        db.events.where('synced').equals(0).toArray(),
        db.events.where('synced').equals(1).count(),
      ])
      if (!live) return
      const queuedParcels = new Map<string, PodStatus>()
      for (const pod of unsynced) if (pod.parcelId) queuedParcels.set(pod.parcelId, pod.status)
      const queuedStages = new Map<string, Stage>()
      for (const ev of unsyncedEvents) {
        // warehouse outranks collection if both are queued
        if (ev.stage === 'warehouse' || !queuedStages.has(ev.parcelId)) {
          queuedStages.set(ev.parcelId, ev.stage)
        }
      }
      const stuck =
        unsynced.filter((p) => p.attempts >= MAX_AUTO_ATTEMPTS).length +
        unsyncedEvents.filter((e) => e.attempts >= MAX_AUTO_ATTEMPTS).length
      setStatus({
        queued: unsynced.length + unsyncedEvents.length - stuck,
        stuck,
        synced: synced + syncedEvents,
        online: navigator.onLine,
        syncing: isSyncing(),
        queuedParcels,
        queuedStages,
      })
    }
    void refresh()
    const unsubscribe = subscribeSync(() => void refresh())
    const onNet = () => void refresh()
    window.addEventListener('online', onNet)
    window.addEventListener('offline', onNet)
    return () => {
      live = false
      unsubscribe()
      window.removeEventListener('online', onNet)
      window.removeEventListener('offline', onNet)
    }
  }, [])

  return status
}

/** Live view of a single queued pod — the confirmation screen watches its own
 *  record flip from queued to synced. */
export function useQueuedPod(podId: string): QueuedPod | null {
  const [pod, setPod] = useState<QueuedPod | null>(null)

  useEffect(() => {
    let live = true
    const refresh = async () => {
      const row = await db.pods.get(podId)
      if (live) setPod(row ?? null)
    }
    void refresh()
    return subscribeSync(() => void refresh())
  }, [podId])

  return pod
}
