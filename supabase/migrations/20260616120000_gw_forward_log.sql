-- ePOD → GWOptical forwarder bookkeeping.
-- One row per ePOD tracking event handed to GWOptical's intake table
-- (dbo.TrackingLogExport). scripts/forward_gw_events.py reads ePOD events
-- (parcel_events: collection/warehouse · pod_records: delivered/failed),
-- pushes each to GWOptical, and records the handover + export state here.
--
-- This is bookkeeping only — ePOD's parcel_events/pod_records remain the
-- system of record for the events; GWOptical owns them once exported.
--
-- RLS enabled with NO policies: invisible to anon/authenticated (deny by
-- default). The forwarder connects as `postgres` (Session Pooler) and bypasses
-- RLS. No app user ever reads this table.
create table if not exists public.gw_forward_log (
  source           text        not null check (source in ('event','pod')),
  source_id        uuid        not null,  -- ePOD client UUID (parcel_events.id / pod_records.id)
  tracking_number  text        not null,
  carrier_code     text        not null,  -- DHL CarrierCode sent to the intake (CTCL/WH10/DT15/DF48)
  event_at         timestamptz not null,  -- captured_at of the source event
  forwarded_at     timestamptz not null default now(),
  gw_export_id     bigint,                -- dbo.TrackingLogExport.Id returned on insert
  exported_at      timestamptz,           -- set once GWOptical's pull marks the row Exported
  primary key (source, source_id)
);

alter table public.gw_forward_log enable row level security;
