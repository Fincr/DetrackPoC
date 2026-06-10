/**
 * PodCaptureScreen — Proof-of-Delivery capture for a courier PWA, in one file.
 *
 * A professional, responsive web-app screen:
 *  - laptop: full-width console — top app bar, two-column card grid
 *    (shipment + photo evidence left; signature + completion rail right,
 *    sticky while the page scrolls)
 *  - mobile: the same cards stacked, with a fixed bottom action bar sized
 *    for one-handed (gloved) use — every target ≥ 48px
 *
 * Drop-in: React + Tailwind utility classes only. The palette (deep navy
 * #0a1f44 family, gold, neutral workspace) rides on arbitrary values, so no
 * tailwind.config entries or UI libraries are required. `font-serif`
 * resolves to Georgia on Tailwind's default stack.
 *
 * Capture rules carried over from the ePOD architecture:
 *  - GPS is real-or-nothing: no fix → red notice with Retry, and the payload
 *    records null — never a fabricated coordinate. The fix shown (and stored)
 *    is the one burned into the photo, so the record always matches the image.
 *  - Confirm never blocks on the network: offline, the typed payload is
 *    handed to onConfirm flagged `queuedOffline` and the screen plays the
 *    queued → syncing → done lifecycle as connectivity returns. The sync
 *    animation is presentational — persistence and upload belong to the
 *    consumer's offline queue.
 *
 * Usage: <PodCaptureScreen shipmentRef="WB-204711-GB" onConfirm={queueIt} />
 */
import { useCallback, useEffect, useRef, useState } from 'react'

// ── Public types ────────────────────────────────────────────────────────────

export interface GpsFix {
  lat: number
  lng: number
  /** reported accuracy radius, metres */
  accuracyM: number
}

/** The full evidence bundle handed to onConfirm. */
export interface PodPayload {
  shipmentRef: string
  /** tracking value scanned (or typed) off the label */
  barcode: string
  recipientName: string
  /** stamped JPEG — GPS + timestamp burned into the bottom-left corner */
  photo: Blob
  /** transparent PNG exported from the signature pad */
  signature: Blob
  /** the fix burned into the photo; null = no fix at the shutter */
  gps: GpsFix | null
  /** ISO-8601, device clock at the shutter — the evidence time */
  capturedAt: string
  /** true when confirmed with no connectivity — the consumer must queue it */
  queuedOffline: boolean
}

export type ConnectionState = 'online' | 'offline' | 'syncing'

// ── Internal types ──────────────────────────────────────────────────────────

type GpsState = { status: 'acquiring' } | { status: 'fix'; fix: GpsFix } | { status: 'none' }

type Phase = 'editing' | 'queued' | 'syncing' | 'done'

interface StampedPhoto {
  blob: Blob
  url: string
  /** the fix that was burned into the image (null = stamped "NO GPS FIX") */
  fix: GpsFix | null
  takenAt: Date
}

interface SignatureApi {
  toBlob(): Promise<Blob | null>
  clear(): void
}

// ── Hooks ───────────────────────────────────────────────────────────────────

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

/** One-shot high-accuracy fix on mount, with a manual retry. Real-or-nothing:
 *  a denied/timed-out read resolves to 'none' — never a fallback coordinate. */
function useGps() {
  const [gpsState, setGpsState] = useState<GpsState>({ status: 'acquiring' })

  const retryGps = useCallback(() => {
    // Geolocation only exists in secure contexts (HTTPS / localhost)
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      setGpsState({ status: 'none' })
      return
    }
    setGpsState({ status: 'acquiring' })
    navigator.geolocation.getCurrentPosition(
      (p) =>
        setGpsState({
          status: 'fix',
          fix: {
            lat: +p.coords.latitude.toFixed(5),
            lng: +p.coords.longitude.toFixed(5),
            accuracyM: Math.round(p.coords.accuracy),
          },
        }),
      () => setGpsState({ status: 'none' }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    )
  }, [])

  useEffect(() => {
    retryGps()
  }, [retryGps])

  return { gpsState, retryGps }
}

