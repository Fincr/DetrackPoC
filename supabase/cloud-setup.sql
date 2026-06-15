-- ePOD PoC: ONE-PASTE cloud setup for a FRESH hosted Supabase project.
-- Paste this whole file into the dashboard SQL Editor and Run, then create the
-- demo logins:
--
--   $env:SUPABASE_URL = "https://<your-ref>.supabase.co"
--   $env:SUPABASE_SERVICE_ROLE_KEY = "<service role key from Settings → API>"
--   node scripts/seed-auth.mjs
--
-- This is the complete, current schema + demo seed (mirrors supabase/migrations
-- + seed.sql as of 2026-06-11: region areas, parcel lifecycle, sites, atomic
-- status RPCs, RLS everywhere, private evidence bucket). Safe to re-run.

create extension if not exists postgis;

-- ── fleet ────────────────────────────────────────────────────────────────────
-- A ROUTE is a driver's run (one English region); parcels/sites are allocated
-- to a route, and each route is run by one driver. driver_id is text to match
-- pod_records.driver_id.
create table if not exists drivers (
  id         text primary key,
  name       text not null,
  created_at timestamptz default now()
);

create table if not exists routes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  driver_id  text references drivers(id),
  -- Regions this route covers — powers the dispatcher's "auto-allocate by area"
  areas      text[] not null default '{}',
  created_at timestamptz default now()
);

-- ── jobs / manifests ─────────────────────────────────────────────────────────
-- Importing a parcel manifest (.xlsx) creates a batch of parcels (each row
-- carries its own tracking number); parcels.manifest_id links them.
create table if not exists manifests (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  reference       text,
  source_filename text,
  imported_at     timestamptz default now(),
  created_at      timestamptz default now()
);

-- ── parcels ──────────────────────────────────────────────────────────────────
-- status IS the lifecycle: awaiting_collection → collected → at_warehouse →
-- delivered (or terminal 'returned' after max failed attempts). Forward-only —
-- see advance_parcel_status below.
create table if not exists parcels (
  id              uuid primary key default gen_random_uuid(),
  tracking_number text unique not null,      -- the barcode value on the label
  recipient_name  text not null,
  address_line    text not null,
  postcode        text,
  destination     geography(point, 4326),    -- where it *should* go (geofence)
  area            text default 'Greater London'
                  check (area in ('Greater London','South East','North West')),
  status          text default 'awaiting_collection'
                  check (status in ('awaiting_collection','collected','at_warehouse','delivered','returned')),
  -- The run this parcel belongs to. Not terminal AND due_date < today =
  -- rollover (derived in the app — no nightly job).
  due_date        date not null default current_date,
  attempts        int not null default 0,    -- failed delivery attempts so far
  last_failure    text,
  completed_at    timestamptz,               -- set when the stop goes terminal
  -- Allocation link. null = unallocated: dispatcher to-do, hidden from drivers.
  route_id        uuid references routes(id),
  manifest_id     uuid references manifests(id),
  meta            jsonb,                     -- extra manifest columns, verbatim
  created_at      timestamptz default now()
);
create index if not exists parcels_route_idx on parcels(route_id);
create index if not exists parcels_manifest_idx on parcels(manifest_id);

-- ── sites ────────────────────────────────────────────────────────────────────
-- Stores/depots delivered to WITHOUT a per-item manifest: the driver scans and
-- captures proof against the site itself. Allocated to routes like parcels.
create table if not exists sites (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  address_line text,
  postcode     text,
  kind         text not null default 'store' check (kind in ('store','depot','both')),
  destination  geography(point, 4326),
  route_id     uuid references routes(id),
  created_at   timestamptz default now()
);
create index if not exists sites_route_idx on sites(route_id);

