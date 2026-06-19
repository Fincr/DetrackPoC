# Collect-and-Deliver Across Multiple Sender Sites — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each parcel a sender-derived **origin** so a driver collects from sender sites, then delivers — same day. Routes pair a set of **collection areas** with a set of **delivery areas**; the area grain becomes the UK postcode-area prefix (`DY`, `EH`, `SL`).

**Architecture:** Widen the existing Lens read path (`enrich-shipments` → `enrich.ts`) to carry the sender block; derive two postcode-areas per parcel; allocation matches both dimensions; the driver run gains a Collect phase before the existing Deliver phase. The redundant spreadsheet-upload importer is removed (everything enters by tracking-number enrichment). Shop names are denormalised onto `parcels.sender_name` at import, so the offline driver app needs no new table or Dexie change.

**Tech Stack:** Vite + React 19 + TS strict; Tailwind v3 ("Freight Modern"); Supabase JS v2 (hosted `mqiwyfhxcjvkpnpbtgql`, eu-west-2) + Lens project (`eivbxinppkwhqtglusmh`); Supabase Edge Functions (Deno); Dexie offline queue; node `.mjs` tests via Node 24 type-stripping (no runner).

> **Spec:** `docs/superpowers/specs/2026-06-19-collect-and-deliver-multi-site-design.md`
> **ADR:** `docs/adr/0004-collect-and-deliver-routing.md`

## Global Constraints

- **Commits are user-gated.** Work on `master`. Keep the per-task commit steps but run them only on the user's go-ahead. Always `npm run build` before any commit touching `src/`.
- **Hosted DB is not CLI-migration-tracked.** Apply every ePOD DDL change live via the Supabase MCP `execute_sql` (project `mqiwyfhxcjvkpnpbtgql`) **and** mirror it into `supabase/cloud-setup.sql` + `supabase/seed.sql` so a fresh project still builds. (No `supabase/migrations/*` file is required for the hosted flow.)
- **Lens DDL** is applied to the **Lens** project (`eivbxinppkwhqtglusmh`) and version-controlled in `supabase/lens-epod-reader.sql` only — never run ePOD DDL against Lens or vice-versa.
- **Secrets never committed.** `LENS_DB_URL`, `scripts/.env`, service-role keys stay out of git and out of logs.
- **Idempotency invariant preserved:** parcels upsert on `tracking_number`; every server write stays keyed on the client `podId`/event UUID; deterministic storage paths. Re-import updates, never duplicates, and leaves `route_id`/`status` intact.
- **RLS on every table.** A new table gets `enable row level security` + policies in the same change.
- **`postcodeArea` is the single source of an area code** — the outward letter prefix, upper-cased. Anything that accepts a typed-in area code upper-cases it to match.
- **Real-GPS-only, lifecycle enum, POD pipeline: untouched.** No simulated fallback; no new lifecycle states; collection stays a quick scan, delivery stays the full POD.

---

## Data check — gating precondition (do this BEFORE Task 2)

A SQL column rename **keeps existing values**. So if the hosted `parcels`/`routes` aren't empty, `area → delivery_area` leaves old London labels (`'South London'`) sitting in a column that should hold postcode prefixes, and every existing route keeps London-label `delivery_areas` with an empty `collection_areas` (→ nothing auto-allocates). The design assumes wiped data; verify or backfill.

- [ ] **Run (MCP `execute_sql`, project `mqiwyfhxcjvkpnpbtgql`):**

```sql
select
  (select count(*) from parcels) as parcels,
  (select count(*) from routes)  as routes;
```

- [ ] **If both are 0** (clean-break holds): proceed to Task 2, nothing else to do.
- [ ] **If `parcels` > 0 or `routes` > 0:** STOP and surface to the user. Either truncate (`delete from parcels; delete from routes;` — destructive, get explicit go-ahead) or plan to backfill immediately after the Task 2 rename:

```sql
-- run AFTER the Task 2 rename; postcodeArea() equivalent in SQL
update parcels set delivery_area  = upper(substring(coalesce(postcode,'')        from '^[A-Za-z]{1,2}'));
update parcels set collection_area = upper(substring(coalesce(sender_postcode,'') from '^[A-Za-z]{1,2}'));
-- routes must be rebuilt by hand (old London-label delivery_areas + empty collection_areas can't auto-allocate)
```

> **Deploy-ordering note:** the live Vercel bundle reads the *old* column names until the Task 4 code ships. Apply the Task 2 DDL close to the Task 4 deploy (or in a quiet window). For a wiped pilot DB with no active driver mid-build this is a non-issue.

---

## File map

**Lens project (SQL only):**
- **Modify** `supabase/lens-epod-reader.sql` — add 7 `sender_*` columns to `epod_shipment_lookup`; re-grant.

**ePOD schema:**
- **Modify** `supabase/cloud-setup.sql` — `parcels` sender columns + `area→delivery_area` + drop CHECK/default; `routes` `areas→delivery_areas` + `collection_areas`; new `collection_points` table + RLS.
- **Modify** `supabase/seed.sql` — drop any `area` references; keep template empty.

**ePOD code — created:**
- **Create** `src/lib/allocate.ts` — pure `matchRoute(parcel, routes)` + `unallocatedReason(parcel, routes)` (two-dimensional match; testable).
- **Create** `scripts/test-allocate.mjs` — node test for `allocate.ts`.

