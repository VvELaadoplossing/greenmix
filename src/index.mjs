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
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=900" },
  });

function csv(rows) {
  if (!rows.length) return new Response("", { headers: { "content-type": "text/csv; charset=utf-8" } });
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  return new Response(body, {
    headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "max-age=900" },
  });
}

const HELP = `Greenmix (Ned.nl) — read-only API

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Collapse repeated slashes and strip a trailing slash so /api/forecast/
    // and //api/refresh route the same as the canonical paths.
    const p = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
    const q = url.searchParams;

    try {
      if (p === "/" || p === "") {
        return new Response(HELP, { headers: { "content-type": "text/plain; charset=utf-8" } });
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

      return json({ error: "not found", help: "/" }, 404);
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
