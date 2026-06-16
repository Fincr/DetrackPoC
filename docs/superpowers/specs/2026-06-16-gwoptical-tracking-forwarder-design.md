# ePOD → GWOptical tracking forwarder — design

Date: 2026-06-16
Status: Accepted

## Goal

ePOD-captured tracking events (collection / warehouse / delivered / failed)
flow into GWOptical's `dbo.TrackingLog`, so a parcel ePOD handles shows its
ePOD scans alongside its carrier scans in GWOptical and everything downstream
(its internal portal, Lens, exports).

## Why an intake table, not a direct `TrackingLog` write

GWOptical (`sqlaggw.citipost.co.uk`, SQL Server, DB `GWOptical`) does **not**
accept externally-originated events straight into `dbo.TrackingLog`. It exposes
a handover/intake table `dbo.TrackingLogExport`; its owner (Audrius) runs a
5-minute pull job that maps each row's `CarrierCode` to a CarrierHub
`CodeDescription`, sets `Exported`/`ExportedDateTime`, and lands the event in
`dbo.TrackingLog` with a fresh `ImportedIntoGW`. This is the exact contract the
sibling **Lens** app already uses for its "Manual Events"
(`specsavers-report/scripts/forward_manual_events.py`,
`docs/adr/0002-manual-events-via-gwoptical-intake.md`). We reuse it verbatim.

The box only reachable from is **this automation host** — `sqlaggw` resolves to
private `10.x` addresses, so neither Vercel nor Supabase can reach GWOptical.
The forwarder therefore runs here, not as an Edge Function or Vercel route.

## Architecture & data flow

```
ePOD driver capture ─→ parcel_events / pod_records   (ePOD Supabase mqiwyfhxcjvkpnpbtgql)
                                 │
                forward_gw_events.py  (this host, every 5 min)
     reads un-forwarded events ───┘   └──→ INSERT dbo.TrackingLogExport (Exported=0)
                                                       │
                          Audrius's 5-min pull (CarrierHub maps CarrierCode)
                                                       ▼
                                          dbo.TrackingLog (+ ImportedIntoGW)
```

## Carrier branding (multi-carrier → always DHL)