**ePOD code — modified:**
- **Modify** `src/lib/types.ts` — `Area = string`; remove `AREAS`; `Parcel.area→delivery_area` + sender fields + `collection_area`; `Route.areas→delivery_areas` + `collection_areas`.
- **Modify** `src/lib/enrich.ts` — `deriveArea→postcodeArea`; `ShipmentRow` sender fields; `composeSenderAddress`, `senderName`; `shipmentToParcelInput(row, names?)` sets both areas + sender block + mapped name.
- **Modify** `src/lib/manifest.ts` — gut to just `ParcelInput` (now with `delivery_area` + sender fields).
- **Modify** `supabase/functions/enrich-shipments/index.ts` — SELECT the 7 sender columns into the returned rows.
- **Modify** `src/screens/JobsScreen.tsx` — remove `ImportCard`; `EnrichCard` fetches the names map; relabel copy; fix `JobParcel`/pill/export-query for `delivery_area`.
- **Modify** `src/screens/AllocateScreen.tsx` — two-dimensional auto-allocate via `matchRoute`; remove per-parcel area override; route subtitle `coll → deliv`; two-part unallocated hint.
- **Modify** `src/screens/admin/RoutesPanel.tsx` — two area multi-selects (`collection_areas`/`delivery_areas`) drawn from present areas + free entry; header `DY → EH·G·ML`.
- **Modify** `src/screens/StopsScreen.tsx` — Collect/Deliver segmented control; Collect groups by collection point; delivery chip uses `delivery_area`.
- **Modify** `src/screens/DispatcherScreen.tsx` — `pod.parcel.area → delivery_area` (line ~204).
- **Modify** `src/App.tsx` — `captureEyebrow` `parcel.area → delivery_area` (×3).
- **Modify** `scripts/test-enrich.mjs` — `deriveArea→postcodeArea` tests; drop the manifest-relaxation block; add sender/name-map coverage.

**ePOD code — deleted:**
- **Delete** `scripts/make-sample-manifest.mjs`, `scripts/test-manifest.mjs`, `scripts/test-ui-e2e.mjs` (all exist only to exercise the spreadsheet upload).
- **Remove** `xlsx` from `package.json` dependencies.

---

## Task 1: Widen the Lens view with the sender block

**Files:**
- Modify: `supabase/lens-epod-reader.sql`
- Apply live: Lens project `eivbxinppkwhqtglusmh`

**Interfaces:**
- Produces: `public.epod_shipment_lookup` now also exposes `sender_company, sender_address1, sender_address2, sender_address3, sender_city, sender_county, sender_postcode` (read-only to `epod_reader`). Task 4's edge-function SELECT relies on these names.

- [ ] **Step 1: Confirm the mirror's sender column names**

The view must reference columns that actually exist on Lens's `public.shipments`. Verify (MCP `execute_sql`, project **`eivbxinppkwhqtglusmh`**):

```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'shipments' and column_name ilike 'sender%'
order by column_name;
```

Expected: `sender_address1, sender_address2, sender_address3, sender_city, sender_company, sender_county, sender_postcode` (snake_case, mirroring `recipient_*`). If any differ, use the **actual** names in Steps 2–3 and in Task 4's function SELECT.

- [ ] **Step 2: Update the version-controlled view DDL**

In `supabase/lens-epod-reader.sql`, replace the `create or replace view` block with:

```sql
create or replace view public.epod_shipment_lookup as
  select tracking_number,
         recipient_full_name, recipient_company,
         recipient_address1, recipient_address2, recipient_address3,
         recipient_city, recipient_county, recipient_postcode,
         sender_company,
         sender_address1, sender_address2, sender_address3,
         sender_city, sender_county, sender_postcode
  from public.shipments
  where is_deleted = false;        -- row scope: exclude soft-deleted shipments

grant select on public.epod_shipment_lookup to epod_reader;
```

Also update the file's column-scope comment ("only the 9 recipient fields") to note the sender block is now included and that return-to/phone/email/tax stay excluded.

- [ ] **Step 3: Apply to the Lens project**

Apply the `create or replace view` + `grant` from Step 2 via MCP `execute_sql` against **`eivbxinppkwhqtglusmh`**.

- [ ] **Step 4: Verify the read path as `epod_reader`**

```sql
select tracking_number, sender_company, sender_postcode, sender_city
from public.epod_shipment_lookup
limit 3;
```

Expected: rows return with sender columns populated (sender_company usually blank, sender_postcode present). Confirms the view compiles and the grant holds.

- [ ] **Step 5: Commit** (on user go-ahead)

```bash
git add supabase/lens-epod-reader.sql
git commit -m "feat(enrich): widen Lens epod_shipment_lookup with the sender block"
```

---

## Task 2: ePOD schema migration (origin columns, renames, `collection_points`)

**Files:**
- Apply live: ePOD project `mqiwyfhxcjvkpnpbtgql`
- Modify: `supabase/cloud-setup.sql`, `supabase/seed.sql`

**Interfaces:**
- Produces: `parcels.{sender_name, sender_address_line, sender_postcode, collection_area, delivery_area}`; `routes.{delivery_areas, collection_areas}`; table `collection_points(postcode pk, name, pin)`. Task 4's types/queries depend on exactly these names.

> Precondition: the **Data check** section above is done.

- [ ] **Step 1: Apply the DDL live (MCP `execute_sql`, project `mqiwyfhxcjvkpnpbtgql`)**

```sql
-- parcels: add the origin block, rename area, drop the London-label CHECK + default
alter table parcels add column if not exists sender_name text;
alter table parcels add column if not exists sender_address_line text;
alter table parcels add column if not exists sender_postcode text;
alter table parcels add column if not exists collection_area text;
alter table parcels drop constraint if exists parcels_area_check;
alter table parcels alter column area drop default;
alter table parcels rename column area to delivery_area;

-- routes: rename areas → delivery_areas, add collection_areas
alter table routes rename column areas to delivery_areas;
alter table routes add column if not exists collection_areas text[] not null default '{}';

-- collection_points: display-only shop names/pins, keyed on the full sender postcode
create table if not exists collection_points (
  postcode   text primary key,
  name       text,
  pin        geography(point, 4326),
  created_at timestamptz default now()
);
alter table collection_points enable row level security;
drop policy if exists collection_points_select on collection_points;
create policy collection_points_select on collection_points
  for select using (auth.uid() is not null);
drop policy if exists collection_points_admin_write on collection_points;
create policy collection_points_admin_write on collection_points
  for all using (public.is_admin()) with check (public.is_admin());
```

