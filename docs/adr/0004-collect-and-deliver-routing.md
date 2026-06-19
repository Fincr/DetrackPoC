# Parcels carry a sender-derived origin; routes pair collection-area and delivery-area sets

**Status:** accepted

The app gains a **collection leg**. Until now a parcel had only a destination and
the operation was London delivery; now each parcel also has an **origin** (the
sender block carried on every GWOptical shipment), and a driver **collects then
delivers the same parcels, same day**.

The decision, in one breath:

- **Origin is per-parcel, not a maintained registry.** Each parcel stores its
  sender address (`sender_*`), pulled from GWOptical via the existing Lens path.
  **Collection points** (the distinct sender sites a driver visits) are *derived*
  by grouping parcels on their sender postcode — never a hand-kept list.
- **Regions are UK postcode areas** — the letter prefix (`DY`, `EH`, `SW`…),
  derived straight from a postcode. This replaces the six fixed London labels. A
  parcel therefore carries **two** areas: a **collection area** (from its sender
  postcode) and a **delivery area** (from its recipient postcode).
- **A Route = a set of collection areas → a set of delivery areas**, one driver
  (each set usually one). A parcel auto-allocates when its collection area ∈ the
  route's collection set **and** its delivery area ∈ its delivery set.
- **Collect → deliver directly, same day, cross-region is normal.** No hub on the
  happy path; the existing `at_warehouse` stage is retained only for exceptions
  (re-route, missed window). Collection is a **per-parcel quick scan** (custody:
  time + GPS + driver); delivery keeps the full POD.

## The evidence behind it

A read-only probe of GWOptical's `dbo.Shipments` (≈350k rows, 3 months) drove the
shape and is the reason several choices look the way they do:

- **Origin is always present.** `Sender_Postcode` was non-null on **every** row;
  the full sender block (`Sender_Address1/2/3`, `Sender_City`, `Sender_Postcode`)
  rides on each shipment. → origin can be per-parcel.
- **The shop *name* is not.** `Sender_Company` is blank on almost every row (5
  distinct values in 6 months). → the address always renders; a *name* needs a
  small lookup (below).
- **The operation is hub-and-spoke, not intra-region.** Only **10.6%** of
  shipments have sender area == recipient area; the dominant flows are
  `NN → {B, TN, LE, …}` and `DY → {EH, ML, G, …}` — two DCs fanning out
  nationwide. → routes must pair *different* collection and delivery areas; an
  "origin ≈ destination" model would have been wrong.
- **Lanes are fat enough to fill a van.** The big (collection→delivery) pairs are
  thousands each (`NN→B` 3,445; `DY→EH` 3,235). → an area→area route is a real
  unit of work. The thin tail is why a route holds *sets*, not a single pair.
- **No same-day service exists in the source** (all `Parcel Next day …`). →
  same-day is *Citipost's own leg SLA*, not a field we read.

## Why this over the alternatives

- **A maintained collection-point registry** (the first instinct — "find every
  site and store them"). Rejected: origin is non-null on every row, so a registry
  would duplicate the truth that already rides on each parcel and *drift* from it,
  and new senders would silently fall through until added. The derived model is
  zero-maintenance and scales from a few pilot shops to nationwide with **no code
  change** — only more parcels. The one curated concession is a thin,
  **display-only** `collection_points` lookup (sender postcode → friendly name +
  map pin) so a known shop reads "Specsavers Windsor" rather than only its
  address; it overrides presentation, never the model.
- **Grouped / named operational regions** (e.g. "West Midlands" = `B`+`DY`+`WV`).
  Rejected as the grain: it needs a hand-maintained mapping and border
  judgements, whereas postcode area derives for free and matches the lanes the
  data already forms. Friendly region names can sit *on top* later without
  changing the model.
- **Keeping the six London labels.** Rejected: the operation is UK-wide; the
  labels can't express national lanes. Clean break is affordable because the
  hosted data is wiped between tests (no back-compat to preserve).
- **A central hub / sort between collect and deliver.** Rejected as the default:
  the SLA is same-day and one driver carries the parcels A→B. The warehouse stage
  is kept *only* for the exceptions the user named (driver re-route, too late) —
  the forward-only `advance_parcel_status` RPC already allows both
  `collected → delivered` and the `collected → at_warehouse → delivered` detour,
  so no lifecycle surgery is needed.
- **Strict one collection area → one delivery area routes.** Rejected: the lane
  tail is thin and a 3-parcel lane isn't worth a van. Modelling each side as a
  *set* lets the dispatcher consolidate small lanes into a viable load while the
  common 1→1 case is just a set of size one.

## Consequences

- **The area subsystem is replaced, not extended.** `Area` stops being a
  six-value union with a DB `CHECK`; it becomes a UK postcode-area code (a
  string). `deriveArea` simplifies to "extract the postcode's letter prefix."
  `parcels.area` is renamed `delivery_area` and gains a sibling `collection_area`;
  `routes.areas` becomes `routes.delivery_areas` and gains `routes.collection_areas`.
  This touches `types.ts`, the routes editor, the allocate screen, and the
  enrich/manifest derivation. (Supersedes the six-label scheme in the 2026-06-17
  enrich spec.)
- **`parcels` gains the sender block** (`sender_name`, `sender_address_line`,
  `sender_postcode`, `collection_area`) plus `delivery_area`. The `destination`
  pin stays null (the mirror carries no geocode — same non-goal as enrichment);
  collection has no geofence initially.
- **The Lens read path widens, not forks.** `epod_shipment_lookup` (the
  version-controlled Lens view) and `enrich-shipments` gain the `Sender_*`
  columns; `src/lib/enrich.ts` composes them. The **PII boundary grows** to
  include sender addresses — recorded as a deliberate expansion of the boundary
  the enrich spec set.
- **The driver run becomes two-phase** (collect, then deliver). The collection
  stage, its quick-scan, and its GWOptical forwarding **already exist**, so the
  collection leg lights up with no new downstream integration.
- **Names lag at scale, addresses never do.** A brand-new shop is collectable the
  moment its parcels import (its address shows immediately); only the *friendly
  name* would lag without a store-directory feed. For the pilot's few shops the
  lookup is hand-filled; nationwide would want a directory.
- **The delivery-only `sites` feature is orthogonal** and left untouched (a
  "deliver to a store/depot" path; the dispatcher may retire it separately).
