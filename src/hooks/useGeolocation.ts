import { useCallback, useEffect, useRef, useState } from 'react'
import type { Fix } from '../lib/types'

/** Why a device fix couldn't be acquired (drives the "simulated" hint in the
 *  capture UI so a blocked permission isn't silently invisible). */
export type SimReason = 'insecure' | 'denied' | 'unavailable' | 'timeout'

/** Demo fallback (Erith, like the reference) used when the fix is denied,
 *  times out, or geolocation is unavailable (e.g. plain-HTTP LAN access).
 *  The 'simulated' source keeps trusted and untrusted reads distinguishable (§5). */
const FALLBACK: Fix = { lat: 51.484, lng: 0.177, accuracyM: 35, source: 'simulated' }

interface Acquired {
  fix: Fix
  /** null when `fix` is a real device read */
  reason: SimReason | null
}

function acquire(opts: PositionOptions): Promise<Acquired> {
  return new Promise((resolve) => {
    // Browsers only expose real geolocation in secure contexts — a phone
    // hitting the dev server over plain-HTTP LAN lands here. `npm run
    // dev:https` is the fix for that case.
    if (!window.isSecureContext || !('geolocation' in navigator)) {
      resolve({ fix: FALLBACK, reason: 'insecure' })
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          fix: {
            lat: +p.coords.latitude.toFixed(5),
            lng: +p.coords.longitude.toFixed(5),
            accuracyM: Math.round(p.coords.accuracy),
            source: 'device',
          },
          reason: null,
        }),
      (err) =>
        resolve({
          fix: FALLBACK,
          reason:
            err.code === err.PERMISSION_DENIED
              ? 'denied'
              : err.code === err.TIMEOUT
                ? 'timeout'
                : 'unavailable',
        }),
      opts,
    )
  })
}

/** Two-stage acquisition:
 *  - Mount: a warm-up read (also surfaces the permission prompt before the
 *    driver reaches the shutter). `fix` is null while it's in flight.
 *  - Shutter (`getFix`): a *fresh* read so the recorded position is where
 *    the photo was actually taken, not where the screen was opened.
 *    `maximumAge` lets the still-warm mount fix answer instantly; if the
 *    fresh read fails, a real mount-time fix still beats the simulated
 *    fallback (it can only be screen-age stale). */
export function useGeolocation() {
  const [acquired, setAcquired] = useState<Acquired | null>(null)
  const mountRef = useRef<Promise<Acquired> | null>(null)

  useEffect(() => {
    const p = acquire({ enableHighAccuracy: true, timeout: 8000, maximumAge: 0 })
    mountRef.current = p
    let live = true
    void p.then((a) => live && setAcquired(a))
    return () => {
      live = false
    }
  }, [])

  const getFix = useCallback(async (): Promise<Fix> => {
    const fresh = await acquire({ enableHighAccuracy: true, timeout: 6000, maximumAge: 15000 })
    if (fresh.reason === null) {
      setAcquired(fresh)
      return fresh.fix
    }
    const mount = await (mountRef.current ?? Promise.resolve(fresh))
    if (mount.reason === null) return mount.fix
    setAcquired(fresh) // surface the freshest failure reason in the UI
    return fresh.fix
  }, [])

  return { fix: acquired?.fix ?? null, simReason: acquired?.reason ?? null, getFix }
}