- [ ] **Step 2: Verify the live schema**

```sql
select column_name from information_schema.columns
where table_name = 'parcels'
  and column_name in ('sender_name','sender_address_line','sender_postcode','collection_area','delivery_area')
order by column_name;
select column_name from information_schema.columns
where table_name = 'routes' and column_name in ('collection_areas','delivery_areas') order by column_name;
select count(*) from collection_points;
```

Expected: all five parcel columns present (no `area`); both route columns present; `collection_points` exists (0 rows). If the **Data check** flagged existing rows, run the backfill UPDATEs from that section now.

- [ ] **Step 3: Mirror into `supabase/cloud-setup.sql` — `routes`**

Replace the `areas` line (the `routes` table, ~line 30) with:

```sql
  -- Postcode-areas this route COLLECTS from and DELIVERS to (UK outward prefixes).
  -- Auto-allocate matches a parcel when its collection_area ∈ collection_areas
  -- AND its delivery_area ∈ delivery_areas.
  collection_areas text[] not null default '{}',
  delivery_areas   text[] not null default '{}',
```

- [ ] **Step 4: Mirror into `supabase/cloud-setup.sql` — `parcels`**

Replace the `area … check(...)` block (~lines 57–58) with the origin block:

```sql
  -- Recipient/delivery area + sender (origin) block, both areas = postcodeArea()
  -- of the respective postcode (UK outward letter prefix). No CHECK — areas are
  -- an open set of ~120 UK prefixes, not a fixed enum.
  delivery_area       text,
  sender_name         text,   -- friendly shop name, baked at import (Sender_Company → collection_points → null)
  sender_address_line text,
  sender_postcode     text,
  collection_area     text,
```

- [ ] **Step 5: Append `collection_points` to `supabase/cloud-setup.sql`**

After the `sites` table block, add the table; and in the RLS section (alongside the other `enable row level security` + policies) add its RLS. Use the exact DDL from Step 1 (`create table … collection_points …` + the `enable row level security` + two policies).

- [ ] **Step 6: Scrub `supabase/seed.sql`**

Open `supabase/seed.sql`; if it references `area`, `areas`, or sets a London label on any seed row, remove/rename those (template ships with no parcel data, so this is comment/column hygiene only — keep it consistent with the new schema).

- [ ] **Step 7: Commit** (on user go-ahead)

```bash
git add supabase/cloud-setup.sql supabase/seed.sql
git commit -m "feat(schema): parcel origin block, postcode-area routes, collection_points"
```

---

## Task 3: Remove the manifest file-upload path

**Files:**
- Modify: `src/screens/JobsScreen.tsx` (delete `ImportCard`; trim imports/copy)
- Modify: `src/lib/manifest.ts` (gut to `ParcelInput`)
- Modify: `scripts/test-enrich.mjs` (drop the manifest-relaxation block)
- Delete: `scripts/make-sample-manifest.mjs`, `scripts/test-manifest.mjs`, `scripts/test-ui-e2e.mjs`
- Modify: `package.json` (drop `xlsx`)

**Interfaces:**
- Produces: `ParcelInput` (unchanged shape this task — still `area: Area`); `commitParcels`, `EnrichCard` remain. Removes `parseManifestFile`, `autoMap`, `buildParcelInputs`, `splitRowsForEnrichment`, `MANIFEST_FIELDS`, `SYNONYMS`, `ManifestField`, `ColumnMapping`, `ParsedManifest`, `toArea`.

> This task keeps `ParcelInput.area` as-is so it stays green; Task 4 renames it.

- [ ] **Step 1: Check `test-ui-e2e.mjs` scope, then delete the upload-only scripts**

Read `scripts/test-ui-e2e.mjs`. If it exists solely to drive the spreadsheet-upload flow (it builds a manifest via `make-sample-manifest.mjs` and uploads it), delete all three:

```bash
git rm scripts/make-sample-manifest.mjs scripts/test-manifest.mjs scripts/test-ui-e2e.mjs
```

If `test-ui-e2e.mjs` also covers non-upload flows, excise only its upload section instead of deleting it (keep the rest).

- [ ] **Step 2: Gut `src/lib/manifest.ts` to just `ParcelInput`**

Replace the entire file with:

```ts
/** This file is imported by Node.js test scripts and by src/lib/enrich.ts.
 *  Parcels enter ePOD via tracking-number enrichment (see enrich.ts /
 *  JobsScreen EnrichCard) — there is no spreadsheet importer. */
import type { Area } from './types.ts'

export interface ParcelInput {
  tracking_number: string
  recipient_name: string
  address_line: string
  postcode: string | null
  area: Area
  /** Raw source row, stashed verbatim into the jsonb column. */
  meta: Record<string, string | null>
}
```

- [ ] **Step 3: Trim `scripts/test-enrich.mjs`**

Remove the `buildParcelInputs, splitRowsForEnrichment` import (line 7) and the entire `console.log('manifest relaxation')` block (lines ~64–77). Leave the compose/deriveArea/shipmentToParcelInput sections (Task 4 rewrites deriveArea).

- [ ] **Step 4: Remove `ImportCard` and fix `JobsScreen` imports/render**

In `src/screens/JobsScreen.tsx`:
- Delete the `ImportCard` component (the whole `function ImportCard(...)` block) and the `UploadGlyph` component.
- Change the manifest import to only what's still used:

```ts
import type { ParcelInput } from '../lib/manifest'
```

- In the `JobsScreen` return, drop `<ImportCard … />` from the left column (keep `<EnrichCard … />`):

```tsx
<div className="xl:sticky xl:top-[82px] flex flex-col gap-6">
  <EnrichCard onImported={() => void load()} />
</div>
```

