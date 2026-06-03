import { db } from './db'
import { uploadPod } from './pod'
import { emitSync } from './syncEvents'

/** §8 sync worker: drains the queue oldest-first. Triggered on app load, on
 *  `online` events, on a short interval, and right after each capture. */

let syncing = false

export function isSyncing(): boolean {
  return syncing
}

export async function syncNow(): Promise<void> {
  // Single-flight: the triggers overlap freely (load + interval + online),
  // only one pass runs at a time.
  if (syncing || !navigator.onLine) return

  const queued = await db.pods.where('synced').equals(0).sortBy('queuedAt')
  if (!queued.length) return

  syncing = true
  emitSync()
  try {
    for (const pod of queued) {
      try {
        const syncedAt = await uploadPod(pod)
        // Flip the flag, keep the item — the UI shows synced history (§8)
        await db.pods.update(pod.podId, {
          synced: 1,
          syncedAt: syncedAt ?? new Date().toISOString(),
          lastError: null,
        })
      } catch (e) {
        await db.pods.update(pod.podId, {
          attempts: pod.attempts + 1,
          lastError: e instanceof Error ? e.message : String(e),
        })
        // Most failures here mean the network just dropped — stop this pass,
        // the next trigger retries idempotently from the same item.
        break
      } finally {
        emitSync() // the queued counter visibly drains item by item
      }
    }
  } finally {
    syncing = false
    emitSync()
  }
}

const SYNC_INTERVAL_MS = 8_000

/** Install the §8 triggers. Called once from main.tsx. */
export function startSyncTriggers(): void {
  window.addEventListener('online', () => void syncNow())
  window.setInterval(() => void syncNow(), SYNC_INTERVAL_MS)
  void syncNow() // app load
}
