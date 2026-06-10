-- Paste into the Supabase dashboard SQL Editor of the EXISTING cloud project
-- after pulling the sites build. Mirrors migration 20260610160000. Run it AFTER
-- the auth/RLS update (it relies on public.is_admin / public.auth_driver_id).
-- Safe to re-run.

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

alter table pod_records add column if not exists site_id uuid references sites(id);
create index if not exists pod_records_site_idx on pod_records(site_id);

alter table sites enable row level security;

drop policy if exists sites_select on sites;
create policy sites_select on sites for select
  using (public.is_admin()
         or route_id in (select id from routes where driver_id = public.auth_driver_id()));

drop policy if exists sites_admin_write on sites;
create policy sites_admin_write on sites for all
  using (public.is_admin()) with check (public.is_admin());

do $$ begin
  alter publication supabase_realtime add table sites;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- Demo sites (mirrors seed.sql): one per route plus one unallocated. Guarded
-- by name so re-running the script doesn't duplicate them.
insert into sites (name, address_line, postcode, kind, destination, route_id)
select v.name, v.address_line, v.postcode, v.kind,
       st_setsrid(st_makepoint(v.lng, v.lat), 4326)::geography,
       (select id from routes r where r.name = v.route_name)
from (values
  ('Citipost Collect — Camden',  '112 Camden High Street, London', 'NW1 0LU', 'store', -0.14260, 51.53900, 'Greater London'),
  ('Heathrow Air Freight Depot', 'Shoreham Road East, Hounslow',   'TW6 3UA', 'depot', -0.44640, 51.46070, 'International & Air'),
  ('Leeds Fulfilment Centre',    '40 Whitehall Road, Leeds',       'LS12 1BE', 'both', -1.56230, 53.79280, 'Fulfilment & Sort'),
  ('Citipost Collect — Norwich', '5 Gentlemans Walk, Norwich',     'NR2 1NA', 'store', 1.29310, 52.62850, null)
) as v(name, address_line, postcode, kind, lng, lat, route_name)
where not exists (select 1 from sites s where s.name = v.name);
