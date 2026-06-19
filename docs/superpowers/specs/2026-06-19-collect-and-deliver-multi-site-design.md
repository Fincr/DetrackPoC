# Collect-and-deliver across multiple sender sites — design

**Date:** 2026-06-19
**Status:** Approved (brainstorm), pending implementation plan
**Related:**
- ADR `docs/adr/0004-collect-and-deliver-routing.md` (the decision + data evidence)
- `CONTEXT.md` (glossary: **Origin**, **Collection point**, **Collection area**, **Delivery area**, **Route**)
- `docs/superpowers/specs/2026-06-17-auto-enrich-job-import-from-gwoptical-design.md` (the enrich path this widens)
- `docs/superpowers/specs/2026-06-16-gwoptical-tracking-forwarder-design.md` (collection events already flow to GWOptical)
- `src/lib/enrich.ts` (`deriveArea`, `shipmentToParcelInput`), `src/lib/manifest.ts` (`ParcelInput`)
- `supabase/functions/enrich-shipments/index.ts`, `supabase/lens-epod-reader.sql` (the Lens view)
- `src/lib/types.ts` (`Area`, `Parcel`, `Route`), `src/screens/{JobsScreen,AllocateScreen,StopsScreen}.tsx`, `RoutesPanel`
- Memory: `epod-address-enrichment`, `gwoptical-integration`

## 1. Goal

Give a driver a **collection leg** before delivery. Each parcel gains an
**origin** (its sender address, read from GWOptical alongside the recipient), so
the dispatcher can build routes that **collect from sender sites, then deliver**,
same day. A route pairs a set of **collection areas** with a set of **delivery
areas**; the driver collects the route's parcels at their sender sites (per-parcel
quick scan), then delivers them (full POD). Built to run on a few pilot shops and
scale to nationwide with no code change.

### Non-goals (this iteration)

- **No geocoded collection pin / collection geofence.** The mirror has no
  sender geocode (same constraint as delivery enrichment); `destination` stays
  null and there's no collect-side distance check yet.
- **No store-directory feed for names.** Pilot shop names/pins are hand-filled in
  a small lookup (§4.5); a directory is a later add.
