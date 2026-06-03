-- ePOD PoC schema (§4 of the brief).
-- PoC posture: RLS is left DISABLED on these tables and the bucket is public —
-- there is no real auth (hardcoded demo driver). Do not ship this to prod.

create extension if not exists postgis;

-- The parcels / jobs a driver is delivering today
create table parcels (
  id              uuid primary key default gen_random_uuid(),
  tracking_number text unique not null,      -- the barcode value read off the label
  recipient_name  text not null,
  address_line    text not null,
  postcode        text,
  destination     geography(point, 4326),    -- where it *should* go
  area            text default 'Domestic'
                  check (area in ('Domestic','International','Fulfilment','Sortation')),
  status          text default 'pending'
                  check (status in ('pending','delivered','failed')),
  created_at      timestamptz default now()
);

-- One proof-of-delivery record per delivery attempt
create table pod_records (
  id              uuid primary key default gen_random_uuid(),
  parcel_id       uuid references parcels(id),
  tracking_scanned text not null,            -- what the driver actually scanned
  status          text not null check (status in ('delivered','failed')),
  failure_reason  text,                      -- required when status = failed
  received_by     text,                      -- name, or "left in porch", etc.
  captured_at     timestamptz not null,      -- device clock, at moment of capture (evidence time)
  -- Server clock = trust stamp. Rows are only ever inserted at upload time
  -- (directly when online, or by the sync worker draining the queue), so a
  -- plain default gives the server-side receive time without trusting the client.
  synced_at       timestamptz default now(),
  location        geography(point, 4326),
  gps_accuracy_m  int,
  gps_simulated   boolean default false,     -- true if the device couldn't get a real fix
  signature_path  text,                      -- storage path, nullable
  driver_id       text default 'drv_demo',
  created_at      timestamptz default now(),

  -- A failed delivery must say why (acceptance test 3 enforces this in the UI too)
  constraint failed_needs_reason check (status <> 'failed' or failure_reason is not null)
);

create index pod_records_parcel_idx on pod_records(parcel_id);

-- A POD can have multiple photos (label, where-left, etc.)
create table pod_photos (
  id            uuid primary key default gen_random_uuid(),
  pod_id        uuid references pod_records(id) on delete cascade,
  photo_type    text not null check (photo_type in ('label','where_left')),
  storage_path  text not null,
  orig_kb       int,
  compressed_kb int,

  -- One photo per type per POD; lets the sync worker upsert idempotently
  unique (pod_id, photo_type)
);

create index pod_photos_pod_idx on pod_photos(pod_id);

-- Evidence bucket. Public read keeps the dispatcher view simple (no signed
-- URLs in a PoC); uploads are allowed to this bucket only.
insert into storage.buckets (id, name, public)
values ('pod-evidence', 'pod-evidence', true)
on conflict (id) do nothing;

create policy "pod evidence read"
  on storage.objects for select
  using (bucket_id = 'pod-evidence');

create policy "pod evidence upload"
  on storage.objects for insert
  with check (bucket_id = 'pod-evidence');
