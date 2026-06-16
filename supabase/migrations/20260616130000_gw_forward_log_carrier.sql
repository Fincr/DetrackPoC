-- Per-carrier forwarding (2026-06-16). forward_gw_events.py now sends each event
-- under its TRUE CarrierProviderName (DHL Parcel UK / I2I / DX, Oceanair suppressed)
-- with that carrier's own CarrierCode, instead of always branding DHL. Record which
-- carrier we sent for auditability — other GWOptical consumers read these rows, so
-- the bookkeeping should say exactly what was handed over.
--
-- Backfill: every event forwarded before this change was DHL-branded.
alter table public.gw_forward_log
  add column if not exists carrier_provider text;

update public.gw_forward_log
  set carrier_provider = 'DHL Parcel UK'
  where carrier_provider is null;