- **No automated parcel feed.** Parcels still arrive via the dispatcher's
  tracking-number enrich step (the day's set is looked up before a run).
  Automating that pull is separate.
- **No write-back to GWOptical/Lens** (read-only, as today).
- **No change to the delivery-only `sites` feature** (orthogonal; may be retired
  separately).

## 2. Background

Today a parcel is delivery-only (`recipient_name`, `address_line`, `postcode`,
`destination`, `area`), `area` is one of six London labels derived from the
recipient postcode, and a `route` "covers a set of areas" (`routes.areas`). The
collection stage exists in the lifecycle (`awaiting_collection → collected →
at_warehouse → delivered`) but only as a quick scan with no notion of *where*.

The probe behind ADR 0004 established: GWOptical's `dbo.Shipments` carries a full
**Sender block** on every row (`Sender_Postcode` non-null on all ~350k), the shop
*name* (`Sender_Company`) is almost always blank, and the real traffic is
hub-and-spoke (only 10.6% intra-region). So origin is a reliable per-parcel fact,
routes pair *different* areas, and the area grain becomes the UK **postcode area**.

The data reaches ePOD the same way recipient data does (ADR/spec 0617): a
server-side read of Lens's `public.shipments` mirror via `enrich-shipments`, since
GWOptical is unreachable from Vercel/Supabase. **This spec widens that path to the
sender columns** — no new connection.

## 3. Architecture & data flow

```
Dispatcher (ePOD on Vercel) — enrich the day's parcels from tracking numbers
   │
   ▼  enrich-shipments Edge Function (server-side; holds Lens read creds)
   │   SELECT recipient_* AND sender_* FROM shipments WHERE tracking = ANY($list)
   ▼  ShipmentRow[] (now incl. sender block)
src/lib/enrich.ts  →  ParcelInput with: recipient + delivery_area, sender + collection_area
   │   delivery_area = postcodeArea(recipient_postcode);  collection_area = postcodeArea(sender_postcode)
   ▼  upsert parcels (onConflict tracking_number) — admin RLS under dispatcher session
Allocate: parcel joins route R  ⇔  collection_area ∈ R.collection_areas
                                AND delivery_area  ∈ R.delivery_areas
   ▼
Driver run (two phases) — COLLECT (group parcels by Collection point, quick-scan each
   → collected) then DELIVER (existing per-parcel POD → delivered). Same parcels, same day.
   ▼
GWOptical forwarder (unchanged) — collection + delivery events already forwarded.
```

## 4. Components

### 4.1 `parcels` schema — add the origin
New columns (nullable, so the existing delivery-only path and old rows survive):
- `sender_name text` — friendly name **baked at import**: `Sender_Company` if
  present, else the `collection_points` name (§4.5), else null. The address always
  renders separately from `sender_address_line`, so a nameless origin still shows.
- `sender_address_line text` — composed `Sender_Address1/2/3, City, County`.
- `sender_postcode text` — the stable origin key (always present from source).
- `collection_area text` — `postcodeArea(sender_postcode)`.
- `delivery_area text` — **rename of `area`** (semantically unchanged: the
  recipient-derived area). Renamed for symmetry with `collection_area`; affordable
  under the clean-break (wiped data). The `parcels.area` `CHECK` is **dropped**
  (postcode areas aren't a fixed enum).

### 4.2 `postcodeArea()` — the new derivation (`src/lib/enrich.ts`)
`deriveArea(postcode): Area` (six-label map) is replaced by
`postcodeArea(postcode): Area` returning the **outward letter prefix**, upper-cased
(`"SL4 1DE" → "SL"`, `"DY11 7FL" → "DY"`, `"B2 4RQ" → "B"`); blank/unparseable →
`""` (an "unknown" bucket the dispatcher can see and fix, mirroring today's
`'Other'`). `Area` in `types.ts` changes from a union to `type Area = string`, and
the fixed `AREAS` array is removed — area pickers now draw from the **distinct
areas present in the loaded parcels** (§4.8), not a hardcoded list.

### 4.3 Lens view widening (`supabase/lens-epod-reader.sql`)
Extend `public.epod_shipment_lookup` to also expose `sender_company,
sender_address1, sender_address2, sender_address3, sender_city, sender_county,
sender_postcode` (still `where is_deleted = false`, still SELECT-only to
`epod_reader`). A deliberate, version-controlled change in the **Lens** project;
the PII boundary grows to include sender addresses (recorded in ADR 0004).
*Return-to / phone / email / tax stay excluded.*

### 4.4 `enrich-shipments` + `enrich.ts` — carry the sender block
- **Function:** add the seven `sender_*` columns to the SELECT and to
  `ShipmentRow`. No other change (same admin gate, batch cap, found/notFound).
- **`enrich.ts` (stays pure / node-testable):** add `composeSenderAddress(row)`
  and `senderName(row, names?)`; `shipmentToParcelInput(row, names?)` now also sets
  `sender_address_line`, `sender_postcode`,
  `collection_area = postcodeArea(sender_postcode)`,
  `delivery_area = postcodeArea(recipient_postcode)`, and `sender_name` =
  `Sender_Company` if present, else `names[sender_postcode]` from the optional
  `collection_points` map (§4.5), else null. `EnrichCard` fetches that map once
  and passes it in, so `enrich.ts` never touches the network. The friendly name
  is **baked into the parcel at import** — see §4.5 for why.

### 4.5 `collection_points` lookup — names/pins for known shops
Tiny table: `postcode text primary key` (full sender postcode, e.g. `SL4 1DE`),
`name text`, `pin geography(point,4326) null`. **Resolved at import, not at
runtime:** when enrich builds a parcel it copies the matched shop `name` into
`parcels.sender_name` (§4.4). So the driver's Collect phase reads `sender_name`
straight off the already-offline-cached parcel — no extra table fetch, no Dexie
schema change, offline "just works"; the Collect group header uses `sender_name`,
falling back to `sender_address_line` when there's no match. The trade-off: a
shop rename only affects parcels imported *after* the edit (fine for a hand-filled
pilot list — re-import refreshes). **Never** feeds allocation or the lifecycle —
names only. `pin` is stored for a future collect-side map but is unused today (no
map in the driver app yet). RLS: readable by any authenticated user, writable by
admin.

### 4.6 Allocation (`AllocateScreen` / auto-allocate)
Auto-allocate changes from one-dimensional (`parcel.area ∈ route.areas`) to
two-dimensional: a parcel is offered to route R when
`collection_area ∈ R.collection_areas AND delivery_area ∈ R.delivery_areas`. The
dispatcher keeps a day's route sets non-overlapping so each parcel matches exactly
one route; if two match, first-by-name wins and the screen flags the overlap.
**Remove the per-parcel area `<select>` override** (and its `assignArea` write):
areas are now derived deterministically from the postcode, so there's no fixed
list to pick from and nothing meaningful to hand-edit. A parcel that won't
auto-allocate (blank/unknown area) is still assignable by hand via the existing
route dropdown; the fix for a *wrong* area is a correct postcode (re-enrich), not
a manual relabel. When a parcel matches no route, the "why unallocated" hint
becomes two-part (which side missed), so the dispatcher can see whether it's the
collection or the delivery area that has no home.

### 4.7 Driver run — two phases (`StopsScreen`, `App.tsx`)
The run sheet gains a **Collect** phase and a **Deliver** phase (a segmented
control at the top; Collect leads):
- **Collect** — route parcels grouped by **Collection point** (distinct
  `sender_postcode` → `collection_points.name` or `sender_address_line`). Each
  group is a card: site name/address, "collect N here", and the parcels. The
  existing scan sheet's `collection` stage quick-scans each parcel → `collected`
  (no photo). Header progress: "Collected 12 / 20".
- **Deliver** — the current stop list and full POD capture, unchanged, scoped to
  the route's parcels. A parcel becomes deliverable once collected; **warn-but-
  allow** if a driver delivers an un-collected parcel (matches the existing
  ordering philosophy — the forward-only RPC prevents regressions either way).
- `App.tsx` view state gains the phase; `useParcels`/route filter unchanged
  (parcels are already route-scoped). Offline/queue behaviour unchanged — both
  scans drain through the same sync worker.

### 4.8 Dispatcher route editor (`RoutesPanel`)
Replace the single "Covers areas" checklist with **two** multi-selects —
"Collects from (areas)" → `collection_areas[]` and "Delivers to (areas)" →
`delivery_areas[]` — each populated from the distinct collection/delivery areas
present in the current parcel set, with free entry for a not-yet-seen code
(upper-cased to match `postcodeArea`'s output so the `∈` test never misses on
case). A route's
header reads e.g. `DY → EH·G·ML`.

### 4.9 Remove the manifest file-upload path (`ImportCard`)
Redundant now that every parcel enters by tracking-number enrichment (the upload's
own "tracking-only" branch already just forwarded to the same lookup). **Remove**
`JobsScreen`'s `ImportCard` (the `.xlsx`/`.csv` upload + column-mapping UI) and the
machinery only it uses in `manifest.ts` — `parseManifestFile`, `autoMap`,
`buildParcelInputs`, `splitRowsForEnrichment`, `MANIFEST_FIELDS`, `SYNONYMS`,
`ManifestField`, `ColumnMapping`, `ParsedManifest`, `toArea` — plus the
`xlsx`/SheetJS dependency (its sole consumer; dropping it shrinks the bundle).
**Keep** `EnrichCard` (paste tracking numbers → GWOptical), the `ParcelInput` type
(still returned by `enrich.ts`, consumed by `commitParcels`), the `manifests`/
"jobs" table + grouping (enrichment still creates a job), and the tracking-CSV
export. Relabel the screen's "Import a manifest" / "Jobs & manifests" copy to the
single tracking-number path. This also dissolves any "how does a manifest carry
sender columns" question — there is no manifest upload to carry them.

## 5. Data model changes (consolidated)

- `parcels`: **+** `sender_name`, `sender_address_line`, `sender_postcode`,
  `collection_area`; **rename** `area → delivery_area`; **drop** the `area` CHECK
  **and** its `default 'South London'` (a London label is a nonsensical default
  for a UK-wide postcode-area column).
- `routes`: **rename** `areas → delivery_areas`; **+** `collection_areas text[]`.
- **new** `collection_points (postcode pk, name, pin)`.
- `Area` type → `string`; `AREAS` removed; `deriveArea → postcodeArea`.
- Mirror every DDL change in `supabase/cloud-setup.sql` (hosted project isn't
  CLI-migration-tracked — apply live via `execute_sql`, as the 0617 spec did).
- Lifecycle enum, `pod_records`, `pod_photos`, `parcel_events`: **unchanged**.

**Full `area → delivery_area` rename inventory.** TS strict catches the `.ts`
sites at `npm run build`; the `.mjs`/SQL ones fail only at *runtime*, so they're
listed explicitly to stop a green build from hiding a broken script:
- *Compiler-checked* (`.ts`/`.tsx`): `types.ts` (`Parcel.area`, `Route.areas`,
  `Area`, `AREAS`); `enrich.ts`; `AllocateScreen.tsx`; `RoutesPanel.tsx`;
  `StopsScreen.tsx` (the gold area chip, ~`:601`); `JobsScreen.tsx` (the `parcels`
  select, `JobParcel.area`, the area pill, and the CSV export's
  `parcel:parcels(…,area,…)` join); `trackingExport.ts` (`pod.area`/`scan.area`).
- *Not* compiler-checked — sweep by hand: `cloud-setup.sql`, `seed.sql`, and the
  scripts that `select('area')` (`smoke-db.mjs`, `seed-cloud.mjs`,
  `seed-cloud-job.mjs`, `test-manifest.mjs`, `probe-cloud.mjs`).
- `manifest.ts` is largely **deleted** (§4.9); only `ParcelInput` survives — there
  `area` becomes `delivery_area` and the four sender fields are added.

## 6. Lifecycle & scanning

No lifecycle surgery. `awaiting_collection → collected → delivered` is the happy
path; `→ at_warehouse →` remains available for exceptions. Collection = the
existing per-parcel quick scan (time + GPS + driver, no photo) via the scan
sheet's `collection` stage; delivery = the existing full POD. Both already forward
to GWOptical (`CTCL`/`I2I04`/`VS` collection codes; delivered/failed PODs).

## 7. Idempotency

Unchanged. Parcels upsert on `tracking_number`; every server write stays keyed on
the client-generated `podId`/event UUID; deterministic storage paths. Re-import
updates rather than duplicates and leaves `route_id`/`status` intact.

## 8. Security & RLS

- Parcels remain route-scoped — a driver still sees only their route's parcels, so
  the collection grouping exposes nothing new cross-route. Collection
  `parcel_events` INSERT RLS (own-route, migration 2026-06-11) already covers the
  collect leg.
- `collection_points` is low-sensitivity (shop names/pins): authenticated read,
  admin write.
- The Lens read stays server-side in `enrich-shipments` under the admin gate; the
  `LENS_DB_URL` read-only role now also reaches the sender columns. PII boundary
  expansion recorded in ADR 0004.

## 9. Coupling & failure modes

- **Bounded coupling unchanged:** origin is copied into `parcels` at import; a Lens
  outage blocks only new enrichment, not existing runs.
- **A parcel with no sender data** (a pre-existing row, or a shipment Lens carries
  no sender for) has no collection leg and a blank `collection_area`, so it can't
  *auto*-allocate (matching needs both areas) — the dispatcher hand-assigns it to a
  route, after which it shows in Deliver only. Non-breaking.
- **Unknown area (`""`)**: surfaces in the dispatcher's area pickers as the unknown
  bucket; the parcel won't auto-allocate, and there's no manual area relabel anymore
  (§4.6) — so the dispatcher either assigns the route by hand or corrects the
  postcode and re-enriches. Mirrors today's `'Other'` needs-review case.

## 10. Open items (user contributions at build time)

- **The pilot `collection_points` rows** — the few shops' friendly names + pins.
  Pure domain data; seed these *before* the first enrich import so the names bake
  into `sender_name` (§4.5).
- **`postcodeArea()` edge rules** — confirm handling of odd inputs (e.g.
  `GIR 0AA`, missing space, lowercase); a small, node-tested function.
- **Allocation overlap policy** — confirm "first route by name wins + flag" is the
  desired tiebreak when a dispatcher's sets overlap.

Tests (repo convention — standalone node `.mjs`, no runner):
- extend `scripts/test-enrich.mjs`: `postcodeArea` (prefix extraction, blank/odd →
  `""`), `composeSenderAddress`, `senderName` (blank company → lookup map, then null),
  `shipmentToParcelInput(row, names)` sets both areas + sender block + mapped name.
- new `scripts/test-allocate.mjs`: two-dimensional match (both-in → matched;
  one-in → not; overlap → first-by-name + flagged).
- trim `scripts/test-manifest.mjs` — the file-build-path tests
  (`buildParcelInputs` etc.) go with the upload (§4.9); keep any enrich/idempotency
  coverage worth saving.
- manual e2e: import with sender data → two areas derived; build a `DY → EH` route
  → parcels auto-allocate; driver Collect (group by site, quick-scan) → Deliver
  (POD); a no-sender parcel shows in Deliver only; a known shop shows its lookup name.

## 11. Rollout / migration steps (high level)

1. **Lens:** widen `epod_shipment_lookup` with the `sender_*` columns
   (`lens-epod-reader.sql`); re-grant unchanged.
2. **ePOD DDL** (live `execute_sql` + `cloud-setup.sql` + `seed.sql`): `parcels`
   sender columns + `area→delivery_area` + drop CHECK & default; `routes`
   `areas→delivery_areas` + `collection_areas`; new `collection_points`.
   ⚠ **Data check first** — the rename *keeps* existing values: any live parcel
   keeps its old London label as `delivery_area` (invalid as a postcode area), and
   every existing route keeps London-label `delivery_areas` with an empty
   `collection_areas` (so nothing auto-allocates). Confirm the hosted `parcels`/
   `routes` are empty (the clean-break assumption), or backfill
   `delivery_area = postcodeArea(postcode)` and rebuild routes, before trusting
   allocation.
3. **ePOD code:** `types.ts` (`Area = string`, drop `AREAS`); `enrich.ts`
   (`postcodeArea`, sender compose, both areas, name-from-map); `enrich-shipments`
   SELECT; `ParcelInput` (sender fields, `delivery_area`).
4. **Remove the manifest upload** (§4.9): delete `ImportCard` + the file/mapping
   machinery in `manifest.ts` + the `xlsx` dependency; relabel the Jobs copy.
5. **Sweep the `area` consumers** (§5 inventory): the `.ts` sites first, then the
   `.mjs`/SQL that `tsc` won't catch.
6. **Allocation + routes editor** (`AllocateScreen`, `RoutesPanel`):
   two-dimensional; remove the per-parcel area override.
7. **Driver run** (`StopsScreen`, `App.tsx`): Collect/Deliver phases.
8. Seed pilot `collection_points` **first**, then re-import tracking numbers to
   test (names bake in). `npm run build` before committing; push → Vercel rebuild.
