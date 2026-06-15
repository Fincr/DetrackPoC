# Citipost ePOD — onboarding

Electronic Proof of Delivery: drivers scan parcels and capture stamped
photo/signature/GPS evidence (fully offline-capable); dispatchers import job
manifests, allocate runs, track the parcel lifecycle, and export tracking data.
React PWA + Supabase (Postgres/PostGIS, Auth, Storage, Realtime), RLS on every
table.

- **Repo:** https://github.com/Fincr/DetrackPoC
- **Conventions & gotchas:** `CLAUDE.md` (read before changing code)
- **Hosted setup & access model:** `README.md`

---

## 1. Run it locally (zero shared credentials needed)

The local Supabase stack generates its own keys on your machine.

Prereqs: **Node 20+** (24 recommended — the test scripts use type-stripping),
**Docker Desktop** (running).

```powershell
git clone https://github.com/Fincr/DetrackPoC.git
cd DetrackPoC
npm install
npx supabase start          # starts the local stack; PRINTS your keys
copy .env.example .env      # paste the printed anon key into .env
npx supabase db reset       # apply all migrations (seed is empty)
node scripts/seed-auth.mjs  # create local accounts (REQUIRED after every db reset)
npm run dev                 # http://localhost:5173
```

`seed-auth.mjs` creates an admin + a driver account. The password comes from
`SEED_PASSWORD` (defaults to a local-dev value); set it for a real environment.
Accounts start with `driver_id = null` — the app has no fleet until you add one.

### URLs

- Driver app: `http://localhost:5173` (sign in as a driver)
- Dispatcher: `#/allocate` (assign parcels/sites to runs) · `#/jobs` (import a
  manifest, export tracking CSV) · `#/sites` · `#/dispatch` (captured PODs)
- Supabase Studio (inspect rows/files): `http://127.0.0.1:54323`

### Verify your setup

```powershell
node scripts/smoke-db.mjs      # stack, RLS, storage, idempotency
node scripts/test-system.mjs   # full backend suite (RLS, lifecycle, attempts)
node scripts/test-manifest.mjs # manifest import end-to-end
npm run build                  # must pass before committing (tsc + vite)
```

---

## 2. What the system does (60-second map)

- **Jobs/manifests** — admin imports a parcel manifest (`.xlsx`/`.csv`, one
  tracking number per row; column names auto-mapped). Parcels arrive unallocated.
- **Allocation** — parcels (and **sites** — stores/depots with no per-item
  manifest) are assigned to a **route**; each route belongs to one driver, so
  allocation = giving the driver the work. Changes reach the phone live (Realtime).
- **Lifecycle** — `awaiting_collection → collected → at_warehouse → delivered`
  (or terminal `returned` after 3 failed attempts). Collection/warehouse are
  quick scans; delivery is the full POD capture. Status only moves forward
  (atomic RPC), so late-syncing scans can't regress a parcel.
- **Capture** — photo (compressed + evidence strip burned in), signature, GPS
  (real fix or nothing — no simulated fallback), geofence distance to the
  destination. **Everything goes through an offline queue** (Dexie/IndexedDB);
  sync is idempotent on a client-generated UUID, so retries never duplicate.
- **Export** — tracking CSV from captured PODs (placeholder carrier event codes
  — swap before any real integration).

Architecture details, invariants, and design tokens: `CLAUDE.md`.

---

## 3. Hosted deployment

See `README.md` → "Hosted setup". In short: paste `supabase/cloud-setup.sql`
into the Supabase SQL editor, create accounts with `scripts/seed-auth.mjs`
(service-role key in the shell — the only real secret, never committed), and
set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in Vercel for Production and
Preview. Push to `master` auto-deploys.

The live app starts empty — provision a fleet (`supabase/seed.sql` template)
and import parcels via Jobs before a driver sees work.

---

## 4. Gotchas that will bite you (learned the hard way)

- **After every `npx supabase db reset`, run `node scripts/seed-auth.mjs`** —
  the reset wipes auth users and nobody can log in until you recreate them.
- **"An invalid response was received from the upstream server"** from storage
  or auth after a reset → the Kong gateway has stale container routes:
  `docker restart supabase_kong_Detrack_PoC`, wait ~5 s, retry.
- **Sandboxed/restricted shells:** if `npx supabase` fails with EPERM, call the
  binary directly: `node_modules\@supabase\cli-windows-x64\bin\supabase.exe`.
- **PWA caching:** the app is a service-worker PWA. If a screen looks stale
  after pulling changes, hard-refresh (Ctrl+Shift+R); after a `db reset`, also
  clear site data (DevTools → Application → Storage) so the offline queue
  doesn't hold PODs for wiped parcels.
- **Real GPS needs a secure context.** On a LAN phone use `npm run dev:https`,
  but Chrome auto-denies geolocation on self-signed certs — phone GPS really
  wants the deployed (HTTPS) build.
- **Don't re-litigate stack choices** (Tailwind v3, Dexie queue, barcode
  fallback chain, etc.) — see `CLAUDE.md`.

---

## 5. Day-to-day commands

```powershell
npm run dev                  # vite dev server
npm run build                # type-check + production build — run before committing
npm run preview              # serve the production build (bulletproof offline test)
npx supabase start|stop      # local stack (Docker)
npx supabase db reset        # re-apply migrations (then seed-auth.mjs!)
```
