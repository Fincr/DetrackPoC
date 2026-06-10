-- Jobs / manifests: importing a manifest creates a batch of parcels. Unlike
-- the mail manifest, a parcel manifest carries a tracking number per row, so
-- each row becomes a parcels row keyed on tracking_number (unique → re-import
-- upserts, never duplicates). The parcels then flow through the existing
-- allocate → driver → POD pipeline; tracking export reads pod_records back out
-- as an Evri-format CSV. PoC posture unchanged: no auth, RLS off.

create table if not exists manifests (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,          -- job name (a reference or the filename)
  reference       text,                   -- optional client reference from the sheet
  source_filename text,
  imported_at     timestamptz default now(),
  created_at      timestamptz default now()
);

-- Which job a parcel was imported on (null = seeded/manual). `meta` keeps any
-- extra spreadsheet columns we don't model, so nothing from the sheet is lost.
alter table parcels add column if not exists manifest_id uuid references manifests(id);
alter table parcels add column if not exists meta jsonb;
create index if not exists parcels_manifest_idx on parcels(manifest_id);

-- Live updates for the Jobs view (mirrors parcels/pod_records).
do $$ begin
  alter publication supabase_realtime add table manifests;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
