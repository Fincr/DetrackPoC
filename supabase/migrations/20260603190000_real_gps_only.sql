-- Real-GPS-only: the simulated fallback is gone from the app. A capture
-- that couldn't get a fix now stores location = null and gps_source = null
-- (previously impossible — the column was not-null default 'device', which
-- would have silently mislabelled fix-less records as device reads).
-- gps_simulated and the 'simulated' check value stay for legacy rows.
alter table pod_records alter column gps_source drop default;
alter table pod_records alter column gps_source drop not null;