- Relabel copy: `AdminShell title="Jobs & manifests"` → `title="Jobs"`; the empty-state "No jobs yet — import a manifest to create one." → "No jobs yet — look up tracking numbers to create one."; the header doc-comment to describe the enrich-only path.

- [ ] **Step 5: Uninstall `xlsx`**

```bash
npm uninstall xlsx
```

Expected: `package.json` no longer lists `xlsx`; `package-lock.json` updates.

- [ ] **Step 6: Build + run the trimmed test**

```bash
npm run build
node scripts/test-enrich.mjs
```

Expected: build clean (no dangling `xlsx`/`ImportCard`/`buildParcelInputs` references); `test-enrich` still passes.

- [ ] **Step 7: Commit** (on user go-ahead)

```bash
git add -A
git commit -m "chore(jobs): remove redundant spreadsheet-upload importer (enrich-only intake)"
```

---

## Task 4: Postcode-area model + sender enrichment + two-dimensional allocation

The atomic model swap: renaming `Area`/`Parcel.area`/`Route.areas` breaks every consumer at once, so they're fixed together; the task ends green with enrichment producing both areas + a baked sender name, and allocation matching both dimensions.

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/manifest.ts`, `src/lib/enrich.ts`
- Create: `src/lib/allocate.ts`, `scripts/test-allocate.mjs`
- Modify: `supabase/functions/enrich-shipments/index.ts`
- Modify: `src/screens/JobsScreen.tsx`, `src/screens/AllocateScreen.tsx`, `src/screens/admin/RoutesPanel.tsx`, `src/screens/StopsScreen.tsx`, `src/screens/DispatcherScreen.tsx`, `src/App.tsx`
- Modify: `scripts/test-enrich.mjs`; sweep `scripts/{smoke-db,seed-cloud,seed-cloud-job,probe-cloud}.mjs`

**Interfaces:**
- Produces: `postcodeArea(pc): string`; `Parcel` with `delivery_area, collection_area, sender_name, sender_address_line, sender_postcode`; `Route` with `delivery_areas, collection_areas`; `ParcelInput` with `delivery_area` + sender fields; `shipmentToParcelInput(row, names?)`; `matchRoute(parcel, routes)`, `unallocatedReason(parcel, routes)`.
- Consumes: Task 2 columns; Task 1 sender view.

- [ ] **Step 1: Rewrite the `enrich.ts` tests (red)**

In `scripts/test-enrich.mjs`, replace the import line and the `deriveArea` block, and extend `shipmentToParcelInput`:

```js
import {
  composeAddressLine, composeRecipient, composeSenderAddress, senderName,
  postcodeArea, shipmentToParcelInput,
} from '../src/lib/enrich.ts'
```

```js
console.log('postcodeArea')
check('SL4 1DE → SL', postcodeArea('SL4 1DE') === 'SL')
check('DY11 7FL → DY', postcodeArea('DY11 7FL') === 'DY')
check('B2 4RQ → B', postcodeArea('B2 4RQ') === 'B')
check('lowercase + spaces tolerated', postcodeArea('  dy11 7fl ') === 'DY')
check('blank → ""', postcodeArea('') === '')
check('null → ""', postcodeArea(null) === '')
check('numeric junk → ""', postcodeArea('1234') === '')

console.log('sender')
const srow = { ...row,
  sender_company: '', sender_address1: '5 Mill St', sender_address2: '', sender_address3: '',
  sender_city: 'Windsor', sender_county: 'Berkshire', sender_postcode: 'SL4 1DE' }
check('composeSenderAddress joins parts', composeSenderAddress(srow) === '5 Mill St, Windsor, Berkshire')
check('senderName blank company → null (no map)', senderName(srow) === null)
check('senderName uses Sender_Company when present',
  senderName({ ...srow, sender_company: 'Specsavers' }) === 'Specsavers')
check('senderName falls back to lookup map',
  senderName(srow, { 'SL4 1DE': 'Specsavers Windsor' }) === 'Specsavers Windsor')

console.log('shipmentToParcelInput')
const pi = shipmentToParcelInput(srow, { 'SL4 1DE': 'Specsavers Windsor' })
check('both areas + sender block + mapped name',
  pi.delivery_area === 'BR' && pi.collection_area === 'SL' &&
  pi.sender_postcode === 'SL4 1DE' && pi.sender_address_line === '5 Mill St, Windsor, Berkshire' &&
  pi.sender_name === 'Specsavers Windsor', JSON.stringify(pi))
```

(Keep the `compose`/`composeRecipient` checks. Note `row.recipient_postcode` is `BR1 1AA` → `delivery_area === 'BR'`.)

- [ ] **Step 2: Run — verify it fails**

Run: `node scripts/test-enrich.mjs`
Expected: FAIL — `postcodeArea`/`composeSenderAddress`/`senderName` not exported.

- [ ] **Step 3: `types.ts` — area becomes a string; parcels/routes gain the new fields**

In `src/lib/types.ts`:

```ts
/** A UK postcode area — the outward letter prefix (`DY`, `EH`, `SL`…), or "" when
 *  the postcode is missing/unparseable. Replaces the old six-label union. */
export type Area = string
```

Delete the `AREAS` const. Update `Route`:

```ts
export interface Route {
  id: string
  name: string
  driver_id: string | null
  /** Postcode-areas this route collects from / delivers to. */
  collection_areas: Area[]
  delivery_areas: Area[]
}
```

Update `Parcel` — rename `area` and add the origin block:

```ts
  /** postcodeArea(recipient postcode) — the delivery region. */
  delivery_area: Area
  /** Origin (sender) block, pulled from GWOptical at enrich time. */
  sender_name: string | null
  sender_address_line: string | null
  sender_postcode: string | null
  /** postcodeArea(sender postcode) — the collection region. */
  collection_area: Area