ePOD parcels span DHL, i2i, Oceanair, DX. Every event is forwarded as
`CarrierProviderName = 'DHL Parcel UK'` regardless of the parcel's real carrier,
because **DHL is the only `CarrierProviderName` whose codes CarrierHub
classifies**. Downstream, GWOptical/Lens relabel the carrier from the parcel's
service, so an Oceanair parcel still reads Oceanair — the scan stays
carrier-agnostic. (Identical to the Lens forwarder's choice.)

`ClientReference = 'EPOD'` marks the origin (Lens uses `'LENS'`).

## Event → CarrierCode map

All four are **real DHL codes already present in live `dbo.TrackingLog`**, so
CarrierHub maps them with no new config (a confirmation to Audrius is still
courteous for the two new ones). Env-overridable.

| ePOD event | source | `CarrierCode` | Canonical CarrierHub description |
|---|---|---|---|
| `collection` | `parcel_events.stage='collection'` | `CTCL` | Driver Collection Scan |
| `warehouse`  | `parcel_events.stage='warehouse'`  | `WH10` | In Delivering Warehouse |
| `delivered`  | `pod_records.status='delivered'`   | `DT15` | Accepted at delivery point |
| `failed`     | `pod_records.status='failed'`      | `DF48` | 48 - No Contact / Access Avail |

`CTCL` / `DT15` are the codes Lens already agreed with Audrius. `WH10` / `DF48`
are new to this feed — worth a heads-up, non-blocking.

The `delivered` parcel_event (id = podId, written by the POD sync) is **excluded**
by the `stage IN ('collection','warehouse')` filter, so delivery is forwarded
once, from its `pod_records` row.

## Components

### 1. `public.gw_forward_log` (ePOD Supabase) — forwarding bookkeeping

One row per ePOD event handed to GWOptical. PK `(source, source_id)` where
`source ∈ {event, pod}` and `source_id` is the ePOD client UUID.

```
source text, source_id uuid, tracking_number text, carrier_code text,
event_at timestamptz, forwarded_at timestamptz default now(),
gw_export_id bigint, exported_at timestamptz
```

RLS **enabled, no policies** — invisible to anon/authenticated; the forwarder
connects as `postgres` (bypasses RLS). ePOD's `parcel_events`/`pod_records`
stay the system of record for the events; this table only tracks *what was
handed to GW and its export state*.

### 2. `scripts/forward_gw_events.py` — the forwarder

Mirrors `forward_manual_events.py`. Two phases, per-row commits, idempotent:

- **push** — discover events with no `gw_forward_log` row (anti-join over
  `parcel_events` stage∈{collection,warehouse} + `pod_records`
  status∈{delivered,failed}, **parcel-linked only** — site captures excluded),
  INSERT each into `dbo.TrackingLogExport`, commit GW, then record bookkeeping.
- **sync** — for forwarded-but-not-exported rows, copy GW's
  `Exported`/`ExportedDateTime` flag back into `gw_forward_log.exported_at`.
- No **recall** phase — ePOD has no "delete event" UI (YAGNI; manual SQL if ever
  needed).

Single-instance via `pg_try_advisory_lock(7242116003)` (loader holds …001, the
Lens forwarder …002, so they never collide). `--dry-run` logs without writing.

### Field mapping (`dbo.TrackingLogExport` ← ePOD)

| Intake column | Source |
|---|---|
| `CarrierProviderName` | `'DHL Parcel UK'` (constant) |
| `TrackingNumber` | `parcels.tracking_number` (≤50) |
| `ClientReference` | `'EPOD'` |
| `CarrierCode` | code map above |
| `TrackingDate` / `TrackingDateTime` | `captured_at` → Europe/London local, tz-naive |
| `TrackingLocation` | parcel `postcode` ?? `area` (≤200) |
| `Latitude` / `Longitude` | captured fix via `ST_Y`/`ST_X(location)` — `decimal(10,7)` |
| `TrackingAdditionalInfo` | `received_by` (delivered) / `failure_reason` (failed) (≤200) |
| `AddedDate` / `Exported` | `now()` UK-local / `0` |

## Idempotency & safety

- **Primary:** `gw_forward_log` PK on the ePOD event UUID → never re-push.
- **Backstop:** the intake dedups on `(CarrierCode + TrackingNumber +
  TrackingDateTime)` — a crash between the GW insert and the bookkeeping write
  re-pushes harmlessly (ingested-but-ignored), matching ePOD's own
  client-UUID idempotency philosophy.
- Per-row commits; advisory lock prevents overlapping runs. GW datetimes are
  UK-local naive — `captured_at` (stored UTC) is converted at read time.

## Connections & secrets

- `GWOPTICAL_CONN` — ODBC string for `sqlaggw` (same value Lens uses).
- `EPOD_DATABASE_URL` — ePOD Supabase **Session Pooler** URI (carries the DB
  password; the `postgres` role bypasses RLS).

Both live only in a gitignored `scripts/.env`. No secret is committed.

## Scheduling (productionization)

Register with the Global-Intelligence daemon to run every ~5 min, alongside the
Lens loader/forwarder. Documented in `scripts/README` of this feature; wiring is
a follow-up once the end-to-end test passes.

## Test plan

Seed one marked test parcel + a `delivered` POD in ePOD Supabase → run the
forward logic → confirm the row in `dbo.TrackingLogExport` → **recall**
(`DELETE … WHERE Exported = 0`) → clean up the test rows. Proves the full pipe
and leaves zero residue in GWOptical (the test tracking number matches no
shipment, so even an accidental export attaches to nothing).

## Out of scope (YAGNI)

- Photo passthrough (`TrackingPhoto`) — evidence lives in private storage; skip.
- Site (store/depot) captures — not parcels; excluded.
- Recall UI / event editing.
- Backfill of historical events — the forwarder picks up everything un-logged
  on first run; if that's undesirable, pre-seed `gw_forward_log`.
