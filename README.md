# ePOD Proof of Concept

Electronic Proof of Delivery PoC: a driver PWA that captures an evidence
bundle (photos, timestamp, GPS, recipient, signature, status) at the moment
of delivery — **including fully offline** — and syncs it to Supabase where a
dispatcher view shows it attached to the correct parcel.

> Status: **Checkpoint 1 of 8** — scaffold + theme. Screens and data follow.

## Stack

- React + TypeScript + Vite, installable PWA (`vite-plugin-pwa`)
- Tailwind CSS themed to the `design-reference.html` palette (navy / gold / paper)
- Supabase (Postgres + PostGIS, Storage) running locally via the Supabase CLI
- Dexie (IndexedDB) offline queue · `BarcodeDetector` / ZXing · `signature_pad`

## Prerequisites

- Node 20+ and npm
- Docker Desktop **running** (required by `supabase start`)

## Setup & run

```powershell
npm install
npx supabase start          # boots local Supabase; prints URL + anon key
copy .env.example .env      # then paste the anon key from the line above
npm run dev                 # http://localhost:5173
```

`npx supabase status` re-prints the URL/keys at any time.

## Seeded tracking numbers

These are the barcode values — scan a label, or just type one in, to open a
capture with that parcel pre-selected:

| Tracking number | Recipient | Area |
| --- | --- | --- |
| `CP-849213-GB` | Meridian Logistics, Erith | Domestic |
| `CP-100002-GB` | Patricia Holloway, Maidstone | Domestic |
| `CP-100003-GB` | Dev & Sons Hardware, London | Domestic |
| `CP-200004-GB` | Brightwell Imports Ltd, Edinburgh | International |
| `CP-200005-GB` | Atlantique Wines (UK), Cardiff | International |
| `CP-300006-GB` | Acme Home Goods — J. Mercer, Leeds | Fulfilment |
| `CP-300007-GB` | Tillys Toy Shop, Norwich | Fulfilment |
| `CP-400008-GB` | NN4 Regional Sort Hub, Northampton | Sortation |

(`CP-849213-GB` is the parcel from `design-reference.html`.) To re-seed at any
time: `npx supabase db reset`.

## Simulating offline

DevTools → Network tab → throttling dropdown → **Offline**. Capture one or
more deliveries, watch the queued counter rise, switch back to **No
throttling**, and watch the queue drain. The bulletproof offline app-shell
demo is a production build: `npm run build && npm run preview`.

## Repo guide

| Path | Purpose |
| --- | --- |
| `design-reference.html` | Canonical look for the driver app (open it in a browser) |
| `epod-poc-claude-code-brief.md` | The build brief |
| `supabase/` | Local Supabase config, migrations, seed |
| `src/` | The PWA |
| `DEMO.md` | Acceptance-test walkthrough (Checkpoint 8) |