-- ── proof of delivery ────────────────────────────────────────────────────────
create table if not exists pod_records (
  id              uuid primary key default gen_random_uuid(),
  parcel_id       uuid references parcels(id),
  site_id         uuid references sites(id), -- capture against a site (parcel_id null)
  tracking_scanned text not null,
  status          text not null check (status in ('delivered','failed')),
  failure_reason  text,
  received_by     text,
  captured_at     timestamptz not null,      -- device clock at the shutter (evidence time)
  synced_at       timestamptz default now(), -- server clock at first insert (trust stamp)
  location        geography(point, 4326),    -- null = no real fix (never simulated)
  gps_accuracy_m  int,
  gps_simulated   boolean default false,     -- legacy; new captures always write false
  gps_source      text check (gps_source in ('photo_exif','device','simulated')),
  dest_distance_m int,                       -- geofence: metres from destination at capture
  signature_path  text,
  driver_id       text default 'drv_demo',
  created_at      timestamptz default now(),
  constraint failed_needs_reason check (status <> 'failed' or failure_reason is not null)
);
create index if not exists pod_records_parcel_idx on pod_records(parcel_id);
create index if not exists pod_records_site_idx on pod_records(site_id);

create table if not exists pod_photos (
  id            uuid primary key default gen_random_uuid(),
  pod_id        uuid references pod_records(id) on delete cascade,
  photo_type    text not null check (photo_type in ('label','where_left')),
  storage_path  text not null,
  orig_kb       int,
  compressed_kb int,
  unique (pod_id, photo_type)               -- idempotent photo upserts
);
create index if not exists pod_photos_pod_idx on pod_photos(pod_id);

-- ── lifecycle scan events ────────────────────────────────────────────────────
-- One row per stage scan (collection/warehouse quick scans; 'delivered' is
-- written by the POD sync with id = the pod's id). id = client UUID =
-- idempotency key, exactly like pod_records.
create table if not exists parcel_events (
  id              uuid primary key,
  parcel_id       uuid references parcels(id),
  tracking_scanned text not null,
  stage           text not null check (stage in ('collection','warehouse','delivered')),
  captured_at     timestamptz not null,
  synced_at       timestamptz default now(),
  location        geography(point, 4326),
  gps_accuracy_m  int,
  gps_source      text check (gps_source in ('photo_exif','device','simulated')),
  driver_id       text references drivers(id),
  created_at      timestamptz default now()
);
create index if not exists parcel_events_parcel_idx on parcel_events(parcel_id);

-- ── auth: profiles + role helpers ────────────────────────────────────────────
-- A profiles row maps each auth user to a role (admin|driver) and, for
-- drivers, a drivers.id. Created by scripts/seed-auth.mjs.
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin','driver')),
  driver_id  text references drivers(id),
  full_name  text,
  created_at timestamptz not null default now()
);

create or replace function public.auth_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid(); $$;
create or replace function public.auth_driver_id() returns text
  language sql stable security definer set search_path = public as $$
  select driver_id from profiles where id = auth.uid(); $$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.auth_role() = 'admin', false); $$;

-- ── atomic status transitions ────────────────────────────────────────────────
create or replace function public.status_rank(s text) returns int
  language sql immutable set search_path = public as $$
  select case s
    when 'awaiting_collection' then 0
    when 'collected'           then 1
    when 'at_warehouse'        then 2
    when 'delivered'           then 3
    when 'returned'            then 3
    else 0
  end;
$$;

-- Forward-only advance: a late-syncing scan can never regress a parcel.
-- SECURITY INVOKER — parcels RLS still applies to the caller.
create or replace function public.advance_parcel_status(p_id uuid, p_to text) returns void
  language sql security invoker set search_path = public as $$
  update parcels
     set status = p_to
   where id = p_id
     and public.status_rank(p_to) > public.status_rank(status);
$$;

