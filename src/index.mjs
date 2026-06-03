// Greenmix (Ned.nl) Worker
// ----------------------------------------------------------------------------
// A read-only source of the Dutch electricity generation mix, mirroring the
// epexspot worker. A cron fetches Ned.nl utilisation data twice a day and
// stores it in D1; a public JSON/CSV API serves it.
//
// Sibling of epexspot: one writer (the cron), many readers. It stores only
// raw Ned facts. The only opinion baked in is the green/non-green flag, which
// is derived from Ned's OWN renewable definition (the type-0 "All" set on
// https://ned.nl/nl/definities) — not a configurable percentage table.
//
//   forecast  = Ned classification 1  -> table greenmix_forecast
//   realized  = Ned classification 2  -> table greenmix_realized
//
// Secrets (Worker -> Settings -> Variables and Secrets):
//   NED_API_KEY     your Ned.nl X-AUTH-TOKEN
//   REFRESH_TOKEN   any long random string; protects /api/refresh
// ----------------------------------------------------------------------------

// --- Type catalogue ---------------------------------------------------------
// is_green follows Ned's renewable definition. Flip a single boolean to change
// a classification. The two genuinely-partial cases under Ned's own accounting
// are flagged: WastePower (~50% biogenic) and OtherPower (hydro + bio-CHP).
export const TYPES = [
  { id: 1,  name: "Wind Onshore",   green: true  },               // renewable
  { id: 2,  name: "Solar",          green: true  },               // renewable
  { id: 17, name: "Wind Offshore",  green: true  },               // renewable (model)
  { id: 22, name: "Wind Offshore B", green: true },               // renewable (actuals)
  { id: 51, name: "Wind Offshore C", green: true },               // renewable (complete series)
  { id: 25, name: "Biomass Power",  green: true  },               // co-firing biomass = renewable per Ned
  { id: 18, name: "Gas Power",      green: false },               // fossil
  { id: 19, name: "Coal Power",     green: false },               // fossil
  { id: 20, name: "Nuclear",        green: false },               // NOT renewable per Ned / CBS / EU RED
  { id: 21, name: "Waste Power",    green: false },               // FLAG: ~50% biogenic; set false to match old sheet
  { id: 26, name: "Other Power",    green: true  },               // FLAG: hydro + bio-CHP; Ned describes as renewable
  { id: 35, name: "Total WKK",      green: false },               // mostly fossil-gas cogeneration
  { id: 27, name: "Electricity Mix", green: null }, // emission factor, not a generation volume -> excluded from green sum
];
const TYPE_BY_ID = Object.fromEntries(TYPES.map((t) => [t.id, t]));

