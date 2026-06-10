-- Paste into the Supabase dashboard SQL Editor of the EXISTING cloud project
-- (https://supabase.com/dashboard/project/_/sql/new) after pulling the
-- manifests/jobs build. Mirrors migration 20260610130000. Safe to re-run.

create table if not exists manifests (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  reference       text,
  source_filename text,
  imported_at     timestamptz default now(),
  created_at      timestamptz default now()
);

alter table parcels add column if not exists manifest_id uuid references manifests(id);
alter table parcels add column if not exists meta jsonb;
create index if not exists parcels_manifest_idx on parcels(manifest_id);

-- PoC posture: RLS off on the new table.
alter table manifests disable row level security;

-- Live updates for the Jobs view.
do $$ begin
  alter publication supabase_realtime add table manifests;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
