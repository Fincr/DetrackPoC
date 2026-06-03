-- Attempt model + geofence distance.
--
-- A failed delivery is an ATTEMPT, not a terminal state: the parcel stays
-- pending (so it re-appears / rolls over) with attempts incremented and the
-- reason recorded. After MAX_ATTEMPTS (3, enforced in the app) the parcel
-- goes terminal as 'returned' (return to sender).
alter table parcels add column if not exists attempts int not null default 0;
alter table parcels add column if not exists last_failure text;

alter table parcels drop constraint if exists parcels_status_check;
alter table parcels add constraint parcels_status_check
  check (status in ('pending', 'delivered', 'failed', 'returned'));

-- Geofence: metres between the capture fix and parcels.destination,
-- computed client-side at capture (haversine) and stored on the record so
-- the dispatcher can flag "captured far from address".
alter table pod_records add column if not exists dest_distance_m int;

-- Realtime (Phase 4): let the dispatcher subscribe to new PODs instead of
-- polling. Tolerates the publication already containing the table, or the
-- publication not existing at all (then the poll fallback covers it).
do $$ begin
  alter publication supabase_realtime add table pod_records;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
