/** The driver currently "signed in" on this device. A PoC stand-in for auth:
 *  persisted in localStorage so the chosen run survives reloads (and the PWA
 *  relaunch), and stamped onto every POD this device captures. */

const KEY = 'epod.driverId'

/** Default to the design-reference driver so a fresh device opens to the
 *  familiar run (CP-849213-GB + the rollover). */
export const DEFAULT_DRIVER_ID = 'drv_demo'

export function getDriverId(): string {
  try {
    return localStorage.getItem(KEY) ?? DEFAULT_DRIVER_ID
  } catch {
    return DEFAULT_DRIVER_ID
  }
}

export function setDriverId(id: string): void {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* private mode / storage disabled — selection just won't persist */
  }
}
