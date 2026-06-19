# Citipost ePOD — domain glossary

The canonical vocabulary for this project. Implementation details belong in
`CLAUDE.md` and the code; this file defines *what the words mean* so we use them
consistently. Resolved during the admin-panel design (2026-06-16).

## Identity & access

The word "driver" is overloaded in casual speech. In this system it splits into
**two distinct things** that can exist independently:

- **Login** — an `auth.users` account: a credential (see **Username** /
  **Email** below) + password a person signs in with. Has no role or fleet
  meaning on its own. Created/managed only with the service-role key (never from
  the browser).

- **Username** — how a **driver** signs in: first initial + surname, e.g.
  `FCrawley` (case-insensitive). Drivers have no email. Admins sign in with their
  real company **email** instead. The sign-in box accepts either.

- **Synthetic email** — the implementation of a Username. Supabase Auth keys
  accounts on an email, so a Username is stored as `<username>@<internal-domain>`
  (a non-routable address that never reaches a real inbox). It's an internal
  detail — users only ever see/type the Username. See ADR 0003.

- **Profile** — a `profiles` row that maps one Login to a **Role** and, for
  drivers, to a **Roster entry**. This is the app's notion of *who you are*.
  One Login ↔ one Profile.

- **Role** — `admin` or `driver`. `admin` runs the dispatcher portal (allocate,
  jobs, sites, PODs, admin panel). `driver` sees only their own run.

- **Roster entry** (a.k.a. **Driver**, the `drivers` table row) — `id` + `name`.
  This is the *fleet identity* stamped onto every POD and scan event and
  assigned to a Route. A Roster entry can exist with **no Login at all** (e.g.
  a seeded driver, or one kept only so historical PODs still resolve a name).
  When we say "Driver" unqualified, we mean this roster entity.

- **Driver login** — the common case: a Login whose Profile has `role = driver`
  and whose `driver_id` points at a Roster entry. Creating a working driver
  therefore means ensuring **both** a Roster entry and a Driver login linked to
  it. Attribution (which PODs are whose) follows the Roster entry, not the
  Login — deleting a Login never orphans delivery history.

## Fleet & work

- **Route** — one Driver's run for a day (the `routes` row), defined as a set of
  **Collection areas** → a set of **Delivery areas** (each usually just one). The
  driver collects every parcel whose **origin** falls in one of the route's
  collection areas, then delivers those *same* parcels into one of its delivery
  areas — same parcels, same day; cross-region is normal (e.g. collect `DY`,
  deliver `EH`+`G`+`ML`). A parcel auto-allocates to a Route when its collection
  area ∈ the route's collection set **and** its delivery area ∈ its delivery set
  (the dispatcher keeps a day's sets non-overlapping, so a parcel lands on
  exactly one). Has a unique name and an assigned Roster entry (`driver_id`).

- **Area** — the canonical region grain: a **UK postcode area** — the leading
  letters of a postcode (`EH`, `DY`, `NN`, `SW`…; ~120 nationwide), derived
  directly from the postcode (a simpler `deriveArea`). A parcel carries **two**:
  a **Collection area** (from its sender) and a **Delivery area** (from its
  recipient); a Route pairs one of each and auto-allocation matches both.
  *(Supersedes the original six London-only labels — `South London`, `Kent`, … —
  which this replaces with the UK-wide postcode-area scheme.)*

- **Origin (sender)** — where a parcel is collected *from*. Each parcel carries
  a sender address (company/name, address lines, `sender_postcode`), taken from
  the GWOptical shipment record at import/enrich time — the pickup-leg
  counterpart of the recipient/delivery address. Always present in the source.

- **Collection point** — a distinct origin that parcels are picked up from,
  identified by its **sender postcode + address** and **derived** from the
  parcels themselves (their sender fields), *not* a separately maintained list.
  It is the pickup-leg analogue of a delivery destination; Collection points group
  into a driver's pickup leg by **Collection area**, mirroring how **Delivery
  area** groups deliveries. A Collection point is an *origin* and is **not** a
  **Site** — a Site is a store/depot you deliver *to*.

- **Collection area** — a region a Route collects in (a Route holds one or
  more), derived from each parcel's **sender** postcode. Contains many
  **Collection points** (the distinct sender sites that fall within it).

- **Delivery area** — a region a Route delivers in (a Route holds one or more),
  derived from each parcel's **recipient** postcode; this is what **Area**
  becomes once generalised UK-wide. A parcel therefore has *two* areas — a
  collection area (from its sender) and a delivery area (from its recipient) —
  and a Route holds a set of each.

- **Allocation** — linking a Parcel (or Site) to a Route (`route_id`). `null` =
  unallocated (dispatcher to-do; hidden from every driver's run).

- **Parcel**, **Manifest (Job)**, **Site**, **POD**, **Scan event** — unchanged
  from `CLAUDE.md`; see there for lifecycle detail.

## Admin panel verbs

- **Add a user** — create a Login + Profile in one step. A driver gets a
  **Username** (suggested from their name) and a **Roster entry minted from
  their Full name** (one per person — the identity shown on deliveries); an
  admin gets an **email**. Re-linking a driver to an *existing* Roster entry is
  a Manage-panel action, not part of Add.
- **Assign a role / re-link a driver** — edit the Profile. Editing a driver's
  Full name also renames their linked Roster entry (kept in sync), unless you
  re-link them to a different existing entry.
- **Reset password** — set a new password on the Login (admin-chosen; see
  ADR 0002).
- **Deactivate** — ban the Login so it can't sign in, without deleting history.
- **Delete user** — remove the Login (cascades to its Profile). Does **not**
  touch the Roster entry or any PODs.
- **Manage drivers** — CRUD the Roster (`drivers`).
- **Manage routes** — CRUD Routes and their Areas.
