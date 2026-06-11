-- Lifecycle hardening (closes the gaps the E2E test pass surfaced):
--
--  1. parcel_events INSERT now requires the parcel to be ON the driver's own
--     route — previously only the driver_id was checked, so an API caller
--     could log scans against any parcel id (unreachable via the UI, but
--     still a hole).
--  2. Status transitions move into atomic, single-statement RPCs instead of
--     client read-modify-write:
--       advance_parcel_status  — forward-only lifecycle advance
--       apply_failed_attempt   — derived attempt count + terminal 'returned'
--     Both are SECURITY INVOKER, so parcels/pod_records RLS still applies to
--     the caller.

-- 1. Tighten event inserts to the driver's own parcels
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

-- 2a. Lifecycle order, shared by the advance guard
create or replace function public.status_rank(s text) returns int
  language sql immutable as $$
  select case s
    when 'awaiting_collection' then 0
    when 'collected'           then 1
    when 'at_warehouse'        then 2
    when 'delivered'           then 3
    when 'returned'            then 3
    else 0
  end;
$$;

-- 2b. Forward-only advance: a late-syncing collection scan can never regress
--     a delivered parcel, and concurrent advances can't interleave (single
--     statement, row-level lock).
create or replace function public.advance_parcel_status(p_id uuid, p_to text) returns void
  language sql security invoker as $$
  update parcels
     set status = p_to
   where id = p_id
     and public.status_rank(p_to) > public.status_rank(status);
$$;

-- 2c. Failed delivery attempt: attempts are DERIVED from the failed POD rows
--     (idempotent — a sync retry of the same pod can't double-count), and the
--     parcel goes terminal 'returned' at p_max. The count runs under the
--     caller's RLS (a driver counts their own pods; a parcel is worked by one
--     route, so that's the full picture).
create or replace function public.apply_failed_attempt(p_id uuid, p_reason text, p_max int) returns void
  language plpgsql security invoker as $$
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