// --- small helpers ----------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalise any ISO date to fixed-width UTC ending in Z (drops milliseconds).
export function isoZ(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d)) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Same instant in Amsterdam wall-clock time, with the correct +01:00/+02:00
// offset for the date (handles DST). e.g. 2026-05-27T14:00:00+02:00
export function amsterdamLocal(value) {
  const date = new Date(value);
  if (isNaN(date)) return null;
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour; // some engines emit 24
  const wall = `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  const offMin = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offMin >= 0 ? "+" : "-";
  const a = Math.abs(offMin);
  const oh = String(Math.floor(a / 60)).padStart(2, "0");
  const om = String(a % 60).padStart(2, "0");
  return `${wall}${sign}${oh}:${om}`;
}

const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v));
const ymd = (d) => new Date(d).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

// --- Ned API ----------------------------------------------------------------
// Fetch every page for one (type, classification, window). Ned runs on API
// Platform: ld+json responses carry hydra:member + hydra:view.hydra:next, so
// we page until there is no next link. itemsPerPage keeps the page count (and
// thus request count) low and well under Ned's 200-requests / 5-minutes limit.
async function fetchType(env, typeId, classification, fromDate, toDate) {
  const members = [];
  let page = 1;
  const MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    const url = new URL("https://api.ned.nl/v1/utilizations");
    url.searchParams.set("point", "0");                 // Netherlands
    url.searchParams.set("type", String(typeId));
    url.searchParams.set("granularity", "4");           // 15 minutes
    url.searchParams.set("granularitytimezone", "0");   // UTC
    url.searchParams.set("classification", String(classification));
    url.searchParams.set("activity", "1");              // providing
    url.searchParams.set("validfrom[after]", fromDate);
    url.searchParams.set("validfrom[strictly_before]", toDate);
    // Large page -> ~1 fetch per type. Cloudflare caps outbound fetches per
    // Worker invocation (50 on the free plan), so keeping the fetch count low
    // is what stops "Too many subrequests". Ned clamps to its own max if lower.
    url.searchParams.set("itemsPerPage", "2000");
    url.searchParams.set("page", String(page));

    const res = await fetch(url.toString(), {
      headers: { "X-AUTH-TOKEN": env.NED_API_KEY, Accept: "application/ld+json" },
    });

    if (res.status === 429) { await sleep(3000); continue; } // throttled -> wait and retry
    if (!res.ok) break;                                      // no data / bad combo -> skip type

    const body = await res.json();
    const page_members =
      body["hydra:member"] || body.member || (Array.isArray(body) ? body : []);
    members.push(...page_members);

    const view = body["hydra:view"] || {};
    const next = view["hydra:next"] || view.next;
    if (!next || page_members.length === 0) break;
    page += 1;
    await sleep(250); // stay polite / under the rate limit
  }
  return members;
}

export function toRow(rec, typeId, nowIso) {
  const vf = rec.validfrom || rec.validFrom || rec.datetime || rec.timestamp;
  const tsUtc = isoZ(vf);
  if (!tsUtc) return null;
  return {
    type_id: typeId,
    ts_utc: tsUtc,
    ts_local: amsterdamLocal(vf),
    ts_utc_end: isoZ(rec.validto || rec.validTo),
    volume_kwh: num(rec.volume),
    capacity_kw: num(rec.capacity),
    percentage: num(rec.percentage),
    emission_kg: num(rec.emission),
    emissionfactor: num(rec.emissionfactor),
    point: 0,
    granularity: 4,
    ned_id: rec.id ?? null,
    last_update: isoZ(rec.lastupdate || rec.lastUpdate),
    raw_json: JSON.stringify(rec),
    updated_at: nowIso,
  };
}

const COLS = [
  "type_id", "ts_utc", "ts_local", "ts_utc_end", "volume_kwh", "capacity_kw",
  "percentage", "emission_kg", "emissionfactor", "point", "granularity",
  "ned_id", "last_update", "raw_json", "updated_at",
];

function upsertStmt(env, table) {
  const placeholders = COLS.map(() => "?").join(",");
  const updates = COLS
    .filter((c) => c !== "type_id" && c !== "ts_utc")
    .map((c) => `${c}=excluded.${c}`)
    .join(", ");
  const sql =
    `INSERT INTO ${table} (${COLS.join(",")}) VALUES (${placeholders}) ` +
    `ON CONFLICT(type_id, ts_utc) DO UPDATE SET ${updates}`;
  return env.DB.prepare(sql);
}

// Collect one source ("forecast" | "realized") into its table.
async function fetchAndStore(env, source, opts = {}) {
  const classification = source === "realized" ? 2 : 1;
  const table = source === "realized" ? "greenmix_realized" : "greenmix_forecast";

  const now = Date.now();
  const day = 86400000;
  // Wide, overlapping windows so a missed run self-heals on the next run.
  // forecast looks forward; realized looks back. days_back/days_fwd overridable.
  const daysBack = opts.daysBack ?? (source === "realized" ? 4 : 1);
  const daysFwd = opts.daysFwd ?? (source === "realized" ? 1 : 3);
  const fromDate = ymd(now - daysBack * day);
  const toDate = ymd(now + daysFwd * day);

  const nowIso = isoZ(now);
  const stmt = upsertStmt(env, table);
  let written = 0;
  const perType = {};

  for (const t of TYPES) {
    let recs;
    try {
      recs = await fetchType(env, t.id, classification, fromDate, toDate);
    } catch (e) {
      perType[t.id] = `error: ${e.message}`;
      continue;
    }
    const rows = recs.map((r) => toRow(r, t.id, nowIso)).filter(Boolean);
    perType[t.id] = rows.length;

    // Upsert in chunks (one bound statement per row; chunk the batch).
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100).map((row) =>
        stmt.bind(...COLS.map((c) => row[c]))
      );
      if (chunk.length) {
        await env.DB.batch(chunk);
        written += chunk.length;
      }
    }
    await sleep(250);
  }

  return { source, table, window: { fromDate, toDate }, written, perType };
}

// --- read helpers -----------------------------------------------------------
function clampSource(s) {
  return s === "realized" ? "realized" : "forecast";
}

async function queryRows(env, source, params) {
  const table = source === "realized" ? "greenmix_realized" : "greenmix_forecast";
  const where = [];
  const binds = [];

  if (params.get("all") !== "1") {
    if (params.get("from")) { where.push("ts_utc >= ?"); binds.push(isoZ(params.get("from"))); }
    if (params.get("to"))   { where.push("ts_utc < ?");  binds.push(isoZ(params.get("to"))); }
    // default: last 14 days if no explicit range
    if (!params.get("from") && !params.get("to")) {
      where.push("ts_utc >= ?");
      binds.push(isoZ(Date.now() - 14 * 86400000));
    }
  }
  if (params.get("type")) {
    const ids = params.get("type").split(",").map((x) => parseInt(x, 10)).filter(Number.isFinite);
    if (ids.length) { where.push(`type_id IN (${ids.map(() => "?").join(",")})`); binds.push(...ids); }
  }

  const limit = Math.min(parseInt(params.get("limit") || "0", 10) || 100000, 100000);
  const sql =
    `SELECT type_id, ts_utc, ts_local, ts_utc_end, volume_kwh, capacity_kw, percentage, ` +
    `emission_kg, emissionfactor, last_update FROM ${table} ` +
    (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
    `ORDER BY ts_utc ASC, type_id ASC LIMIT ?`;
  binds.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results.map((r) => {
    const t = TYPE_BY_ID[r.type_id] || {};
    return { ...r, type_name: t.name ?? null, is_green: t.green ?? null };
  });
}

// Per-timestamp green vs non-green split, computed from the green map (not the
// DB). Reproduces the Green / Non-Green columns from the original sheet.
async function queryGreenmix(env, source, params) {
  const rows = await queryRows(env, source, params);
  const byTs = new Map();
  for (const r of rows) {
    if (r.is_green === null || r.volume_kwh == null) continue; // skip emission-factor types
    const k = r.ts_utc;
    if (!byTs.has(k)) byTs.set(k, { ts_utc: k, ts_local: r.ts_local, green_kwh: 0, nongreen_kwh: 0 });
    const o = byTs.get(k);
    if (r.is_green) o.green_kwh += r.volume_kwh; else o.nongreen_kwh += r.volume_kwh;
  }
  return [...byTs.values()].map((o) => {
    const total = o.green_kwh + o.nongreen_kwh;
    return { ...o, total_kwh: total, green_share: total ? o.green_kwh / total : null };
  });
}

// --- response formatting ----------------------------------------------------
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=900", ...CORS },
  });

function csv(rows) {
  if (!rows.length) return new Response("", { headers: { "content-type": "text/csv; charset=utf-8", ...CORS } });
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  return new Response(body, {
    headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "max-age=900", ...CORS },
  });
}

const HELP = `Greenmix (Ned.nl) — read-only API

  GET /docs                    human-friendly HTML documentation (start here)

  GET /api/forecast            JSON, defaults to last 14 days
  GET /api/forecast.csv        same as CSV
  GET /api/realized            JSON (Ned 'current' / actuals)
  GET /api/realized.csv        same as CSV
  GET /api/greenmix            per-timestamp green vs non-green kWh split
                               (?source=forecast|realized, default forecast)
  GET /api/refresh?token=...   run the collector now (needs REFRESH_TOKEN)
                               &days_back=N&days_fwd=N to widen the window
                               &source=forecast|realized|both (default both)
                               On the free plan, if "both" ever returns a
                               "Too many subrequests" error over a very wide
                               window, call source=forecast and source=realized
                               separately (each is its own invocation).

  Query params for the data routes:
    ?from=ISO  ?to=ISO  ?all=1  ?limit=N  ?type=1,2,20

  Time: ts_utc is UTC (...Z) and is the correct sort key. ts_local is
  Amsterdam wall-clock for display only. Volumes are kWh, capacity kW,
  emission kg, emissionfactor kg/kWh. Green flag follows Ned's renewable
  definition (nuclear is NOT green).
`;

// --- HTML docs page ---------------------------------------------------------
// A small, self-contained documentation page served at /docs, in the same
// spirit as the epexspot worker's /docs. The generation-type table is built
// from TYPES above so the page can never drift out of sync with the code.
const escHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function typeRows() {
  const note = { 21: " *", 26: " **", 27: " ***" };
  return TYPES.map((t) => {
    const label = t.green === true ? "Yes" : t.green === false ? "No" : "—";
    const cls = t.green === true ? "yes" : t.green === false ? "no" : "na";
    return (
      `<tr><td><code>${t.id}</code></td>` +
      `<td>${escHtml(t.name)}${note[t.id] || ""}</td>` +
      `<td class="g-${cls}">${label}</td></tr>`
    );
  }).join("\n");
}

export function docsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Greenmix API · Netherlands</title>
<style>
  :root {
    --fg: #1c2024; --muted: #5b6470; --line: #e3e7ec; --bg: #ffffff;
    --code-bg: #f5f7f9; --accent: #1f8a4c; --accent-bg: #eaf6ee; --link: #0a6cce;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #e6e9ed; --muted: #9aa4b1; --line: #2a3038; --bg: #14171b;
      --code-bg: #1c2127; --accent: #4cc47e; --accent-bg: #16271d; --link: #69b4ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  h2 { font-size: 1.25rem; margin: 2.4rem 0 .6rem; padding-top: .4rem; border-top: 1px solid var(--line); }
  p { margin: .6rem 0; }
  .lede { color: var(--muted); font-size: 1.05rem; }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: .9em; background: var(--code-bg); padding: .1em .4em; border-radius: 4px;
  }
  pre {
    background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
    padding: 1rem; overflow-x: auto; font-size: .88rem; line-height: 1.5;
  }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0; font-size: .94rem; }
  th, td { text-align: left; padding: .5rem .65rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: .82rem; text-transform: uppercase; letter-spacing: .03em; }
  tbody tr:hover { background: var(--code-bg); }
  .g-yes { color: var(--accent); font-weight: 600; }
  .g-no { color: var(--muted); }
  .g-na { color: var(--muted); }
  ul { padding-left: 1.2rem; }
  li { margin: .25rem 0; }
  .note { color: var(--muted); font-size: .9rem; }
  .pill {
    display: inline-block; background: var(--accent-bg); color: var(--accent);
    border-radius: 999px; padding: .1rem .6rem; font-size: .8rem; font-weight: 600;
  }
  footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; }
</style>
</head>
<body>
<main>
  <p><span class="pill">read-only · no key needed</span></p>
  <h1>Greenmix API</h1>
  <p class="lede">The Dutch electricity generation mix from Ned.nl, served as JSON or CSV.</p>

  <p>A small, public, read-only API and the sibling of the EPEX SPOT price API.
  It stores raw Ned.nl facts only. The single opinion baked in is the
  <strong>green / non-green</strong> flag, which follows
  <a href="https://ned.nl/nl/definities">Ned's own renewable definition</a> —
  not a configurable percentage table. Nuclear is <em>not</em> counted as green.</p>

  <h2>What you get back</h2>
  <p>The data routes return one row per generation type per 15-minute slot:</p>
  <table>
    <thead><tr><th>Field</th><th>Example</th><th>Meaning</th></tr></thead>
    <tbody>
      <tr><td><code>type_id</code> / <code>type_name</code></td><td><code>2</code> / <code>Solar</code></td><td>Ned generation type (see the table below).</td></tr>
      <tr><td><code>is_green</code></td><td><code>true</code></td><td>Whether this type counts as green under Ned's definition.</td></tr>
      <tr><td><code>ts_utc</code></td><td><code>2026-05-27T12:00:00Z</code></td><td>Slot start in UTC. Part of the unique key, so rows never duplicate.</td></tr>
      <tr><td><code>ts_local</code></td><td><code>2026-05-27T14:00:00+02:00</code></td><td>The same moment in Amsterdam time, with the right summer/winter offset.</td></tr>
      <tr><td><code>ts_utc_end</code></td><td><code>2026-05-27T12:15:00Z</code></td><td>Slot end in UTC.</td></tr>
      <tr><td><code>volume_kwh</code></td><td><code>123456</code></td><td>Energy in this slot, in kWh.</td></tr>
      <tr><td><code>capacity_kw</code></td><td><code>987654</code></td><td>Available capacity, in kW.</td></tr>
      <tr><td><code>percentage</code></td><td><code>0.18</code></td><td>Ned's share value for the type.</td></tr>
      <tr><td><code>emission_kg</code> / <code>emissionfactor</code></td><td><code>0.31</code></td><td>CO₂ in kg, and the factor in kg/kWh.</td></tr>
    </tbody>
  </table>
  <p class="note">The <code>/api/greenmix</code> route is different: it returns one row per slot with
  <code>green_kwh</code>, <code>nongreen_kwh</code>, <code>total_kwh</code> and <code>green_share</code> (0–1).</p>

  <h2>Generation types</h2>
  <p>The catalogue of Ned types and whether each one counts as green:</p>
  <table>
    <thead><tr><th>ID</th><th>Type</th><th>Counts as green?</th></tr></thead>
    <tbody>
${typeRows()}
    </tbody>
  </table>
  <p class="note">
    * Waste Power is roughly 50% biogenic; it is currently counted as
    <strong>non-green</strong> to match the original sheet. Flip its <code>green</code> flag in
    <code>TYPES</code> to change that.<br>
    ** Other Power is hydro + bio-CHP; Ned describes it as renewable, so it counts as green.<br>
    *** Electricity Mix is an emission factor, not a generation volume, so it is excluded from the green/non-green sum.
  </p>

  <h2>Endpoints</h2>
  <table>
    <thead><tr><th>Route</th><th>Returns</th></tr></thead>
    <tbody>
      <tr><td><code>GET /api/forecast</code></td><td>Forecast mix (Ned classification 1), as JSON.</td></tr>
      <tr><td><code>GET /api/forecast.csv</code></td><td>The same data as CSV.</td></tr>
      <tr><td><code>GET /api/realized</code></td><td>Realized / actuals (Ned classification 2), as JSON.</td></tr>
      <tr><td><code>GET /api/realized.csv</code></td><td>The same data as CSV.</td></tr>
      <tr><td><code>GET /api/greenmix</code></td><td>Per-slot green vs non-green split. Add <code>?source=forecast</code> or <code>?source=realized</code> (default forecast).</td></tr>
      <tr><td><code>GET /api/greenmix.csv</code></td><td>The same split as CSV.</td></tr>
    </tbody>
  </table>

  <h2>Query parameters</h2>
  <p>Add these after a <code>?</code>, joined with <code>&amp;</code>. They work on every data route.</p>
  <table>
    <thead><tr><th>Parameter</th><th>Effect</th></tr></thead>
    <tbody>
      <tr><td><code>from=ISO</code></td><td>Only rows at/after this UTC time, e.g. <code>2026-05-01T00:00:00Z</code>.</td></tr>
      <tr><td><code>to=ISO</code></td><td>Only rows strictly before this UTC time.</td></tr>
      <tr><td><code>all=1</code></td><td>Return the entire history (overrides the default window).</td></tr>
      <tr><td><code>limit=N</code></td><td>Cap the number of rows (maximum 100000).</td></tr>
      <tr><td><code>type=1,2,20</code></td><td>Only these generation type IDs.</td></tr>
    </tbody>
  </table>
  <p>With no parameters you get the <strong>last 14 days</strong>. Give times as UTC, ending in <code>Z</code>, to match <code>ts_utc</code> — that is always the correct sort and range key. <code>ts_local</code> carries +01:00/+02:00 offsets and is for display only.</p>

  <h2>Try it</h2>
  <ul>
    <li><a href="/api/forecast">/api/forecast</a> — forecast, last 14 days</li>
    <li><a href="/api/realized">/api/realized</a> — actuals, last 14 days</li>
    <li><a href="/api/greenmix">/api/greenmix</a> — green vs non-green split</li>
    <li><a href="/api/forecast?type=1,2,17,22,51">/api/forecast?type=1,2,17,22,51</a> — wind &amp; solar only</li>
    <li><a href="/api/greenmix.csv?all=1">/api/greenmix.csv?all=1</a> — full split as CSV</li>
  </ul>

  <h2>Using it from code</h2>
  <pre><code>const res = await fetch("/api/greenmix?source=forecast");
const mix = await res.json();
// mix[0] -> { ts_utc, ts_local, green_kwh, nongreen_kwh, total_kwh, green_share }

// e.g. the green share of the most recent slot, as a percentage
const latest = mix[mix.length - 1];
console.log(Math.round(latest.green_share * 100) + "% green");</code></pre>
  <p class="note">Responses are cached for 15 minutes. Data is collected from Ned.nl twice a day,
  with a wider monthly sweep that overwrites still-provisional realized values.</p>

  <footer>Greenmix · read-only generation-mix API · data from Ned.nl</footer>
</main>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Collapse repeated slashes and strip a trailing slash so /api/forecast/
    // and //api/refresh route the same as the canonical paths.
  const p = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
    const q = url.searchParams;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    try {
      if (p === "/" || p === "") {
        return new Response(HELP, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      if (p === "/docs") {
        return new Response(docsHtml(), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=900" },
        });
      }

      if (p === "/api/forecast")      return json(await queryRows(env, "forecast", q));
      if (p === "/api/forecast.csv")  return csv(await queryRows(env, "forecast", q));
      if (p === "/api/realized")      return json(await queryRows(env, "realized", q));
      if (p === "/api/realized.csv")  return csv(await queryRows(env, "realized", q));

      if (p === "/api/greenmix") {
        const src = clampSource(q.get("source"));
        return json(await queryGreenmix(env, src, q));
      }
      if (p === "/api/greenmix.csv") {
        const src = clampSource(q.get("source"));
        return csv(await queryGreenmix(env, src, q));
      }

      if (p === "/api/refresh") {
        if (!env.REFRESH_TOKEN || q.get("token") !== env.REFRESH_TOKEN) {
          return json({ error: "unauthorized" }, 401);
        }
        const opts = {};
        if (q.get("days_back")) opts.daysBack = parseInt(q.get("days_back"), 10);
        if (q.get("days_fwd")) opts.daysFwd = parseInt(q.get("days_fwd"), 10);
        const which = q.get("source") || "both";
        const out = [];
        if (which === "both" || which === "forecast") out.push(await fetchAndStore(env, "forecast", opts));
        if (which === "both" || which === "realized") out.push(await fetchAndStore(env, "realized", opts));
        return json({ ok: true, ran: out });
      }

      return json({ error: "not found", help: "/docs" }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  // Cron runs one source per invocation so neither can approach Cloudflare's
  // per-invocation fetch cap, regardless of how Ned paginates. Times are UTC.
  // :00 triggers -> forecast, :30 triggers -> realized, monthly -> deep
  // realized sweep (~32 days back) to overwrite any values that were still
  // provisional within Ned's revision windows.
  async scheduled(event, env, ctx) {
    if (event.cron === "0 12 1 * *") {
      ctx.waitUntil(fetchAndStore(env, "realized", { daysBack: 32, daysFwd: 1 }));
      return;
    }
    const realizedCrons = ["30 13 * * *", "30 18 * * *"];
    const source = realizedCrons.includes(event.cron) ? "realized" : "forecast";
    ctx.waitUntil(fetchAndStore(env, source));
  },
};
