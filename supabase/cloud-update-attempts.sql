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
