# ePOD automation scripts

Backend automation that runs on the **Citipost automation host** (not Vercel /
not Supabase Edge — GWOptical is only reachable from the private network here).

## `forward_gw_events.py` — ePOD → GWOptical tracking forwarder

Pushes ePOD tracking events (collection / warehouse scans + delivered / failed
PODs) into GWOptical's intake table `dbo.TrackingLogExport`, from where
GWOptical's 5-minute pull job lands them in `dbo.TrackingLog`.

Design & rationale:
`docs/superpowers/specs/2026-06-16-gwoptical-tracking-forwarder-design.md`.
It mirrors the Lens "Manual Events" forwarder
(`specsavers-report/scripts/forward_manual_events.py`).

### Setup

```powershell
pip install psycopg2-binary pyodbc python-dotenv   # if not already present
copy scripts\.env.example scripts\.env             # then fill in the two connection strings
```

`scripts/.env` (gitignored) needs:
- `EPOD_DATABASE_URL` — ePOD Supabase Session Pooler URI (carries the DB password).
- `GWOPTICAL_CONN` — the GWOptical ODBC string (copy from `specsavers-report/scripts/.env`).

The ODBC Driver 18 for SQL Server must be installed (it already is on the host —
the Lens loader/forwarder use it).

### Run

```powershell
cd scripts
python forward_gw_events.py --dry-run   # log what would be sent, write nothing
python forward_gw_events.py             # push un-forwarded events, sync export flags
```

Idempotent and safe to re-run: each event is recorded in `public.gw_forward_log`
(keyed on the ePOD event UUID) so it's never double-sent, and GWOptical's intake
dedupes on `(CarrierCode + TrackingNumber + TrackingDateTime)` as a backstop. A
`pg_try_advisory_lock(7242116003)` guard means a second concurrent run exits
immediately.

### Scheduling

Register with the Global-Intelligence daemon to run every ~5 minutes, alongside
the Lens loader/forwarder (`C:\Automations\Global-Intelligence\scripts\ist-sync-daemon.cjs`).
