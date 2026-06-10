# ePOD PoC — project conventions

A complete proof-of-concept for Electronic Proof of Delivery. The brief is
`epod-poc-claude-code-brief.md`; the canonical driver-app look is
`design-reference.html` (open it — match it, don't approximate it). The
acceptance-test walkthrough is `DEMO.md`.

## Ground rules

- **PoC, not production.** Convincing runnable demo > completeness. Auth is
  real but demo-grade: Supabase Auth sign-in portal, seeded logins (admin +
  3 drivers, password `citipost`, created by `scripts/seed-auth.mjs` — rerun
  after every `db reset`), RLS on every table (`profiles` maps user → role +
  driver_id; drivers see only their route's parcels/PODs, dispatch is
  admin-only), private `pod-evidence` bucket. No multi-tenancy.
- Keep logic commented where non-obvious: overlay maths (`stamp.ts`), sync
  idempotency (`pod.ts`/`syncWorker.ts`), GPS acquisition (`useGeolocation.ts`),
  EWKB parsing (`geo.ts`).
- Windows dev machine. The Supabase CLI is a devDependency; in sandboxed
  shells `npx supabase` can fail with EPERM — call the binary directly:
  `node_modules\@supabase\cli-windows-x64\bin\supabase.exe`.
- Docker Desktop must be running for `supabase start`.

## Stack decisions (fixed by the brief — don't re-litigate)

- Vite + React 19 + TS strict; PWA via `vite-plugin-pwa` (`devOptions.enabled`
  so offline works in dev; bulletproof offline = build + preview)
- Tailwind **v3** (classic `tailwind.config.js` — the brief specifies
  `theme.extend.colors`)
- Supabase JS v2 on the local CLI stack; PostGIS enabled
- Dexie for the offline queue; **capture always goes through the queue**,
  online or not
- Barcode: native `BarcodeDetector` if `getSupportedFormats()` is non-empty,
  else `@zxing/library` (dynamic import — keep it out of the main chunk)
- `signature_pad` for signatures; plain `<canvas>` for stamp + compress

## Architecture

```
CaptureScreen ─→ queuePod() ──→ Dexie (epod.pods: bundle + blobs, synced=0)
                    │                       ▲ flips to synced=1, kept as history
                    └→ syncNow() ─→ uploadPod(): storage upserts → pod_records
                                    upsert (onConflict id) → pod_photos upsert
                                    (onConflict pod_id,photo_type) → parcel status
Triggers: app load · window "online" · 8s interval · post-capture · badge tap
Events:   syncEvents.ts emitter → useSyncStatus / useQueuedPod re-query
Routing:  main.tsx hash router gated by useSession (LoginScreen when signed
          out) — #/allocate · #/jobs · #/dispatch = dispatcher (admin-only;
          drivers bounced), else driver App. driver_id comes from the session.
```

- **Idempotency invariant:** every server write is keyed on the
  client-generated `podId`; storage paths are deterministic
  (`{podId}/label.jpg`, `{podId}/where_left.jpg`, `{podId}/signature.png`).
  A retry must never duplicate — preserve this in any change.
- **Poison items:** after `MAX_AUTO_ATTEMPTS` (5) failures an item is
  "stuck" — skipped by automatic passes (never blocks the queue), retried by
  a manual badge tap (`syncNow({includeStuck:true})`).
- **Attempt model:** delivered = terminal; failed keeps the parcel `pending`
  (re-attempt, rolls over) with `parcels.attempts`/`last_failure` updated at
  sync; at `MAX_DELIVERY_ATTEMPTS` (3) → terminal `'returned'`.
- **Geofence:** haversine (geo.ts) between the capture fix and
  `parcels.destination` at capture → `pod_records.dest_distance_m`;
  thresholds 250 m ok / 1 km warn used in capture chip, receipt, dispatcher.
- **Offline cache:** Dexie v2 `parcels` table is a read-through cache of the
  stop list (cold offline start still renders the run).
- **Trust boundary:** `captured_at` = device clock at the shutter;
  `synced_at` = DB column default `now()` at first insert (never sent by the
  client, never overwritten on conflict-update).
- **GPS is real-or-nothing** (`gps_source`): photo EXIF (exifr) → live
  device fix (warm-up on capture-screen mount, *fresh* read at the
  shutter) → none (`location`/`gps_source` null, red "no fix" chip with the
  reason + Retry). There is NO simulated fallback (removed 2026-06-03 at
  the user's request, diverging from the brief); `gps_simulated` and the
  'simulated' enum value linger only for legacy rows. EXIF fixes have
  `gps_accuracy_m = null`. The fix burned into the photo is the fix stored
  on the record (tri-state `usedFix` in CaptureScreen). Browsers often
  strip EXIF GPS, so 'device' is the common case. Real GPS needs a secure
  context: `npm run dev:https` for LAN phones — but Chrome auto-denies
  geolocation on self-signed certs, so phone GPS demos want a trusted
  origin (deploy) or the phone-side `unsafely-treat-insecure-origin-as-
  secure` flag.
- **Geography columns** come back from PostgREST as EWKB hex — parse with
  `geo.ts` (offsets verified by `scripts/test-ewkb.mjs`).

## Data model (§4 + adjustments)

- `parcels` — tracking_number unique (the barcode value), recipient/address,
  `destination geography(point,4326)`, area, status, `due_date` (the run the
  parcel belongs to); seeded with 8 UK parcels (`CP-849213-GB` = the
  design-reference parcel; `CP-100003-GB` is seeded due yesterday to demo
  rollover). **Rollover is derived**: pending AND due_date < today → badge +
  sorted first (order by due_date) — no nightly job.
- `pod_records` — client UUID pk, parcel_id FK, tracking_scanned, status
  (delivered|failed), failure_reason (check: required when failed),
  received_by, captured_at, synced_at (default now()), location geography,
  gps_accuracy_m, gps_simulated, signature_path, driver_id
- `pod_photos` — pod_id FK cascade, photo_type label|where_left,
  storage_path, orig_kb, compressed_kb, **unique (pod_id, photo_type)**
- Bucket `pod-evidence`: private — signed-in read + insert only; the
  dispatcher views photos via signed URLs

## Design tokens (§7) — in `tailwind.config.js`

- navy `#0e1c38` / 600 `#16294d` / 500 `#1f3a66`; gold `#c9a227` /
  soft `#e3c766`; paper `#f6f4ee`; ink `#10192e`; muted `#6b7589`;
  ok `#2f8f5b`; fail `#c0492f`; hairline `line` = `rgba(14,28,56,.12)`
- Georgia serif: app title, parcel ref, primary buttons. Mono: barcode lines,
  JSON. Section labels: 11px uppercase tracked muted bold.
- Responsive shell (`AppShell`): edge-to-edge on mobile (min-h-dvh,
  safe-area-aware top bar/badge/footer), centred ~430px elevated column on
  the navy gradient for laptop. No mockup chrome — this is the product UI.
  Gold-to-transparent `gold-underline` on top bars. GPS chip red "no fix" +
  reason note with Retry when no real fix exists. JSON panel: keys gold,
  strings green, numbers orange, booleans blue.

## Commands

```powershell
npm run dev                  # vite dev server
npm run build                # tsc -b && vite build (run before committing)
npx supabase start|stop      # local stack (Docker)
npx supabase db reset        # re-apply migrations + seed (wipes auth users!)
node scripts/seed-auth.mjs   # recreate demo logins — required after db reset
node scripts/smoke-db.mjs    # stack/seed/RLS/bucket/idempotency smoke test
```
