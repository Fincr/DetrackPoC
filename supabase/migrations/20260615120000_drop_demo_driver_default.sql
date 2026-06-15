-- Production cleanup: drop the demo 'drv_demo' default on pod_records.driver_id.
-- The client always stamps the capturing driver's id from the session, so the
-- default never applied in practice — it was a leftover from the demo dataset.
alter table pod_records alter column driver_id drop default;