```

(Replace the existing `area: Area` line; keep every other `Parcel` field.)

- [ ] **Step 4: `manifest.ts` — `ParcelInput` gains the new shape**

```ts
export interface ParcelInput {
  tracking_number: string
  recipient_name: string
  address_line: string
  postcode: string | null
  delivery_area: Area
  sender_name: string | null
  sender_address_line: string | null
  sender_postcode: string | null
  collection_area: Area
  meta: Record<string, string | null>
}
```

- [ ] **Step 5: `enrich.ts` — `postcodeArea`, sender helpers, widened `ShipmentRow`/mapping**

Replace `deriveArea` + `POSTCODE_AREA` with:

```ts
/** UK postcode → area = the outward letter prefix, upper-cased. "SL4 1DE" → "SL",
 *  "B2 4RQ" → "B". Blank / unparseable → "" (the dispatcher's unknown bucket).
 *  The leading letters ARE the postcode area; we never strip 2→1 (WA≠W, NE≠N). */
export function postcodeArea(postcode: string | null | undefined): Area {
  const pc = (postcode ?? '').trim().toUpperCase()
  return (pc.match(/^[A-Z]{1,2}/) ?? [''])[0]
}
```

Add the sender block to `ShipmentRow`:

```ts
  sender_company: string | null
  sender_address1: string | null
  sender_address2: string | null
  sender_address3: string | null
  sender_city: string | null
  sender_county: string | null
  sender_postcode: string | null
```

Add the sender helpers + rewrite `shipmentToParcelInput`:

```ts
/** GWOptical splits the sender address across columns; join the non-empty parts. */
export function composeSenderAddress(row: ShipmentRow): string {
  return [row.sender_address1, row.sender_address2, row.sender_address3, row.sender_city, row.sender_county]
    .map((p) => (p ?? '').trim()).filter(Boolean).join(', ')
}

/** Friendly shop name: Sender_Company, else the collection_points lookup by
 *  postcode, else null (the address still renders). `names` is postcode→name. */
export function senderName(row: ShipmentRow, names?: Record<string, string>): string | null {
  const company = (row.sender_company ?? '').trim()
  if (company) return company
  const pc = (row.sender_postcode ?? '').trim()
  return names && pc && names[pc] ? names[pc] : null
}

export function shipmentToParcelInput(row: ShipmentRow, names?: Record<string, string>): ParcelInput {
  return {
    tracking_number: row.tracking_number,
    recipient_name: composeRecipient(row),
    address_line: composeAddressLine(row),
    postcode: (row.recipient_postcode ?? '').trim() || null,
    delivery_area: postcodeArea(row.recipient_postcode),
    sender_name: senderName(row, names),
    sender_address_line: composeSenderAddress(row) || null,
    sender_postcode: (row.sender_postcode ?? '').trim() || null,
    collection_area: postcodeArea(row.sender_postcode),
    meta: { ...(row as unknown as Record<string, string | null>) },
  }
}
```

- [ ] **Step 6: Run — verify `test-enrich` passes**

Run: `node scripts/test-enrich.mjs`
Expected: all `✓`, `N passed, 0 failed`.

- [ ] **Step 7: Edge function — SELECT the sender columns**

In `supabase/functions/enrich-shipments/index.ts`, extend the SELECT and the `ShipmentRow` interface (if present) with the 7 sender columns:

```ts
    const rows = await sql`
      select tracking_number, recipient_full_name, recipient_company,
             recipient_address1, recipient_address2, recipient_address3,
             recipient_city, recipient_county, recipient_postcode,
             sender_company, sender_address1, sender_address2, sender_address3,
             sender_city, sender_county, sender_postcode
      from public.epod_shipment_lookup
      where tracking_number = any(${submitted})`
```

Update the function's column-scope comment to say "recipient + sender columns". Deploy:

```bash
node_modules/@supabase/cli-windows-x64/bin/supabase.exe functions deploy enrich-shipments --project-ref mqiwyfhxcjvkpnpbtgql
```

- [ ] **Step 8: `EnrichCard` — fetch the names map, pass it to the mapper**

In `src/screens/JobsScreen.tsx` `EnrichCard.lookup`, fetch `collection_points` once and pass the map:

```ts
const res = await enrichShipments(numbers)
const { data: cps } = await supabase.from('collection_points').select('postcode, name')
const names = Object.fromEntries(
  ((cps ?? []) as { postcode: string; name: string | null }[])
    .filter((c) => c.name).map((c) => [c.postcode, c.name as string]),
)
const mapped = res.found.map((r) => shipmentToParcelInput(r, names))
setFound((prev) => (merge && prev ? [...prev, ...mapped] : mapped))
setNotFound(res.notFound)
```

- [ ] **Step 9: Create `src/lib/allocate.ts` (pure two-dimensional match)**

```ts
import type { Parcel, Route } from './types'

type Areas = Pick<Parcel, 'collection_area' | 'delivery_area'>

/** A parcel matches route R when its collection_area ∈ R.collection_areas AND its
 *  delivery_area ∈ R.delivery_areas. On overlap, first route by name wins
 *  (deterministic); dispatchers keep a day's sets non-overlapping. */
export function matchRoute<R extends Route>(p: Areas, routes: R[]): R | null {
  const hits = routes.filter(
    (r) => r.collection_areas.includes(p.collection_area) && r.delivery_areas.includes(p.delivery_area),
  )
  return hits.length ? [...hits].sort((a, b) => a.name.localeCompare(b.name))[0] : null
}

