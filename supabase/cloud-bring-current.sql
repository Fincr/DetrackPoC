-- Bring an OLD hosted project (parcels/pod_records/pod_photos only) fully
-- up to date: rollover, attempts/geofence, drivers+routes, manifests,
-- completed_at, then auth + RLS. Idempotent where it can be. Paste this
-- whole file into the Supabase SQL Editor for project ydhypslunoybvwoslyss,
-- then run: SUPABASE_URL=https://ydhypslunoybvwoslyss.supabase.co \
--          SUPABASE_SERVICE_ROLE_KEY=<service key> node scripts/seed-auth.mjs


-- ============================================================
-- cloud-update-rollover.sql
-- ============================================================
-- Paste into the Supabase dashboard SQL Editor of an EXISTING cloud project
-- (https://supabase.com/dashboard/project/_/sql/new) to bring it up to the
-- rollover + gps_source schema. Safe to run more than once.

alter table parcels
  add column if not exists due_date date not null default current_date;

alter table pod_records
  add column if not exists gps_source text not null default 'device'
  check (gps_source in ('photo_exif', 'device', 'simulated'));

-- Demo rollover: yesterday's leftover stop (only while it is still pending)
update parcels set due_date = current_date - 1
where tracking_number = 'CP-100003-GB' and status = 'pending';

-- ============================================================
-- cloud-update-attempts.sql
-- ============================================================
-- Paste into the Supabase dashboard SQL Editor of the EXISTING cloud project
-- (https://supabase.com/dashboard/project/_/sql/new) after pulling the
-- attempt-model + geofence build. Identical to migration 20260603180000.
-- Safe to run more than once.

alter table parcels add column if not exists attempts int not null default 0;
alter table parcels add column if not exists last_failure text;

alter table parcels drop constraint if exists parcels_status_check;
alter table parcels add constraint parcels_status_check
  check (status in ('pending', 'delivered', 'failed', 'returned'));

alter table pod_records add column if not exists dest_distance_m int;

do $$ begin
  alter publication supabase_realtime add table pod_records;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- ============================================================
-- cloud-update-routes.sql
-- ============================================================
-- Paste into the Supabase dashboard SQL Editor of the EXISTING cloud project
-- (https://supabase.com/dashboard/project/_/sql/new) after pulling the
-- driver/route allocation build. Mirrors migration 20260610120000 plus the
-- demo fleet seed, and allocates the parcels already in the project by area.
-- Safe to run more than once.

create table if not exists drivers (
  id         text primary key,
  name       text not null,
  created_at timestamptz default now()
);

create table if not exists routes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  driver_id  text references drivers(id),
  areas      text[] not null default '{}',
  created_at timestamptz default now()
);

alter table parcels add column if not exists route_id uuid references routes(id);
create index if not exists parcels_route_idx on parcels(route_id);

-- Demo fleet (drv_demo = the design-reference driver / default identity).
insert into drivers (id, name) values
  ('drv_demo',  'Sam Okafor'),
  ('drv_priya', 'Priya Nair'),
  ('drv_dan',   'Dan Whitlock')
on conflict (id) do nothing;

insert into routes (name, driver_id, areas) values
  ('Greater London',     'drv_demo',  array['Domestic']),
  ('International & Air', 'drv_priya', array['International']),
  ('Fulfilment & Sort',  'drv_dan',   array['Fulfilment', 'Sortation'])
on conflict (name) do nothing;

-- Allocate existing unallocated parcels by area, leaving two for the demo.
update parcels p set route_id = r.id
  from routes r
  where p.area = any (r.areas)
    and p.route_id is null
    and p.tracking_number not in ('CP-100002-GB', 'CP-300007-GB');

-- PoC posture: RLS off on the new tables.
alter table drivers disable row level security;
alter table routes  disable row level security;

-- Live allocations on the driver app + allocation view.
do $$ begin
  alter publication supabase_realtime add table parcels;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- ============================================================
-- cloud-update-manifests.sql
-- ============================================================
-- Paste into the Supabase dashboard SQL Editor of the EXISTING cloud project
-- (https://supabase.com/dashboard/project/_/sql/new) after pulling the
-- manifests/jobs build. Mirrors migration 20260610130000. Safe to re-run.

create table if not exists manifests (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  reference       text,
  source_filename text,
  imported_at     timestamptz default now(),
  created_at      timestamptz default now()
);

alter table parcels add column if not exists manifest_id uuid references manifests(id);
alter table parcels add column if not exists meta jsonb;
create index if not exists parcels_manifest_idx on parcels(manifest_id);

-- PoC posture: RLS off on the new table.
alter table manifests disable row level security;

-- Live updates for the Jobs view.
do $$ begin
  alter publication supabase_realtime add table manifests;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- ============================================================
-- cloud-update-completed-at.sql
-- ============================================================
-- Apply to an existing hosted project to add the parcel completion timestamp
-- (see migrations/20260610140000_completed_at.sql). Safe to run more than once.
alter table parcels add column if not exists completed_at timestamptz;

-- ============================================================
-- cloud-update-auth-rls.sql
-- ============================================================
-- Add real auth + Row Level Security to an existing hosted project. Mirrors
-- migrations/20260610150000_auth_profiles_rls.sql; safe to re-run.
--
-- After applying, create the demo auth users — in the dashboard
-- (Authentication → Users) or with the seed script pointed at the host:
--   SUPABASE_URL=https://<ref>.supabase.co \
--   SUPABASE_SERVICE_ROLE_KEY=<service key> node scripts/seed-auth.mjs
-- (the script also upserts the matching profiles rows).

create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin','driver')),
  driver_id  text references drivers(id),
  full_name  text,
  created_at timestamptz not null default now()
);

create or replace function public.auth_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;
create or replace function public.auth_driver_id() returns text
  language sql stable security definer set search_path = public as $$
  select driver_id from profiles where id = auth.uid();
$$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.auth_role() = 'admin', false);
$$;

alter table profiles    enable row level security;
alter table drivers     enable row level security;
alter table routes      enable row level security;
alter table manifests   enable row level security;
alter table parcels     enable row level security;
alter table pod_records enable row level security;
alter table pod_photos  enable row level security;

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

-- Lock the evidence bucket to signed-in users (was public). The dispatcher
-- reads via signed URLs.
update storage.buckets set public = false where id = 'pod-evidence';
drop policy if exists "pod evidence read" on storage.objects;
create policy "pod evidence read" on storage.objects for select
  using (bucket_id = 'pod-evidence' and auth.uid() is not null);
drop policy if exists "pod evidence upload" on storage.objects;
create policy "pod evidence upload" on storage.objects for insert
  with check (bucket_id = 'pod-evidence' and auth.uid() is not null);

-- ============================================================
-- normalise: real-GPS-only model makes gps_source nullable
-- (no standalone cloud-update existed for this step)
-- ============================================================
alter table pod_records alter column gps_source drop not null;
alter table pod_records alter column gps_source drop default;
