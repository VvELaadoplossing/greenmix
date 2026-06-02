-- Greenmix (Ned.nl) — D1 schema
--
-- Two tables, same shape: one for Ned classification=1 (Forecast), one for
-- classification=2 (Current / realized). They store ONLY raw facts from the
-- Ned API. The green/non-green classification is NOT stored here — it is
-- derived in the worker from Ned's own renewable definition (see src/index.mjs).
--
-- Time columns follow the EPEX worker exactly:
--   ts_utc    fixed-width UTC ISO ending in Z, e.g. 2026-05-27T12:00:00Z
--             -> sorting it as TEXT == sorting chronologically (even across DST)
--   ts_local  same instant in Amsterdam wall-clock, e.g. 2026-05-27T14:00:00+02:00
--             -> for display only; NOT monotonic across DST, never sort on it
--
-- (type_id, ts_utc) is the primary key: re-running the cron upserts in place
-- and never creates duplicate rows.

CREATE TABLE IF NOT EXISTS greenmix_forecast (
  type_id        INTEGER NOT NULL,   -- Ned type id (1 Wind, 2 Solar, 20 Nuclear, ...)
  ts_utc         TEXT    NOT NULL,   -- validfrom, UTC, ...Z
  ts_local       TEXT    NOT NULL,   -- validfrom, Amsterdam, +01:00/+02:00
  ts_utc_end     TEXT,               -- validto, UTC, ...Z
  volume_kwh     REAL,               -- volume (kWh) produced in the interval
  capacity_kw    REAL,               -- capacity (kW), volume normalised to an hourly rate
  percentage     REAL,               -- utilisation as a fraction (0..1) of max capacity
  emission_kg    REAL,               -- CO2 emission (kg) for the interval
  emissionfactor REAL,               -- emission factor (kg CO2 / kWh)
  point          INTEGER,            -- geographic point (0 = Netherlands)
  granularity    INTEGER,            -- 4 = 15 minutes
  ned_id         INTEGER,            -- Ned record id
  last_update    TEXT,               -- Ned 'lastupdate' (UTC, ...Z) — bumps on recalculation
  raw_json       TEXT,               -- full original record, kept for safety/future fields
  updated_at     TEXT    NOT NULL,   -- when WE wrote this row (ISO, ...Z)
  PRIMARY KEY (type_id, ts_utc)
);

CREATE TABLE IF NOT EXISTS greenmix_realized (
  type_id        INTEGER NOT NULL,
  ts_utc         TEXT    NOT NULL,
  ts_local       TEXT    NOT NULL,
  ts_utc_end     TEXT,
  volume_kwh     REAL,
  capacity_kw    REAL,
  percentage     REAL,
  emission_kg    REAL,
  emissionfactor REAL,
  point          INTEGER,
  granularity    INTEGER,
  ned_id         INTEGER,
  last_update    TEXT,
  raw_json       TEXT,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (type_id, ts_utc)
);

-- The PK is (type_id, ts_utc); these indexes speed up the common API queries
-- that range-filter on ts_utc alone across all types.
CREATE INDEX IF NOT EXISTS idx_forecast_ts ON greenmix_forecast (ts_utc);
CREATE INDEX IF NOT EXISTS idx_realized_ts ON greenmix_realized (ts_utc);