/** Why a parcel didn't auto-allocate — which side has no home (two-part hint). */
export function unallocatedReason(p: Areas, routes: Route[]): string | null {
  if (matchRoute(p, routes)) return null
  const coll = routes.some((r) => r.collection_areas.includes(p.collection_area))
  const deliv = routes.some((r) => r.delivery_areas.includes(p.delivery_area))
  const c = p.collection_area || '?'
  const d = p.delivery_area || '?'
  if (!coll && !deliv) return `No route covers ${c} → ${d}`
  if (!coll) return `No route collects ${c}`
  if (!deliv) return `No route delivers ${d}`
  return `${c} and ${d} aren't on the same route`
}
```

- [ ] **Step 10: Create `scripts/test-allocate.mjs` (and run it)**

```js
// Pure-function tests for two-dimensional allocation. node scripts/test-allocate.mjs
import { matchRoute, unallocatedReason } from '../src/lib/allocate.ts'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`) }

const routes = [
  { id: 'r1', name: 'Alpha', driver_id: null, collection_areas: ['DY'], delivery_areas: ['EH', 'G'] },
  { id: 'r2', name: 'Bravo', driver_id: null, collection_areas: ['NN'], delivery_areas: ['B'] },
]

check('both-in → matched', matchRoute({ collection_area: 'DY', delivery_area: 'EH' }, routes)?.id === 'r1')
check('delivery not in set → no match', matchRoute({ collection_area: 'DY', delivery_area: 'B' }, routes) === null)
check('collection not in set → no match', matchRoute({ collection_area: 'NN', delivery_area: 'EH' }, routes) === null)
check('overlap → first route by name', matchRoute({ collection_area: 'DY', delivery_area: 'EH' },
  [{ id: 'rZ', name: 'Zeta', driver_id: null, collection_areas: ['DY'], delivery_areas: ['EH'] }, ...routes])?.name === 'Alpha')
check('matched → no reason', unallocatedReason({ collection_area: 'DY', delivery_area: 'EH' }, routes) === null)
check('collection missing → says so', unallocatedReason({ collection_area: 'ZZ', delivery_area: 'EH' }, routes) === 'No route collects ZZ')
check('delivery missing → says so', unallocatedReason({ collection_area: 'DY', delivery_area: 'ZZ' }, routes) === 'No route delivers ZZ')
check('both on different routes → not-together', unallocatedReason({ collection_area: 'NN', delivery_area: 'EH' }, routes) === "NN and EH aren't on the same route")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
```

Run: `node scripts/test-allocate.mjs`
Expected: `8 passed, 0 failed`.

- [ ] **Step 11: `AllocateScreen` — two-dimensional auto-allocate; drop the area override**

In `src/screens/AllocateScreen.tsx`:
- Replace the import `import { AREAS } from '../lib/types'` with `import { matchRoute, unallocatedReason } from '../lib/allocate'` (keep the `Parcel` type import; drop `Area` if now unused).
- Delete `assignArea` and `routeForArea`.
- `autoAllocate` update line: `routeId: matchRoute(p, routes)?.id ?? null`.
- `canAuto`: `unallocated.some((p) => matchRoute(p, routes))`.
- In the route card subtitle (~line 173), replace `r.areas.join(', ') || 'no areas'` with:

```tsx
{r.collection_areas.join('·') || '—'} → {r.delivery_areas.join('·') || '—'}
```

- In `ParcelRow`: remove the area `<select>` and the `onSetArea` prop; replace with read-only chips and (for unallocated rows) the reason:

```tsx
<span className="flex-none rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-gold">
  {p.collection_area || '?'} → {p.delivery_area || '?'}
</span>
```

Replace the `suggestion` prop wiring: pass `suggestion={matchRoute(p, routes)?.name}` (unchanged intent) and, when there's no match, render `unallocatedReason(p, routes)` as a muted note under the address. Remove the `onSetArea={(area) => void assignArea(...)}` from both `ParcelRow` usages.

- [ ] **Step 12: `RoutesPanel` — two area multi-selects**

In `src/screens/admin/RoutesPanel.tsx`:
- Drop the `AREAS` import; the `Route` type now carries `collection_areas`/`delivery_areas`.
- Fetch the areas present in the parcel set once (for suggestions), in `RoutesPanel`:

```tsx
const [presentColl, setPresentColl] = useState<string[]>([])
const [presentDeliv, setPresentDeliv] = useState<string[]>([])
useEffect(() => {
  void supabase.from('parcels').select('collection_area, delivery_area').then(({ data }) => {
    const coll = new Set<string>(), deliv = new Set<string>()
    for (const r of (data ?? []) as { collection_area: string | null; delivery_area: string | null }[]) {
      if (r.collection_area) coll.add(r.collection_area)
      if (r.delivery_area) deliv.add(r.delivery_area)
    }
    setPresentColl([...coll].sort()); setPresentDeliv([...deliv].sort())
  })
}, [])
```

- Replace the single `areas`/`setAreas` state in both the add-form and `RouteRow` with `collectionAreas`/`deliveryAreas`, and the single `AreaChecks` with two `AreaPicker`s. The insert/update payloads become `{ name, driver_id, collection_areas, delivery_areas }`.
- Replace `AreaChecks` with a tag-style `AreaPicker` (present-areas as toggles + free entry, upper-cased):

