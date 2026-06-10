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
