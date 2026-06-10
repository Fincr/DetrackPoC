-- Drivers, routes, and parcel allocation.
--
-- Allocation model: a ROUTE is a driver's run for the day; parcels are
-- allocated to a route (parcels.route_id). Each route is run by one driver, so
-- allocating a parcel to a route implicitly assigns it to that driver. The
-- dispatcher allocates (manual or auto-by-area); the driver app filters to the
-- selected driver's run. PoC posture unchanged: no auth, RLS off, demo rows
-- live in seed.sql.

-- driver_id is text to match the existing pod_records.driver_id (default
-- 'drv_demo') — no type juggling when a POD records who delivered it.
create table if not exists drivers (
  id         text primary key,
  name       text not null,
  created_at timestamptz default now()
);

create table if not exists routes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  driver_id  text references drivers(id),
  -- Areas this route covers — powers the dispatcher's "auto-allocate by area"
  -- (a parcel maps to the route whose areas contain parcels.area).
  areas      text[] not null default '{}',
  created_at timestamptz default now()
);

-- Allocation link. null = unallocated: shows in the dispatcher's to-do list,
-- hidden from every driver's run until assigned.
alter table parcels add column if not exists route_id uuid references routes(id);
create index if not exists parcels_route_idx on parcels(route_id);

-- Let the driver app see allocations the instant the dispatcher makes them
-- (mirrors the pod_records realtime wiring). Tolerant of re-runs / no publication.
do $$ begin
  alter publication supabase_realtime add table parcels;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