```tsx
function AreaPicker({ label, options, selected, onChange }: {
  label: string; options: string[]; selected: string[]; onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const all = [...new Set([...options, ...selected])].sort()
  const toggle = (a: string) => onChange(selected.includes(a) ? selected.filter((x) => x !== a) : [...selected, a])
  const add = () => { const a = draft.trim().toUpperCase(); if (a && !selected.includes(a)) onChange([...selected, a]); setDraft('') }
  return (
    <div>
      <p className="section-label mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {all.map((a) => (
          <button key={a} type="button" onClick={() => toggle(a)}
            className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold transition ${
              selected.includes(a) ? 'border-navy-500/50 bg-navy-500/10 text-ink' : 'border-line text-muted hover:border-navy-500/30'}`}>
            {a}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          placeholder="Add a code (e.g. DY)"
          className={`${INPUT} flex-1`} />
        <button type="button" onClick={add} className={BTN_GHOST}>Add</button>
      </div>
    </div>
  )
}
```

- In the add-form and `RouteRow`, render two pickers ("Collects from" → collectionAreas, "Delivers to" → deliveryAreas) using `presentColl`/`presentDeliv` as options. In the route row header (read view), replace the `route.areas` chips with `{route.collection_areas.join('·')} → {route.delivery_areas.join('·')}` (and the "No areas" empty-state when both are empty).

- [ ] **Step 13: Sweep the remaining `.area` consumers (compile-fix)**

- `src/screens/StopsScreen.tsx` (~line 601): `{p.area}` → `{p.delivery_area}` in the stop card chip.
- `src/screens/JobsScreen.tsx`:
  - `JobParcel.area` → `delivery_area` (interface + the `.select('… , area, …')` → `delivery_area`).
  - the area pill `{p.area}` → `{p.delivery_area}`.
  - the export query embeds (×2): `parcel:parcels(tracking_number,area,postcode,manifest_id)` → `…,delivery_area,…`; in the row mappers, `area: r.parcel?.area ?? null` → `area: r.parcel?.delivery_area ?? null` (keep the `TrackingPod.area`/`TrackingScan.area` field names — `trackingExport.ts` is unchanged; it's a generic "place" label fed by the delivery area).
- `src/screens/DispatcherScreen.tsx` (~line 204): `{pod.parcel.area}` → `{pod.parcel.delivery_area}` (and the embedded select that fetches it, if it names `area`).
- `src/App.tsx` `captureEyebrow` (×3): `parcel.area` → `parcel.delivery_area`.

- [ ] **Step 14: Sweep the non-compiled `.mjs` scripts**

Update the scripts that `select('area')` to `delivery_area` (runtime-only — `tsc` won't flag them):
- `scripts/smoke-db.mjs` (~line 46), `scripts/seed-cloud.mjs` (~39), `scripts/seed-cloud-job.mjs` (~65), `scripts/probe-cloud.mjs` (~24).

Then grep for stragglers:

```bash
grep -rn "\.area\b\|\bareas\b\|AREAS\|deriveArea" src/ scripts/ supabase/ --include=*.ts --include=*.tsx --include=*.mjs --include=*.sql
```

Expected: no hits except `collection_areas`/`delivery_areas`/`collection_area`/`delivery_area` (the new names) and `postcodeArea`.

- [ ] **Step 15: Build + both pure tests**

```bash
npm run build
node scripts/test-enrich.mjs
node scripts/test-allocate.mjs
```

Expected: build clean; both tests `0 failed`.

- [ ] **Step 16: Manual check (hosted, admin)**

Enrich a couple of real tracking numbers → preview shows recipient + composed sender address; import. In SQL or the board, confirm the parcel rows carry `collection_area`, `delivery_area`, `sender_postcode`, `sender_address_line` (and `sender_name` where a `collection_points` row exists). Build a route `DY → EH` in the routes editor → "Auto-allocate by area" places the matching parcels; a non-matching parcel shows its two-part reason.

- [ ] **Step 17: Commit** (on user go-ahead)

```bash
git add -A
git commit -m "feat(routing): postcode-area model, sender enrichment, two-dimensional allocation"
```

---

## Task 5: Driver two-phase run (Collect → Deliver)

**Files:**
- Modify: `src/screens/StopsScreen.tsx`

**Interfaces:**
- Consumes: `Parcel.{sender_postcode, sender_name, sender_address_line, delivery_area}` (Task 4); the existing `ScanSheet` (already supports the `collection` stage).
- Produces: no new exports — internal phase UI.

> Aesthetic: apply the "Freight Modern" language (navy/gold/paper, Barlow Condensed titles, `section-label`s) — reuse the existing `StopRow`/card patterns. Use the `frontend-design` skill for polish, but the structure below is the spec.

- [ ] **Step 1: Add phase state + a default derived from collection progress**

In `StopsScreen`, after `const active = …`:

```tsx
const allCollected = active.length > 0 && active.every((p) => STATUS_RANK[effectiveStatus(p)] >= STATUS_RANK['collected'])
const [phase, setPhase] = useState<'collect' | 'deliver'>(allCollected ? 'deliver' : 'collect')
```

- [ ] **Step 2: Group active parcels by collection point**

```tsx
const collectGroups = useMemo(() => {
  const m = new Map<string, { name: string; postcode: string | null; parcels: Parcel[] }>()
  for (const p of active) {
    const key = p.sender_postcode ?? '∅'
    const g = m.get(key) ?? { name: p.sender_name || p.sender_address_line || 'Unknown origin', postcode: p.sender_postcode, parcels: [] }
    g.parcels.push(p); m.set(key, g)
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
}, [active])
```

- [ ] **Step 3: Render the segmented control**

Above the stops grid (after the "Scan label" row), with live counts:

```tsx
const collectedCount = active.filter((p) => STATUS_RANK[effectiveStatus(p)] >= STATUS_RANK['collected']).length
// …
<div className="mb-4 grid grid-cols-2 gap-1 rounded-[12px] border border-line bg-white p-1">
  {(['collect', 'deliver'] as const).map((ph) => (
    <button key={ph} type="button" onClick={() => setPhase(ph)}
      className={`rounded-[9px] px-3 py-2 text-[13px] font-semibold transition ${phase === ph ? 'bg-navy text-white' : 'text-muted hover:text-ink'}`}>
      {ph === 'collect' ? `Collect · ${collectedCount}/${active.length}` : 'Deliver'}
    </button>
  ))}
</div>
```

- [ ] **Step 4: Render the Collect phase (grouped cards)**

When `phase === 'collect'`, render `collectGroups` instead of the per-stop grid. Each group is a card: name + postcode, a "collected X/Y here" line, and the parcels (reuse `StopRow` or a compact list). Tapping the card's scan affordance opens the scan sheet (Step 6 defaults it to the collection stage). Example header:

```tsx
{phase === 'collect' && (
  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
    {collectGroups.map((g) => {
      const done = g.parcels.filter((p) => STATUS_RANK[effectiveStatus(p)] >= STATUS_RANK['collected']).length
      return (
        <article key={g.postcode ?? g.name} className="flex flex-col rounded-2xl border border-line bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold text-ink">{g.name}</div>
              {g.postcode && <div className="font-mono text-[11px] tracking-[0.5px] text-navy-500">{g.postcode}</div>}
            </div>
            <span className={`flex-none rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] ${done === g.parcels.length ? 'border-ok/40 bg-ok/10 text-ok' : 'border-gold/50 bg-gold/10 text-gold'}`}>
              Collected {done}/{g.parcels.length}
            </span>
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-[12.5px] text-muted">
            {g.parcels.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{p.recipient_name} · {p.delivery_area || '?'}</span>
                <span className="font-mono text-[11px] text-navy-500">{p.tracking_number}</span>
              </li>
            ))}
          </ul>
        </article>
      )
    })}
  </div>
)}
```

- [ ] **Step 5: Scope the existing grid to the Deliver phase**

Wrap the current active-stops grid (the `active.map(...)` card grid) in `{phase === 'deliver' && ( … )}`. Leave the **Completed** and **Sites** sections as they are (they render below both phases).

- [ ] **Step 6: Default the scan sheet's stage to the current phase**

Pass the phase into `ScanSheet` so the driver doesn't re-pick the stage:

```tsx
<ScanSheet … initialStage={phase === 'collect' ? 'collection' : 'delivered'} />
```

In `ScanSheet`, accept `initialStage?: Stage` and initialise `const [mode, setMode] = useState<Stage | null>(initialStage ?? null)`. (The stage switcher stays — the driver can still override.)

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 8: Manual check (hosted, as a driver with a `DY → EH` route)**

Run sheet opens on **Collect** with groups by sender site; "Scan label" defaults to the collection stage; scanning a label moves its group counter. Switch to **Deliver** → the familiar stop list + full POD capture. Offline: scan a collection while offline → counter advances (queued), drains when back online.

- [ ] **Step 9: Commit** (on user go-ahead)

```bash
git add src/screens/StopsScreen.tsx
git commit -m "feat(driver): two-phase run — collect by sender site, then deliver"
```

---

## Task 6: Seed pilot collection points + final verification

**Files:**
- Apply live: `mqiwyfhxcjvkpnpbtgql` (`collection_points` rows)

- [ ] **Step 1: Seed the pilot shops (USER-PROVIDED data)**

Fill in the few pilot shops' postcodes, names, and (optional) pins, then apply via MCP `execute_sql`. Seed **before** re-importing so the names bake into `sender_name`:

```sql
insert into collection_points (postcode, name) values
  ('SL4 1DE', 'Specsavers Windsor'),
  ('DY1 1AA', 'Specsavers Dudley')
