# ePOD PoC — handoff & onboarding

A proof-of-concept for **Electronic Proof of Delivery**: drivers scan parcels,
capture stamped photo/signature/GPS evidence (fully offline-capable), and
dispatchers import job manifests, allocate runs, and export tracking data.
React PWA + Supabase (Postgres/PostGIS, Auth, Storage, Realtime).

- **Repo:** https://github.com/georgeb1-star/DetrackPoC
- **Demo walkthrough:** `DEMO.md` (the ~10-minute acceptance script)
- **Project conventions & gotchas:** `CLAUDE.md` (read this before changing code)

> **PoC, not production.** Demo-grade auth, no multi-tenancy, placeholder
> carrier codes in the tracking export. Convincing demo > completeness.

---

## 1. Run it locally (15 minutes, zero credentials needed)

You do **not** need anyone's `.env` file or any shared secrets — the local
Supabase stack generates its own keys on your machine.

Prereqs: **Node 20+** (24 recommended — the test scripts use type-stripping),
**Docker Desktop** (running).

```powershell
git clone https://github.com/georgeb1-star/DetrackPoC.git
cd DetrackPoC
npm install
npx supabase start          # starts the local stack; PRINTS your keys
copy .env.example .env      # paste the printed anon key into .env
npx supabase db reset       # apply all migrations + demo seed
node scripts/seed-auth.mjs  # create the demo logins (REQUIRED after every db reset)
npm run dev                 # http://localhost:5173
```

### Demo logins (password for all: `citipost`)

| Role | Email | Sees |
| --- | --- | --- |
| Dispatcher (admin) | `admin@citipost.test` | everything: allocate, jobs, sites, captured PODs, export |
| Driver — Sam | `sam@citipost.test` | Greater London run only |
| Driver — Priya | `priya@citipost.test` | South East run only |
| Driver — Dan | `dan@citipost.test` | North West run only |

Access is enforced server-side with RLS — drivers cannot read another run even
with hand-crafted API calls.

### URLs

- Driver app: `http://localhost:5173` (sign in as a driver)
- Dispatcher: `#/allocate` (assign parcels to runs) · `#/jobs` (import a
  manifest .xlsx, export tracking CSV) · `#/dispatch` (captured PODs)
- Supabase Studio (inspect rows/files): `http://127.0.0.1:54323`
- Printable scan labels for the seeded parcels: `/labels.html`

### Verify your setup

```powershell
node scripts/smoke-db.mjs      # stack, RLS, storage, idempotency
node scripts/test-system.mjs   # full backend suite (RLS, lifecycle, attempts)
node scripts/test-manifest.mjs # manifest import end-to-end
node scripts/smoke-sites.mjs   # site (no-manifest) capture path
npm run build                  # must pass before committing (tsc + vite)
```

---

## 2. What the system does (60-second map)

- **Jobs/manifests** — admin imports a parcel manifest (.xlsx, one tracking
  number per row; column names auto-mapped). Parcels arrive unallocated.
- **Allocation** — parcels (and **sites** — stores/depots with no per-item
  manifest) are assigned to a **route**; each route belongs to one driver, so
  allocation = giving the driver the work. Changes reach the driver's phone
  live (Realtime).
- **Lifecycle** — `awaiting_collection → collected → at_warehouse → delivered`
  (or terminal `returned` after 3 failed attempts). Collection/warehouse are
  quick scans; delivery is the full POD capture. Status only moves forward
  (atomic RPC), so late-syncing scans can't regress a parcel.
- **Capture** — photo (compressed + evidence strip burned in), signature, GPS
  (real fix or nothing — no simulated fallback), geofence distance to the
  destination. **Everything goes through an offline queue** (Dexie/IndexedDB);
  sync is idempotent on a client-generated UUID, so retries never duplicate.
- **Export** — Evri-format tracking CSV from captured PODs (placeholder event
  codes — swap before any real integration).

Architecture details, invariants, and design tokens: `CLAUDE.md`.

---

## 3. Cloud assets (all self-service — nothing needed from George)

### Hosted Supabase — create your own (10 minutes, free tier)

George's hosted project can't be shared (team members are a paid Supabase
feature), and the data in it is throwaway demo seed anyway — so you create
your own:

1. supabase.com → New project (free tier is fine). Note the **project URL**
   and, under Settings → API, the **anon key** and **service-role key**.
2. SQL Editor → paste the whole of **`supabase/cloud-setup.sql`** → Run.
   It's the complete schema + RLS + storage + demo seed in one script
   (idempotent — safe to re-run).
3. Create the demo logins:

```powershell
$env:SUPABASE_URL = "https://<your-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service role key from dashboard>"
node scripts/seed-auth.mjs
```

That's a fully working backend. The **service-role key** is the only real
secret in this project — it never goes in git or any committed `.env`.

### Vercel

The current Vercel project is **not git-connected** — deploys were manual via
`npx vercel --prod`. Recommended: import the GitHub repo into your own Vercel
account (New Project → Import), set two environment variables:

```
VITE_SUPABASE_URL       = https://<your-ref>.supabase.co
VITE_SUPABASE_ANON_KEY  = <anon key from YOUR Supabase project>
```

…and every push to `master` will auto-deploy. (The anon key is publishable —
it's safe in a browser bundle; RLS is what protects the data.)

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
  but Chrome auto-denies geolocation on self-signed certs — phone GPS demos
  really want the deployed (HTTPS) build.
- **Don't re-litigate stack choices** (Tailwind v3, Dexie queue, barcode
  fallback chain, etc.) — they're fixed by the brief; see `CLAUDE.md`.

---

## 5. Day-to-day commands

```powershell
npm run dev                  # vite dev server
npm run build                # type-check + production build — run before committing
npm run preview              # serve the production build (bulletproof offline test)
npx supabase start|stop      # local stack (Docker)
npx supabase db reset        # re-seed (then seed-auth.mjs!)
```
