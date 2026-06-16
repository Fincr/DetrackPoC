"""Forward ePOD tracking events into GWOptical's intake table.

ePOD (the driver PWA + dispatcher portal) captures four kinds of tracking
event — collection / warehouse scans (parcel_events) and delivered / failed
PODs (pod_records). This script hands each one to GWOptical the same way the
Lens "Manual Events" forwarder does: it INSERTs into the intake table
`dbo.TrackingLogExport`, and GWOptical's own 5-minute pull job maps the
CarrierCode via CarrierHub and lands the event in `dbo.TrackingLog`.

Why an intake table and not a direct TrackingLog write, why everything is
branded DHL, and the full event journey: see
docs/superpowers/specs/2026-06-16-gwoptical-tracking-forwarder-design.md
and specsavers-report/docs/adr/0002-manual-events-via-gwoptical-intake.md.

GWOptical (sqlaggw.citipost.co.uk) sits on a private 10.x network — reachable
only from the automation host, never from Vercel/Supabase. So this runs here,
on a ~5-minute cron alongside the Lens loader/forwarder.

Two phases, each idempotent and committed per-row, so a GW link flap mid-run
leaves clean state and the next run resumes where this one stopped:

  push    ePOD events with no gw_forward_log row -> INSERT dbo.TrackingLogExport,
                                                    then record the handover
  sync    forwarded-but-not-exported rows        -> copy GW's Exported flag back

System of record: ePOD's parcel_events / pod_records (Supabase). GWOptical owns
the events once ingested. public.gw_forward_log is forwarding bookkeeping only.

Crash-safety: if the GW INSERT commits but the gw_forward_log INSERT doesn't,
the next run re-inserts the event. That duplicate is harmless — GWOptical's
intake dedupes on (CarrierCode + TrackingNumber + TrackingDateTime), so it's
ingested-but-ignored. (Same guarantee ePOD relies on internally: every write is
keyed on a client-generated UUID.)

Usage:
    cd scripts && python forward_gw_events.py [--dry-run]
"""
import os
import pathlib
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import psycopg2
import pyodbc
from dotenv import load_dotenv

LONDON = ZoneInfo("Europe/London")
ADVISORY_LOCK_KEY = 7242116003  # loader holds ...001, Lens forwarder ...002 — distinct so they never collide
DRY = "--dry-run" in sys.argv

# Every event is branded DHL — the only CarrierProviderName whose codes
# CarrierHub classifies. The parcel's real carrier (DHL/i2i/Oceanair/DX) is
# relabelled downstream from its service, so the scan stays carrier-agnostic.
CARRIER_PROVIDER = "DHL Parcel UK"
CLIENT_REFERENCE = "EPOD"  # origin marker (Lens uses 'LENS')

# ePOD event -> DHL CarrierCode. All four are real codes already live in
# dbo.TrackingLog, so CarrierHub maps them with no new config. Env-overridable.
CODES = {
    "collection": os.environ.get("EPOD_CODE_COLLECTION", "CTCL"),  # Driver Collection Scan
    "warehouse": os.environ.get("EPOD_CODE_WAREHOUSE", "WH10"),    # In Delivering Warehouse
    "delivered": os.environ.get("EPOD_CODE_DELIVERED", "DT15"),    # Accepted at delivery point
    "failed": os.environ.get("EPOD_CODE_FAILED", "DF48"),          # 48 - No Contact / Access Avail
}

# Discover un-forwarded events. Two arms unioned so they process in time order:
#   - parcel_events stage IN (collection, warehouse). The 'delivered' parcel_event
#     (id = podId, written by the POD sync) is excluded here and forwarded once,
#     from its pod_records row.
#   - pod_records (delivered/failed), parcel-linked only (JOIN parcels excludes
#     site/store captures — those aren't parcels GWOptical tracks).
# captured_at is stored UTC; AT TIME ZONE 'Europe/London' yields the tz-naive
# UK-local datetime GWOptical expects. Lat/Lng come straight off the captured fix.
DISCOVER_SQL = """
SELECT source, source_id, tracking_number, kind, event_local, lat, lng, loc_text, info
FROM (
  SELECT 'event' AS source, e.id AS source_id, p.tracking_number,
         e.stage AS kind,
         (e.captured_at AT TIME ZONE 'Europe/London') AS event_local,
         ST_Y(e.location::geometry) AS lat, ST_X(e.location::geometry) AS lng,
         COALESCE(p.postcode, p.area) AS loc_text,
         NULL::text AS info
  FROM parcel_events e
  JOIN parcels p ON p.id = e.parcel_id
  WHERE e.stage IN ('collection', 'warehouse')
    AND NOT EXISTS (SELECT 1 FROM gw_forward_log g
                    WHERE g.source = 'event' AND g.source_id = e.id)
  UNION ALL
  SELECT 'pod' AS source, r.id AS source_id, p.tracking_number,
         r.status AS kind,
         (r.captured_at AT TIME ZONE 'Europe/London') AS event_local,
         ST_Y(r.location::geometry) AS lat, ST_X(r.location::geometry) AS lng,
         COALESCE(p.postcode, p.area) AS loc_text,
         CASE WHEN r.status = 'delivered' THEN r.received_by ELSE r.failure_reason END AS info
  FROM pod_records r
  JOIN parcels p ON p.id = r.parcel_id
  WHERE r.status IN ('delivered', 'failed')
    AND NOT EXISTS (SELECT 1 FROM gw_forward_log g
                    WHERE g.source = 'pod' AND g.source_id = r.id)
) q
ORDER BY event_local
"""

