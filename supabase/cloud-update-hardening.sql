-- Paste into the Supabase dashboard SQL Editor of the EXISTING cloud project
-- after pulling the lifecycle-hardening build. Mirrors migration
-- 20260611120000. Run it AFTER cloud-update-lifecycle.sql. Safe to re-run.

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

create or replace function public.advance_parcel_status(p_id uuid, p_to text) returns void
  language sql security invoker as $$
  update parcels
     set status = p_to
   where id = p_id
     and public.status_rank(p_to) > public.status_rank(status);
$$;

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
