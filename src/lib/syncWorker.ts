import { db } from './db'
import { uploadPod } from './pod'
import { emitSync } from './syncEvents'

/** §8 sync worker: drains the queue oldest-first. Triggered on app load, on
 *  `online` events, on a short interval, and right after each capture. */

/** After this many failed upload attempts an item is "stuck": skipped by
 *  automatic passes so it can never jam the queue behind it. A manual sync
 *  (tapping the badge) retries stuck items too. */
export const MAX_AUTO_ATTEMPTS = 5

let syncing = false

export function isSyncing(): boolean {
  return syncing
}

export async function syncNow(opts: { includeStuck?: boolean } = {}): Promise<void> {
  // Single-flight: the triggers overlap freely (load + interval + online),
  // only one pass runs at a time.
  if (syncing || !navigator.onLine) return

  const queued = (await db.pods.where('synced').equals(0).sortBy('queuedAt')).filter(
    (pod) => opts.includeStuck || pod.attempts < MAX_AUTO_ATTEMPTS,
  )
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
        // If the network just died, stop the pass — everything would fail.
        // Otherwise carry on: one rejected record (a "poison" item) must
        // never block the captures queued behind it.
        if (!navigator.onLine) break
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
  // Ask the browser not to evict the queue under storage pressure — silently
  // best-effort (Chrome grants it for installed/engaged PWAs).
  void navigator.storage?.persist?.().catch(() => {})

  window.addEventListener('online', () => void syncNow())
  window.setInterval(() => void syncNow(), SYNC_INTERVAL_MS)
  void syncNow() // app load
}
