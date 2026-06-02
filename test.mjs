// Pure-helper tests. Run: node test.mjs
import { isoZ, amsterdamLocal, toRow, TYPES } from "./src/index.mjs";

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}` + (ok ? "" : `\n        got:  ${got}\n        want: ${want}`));
  ok ? pass++ : fail++;
}

// isoZ: +00:00 -> Z, drops milliseconds
eq("isoZ +00:00 -> Z", isoZ("2026-05-06T00:15:00+00:00"), "2026-05-06T00:15:00Z");
eq("isoZ already Z",   isoZ("2026-05-06T00:15:00.000Z"), "2026-05-06T00:15:00Z");
eq("isoZ null",        isoZ(""), null);

// amsterdamLocal: summer = +02:00, winter = +01:00
eq("ams summer (+02:00)", amsterdamLocal("2026-05-26T00:00:00Z"), "2026-05-26T02:00:00+02:00");
eq("ams winter (+01:00)", amsterdamLocal("2026-01-15T12:00:00Z"), "2026-01-15T13:00:00+01:00");
// just after the spring-forward (last Sunday March 2026 = 29 Mar, 01:00 UTC)
eq("ams DST spring",      amsterdamLocal("2026-03-29T01:00:00Z"), "2026-03-29T03:00:00+02:00");

// toRow maps the Ned record shape from the API docs example
const rec = {
  id: 3844522221,
  capacity: 438626,
  volume: 73104,
  percentage: 0.05968400090932846,
  validfrom: "2020-11-16T14:30:00+00:00",
  validto: "2020-11-16T14:40:00+00:00",
  lastupdate: "2020-11-19T14:06:04+00:00",
};
const row = toRow(rec, 2, "2026-06-02T00:00:00Z");
eq("toRow ts_utc",      row.ts_utc, "2020-11-16T14:30:00Z");
eq("toRow ts_local",    row.ts_local, "2020-11-16T15:30:00+01:00");
eq("toRow ts_utc_end",  row.ts_utc_end, "2020-11-16T14:40:00Z");
eq("toRow volume",      row.volume_kwh, 73104);
eq("toRow capacity",    row.capacity_kw, 438626);
eq("toRow ned_id",      row.ned_id, 3844522221);
eq("toRow last_update", row.last_update, "2020-11-19T14:06:04Z");
eq("toRow empty emission -> null", row.emission_kg, null);

// green map sanity
eq("nuclear not green", TYPES.find((t) => t.id === 20).green, false);
eq("solar green",       TYPES.find((t) => t.id === 2).green, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
