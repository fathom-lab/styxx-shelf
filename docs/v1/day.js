"use strict";
/* day.js: a timestamp's calendar day in the header's anchor_tz (protocol v1, section 1).

   v1 timestamps are exactly YYYY-MM-DDTHH:MM:SSZ (UTC, no fraction, no offset, a real calendar instant). The day
   is read with the platform's zone database through Intl.DateTimeFormat. There is no written fallback rule: a
   zone the database does not hold is refused (code anchor_tz), never approximated. Years run 1000..9998, so the day
   exists as a four-digit year in every zone; "Factory" is refused by name. lateOf is section 5's rule for an anchor
   entry's `late`. Codes: timestamp, anchor_tz, anchor_form. */
const { LedgerValueError } = require("./jcs");

const TIMESTAMP_RX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
// an IANA-shaped name. Intl in recent node also takes offset zones such as "+01:00", which zoneinfo refuses.
const ZONE_NAME_RX = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const DATE_RX = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MIN = 1000, YEAR_MAX = 9998;
const REFUSED_ZONES = ["Factory"];
const LATE_AFTER = "00:10:00";   // an anchor written later than this, local, on the day after its date is late

/* A v1 timestamp as epoch milliseconds; LedgerValueError(timestamp) otherwise. */
function parseTimestamp(ts) {
  if (typeof ts !== "string") throw new LedgerValueError("timestamp", "timestamp is not a string");
  const m = TIMESTAMP_RX.exec(ts);
  if (!m) throw new LedgerValueError("timestamp", "timestamp is not YYYY-MM-DDTHH:MM:SSZ: " + JSON.stringify(ts.slice(0, 40)));
  const n = m.slice(1).map(Number);
  if (n[0] < YEAR_MIN || n[0] > YEAR_MAX) throw new LedgerValueError("timestamp", "timestamp year outside " + YEAR_MIN + ".." + YEAR_MAX + ": " + ts);
  const d = new Date(0);
  d.setUTCFullYear(n[0], n[1] - 1, n[2]); // not Date.UTC: Date.UTC maps years 0-99 to 1900-1999
  d.setUTCHours(n[3], n[4], n[5], 0);
  // the round trip refuses what Date rolls over silently: 30 february, hour 24, second 60, month 13
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 19) + "Z" !== ts) {
    throw new LedgerValueError("timestamp", "timestamp names no calendar instant: " + ts);
  }
  return d.getTime();
}

const fmtCache = new Map();
function formatter(tz) {
  if (typeof tz !== "string" || !tz || !ZONE_NAME_RX.test(tz) || REFUSED_ZONES.includes(tz)) {
    throw new LedgerValueError("anchor_tz", "anchor_tz is not an IANA zone name: " + JSON.stringify(tz));
  }
  let f = fmtCache.get(tz);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    });
  } catch (e) {
    throw new LedgerValueError("anchor_tz", "zone " + JSON.stringify(tz) + " not in this platform's zone database");
  }
  // Intl matches zone names case-insensitively. A case variant of the canonical name is refused, so the
  // implementations do not split on "utc" vs "UTC" by filesystem.
  const resolved = f.resolvedOptions().timeZone;
  if (resolved !== tz && resolved.toLowerCase() === tz.toLowerCase()) {
    throw new LedgerValueError("anchor_tz", "zone " + JSON.stringify(tz) + " is a case variant of " + resolved);
  }
  if (fmtCache.size > 64) fmtCache.clear();
  fmtCache.set(tz, f);
  return f;
}

/* Returns tz, or throws LedgerValueError(anchor_tz) unless this platform's zone database holds it. */
function checkZone(tz) { formatter(tz); return tz; }

/* {day, clock} of a v1 timestamp in zone tz: "YYYY-MM-DD" and "HH:MM:SS". The timestamp is checked before the zone. */
function localParts(ts, tz) {
  const ms = parseTimestamp(ts);
  const parts = formatter(tz).formatToParts(new Date(ms));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  if (!/^\d{1,4}$/.test(m.year) || m.era !== undefined) {
    throw new LedgerValueError("timestamp", "timestamp " + ts + " has no four-digit day in " + tz);
  }
  return { day: m.year.padStart(4, "0") + "-" + m.month + "-" + m.day, clock: m.hour + ":" + m.minute + ":" + m.second };
}

/* The calendar day, YYYY-MM-DD, of a v1 timestamp in zone tz. */
function dayOf(ts, tz) { return localParts(ts, tz).day; }

function nowUtc() { return new Date().toISOString().slice(0, 19) + "Z"; }

/* The day after a YYYY-MM-DD date; LedgerValueError(anchor_form) when it is not a date. */
function nextDay(date) {
  const m = typeof date === "string" ? DATE_RX.exec(date) : null;
  if (m) {
    const d = new Date(0);
    d.setUTCFullYear(+m[1], +m[2] - 1, +m[3]);
    if (d.toISOString().slice(0, 10) === date) {
      d.setUTCDate(d.getUTCDate() + 1);
      const y = d.getUTCFullYear();
      return String(y).padStart(4, "0") + d.toISOString().slice(-20, -14);
    }
  }
  throw new LedgerValueError("anchor_form", "not a YYYY-MM-DD date: " + JSON.stringify(date));
}

/* Section 5's rule for an anchor entry's `late`: its own local day (in tz) is after the day following anchorDate,
   or is that following day with a local clock later than 00:10:00. The writer sets it; a caller does not. */
function lateOf(anchorDate, ts, tz) {
  const nd = nextDay(anchorDate);
  const { day, clock } = localParts(ts, tz);
  return day > nd || (day === nd && clock > LATE_AFTER);
}

module.exports = { TIMESTAMP_RX, parseTimestamp, checkZone, dayOf, localDay: dayOf, localParts, nowUtc, nextDay, lateOf, LATE_AFTER };
