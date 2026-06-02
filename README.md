# Greenmix Worker

A **read-only source of the Dutch electricity generation mix**, running on
Cloudflare Workers + D1. A cron fetches Ned.nl utilisation data twice a day and
stores it in D1; a public JSON/CSV API then serves it to anything that wants it.

This is the sibling of [`epexspot`](https://github.com/VvELaadoplossing/epexspot)
and follows the same rules: it's the shared *energy-data* layer, intentionally
dumb — one writer (its cron) and many readers. It stores **only raw Ned facts**.
The single derived value it exposes, the green/non-green flag, comes from Ned's
own renewable definition, not from any tenant or proposition logic.

```
                 ┌──────────────┐        ┌──────────────────────┐
   Ned.nl    ──▶ │  greenmix     │        │  consumers            │
 (mix + CO2)     │  (this repo)  │        │  charts, portal, ...  │
                 │  cron + D1    │        │                       │
                 │  forecast +   │        │                       │
                 │  realized     │        └──────────┬───────────┘
                 └──────┬───────┘                    │
                        │  GET /api/forecast etc.     │
                        └─────────────────────────────┘
```

**Rule of thumb:** never add proposition-specific logic, branding or opinions
here. The only opinion is the green flag, and that defers to Ned (see below).

---

## Endpoints

| Route | Description |
|---|---|
| `GET /api/forecast` | JSON rows, Ned classification 1 (forecast). Defaults to the last 14 days. |
| `GET /api/forecast.csv` | Same as CSV. |
| `GET /api/realized` | JSON rows, Ned classification 2 (current / actuals). |
| `GET /api/realized.csv` | Same as CSV. |
| `GET /api/greenmix` | Per-timestamp green vs non-green kWh split (`?source=forecast\|realized`). |
| `GET /api/refresh?token=…` | Manually run the collector. Needs the `REFRESH_TOKEN` secret. |
| `GET /` | Plain-text help. |

Query params for the data routes: `?from=ISO`, `?to=ISO`, `?all=1`, `?limit=N`,
`?type=1,2,20` (filter by Ned type id).

Extra params for `/api/refresh`: `?source=forecast|realized|both` (default
`both`), `?days_back=N`, `?days_fwd=N` (widen the window — useful to re-pull
late revisions; see below).

Examples you can paste in a browser:

```
…/api/forecast                                          last 14 days, all types
…/api/realized?type=20&all=1                            all nuclear actuals
…/api/greenmix?source=realized                          green split, realized
…/api/forecast.csv?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z
…/api/refresh?token=YOUR_TOKEN&source=realized&days_back=28
```

## What gets stored

Two D1 tables with the same shape (see `schema.sql`) — `greenmix_forecast`
(classification 1) and `greenmix_realized` (classification 2):

| Column | Meaning |
|---|---|
| `type_id` | Ned type id (1 Wind, 2 Solar, 20 Nuclear, …). Part of the **primary key.** |
| `ts_utc` | UTC timestamp, e.g. `2026-05-27T12:00:00Z`. Part of the **primary key.** |
| `ts_local` | Same instant in Amsterdam wall-clock, e.g. `2026-05-27T14:00:00+02:00`. Display only. |
| `ts_utc_end` | Interval end (`validto`), UTC. |
| `volume_kwh` | Volume produced in the interval (kWh). |
| `capacity_kw` | Capacity (kW) — volume normalised to an hourly rate. |
| `percentage` | Utilisation as a fraction of max capacity. |
| `emission_kg` | CO₂ emission for the interval (kg). |
| `emissionfactor` | Emission factor (kg CO₂ / kWh). |
| `point` | Geographic point (0 = Netherlands). |
| `granularity` | 4 = 15 minutes. |
| `ned_id` | Ned record id. |
| `last_update` | Ned `lastupdate`; bumps when a value is recalculated. |
| `raw_json` | The full original record, kept for safety / future fields. |
| `updated_at` | When the row was last written. |

`(type_id, ts_utc)` being the primary key makes de-duplication automatic (the
cron can run as often as it likes and never creates duplicate rows). Because
`ts_utc` is a fixed-width ISO string, **sorting it as text is the same as
sorting chronologically**, even across daylight-saving changes. Always sort and
range-filter on `ts_utc`; `ts_local` carries `+01:00`/`+02:00` offsets and is
not monotonic across DST. This is identical to the epexspot worker.

Browse it in the D1 console (one line — the console collapses multiline SQL):

```sql
SELECT type_id, ts_utc, ts_local, volume_kwh, capacity_kw, emissionfactor FROM greenmix_forecast ORDER BY ts_utc DESC LIMIT 50;
```

## Green / non-green — following Ned

There is **no configurable percentage table**. The green flag is baked into the
worker (`TYPES` in `src/index.mjs`) and follows Ned's own renewable definition —
the type-0 "All" set documented at <https://ned.nl/nl/definities>:

- **Green (renewable per Ned):** Wind on/offshore, Solar, Biomass Power.
- **Not green:** Gas, Coal, **Nuclear** (Ned does not count nuclear as
  renewable — neither do CBS or the EU Renewable Energy Directive), WKK.
- **The two judgement calls** (where Ned's own accounting is *partial*, so a
  pure boolean can't be exact): **Waste Power** is set non-green (~50% of waste
  is biogenic) and **Other Power** is set green (Ned describes it as hydro +
  biomass/biogas CHP). Each is a one-line boolean flip in `TYPES`.
- **Electricity Mix (type 27)** is an emission factor, not a generation volume,
  so it has `green: null` and is excluded from the green split.

If you ever need nuclear counted as "green", that's the EU *Taxonomy*
("low-carbon", not "renewable") view — flip `id: 20` to `green: true`.

## How the collector works

On each run, `fetchAndStore` pulls every type in `TYPES` for one classification
over a wide, overlapping window (forecast looks forward, realized looks back).
The window is deliberately wide so a missed run is backfilled by the next, and
anything already stored is overwritten (upsert on `(type_id, ts_utc)`) rather
than duplicated.

It requests Ned at **15-minute granularity in UTC** (`granularity=4`,
`granularitytimezone=0`, `activity=1`), pages through API-Platform's
`hydra:member` / `hydra:view.hydra:next` results, and stays under Ned's limit of
**200 requests / 5 minutes** via a high `itemsPerPage` plus a small delay
between requests (and a back-off on HTTP 429).

**Revisions.** Ned recalculates history (the `last_update` field bumps); for
some types — notably Waste Power — actuals fill in over a rolling **28-day**
window. The daily realized window is short, so to re-pull older revisions run
`/api/refresh?source=realized&days_back=28` on demand.

## Schedule (and why it's in UTC)

```
"crons": ["0 13 * * *", "0 18 * * *"]   // 13:00 and 18:00 UTC
```

Cloudflare cron triggers **must** be UTC. These are the same times as the
epexspot worker, so the two refresh together. Add more lines if you want fresher
forecasts during the day.

## How it lines up with epexspot

The **forecast** table matches epexspot cleanly: same 15-minute UTC grid, same
forward horizon, same `ts_utc`/`ts_local` formatting and DST handling — so you
can join greenmix forecast rows to EPEX prices on `ts_utc` directly. The
**realized** table has no EPEX counterpart: a day-ahead price is fixed once
published and never revised, whereas Ned's realized values are revised over
time (hence the 28-day note above).

---

## Setup (dashboard-first)

**1. Use the existing D1 database** — its id is already in `wrangler.jsonc`
(`af605300-b911-40fe-9d84-7cae2f9f7c32`). If you'd rather make a fresh one:
dashboard → **Storage & Databases → D1 → Create**, then paste the new id into
`wrangler.jsonc`.

**2. Create the tables** — open the database → **Console**, and run these two
statements (one line each):

```sql
CREATE TABLE IF NOT EXISTS greenmix_forecast (type_id INTEGER NOT NULL, ts_utc TEXT NOT NULL, ts_local TEXT NOT NULL, ts_utc_end TEXT, volume_kwh REAL, capacity_kw REAL, percentage REAL, emission_kg REAL, emissionfactor REAL, point INTEGER, granularity INTEGER, ned_id INTEGER, last_update TEXT, raw_json TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (type_id, ts_utc));
```

```sql
CREATE TABLE IF NOT EXISTS greenmix_realized (type_id INTEGER NOT NULL, ts_utc TEXT NOT NULL, ts_local TEXT NOT NULL, ts_utc_end TEXT, volume_kwh REAL, capacity_kw REAL, percentage REAL, emission_kg REAL, emissionfactor REAL, point INTEGER, granularity INTEGER, ned_id INTEGER, last_update TEXT, raw_json TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (type_id, ts_utc));
```

(Or load `schema.sql` via the CLI alternative below.)

**3. Add secrets** — Worker → **Settings → Variables and Secrets**:

- `NED_API_KEY` — your Ned.nl X-AUTH-TOKEN. **Regenerate it first** if it has
  ever been shared.
- `REFRESH_TOKEN` — any long random string; protects `/api/refresh`.

**4. Connect GitHub for auto-deploy** — dashboard → **Workers & Pages → Create →
Connect to Git**, pick the `greenmix` repo. Every push to `main` deploys.

**5. Populate it once** — visit `…/api/refresh?token=YOUR_REFRESH_TOKEN`, then
check that `…/api/forecast` returns rows.

### CLI alternative

```bash
npm install
export CLOUDFLARE_API_TOKEN=...
npx wrangler d1 execute greenmix --remote --file=schema.sql
npx wrangler secret put NED_API_KEY
npx wrangler secret put REFRESH_TOKEN
npx wrangler deploy
```

## Tests

```bash
npm test
```

`test.mjs` covers the pure helpers: `+00:00`→`Z` normalisation, the
winter/summer/DST-transition Amsterdam offsets, and mapping a Ned record to a
stored row.

## Notes

- Cron times are UTC; see *Schedule*.
- Fact tables store raw Ned values only; green is derived in code from Ned.
- National (`point=0`) only for now; regional/offshore points can be added to
  the request later.
- Responses carry a 15-minute cache header.
- Cloudflare's free tier covers this workload comfortably.