// ── Photo stamping ──────────────────────────────────────────────────────────

const MAX_EDGE = 1280
const JPEG_QUALITY = 0.74

/** Draw the photo to canvas (longest edge capped), burn a navy evidence
 *  plate into the bottom-left corner — gold timestamp line, then coords or
 *  an honest "NO GPS FIX RECORDED" — and export as JPEG. */
async function stampPhoto(
  file: File,
  fix: GpsFix | null,
  takenAt: Date,
): Promise<{ blob: Blob; url: string }> {
  let img: ImageBitmap | HTMLImageElement
  try {
    img = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('could not decode the photo'))
      el.src = URL.createObjectURL(file)
    })
  }

  let w = img.width
  let h = img.height
  if (Math.max(w, h) > MAX_EDGE) {
    const s = MAX_EDGE / Math.max(w, h)
    w = Math.round(w * s)
    h = Math.round(h * s)
  }

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  if ('close' in img) img.close()

  const fs = Math.max(11, Math.round(w * 0.021))
  ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
  const lineTime = takenAt.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const lineLoc = fix
    ? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}  ±${fix.accuracyM}m`
    : 'NO GPS FIX RECORDED'

  const padX = Math.round(fs * 0.9)
  const padY = Math.round(fs * 0.7)
  const gap = Math.round(fs * 0.45)
  const textW = Math.max(ctx.measureText(lineTime).width, ctx.measureText(lineLoc).width)
  const plateW = textW + padX * 2
  const plateH = fs * 2 + gap + padY * 2
  const margin = Math.round(w * 0.02)
  const x = margin
  const y = h - margin - plateH

  ctx.fillStyle = 'rgba(10,31,68,0.85)'
  // typeof guard (not `in`) — older Safari lacks roundRect at runtime
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(x, y, plateW, plateH, fs * 0.6)
    ctx.fill()
  } else {
    ctx.fillRect(x, y, plateW, plateH)
  }
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#e0c178' // gold timestamp — the brand mark of the stamp
  ctx.fillText(lineTime, x + padX, y + padY)
  ctx.fillStyle = fix ? '#f1f3f7' : '#ff9d87' // missing fix reads warm-red
  ctx.fillText(lineLoc, x + padX, y + padY + fs + gap)

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))),
      'image/jpeg',
      JPEG_QUALITY,
    ),
  )
  return { blob, url: URL.createObjectURL(blob) }
}

// ── Component ───────────────────────────────────────────────────────────────

export default function PodCaptureScreen({
  shipmentRef = 'WB-204711-GB',
  onConfirm,
}: {
  shipmentRef?: string
  onConfirm?: (payload: PodPayload) => void | Promise<void>
}) {
  const online = useOnline()
  const { gpsState, retryGps } = useGps()

  const [barcode, setBarcode] = useState('')
  const [scanning, setScanning] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [photo, setPhoto] = useState<StampedPhoto | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [hasInk, setHasInk] = useState(false)
  const [phase, setPhase] = useState<Phase>('editing')
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const sigApi = useRef<SignatureApi | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const locked = phase !== 'editing'

  // Presentational sync beat: 'syncing' resolves to 'done' after a moment.
  useEffect(() => {
    if (phase !== 'syncing') return
    const t = window.setTimeout(() => setPhase('done'), 1600)
    return () => window.clearTimeout(t)
  }, [phase])

  // The offline-first story: a queued delivery starts syncing the moment
  // connectivity returns.
  useEffect(() => {
    if (online && phase === 'queued') setPhase('syncing')
  }, [online, phase])

  const connection: ConnectionState = phase === 'syncing' ? 'syncing' : online ? 'online' : 'offline'

  // The fix the record will carry: once a photo exists, the burned-in fix is
  // the truth (even if it was null); before that, track the live reading.
  const shownFix = photo ? photo.fix : gpsState.status === 'fix' ? gpsState.fix : null
  const gpsAcquiring = !photo && gpsState.status === 'acquiring'
  const gpsLost = !shownFix && !gpsAcquiring

  const checklist = [
    { key: 'barcode', label: 'Barcode scanned', done: !!barcode.trim() },
    { key: 'recipient', label: 'Recipient recorded', done: !!recipient.trim() },
    { key: 'photo', label: 'Photo evidence', done: !!photo },
    { key: 'signature', label: 'Signature', done: hasInk },
  ]
  const doneCount = checklist.filter((c) => c.done).length
  const canConfirm = doneCount === checklist.length && phase === 'editing'

  /** Integration point: swap for BarcodeDetector / ZXing. The demo fills the
   *  label value after a short "scanning" beat. */
  function simulateScan() {
    if (locked || scanning) return
    setScanning(true)
    window.setTimeout(() => {
      setBarcode(shipmentRef)
      setScanning(false)
    }, 900)
  }

  async function takePhoto(file: File) {
    setPhotoError(null)
    try {
      const takenAt = new Date() // evidence time = device clock at the shutter
      const fix = gpsState.status === 'fix' ? gpsState.fix : null
      const stamped = await stampPhoto(file, fix, takenAt)
      setPhoto((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { ...stamped, fix, takenAt }
      })
    } catch (e) {
      setPhotoError(`Photo processing failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function removePhoto() {
    setPhoto((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
  }

  async function handleConfirm() {
    if (!canConfirm || !photo) return
    setConfirmError(null)
    const signature = (await sigApi.current?.toBlob()) ?? null
    if (!signature) {
      setConfirmError('Could not export the signature — try signing again.')
      return
    }
    const payload: PodPayload = {
      shipmentRef,
      barcode: barcode.trim().toUpperCase(),
      recipientName: recipient.trim(),
      photo: photo.blob,
      signature,
      gps: photo.fix, // must match the image — never the post-photo live fix
      capturedAt: photo.takenAt.toISOString(),
      queuedOffline: !online,
    }
    try {
      await onConfirm?.(payload)
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : String(e))
      return
    }
    setPhase(online ? 'syncing' : 'queued')
  }

  return (
    <div className="min-h-dvh bg-[#eef1f5] bg-[radial-gradient(90%_50%_at_50%_0%,#f7f9fc_0%,#eef1f5_70%)] text-[#16233f]">
      {/* ── App bar ────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30">
        <div className="bg-[#0a1f44] bg-[radial-gradient(120%_180%_at_85%_-40%,#1d3f74_0%,#0a1f44_55%)]">
          <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 pt-[env(safe-area-inset-top)] sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden
                className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-gradient-to-br from-[#dcb958] to-[#a87f1d] text-[#0a1f44] shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
              >
                <ParcelGlyph />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[10px] font-bold uppercase tracking-[0.22em] text-[#c8a44a]">
                  Citipost · Proof of delivery
                </p>
                <h1 className="truncate font-serif text-[19px] leading-tight text-white sm:text-[21px]">
                  {shipmentRef}
                </h1>
              </div>
            </div>
            <div className="flex flex-none items-center gap-3">
              <span className="hidden font-mono text-[11px] tracking-[0.14em] text-white/40 md:block">
                ‖▌║▌‖║▌║‖ {shipmentRef.replace(/-/g, ' ')}
              </span>
              <StatusPill state={connection} />
            </div>
          </div>
        </div>
        <div className="h-px bg-gradient-to-r from-[#c8a44a] via-[#c8a44a]/30 to-transparent" />
      </header>

      {/* ── Workspace ──────────────────────────────────────────────────── */}
      <main className="mx-auto w-full max-w-6xl px-4 pb-36 pt-5 sm:px-6 lg:px-8 lg:pb-12 lg:pt-8">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
          {/* Left column — shipment + evidence */}
          <div className="grid gap-5">
            <Card step="01" title="Shipment" done={!!barcode.trim() && !!recipient.trim()}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <FieldLabel htmlFor="pod-barcode">Barcode / tracking no.</FieldLabel>
                  <div className="flex gap-2">
                    <input
                      id="pod-barcode"
                      value={barcode}
                      onChange={(e) => setBarcode(e.target.value)}
                      disabled={locked}
                      placeholder="Scan or type"
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-12 w-full min-w-0 rounded-xl border border-[#10192e]/15 bg-[#f8f9fb] px-3.5 font-mono text-[15px] uppercase tracking-[0.06em] text-[#16233f] outline-none transition placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-[#8a93a6] focus:border-[#1f3a66] focus:bg-white focus:ring-[3px] focus:ring-[#1f3a66]/15 disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={simulateScan}
                      disabled={locked || scanning}
                      className="inline-flex h-12 flex-none items-center gap-2 rounded-xl bg-[#0a1f44] px-4 text-[13.5px] font-semibold text-white transition hover:bg-[#13315f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0a1f44] focus-visible:ring-offset-2 active:translate-y-px disabled:opacity-40"
                    >
                      {scanning ? (
                        <span
                          aria-hidden
                          className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
                        />
                      ) : (
                        <BarcodeGlyph />
                      )}
                      <span className="hidden sm:inline">{scanning ? 'Scanning' : 'Scan'}</span>
                    </button>
                  </div>
                </div>
                <div>
                  <FieldLabel htmlFor="pod-recipient">Received by</FieldLabel>
                  <input
                    id="pod-recipient"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    disabled={locked}
                    placeholder={'Name, or "left in porch"'}
                    autoComplete="off"
                    className="h-12 w-full rounded-xl border border-[#10192e]/15 bg-[#f8f9fb] px-3.5 text-[15px] text-[#16233f] outline-none transition placeholder:text-[#8a93a6] focus:border-[#1f3a66] focus:bg-white focus:ring-[3px] focus:ring-[#1f3a66]/15 disabled:opacity-60"
                  />
                </div>
              </div>
            </Card>

            <Card step="02" title="Photo evidence" done={!!photo}>
              {/* Capture zone — tap/click to shoot, or drop an image on desktop */}
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  if (!locked) setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  const file = e.dataTransfer.files?.[0]
                  if (file && !locked) void takePhoto(file)
                }}
                className={`relative overflow-hidden rounded-xl transition ${
                  dragOver ? 'ring-[3px] ring-[#c8a44a]' : ''
                }`}
              >
                {photo ? (
                  <div className="relative aspect-[4/3] w-full sm:aspect-[16/9]">
                    {/* the GPS + timestamp plate is burned into this image */}
                    <img
                      src={photo.url}
                      alt="Delivery evidence with timestamp and location stamp"
                      className="absolute inset-0 h-full w-full rounded-xl object-cover"
                    />
                    {!locked && (
                      <div className="absolute right-3 top-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => fileRef.current?.click()}
                          className="h-11 rounded-full bg-[#0a1f44]/85 px-4 text-[13px] font-semibold text-white backdrop-blur-sm transition hover:bg-[#0a1f44] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        >
                          Replace
                        </button>
                        <button
                          type="button"
                          onClick={removePhoto}
                          className="h-11 rounded-full bg-[#0a1f44]/85 px-4 text-[13px] font-semibold text-white backdrop-blur-sm transition hover:bg-[#b4452e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={locked}
                    className={`flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed bg-[#f8f9fb] text-center transition hover:border-[#1f3a66]/60 hover:bg-[#f2f5fa] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#1f3a66]/30 active:scale-[0.995] disabled:opacity-60 sm:aspect-[16/9] ${
                      dragOver ? 'border-[#c8a44a] bg-[#c8a44a]/5' : 'border-[#10192e]/20'
                    }`}
                  >
                    <span className="grid h-14 w-14 place-items-center rounded-full bg-[#0a1f44]">
                      <CameraGlyph />
                    </span>
                    <span className="text-[15px] font-semibold text-[#0a1f44]">
                      Photograph the parcel at the door
                    </span>
                    <span className="text-[13px] text-[#5d6b85]">
                      Time + GPS are stamped into the image
                      <span className="hidden sm:inline"> · click or drop an image here</span>
                    </span>
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  disabled={locked}
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0]
                    e.currentTarget.value = '' // re-selecting the same file must re-fire
                    if (file) void takePhoto(file)
                  }}
                />
              </div>

              {photoError && (
                <p
                  role="alert"
                  className="mt-3 rounded-xl border border-[#b4452e]/30 bg-[#b4452e]/8 px-4 py-3 text-[13px] text-[#b4452e]"
                >
                  {photoError}
                </p>
              )}

              {/* GPS status — the fix that will go on the record */}
              <div
                role="status"
                className="mt-3 flex min-h-[52px] items-center justify-between gap-3 rounded-xl bg-[#f8f9fb] px-4 py-2.5 ring-1 ring-inset ring-[#10192e]/8"
              >
                {gpsAcquiring ? (
                  <span className="flex items-center gap-2.5 text-[13.5px] font-medium text-[#5d6b85]">
                    <span
                      aria-hidden
                      className="h-4 w-4 flex-none animate-spin rounded-full border-2 border-[#0a1f44]/20 border-t-[#0a1f44]"
                    />
                    Acquiring GPS fix…
                  </span>
                ) : shownFix ? (
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13.5px] font-semibold text-[#1f7a4d]">
                    <PinGlyph />
                    <span className="font-mono tracking-[0.02em]">
                      {shownFix.lat.toFixed(5)}, {shownFix.lng.toFixed(5)} ±{shownFix.accuracyM}m
                    </span>
                    {photo && (
                      <span className="rounded-full bg-[#1f7a4d]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[#1f7a4d]">
                        stamped in photo
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-[13.5px] font-semibold leading-snug text-[#b4452e]">
                    No GPS fix — location will be recorded as unavailable.
                  </span>
                )}
                {gpsLost && !locked && (
                  <button
                    type="button"
                    onClick={retryGps}
                    className="h-11 flex-none rounded-lg px-3 text-[13.5px] font-bold text-[#1f3a66] underline underline-offset-2 transition hover:bg-[#1f3a66]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f3a66]"
                  >
                    Retry
                  </button>
                )}
              </div>

              {/* GPS came back after a fix-less photo: the stamp is the truth,
                  so the only way to put the position on record is a re-shoot */}
              {photo && !photo.fix && gpsState.status === 'fix' && (
                <p className="mt-3 rounded-xl border border-[#c8a44a]/40 bg-[#c8a44a]/8 px-4 py-3 text-[13px] leading-snug text-[#8a6d1a]">
                  GPS is working now, but the photo was taken without a fix — tap{' '}
                  <span className="font-semibold">Replace</span> to stamp your position in.
                </p>
              )}
            </Card>
          </div>

          {/* Right rail — signature + completion (sticky on laptop) */}
          <div className="grid gap-5 lg:sticky lg:top-24">
            <Card
              step="03"
              title="Signature"
              done={hasInk}
              action={
                hasInk && !locked ? (
                  <button
                    type="button"
                    onClick={() => {
                      sigApi.current?.clear()
                      setHasInk(false)
                    }}
                    className="h-9 rounded-lg px-3 text-[12.5px] font-semibold text-[#5d6b85] transition hover:bg-[#10192e]/5 hover:text-[#16233f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f3a66]"
                  >
                    Clear
                  </button>
                ) : undefined
              }
            >
              <SignaturePad apiRef={sigApi} hasInk={hasInk} locked={locked} onInkChange={setHasInk} />
            </Card>

            {/* Completion card — desktop; mobile uses the fixed bottom bar */}
            <section
              aria-label="Complete delivery"
              className="hidden rounded-2xl border border-[#10192e]/10 bg-white p-5 shadow-[0_1px_2px_rgba(16,25,46,0.05),0_12px_32px_-16px_rgba(16,25,46,0.18)] lg:block"
            >
              <ul className="grid gap-2.5">
                {checklist.map((item) => (
                  <li key={item.key} className="flex items-center gap-3 text-[14px]">
                    <CheckDisc done={item.done} />
                    <span className={item.done ? 'font-medium text-[#16233f]' : 'text-[#5d6b85]'}>
                      {item.label}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="my-4 h-px bg-[#10192e]/8" />
              <PhaseNotices phase={phase} confirmError={confirmError} />
              <ConfirmButton
                phase={phase}
                canConfirm={canConfirm}
                onClick={() => void handleConfirm()}
              />
              <p className="mt-3 text-center text-[12px] leading-relaxed text-[#8a93a6]">
                Works offline — evidence is saved on this device and synced automatically.
              </p>
            </section>
          </div>
        </div>

        <p className="mt-10 hidden text-center text-[12px] text-[#8a93a6] lg:block">
          Citipost ePOD · evidence captured on device · {doneCount} of {checklist.length} items
          complete
        </p>
      </main>

      {/* ── Mobile action bar ──────────────────────────────────────────── */}
      <div className="fixed inset-x-0 bottom-0 z-30 lg:hidden">
        <div className="h-px bg-gradient-to-r from-transparent via-[#c8a44a]/40 to-[#c8a44a]/70" />
        <div className="border-t border-[#10192e]/8 bg-white/95 px-4 pb-[max(14px,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_-12px_rgba(16,25,46,0.25)] backdrop-blur">
          <PhaseNotices phase={phase} confirmError={confirmError} compact />
          {phase === 'editing' && (
            <p role="status" className="mb-2 text-[12.5px] text-[#5d6b85]">
              {canConfirm ? (
                <span className="font-medium text-[#1f7a4d]">
                  All evidence captured — ready to confirm.
                </span>
              ) : (
                <>
                  <span className="font-semibold text-[#16233f]">
                    {doneCount} of {checklist.length}
                  </span>{' '}
                  captured · still needed:{' '}
                  <span className="font-medium text-[#8a6d1a]">
                    {checklist
                      .filter((c) => !c.done)
                      .map((c) => c.label.toLowerCase())
                      .join(' · ')}
                  </span>
                </>
              )}
            </p>
          )}
          <ConfirmButton
            phase={phase}
            canConfirm={canConfirm}
            onClick={() => void handleConfirm()}
          />
        </div>
      </div>
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Card({
  step,
  title,
  done,
  action,
  children,
}: {
  step: string
  title: string
  done: boolean
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      aria-label={title}
      className="rounded-2xl border border-[#10192e]/10 bg-white shadow-[0_1px_2px_rgba(16,25,46,0.05),0_12px_32px_-16px_rgba(16,25,46,0.18)]"
    >
      <header className="flex min-h-[52px] items-center justify-between gap-3 border-b border-[#10192e]/8 px-5 py-2.5">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="font-mono text-[11px] font-bold text-[#b08a1e]">
            {step}
          </span>
          <h2 className="text-[12.5px] font-bold uppercase tracking-[0.14em] text-[#3c4a63]">
            {title}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {action}
          {done ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#1f7a4d]/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-[#1f7a4d]">
              <TickGlyph /> Done
            </span>
          ) : (
            <span className="rounded-full bg-[#10192e]/5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a93a6]">
              Required
            </span>
          )}
        </div>
      </header>
      <div className="p-5">{children}</div>
    </section>
  )
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-[11.5px] font-bold uppercase tracking-[0.12em] text-[#5d6b85]"
    >
      {children}
    </label>
  )
}

function StatusPill({ state }: { state: ConnectionState }) {
  if (state === 'syncing') {
    return (
      <span
        role="status"
        className="inline-flex h-9 flex-none items-center gap-2 rounded-full border border-[#e0c178]/40 bg-[#e0c178]/10 px-3.5 text-[11px] font-bold uppercase tracking-[0.12em] text-[#e0c178]"
      >
        <span
          aria-hidden
          className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-[#e0c178]/30 border-t-[#e0c178]"
        />
        Syncing
      </span>
    )
  }
  const isOnline = state === 'online'
  return (
    <span
      role="status"
      className={`inline-flex h-9 flex-none items-center gap-2 rounded-full border px-3.5 text-[11px] font-bold uppercase tracking-[0.12em] ${
        isOnline
          ? 'border-[#46c98c]/35 bg-[#46c98c]/10 text-[#7fd6a9]'
          : 'border-[#e0c178]/40 bg-[#e0c178]/10 text-[#e0c178]'
      }`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${isOnline ? 'bg-[#46c98c]' : 'animate-pulse bg-[#e0c178]'}`}
      />
      {isOnline ? 'Online' : 'Offline'}
    </span>
  )
}

function PhaseNotices({
  phase,
  confirmError,
  compact = false,
}: {
  phase: Phase
  confirmError: string | null
  compact?: boolean
}) {
  const base = compact ? 'mb-2 px-3.5 py-2.5 text-[12.5px]' : 'mb-3 px-4 py-3 text-[13px]'
  return (
    <>
      {phase === 'queued' && (
        <p
          role="status"
          className={`rounded-xl border border-[#c8a44a]/40 bg-[#c8a44a]/8 leading-snug text-[#8a6d1a] ${base}`}
        >
          No signal — delivery queued on this device. It will sync automatically when coverage
          returns.
        </p>
      )}
      {phase === 'done' && (
        <p
          role="status"
          className={`rounded-xl border border-[#1f7a4d]/30 bg-[#1f7a4d]/8 font-medium text-[#1f7a4d] ${base}`}
        >
          Evidence synced to dispatch.
        </p>
      )}
      {confirmError && (
        <p
          role="alert"
          className={`rounded-xl border border-[#b4452e]/30 bg-[#b4452e]/8 text-[#b4452e] ${base}`}
        >
          {confirmError}
        </p>
      )}
    </>
  )
}

function ConfirmButton({
  phase,
  canConfirm,
  onClick,
}: {
  phase: Phase
  canConfirm: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!canConfirm}
      className={`flex h-[54px] w-full items-center justify-center gap-3 rounded-xl font-serif text-[17px] tracking-[0.02em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0a1f44] focus-visible:ring-offset-2 active:translate-y-px ${
        phase === 'done'
          ? 'bg-[#1f7a4d] text-white'
          : phase === 'syncing' || phase === 'queued'
            ? 'bg-[#0a1f44]/80 text-white'
            : 'bg-[#0a1f44] text-white shadow-[0_10px_24px_-10px_rgba(10,31,68,0.5)] hover:bg-[#13315f] disabled:opacity-40 disabled:shadow-none disabled:hover:bg-[#0a1f44]'
      }`}
    >
      {phase === 'syncing' && (
        <span
          aria-hidden
          className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white"
        />
      )}
      {phase === 'editing' && 'Confirm delivery'}
      {phase === 'queued' && 'Queued — awaiting signal'}
      {phase === 'syncing' && 'Syncing evidence…'}
      {phase === 'done' && 'Delivered ✓'}
    </button>
  )
}

function CheckDisc({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid h-6 w-6 flex-none place-items-center rounded-full transition ${
        done ? 'bg-[#1f7a4d] text-white' : 'bg-[#10192e]/8 text-transparent'
      }`}
    >
      <TickGlyph />
    </span>
  )
}

/** Raw-canvas signature pad: pointer events (pen / finger / glove-friendly),
 *  devicePixelRatio-aware, re-sizes with its container, exports a transparent
 *  PNG. No library. */
function SignaturePad({
  apiRef,
  hasInk,
  locked,
  onInkChange,
}: {
  apiRef: { current: SignatureApi | null }
  hasInk: boolean
  locked: boolean
  onInkChange: (ink: boolean) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const drawing = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const onInkChangeRef = useRef(onInkChange)
  onInkChangeRef.current = onInkChange

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Size the bitmap to the laid-out CSS box × DPR so strokes stay crisp
    const setup = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      canvas.width = Math.round(canvas.clientWidth * dpr)
      canvas.height = Math.round(canvas.clientHeight * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.lineWidth = 2.4
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = '#16233f'
      ctxRef.current = ctx
    }
    setup()

    apiRef.current = {
      toBlob: () => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png')),
      clear: () => {
        const ctx = ctxRef.current
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
      },
    }

    // Desktop windows resize; a stale bitmap would blur strokes and skew
    // pointer maths. Re-sizing wipes the canvas, so the ink flag resets too.
    const ro = new ResizeObserver(() => {
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      if (Math.round(canvas.clientWidth * dpr) !== canvas.width) {
        setup()
        onInkChangeRef.current(false)
      }
    })
    ro.observe(canvas)

    return () => {
      ro.disconnect()
      apiRef.current = null
    }
  }, [apiRef])

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  return (
    <div className="relative overflow-hidden rounded-xl bg-[#f8f9fb] ring-1 ring-inset ring-[#10192e]/10">
      <canvas
        ref={canvasRef}
        aria-label="Signature pad — draw with finger, stylus or mouse"
        className="block h-44 w-full touch-none select-none lg:h-48"
        onPointerDown={(e) => {
          if (locked) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drawing.current = true
          const p = point(e)
          last.current = p
          const ctx = ctxRef.current
          if (ctx) {
            // ink a dot so a bare tap still registers
            ctx.beginPath()
            ctx.moveTo(p.x, p.y)
            ctx.lineTo(p.x + 0.01, p.y + 0.01)
            ctx.stroke()
          }
          onInkChange(true)
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return
          const ctx = ctxRef.current
          if (!ctx) return
          const p = point(e)
          ctx.beginPath()
          ctx.moveTo(last.current.x, last.current.y)
          ctx.lineTo(p.x, p.y)
          ctx.stroke()
          last.current = p
        }}
        onPointerUp={() => {
          drawing.current = false
        }}
        onPointerCancel={() => {
          drawing.current = false
        }}
      />
      {!hasInk && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <span className="absolute left-1/2 top-[32%] -translate-x-1/2 text-[12px] font-semibold uppercase tracking-[0.2em] text-[#8a93a6]/60">
            Sign here
          </span>
          <span className="absolute bottom-[40px] left-6 font-serif text-[16px] italic text-[#0a1f44]/25">
            ✕
          </span>
          <div className="absolute bottom-9 left-6 right-6 border-b border-dashed border-[#0a1f44]/20" />
        </div>
      )}
    </div>
  )
}

// ── Glyphs ──────────────────────────────────────────────────────────────────

function BarcodeGlyph() {
  return (
    <svg viewBox="0 0 24 16" className="h-3.5 w-5" fill="currentColor" aria-hidden>
      <rect x="0" y="0" width="2" height="16" />
      <rect x="4" y="0" width="1" height="16" />
      <rect x="7" y="0" width="3" height="16" />
      <rect x="12" y="0" width="1" height="16" />
      <rect x="15" y="0" width="2" height="16" />
      <rect x="19" y="0" width="1" height="16" />
      <rect x="22" y="0" width="2" height="16" />
    </svg>
  )
}

function CameraGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6 stroke-[#e0c178]"
      fill="none"
      strokeWidth="1.7"
      aria-hidden
    >
      <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="13" cy="12.5" r="3.5" />
    </svg>
  )
}

function PinGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 flex-none fill-none stroke-current"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M12 21s-7-5.7-7-11a7 7 0 0 1 14 0c0 5.3-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  )
}

function TickGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 fill-none stroke-current"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.5 12.5 10 18 19.5 6.5" />
    </svg>
  )
}

function ParcelGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5 fill-none stroke-current"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </svg>
  )
}