-- Failed delivery attempt: attempts DERIVED from failed POD rows (a sync retry
-- of the same pod can't double-count); terminal 'returned' at p_max.
create or replace function public.apply_failed_attempt(p_id uuid, p_reason text, p_max int) returns void
  language plpgsql security invoker set search_path = public as $$
declare
  n int;
begin
  select count(*) into n from pod_records where parcel_id = p_id and status = 'failed';
  update parcels
     set attempts     = n,
         last_failure = p_reason,
         status       = case when n >= p_max then 'returned' else status end,
         completed_at = case when n >= p_max then now() else null end
   where id = p_id;
end;
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- admin = full access; driver = only parcels/sites/PODs/events on their own
-- route(s); anonymous = nothing.
alter table profiles      enable row level security;
alter table drivers       enable row level security;
alter table routes        enable row level security;
alter table manifests     enable row level security;
alter table parcels       enable row level security;
alter table pod_records   enable row level security;
alter table pod_photos    enable row level security;
alter table sites         enable row level security;
alter table parcel_events enable row level security;

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select using (id = auth.uid() or public.is_admin());

drop policy if exists drivers_select on drivers;
create policy drivers_select on drivers for select using (auth.uid() is not null);
drop policy if exists drivers_admin_write on drivers;
create policy drivers_admin_write on drivers for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists routes_select on routes;
create policy routes_select on routes for select using (public.is_admin() or driver_id = public.auth_driver_id());
drop policy if exists routes_admin_write on routes;
create policy routes_admin_write on routes for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists parcels_select on parcels;
create policy parcels_select on parcels for select
  using (public.is_admin() or route_id in (select id from routes where driver_id = public.auth_driver_id()));
drop policy if exists parcels_update on parcels;
create policy parcels_update on parcels for update
  using (public.is_admin() or route_id in (select id from routes where driver_id = public.auth_driver_id()))
  with check (public.is_admin() or route_id in (select id from routes where driver_id = public.auth_driver_id()));
drop policy if exists parcels_admin_insert on parcels;
create policy parcels_admin_insert on parcels for insert with check (public.is_admin());
drop policy if exists parcels_admin_delete on parcels;
create policy parcels_admin_delete on parcels for delete using (public.is_admin());

drop policy if exists manifests_admin_all on manifests;
create policy manifests_admin_all on manifests for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists pod_records_select on pod_records;
create policy pod_records_select on pod_records for select using (public.is_admin() or driver_id = public.auth_driver_id());
drop policy if exists pod_records_insert on pod_records;
create policy pod_records_insert on pod_records for insert with check (public.is_admin() or driver_id = public.auth_driver_id());
drop policy if exists pod_records_update on pod_records;
create policy pod_records_update on pod_records for update
  using (public.is_admin() or driver_id = public.auth_driver_id())
  with check (public.is_admin() or driver_id = public.auth_driver_id());

drop policy if exists pod_photos_select on pod_photos;
create policy pod_photos_select on pod_photos for select
  using (exists (select 1 from pod_records pr where pr.id = pod_id and (public.is_admin() or pr.driver_id = public.auth_driver_id())));
drop policy if exists pod_photos_insert on pod_photos;
create policy pod_photos_insert on pod_photos for insert
  with check (exists (select 1 from pod_records pr where pr.id = pod_id and (public.is_admin() or pr.driver_id = public.auth_driver_id())));

drop policy if exists sites_select on sites;
create policy sites_select on sites for select
  using (public.is_admin() or route_id in (select id from routes where driver_id = public.auth_driver_id()));
drop policy if exists sites_admin_write on sites;
create policy sites_admin_write on sites for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists parcel_events_select on parcel_events;
create policy parcel_events_select on parcel_events for select
  using (public.is_admin() or driver_id = public.auth_driver_id());
-- Hardened: the parcel must be ON the driver's own route, not just their id.
drop policy if exists parcel_events_insert on parcel_events;
create policy parcel_events_insert on parcel_events for insert
  with check (
    public.is_admin()
    or (
      driver_id = public.auth_driver_id()
      and parcel_id in (
        select p.id from parcels p
        where p.route_id in (select r.id from routes r where r.driver_id = public.auth_driver_id())
      )
    )
  );
drop policy if exists parcel_events_update on parcel_events;
create policy parcel_events_update on parcel_events for update
  using (public.is_admin() or driver_id = public.auth_driver_id())
  with check (public.is_admin() or driver_id = public.auth_driver_id());

-- ── storage: private evidence bucket ─────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('pod-evidence', 'pod-evidence', false)
on conflict (id) do nothing;

drop policy if exists "pod evidence read" on storage.objects;
create policy "pod evidence read" on storage.objects for select
  using (bucket_id = 'pod-evidence' and auth.uid() is not null);
drop policy if exists "pod evidence upload" on storage.objects;
create policy "pod evidence upload" on storage.objects for insert
  with check (bucket_id = 'pod-evidence' and auth.uid() is not null);

-- ── realtime ─────────────────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table pod_records;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table parcels;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table manifests;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table sites;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table parcel_events;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ── demo seed (mirrors supabase/seed.sql) ────────────────────────────────────
-- 3 drivers, one English region each.
insert into drivers (id, name) values
  ('drv_demo',  'Sam Okafor'),
  ('drv_priya', 'Priya Nair'),
  ('drv_dan',   'Dan Whitlock')
on conflict (id) do nothing;

insert into routes (name, driver_id, areas) values
  ('Greater London', 'drv_demo',  array['Greater London']),
  ('South East',     'drv_priya', array['South East']),
  ('North West',     'drv_dan',   array['North West'])
on conflict (name) do nothing;

-- 8 parcels across the three regions. CP-849213-GB = the design-reference parcel.
insert into parcels (tracking_number, recipient_name, address_line, postcode, destination, area) values
  ('CP-849213-GB', 'Meridian Logistics',          'Unit 4, Hailey Road Industrial Estate, Erith', 'DA18 4AA',
   st_setsrid(st_makepoint(0.17700, 51.48400), 4326)::geography, 'Greater London'),
  ('CP-100002-GB', 'Patricia Holloway',           '14 Larkspur Close, Maidstone',                 'ME14 9QT',
   st_setsrid(st_makepoint(0.53940, 51.28790), 4326)::geography, 'South East'),
  ('CP-100003-GB', 'Dev & Sons Hardware',         '88 Roman Road, Bethnal Green, London',         'E2 0QJ',
   st_setsrid(st_makepoint(-0.04900, 51.53090), 4326)::geography, 'Greater London'),
  ('CP-200004-GB', 'Brightwell Imports Ltd',      '22 Deansgate, Manchester',                     'M3 2BW',
   st_setsrid(st_makepoint(-2.24860, 53.47950), 4326)::geography, 'North West'),
  ('CP-200005-GB', 'Atlantique Wines (UK)',       '8 Marine Parade, Brighton',                    'BN2 1TL',
   st_setsrid(st_makepoint(-0.13720, 50.81980), 4326)::geography, 'South East'),
  ('CP-300006-GB', 'Acme Home Goods — J. Mercer', '3 Dale Street, Liverpool',                     'L2 2HF',
   st_setsrid(st_makepoint(-2.98800, 53.40840), 4326)::geography, 'North West'),
  ('CP-300007-GB', 'Tillys Toy Shop',             '27 Deansgate, Bolton',                         'BL1 1BL',
   st_setsrid(st_makepoint(-2.42820, 53.57800), 4326)::geography, 'North West'),
  ('CP-400008-GB', 'Thames Valley Depot',         'Unit 9, Saddlers Way, Reading',                'RG1 1AX',
   st_setsrid(st_makepoint(-0.97810, 51.45430), 4326)::geography, 'South East')
on conflict (tracking_number) do nothing;

-- One stop left over from yesterday's run → visible ROLLOVER on first load.
update parcels set due_date = current_date - 1 where tracking_number = 'CP-100003-GB';

-- Allocate by region, leaving two unallocated so the dispatcher can demo
-- manual + auto allocation.
update parcels p set route_id = r.id
  from routes r
  where p.area = any (r.areas)
    and p.route_id is null
    and p.tracking_number not in ('CP-100002-GB', 'CP-300007-GB');

-- Sites: one per region route + one unallocated (guarded by name on re-runs).
insert into sites (name, address_line, postcode, kind, destination, route_id)
select v.name, v.address_line, v.postcode, v.kind,
       st_setsrid(st_makepoint(v.lng, v.lat), 4326)::geography,
       (select id from routes r where r.name = v.route_name)
from (values
  ('Citipost Collect — Camden',  '112 Camden High Street, London',         'NW1 0LU', 'store', -0.14260, 51.53900, 'Greater London'),
  ('Gatwick Parcel Depot',       'Beehive Ring Road, Gatwick, Crawley',    'RH6 0PA', 'depot', -0.18210, 51.15370, 'South East'),
  ('Trafford Park Fulfilment',   'Mosley Road, Trafford Park, Manchester', 'M17 1AB', 'both',  -2.32000, 53.46700, 'North West'),
  ('Citipost Collect — Reading', '5 Broad Street, Reading',                'RG1 2BH', 'store', -0.97500, 51.45520, null)
) as v(name, address_line, postcode, kind, lng, lat, route_name)
where not exists (select 1 from sites s where s.name = v.name);

-- Done. Now create the demo logins (admin + 3 drivers, password "citipost"):
--   node scripts/seed-auth.mjs   (with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set)
