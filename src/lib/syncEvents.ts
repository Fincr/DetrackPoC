/** Tiny event hub so UI hooks re-query the queue whenever it changes —
 *  kept dependency-free (and import-cycle-free between pod.ts/syncWorker.ts). */
type Listener = () => void

const listeners = new Set<Listener>()

export function subscribeSync(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitSync(): void {
  for (const fn of listeners) fn()
}
