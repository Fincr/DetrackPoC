# Citipost ePOD

Electronic Proof of Delivery: a driver PWA that captures an evidence bundle
(stamped photos, timestamp, GPS, recipient, optional signature, delivered/failed
status) at the moment of delivery — **including fully offline** — and syncs it to
Supabase, where a dispatcher portal allocates work, imports job manifests,
tracks the parcel lifecycle, and exports tracking data.

## Stack

- **React + TypeScript + Vite**, installable PWA (`vite-plugin-pwa`, service
  worker active in dev too)
- **Tailwind v3** ("Freight Modern" theme — graphite/ultramarine/amber)
- **Supabase** — Postgres + PostGIS, **Auth** (username or email + password), **Storage**
  (private evidence bucket), Realtime. Every table has **RLS**.
- **Dexie** (IndexedDB) offline queue + idempotent sync worker
- **Barcode:** native `BarcodeDetector` → `@zxing/library` fallback
  (lazy-loaded) · **Signature:** `signature_pad` · **Stamp/compress:** plain
  `<canvas>`

## Access model

- **Sign-in portal** (Supabase Auth). A `profiles` row maps each account to a
  role (`admin` | `driver`) and, for drivers, a `driver_id`.
- **Drivers sign in with a username** (first initial + surname, e.g. `FCrawley`,
  case-insensitive); **admins** with their company **email**. The single
  sign-in field accepts either. Usernames are stored as a non-routable synthetic
  email — an implementation detail users never see (see `docs/adr/0003`).
- **Admin** → dispatcher portal: `#/allocate`, `#/jobs`, `#/sites`,
  `#/dispatch`. **Driver** → their own run only.
- Enforced **server-side with RLS**: a driver can only read/write parcels,
  sites, PODs and events on their own route; dispatcher tables are admin-only;
  the evidence bucket is private (signed-in insert; dispatcher reads via
  short-lived signed URLs).
- Role assignment is privileged: `profiles` has no insert/update policy, so a
  signed-in user cannot grant themselves a role. Accounts + profiles are
  provisioned out-of-band (`scripts/seed-auth.mjs` or admin SQL).

## Hosted setup (production path)

1. **Supabase project** → SQL Editor → paste all of
   [`supabase/cloud-setup.sql`](supabase/cloud-setup.sql) → Run. That's the
   complete schema + RLS + functions + storage policies (no seed data —
   the app starts with an empty fleet).
2. **Create accounts** (the only manual step — MCP/SQL can't mint a session):
   ```powershell
   $env:SUPABASE_URL = "https://<your-ref>.supabase.co"
   $env:SUPABASE_SERVICE_ROLE_KEY = "<service-role key from dashboard>"
   $env:SEED_PASSWORD = "<a strong password>"
   node scripts/seed-auth.mjs
   ```
3. **Vercel** → import the repo, set `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` (the anon key is publishable — safe in the bundle;
   RLS protects the data) for Production **and** Preview. Push to `master`
   auto-deploys (Vite inlines the env vars at build time).

## First run: provision a fleet

The live app starts with **no drivers, routes, or parcels**. To put work in
front of a driver:

1. Add a driver + route and point the driver's profile at it — see the
   template in [`supabase/seed.sql`](supabase/seed.sql).
2. Sign in as admin → **Jobs → "Import a manifest"** (a `.xlsx`/`.csv` where
   each row is a parcel; columns are auto-mapped) → open the job → assign
   parcels to the route.

## Local development

```powershell
npm install
npx supabase start          # boots local Supabase (Docker Desktop required)
copy .env.example .env      # paste the printed anon key
npx supabase db reset       # apply migrations (seed is empty)
node scripts/seed-auth.mjs  # create local accounts (SEED_PASSWORD optional)
npm run dev                 # http://localhost:5173
```

`npx supabase status` re-prints the keys. After every `db reset` re-run
`seed-auth.mjs` — the reset wipes auth users.

## How the offline sync works (the short version)

1. **Complete delivery** writes the whole bundle — photo/signature **blobs**
   included — to IndexedDB and returns instantly. Nothing blocks on the network.
2. A **sync worker** (app load · `online` event · 8s interval · post-capture)
   drains the queue oldest-first: upload photos/signature → upsert
   `pod_records` → upsert `pod_photos` → advance parcel status.
3. Every step is **idempotent on the client-generated `pod_id`** (deterministic
   storage paths + `on conflict` upserts), so retries after partial failures
   never duplicate anything.
4. `captured_at` is the device clock (evidence time); `synced_at` is set by a
   **DB default on insert** — the server's own clock, the trust stamp.
5. Synced queue items are kept with a flipped flag (history), not deleted.

## Repo guide

| Path | Purpose |
| --- | --- |
| `supabase/cloud-setup.sql` | One-paste hosted setup: schema, RLS, functions, storage |
| `supabase/migrations/` | Migration history (schema, RLS, lifecycle) |
| `supabase/seed.sql` | Fleet template (empty by default) |
| `scripts/seed-auth.mjs` | Create auth accounts + profiles |
| `src/lib/` | stamp (canvas overlay), pod (queue+upload), syncWorker, db (Dexie), geo (EWKB) |
| `src/screens/` | Driver: Stops, Capture, Result · Dispatcher: Allocate, Jobs, Sites, Dispatcher |
| `CLAUDE.md` | Conventions + architecture for future sessions |