on conflict (postcode) do update set name = excluded.name;
```

(Pins, if known: `update collection_points set pin = st_setsrid(st_makepoint(<lng>,<lat>),4326) where postcode = '…';`)

- [ ] **Step 2: Full build + all pure tests**

```bash
npm run build
node scripts/test-enrich.mjs
node scripts/test-allocate.mjs
```

Expected: build clean; both tests `0 failed`.

- [ ] **Step 3: End-to-end walkthrough (hosted, admin then driver)**

- Enrich real tracking numbers → both areas derived; a parcel whose `sender_postcode` matches a `collection_points` row shows that name; one that doesn't shows its address.
- Build a `DY → EH` route → auto-allocate places matching parcels; a non-matching parcel shows its two-part reason and is hand-assignable.
- Driver: Collect phase groups by site, quick-scan advances the counter; Deliver phase captures the POD.
- A parcel with no sender (if any legacy row) appears in Deliver only.
- Export tracking CSV for the job → collection + delivery events present.

- [ ] **Step 4: Deploy** (on user go-ahead)

Push `master` → Vercel auto-rebuilds. Verify the live bundle hash changed and the dispatcher/driver flows work against the hosted DB.

---

## Self-review — spec coverage

| Spec section | Covered by |
|---|---|
| §4.1 parcels schema (sender block, rename, drop CHECK/default) | Task 2 (live + cloud-setup), Task 4 Step 3–4 (types) |
| §4.2 `postcodeArea` / `Area = string` / drop `AREAS` | Task 4 Steps 3, 5 |
| §4.3 Lens view widening | Task 1 |
| §4.4 enrich-shipments + enrich.ts (sender, name-from-map) | Task 4 Steps 5, 7, 8 |
| §4.5 `collection_points` (denormalised at import) | Task 2 (table), Task 4 Step 8 (map → `sender_name`), Task 6 (seed) |
| §4.6 two-dimensional allocation; remove area override; two-part hint | Task 4 Steps 9–11 |
| §4.7 driver two-phase run | Task 5 |
| §4.8 routes editor (two multi-selects, upper-cased free entry) | Task 4 Step 12 |
| §4.9 remove manifest upload + `xlsx` | Task 3 |
| §5 rename inventory (incl. App.tsx, DispatcherScreen — found during planning) | Task 4 Steps 13–14 |
| §6 lifecycle unchanged | (no task — explicitly untouched) |
| §8 `collection_points` RLS | Task 2 Step 1/5 |
| §10 open items — `postcodeArea` edges, overlap tiebreak, pilot rows | Task 4 (tests), Task 6 Step 1 |
| §11 rollout + data-check | Data-check section + Task ordering |

**Known scope notes (from the spec self-review, deliberately deferred):**
- Tracking-CSV "place" for a *collection* scan still uses the delivery area/postcode (pre-existing; `trackingExport.ts` left unchanged). Revisit if the export should show the origin for collection rows.
- `collection_points.pin` is stored but unused (no map in the driver app yet).
- Phase state is local to `StopsScreen` (resets to the progress-derived default after a capture round-trip) rather than lifted into `App.tsx` — simpler, and the default lands on the right phase.