INSERT_INTAKE_SQL = """
INSERT INTO dbo.TrackingLogExport
  (CarrierProviderName, TrackingNumber, ClientReference, CarrierCode,
   TrackingDate, TrackingDateTime, TrackingLocation, TrackingAdditionalInfo,
   Latitude, Longitude, AddedDate, Exported)
OUTPUT INSERTED.Id
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
"""


def log(msg: str) -> None:
    print(f"[{datetime.now(LONDON):%H:%M:%S}] {msg}", flush=True)


def clip(value, length):
    """Trim to the intake column width (defensive — ePOD text is usually short)."""
    if value is None:
        return None
    s = str(value)
    return s[:length]


def main() -> None:
    load_dotenv(pathlib.Path(__file__).with_name(".env"))

    epod_url = os.environ.get("EPOD_DATABASE_URL")
    gw_conn = os.environ.get("GWOPTICAL_CONN")
    if not epod_url:
        sys.exit("Set EPOD_DATABASE_URL in scripts/.env (the ePOD Supabase Session Pooler URI).")
    if not gw_conn:
        sys.exit("Set GWOPTICAL_CONN in scripts/.env (the GWOptical ODBC string).")

    unknown = [k for k, v in CODES.items() if not v]
    if unknown:
        sys.exit(f"Empty CarrierCode for: {', '.join(unknown)} — check EPOD_CODE_* in scripts/.env.")

    pg = psycopg2.connect(epod_url)
    cur = pg.cursor()
    cur.execute("SELECT pg_try_advisory_lock(%s)", (ADVISORY_LOCK_KEY,))
    if not cur.fetchone()[0]:
        log("another forwarder run holds the lock; exiting")
        pg.close()
        return

    gw = None
    pushed = synced = 0
    try:
        gw = pyodbc.connect(gw_conn, timeout=15)
        gwc = gw.cursor()

        # ---- push ----
        cur.execute(DISCOVER_SQL)
        events = cur.fetchall()
        pg.commit()  # close the read transaction before per-row writes

        for source, source_id, tracking, kind, event_local, lat, lng, loc_text, info in events:
            code = CODES[kind]
            if DRY:
                log(f"[dry] would push {source} {source_id} {tracking} {kind} ({code}) @ {event_local}")
                continue
            gwc.execute(
                INSERT_INTAKE_SQL,
                CARRIER_PROVIDER,
                clip(tracking, 50),
                CLIENT_REFERENCE,
                clip(code, 100),
                event_local.date(),
                event_local,
                clip(loc_text, 200),
                clip(info, 200),
                round(float(lat), 7) if lat is not None else None,
                round(float(lng), 7) if lng is not None else None,
                datetime.now(LONDON).replace(tzinfo=None),
            )
            gw_id = gwc.fetchone()[0]
            gw.commit()
            cur.execute(
                """INSERT INTO gw_forward_log
                     (source, source_id, tracking_number, carrier_code, event_at, gw_export_id)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (source, source_id) DO UPDATE
                     SET gw_export_id = EXCLUDED.gw_export_id, forwarded_at = now()""",
                (source, source_id, tracking, code, event_local, gw_id),
            )
            pg.commit()
            pushed += 1
            log(f"pushed {source} {source_id} {tracking} {kind} -> TrackingLogExport Id {gw_id}")

        # ---- sync: copy GW's Exported flag back into the bookkeeping ----
        cur.execute(
            """SELECT source, source_id, gw_export_id FROM gw_forward_log
               WHERE exported_at IS NULL AND gw_export_id IS NOT NULL"""
        )
        for source, source_id, gw_id in cur.fetchall():
            gwc.execute(
                "SELECT Exported, ExportedDateTime FROM dbo.TrackingLogExport WHERE Id = ?", gw_id
            )
            row = gwc.fetchone()
            if DRY:
                log(f"[dry] sync {source} {source_id}: intake says {row}")
                continue
            if row is None:
                # Intake row gone (GW housekeeping after ingest) — treat as exported.
                cur.execute(
                    "UPDATE gw_forward_log SET exported_at = now() WHERE source = %s AND source_id = %s",
                    (source, source_id),
                )
                pg.commit()
                synced += 1
                log(f"sync {source} {source_id}: intake row gone, assuming ingested")
            elif row[0]:
                exported_local = row[1]  # GW datetimes are UK-local naive
                cur.execute(
                    """UPDATE gw_forward_log
                       SET exported_at = COALESCE(%s::timestamp AT TIME ZONE 'Europe/London', now())
                       WHERE source = %s AND source_id = %s""",
                    (exported_local, source, source_id),
                )
                pg.commit()
                synced += 1
                log(f"sync {source} {source_id}: exported at {exported_local}")

        log(f"done - pushed {pushed}, synced {synced}{' (dry-run)' if DRY else ''}")
    finally:
        # Always release the advisory lock and close cleanly — a leaked lock on a
        # pooler-held session would silently wedge every later tick.
        try:
            pg.rollback()  # clear any open/aborted txn
            cur.execute("SELECT pg_advisory_unlock(%s)", (ADVISORY_LOCK_KEY,))
            pg.commit()
        except Exception:
            pass
        if gw is not None:
            try:
                gw.close()
            except Exception:
                pass
        pg.close()


if __name__ == "__main__":
    main()
