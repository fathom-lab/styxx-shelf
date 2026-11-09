#!/usr/bin/env node
/* shelf.mjs — re-derive published darkflobi.gate ledgers from a place that is not the box.

   for every row in shelf.config.json: fetch the row's files, run the shelf's own pinned copy of the verifier over
   the fetched ledger, run the row's conformance vectors, check every anchor the row's index lists against the chain
   and its opentimestamps proof against the bitcoin block header as two explorers return it, count the calendar days
   with no anchor, compare today's ledger bytes with the previous fetch (append-only), and write the report plus a
   static page. with --stamp-self the shelf's own report is stamped through the opentimestamps calendars and earlier
   pending stamps are upgraded, so the shelf's history is pinned outside the lab's repository too.

     node shelf.mjs [--row <name>] [--out <dir>] [--config shelf.config.json] [--explorer <url>]... [--no-ots]
                    [--date <YYYY-MM-DD>] [--through <YYYY-MM-DD>] [--stamp-self] [--calendar <url>]... [--page-only]

   --page-only rewrites index.html from the reports already on disk (the nightly rows' latest.json and the outside
   ledgers' reports written by shelf_read.cjs) and fetches nothing.

   exit 0 when every check passed, 1 when any failed (the report is still written), 2 on usage or a crash.
   node 20+. one dependency: opentimestamps (pinned in package.json). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// the package's "main" names a file that does not exist; requiring index.js directly avoids node's DEP0128 warning
const OTS = require("opentimestamps/index.js");
const CORE = require("./docs/shelf_core.js");   // the register's counts and the scorer sentence, the same code outside.html runs

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELF_SCHEMA = "styxx-shelf/report/v0";
const SHELF_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version;
const TOOLS = {
  verify: path.join(HERE, "tools", "verify.js"),
  check: path.join(HERE, "tools", "check_ledger.cjs"),
  vectors: path.join(HERE, "tools", "run_vectors.cjs"),
  pinned: path.join(HERE, "tools", "PINNED.json")
};

// ---- small things
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const signed = (n) => (n >= 0 ? "+" + n : String(n));
function zonedDay(d, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const m = {}; for (const p of parts) m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day}`;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const isCalendarDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && addDays(s, 0) === s;
function daysDiff(from, to) {           // to - from, in whole days (both YYYY-MM-DD)
  const [a, b] = [from, to].map(s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); });
  return Math.round((b - a) / 86400000);
}
function daysBetween(from, to) {       // inclusive list of YYYY-MM-DD from..to; empty when to < from
  const out = []; let d = from;
  while (d <= to) { out.push(d); d = addDays(d, 1); if (out.length > 10000) break; }
  return out;
}
function countLines(buf) { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++; if (buf.length && buf[buf.length - 1] !== 0x0a) n++; return n; }
function parseAnchorText(text) {       // PROTOCOL.md section 5: the whole text is the form, one trailing newline allowed
  const m = /^gate anchor (\d{4}-\d{2}-\d{2}) head ([0-9a-f]{64}) seq (\d+)\n?$/.exec(String(text));
  return m ? { date: m[1], head: m[2], seq: parseInt(m[3], 10) } : null;
}
const say = (...a) => console.log(...a);
function distinctHeights(rows) {        // [{height}] -> ["974530 x4"] or ["974635 x2", "974643", "974654"]
  const n = new Map(); for (const r of rows) n.set(r.height, (n.get(r.height) || 0) + 1);
  return [...n.entries()].sort((a, b) => a[0] - b[0]).map(([h, k]) => k > 1 ? `${h} x${k}` : String(h));
}
// the opentimestamps library talks through console.log; run it with the log captured
async function quietly(fn, sink) {
  const orig = console.log; console.log = (...a) => sink.push(a.map(String).join(" "));
  try { return await fn(); } finally { console.log = orig; }
}
function ranOn() {
  if (process.env.GITHUB_ACTIONS) {
    const url = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY || "?"}/actions/runs/${process.env.GITHUB_RUN_ID || "?"}`;
    return { where: "github actions", run_url: url, run_id: process.env.GITHUB_RUN_ID || null, run_attempt: process.env.GITHUB_RUN_ATTEMPT || null, sha: process.env.GITHUB_SHA || null, runner_os: process.env.RUNNER_OS || null };
  }
  return { where: "not the action (a local run)", host_platform: `${process.platform} ${os.release()}` };
}

function usage(msg) {
  if (msg) console.error("error: " + msg);
  console.error("usage: node shelf.mjs [--row <name>] [--out <dir>] [--config shelf.config.json] [--explorer <url>]... [--no-ots] [--date <YYYY-MM-DD>] [--through <YYYY-MM-DD>] [--stamp-self] [--calendar <url>]... [--page-only]");
  process.exit(2);
}
function parseArgs(argv) {
  const o = { row: null, out: path.join(HERE, "docs"), config: path.join(HERE, "shelf.config.json"), explorers: [], ots: true, date: null, through: null, stampSelf: false, calendars: [], pageOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--row") o.row = argv[++i];
    else if (a === "--out") o.out = path.resolve(argv[++i]);
    else if (a === "--config") o.config = path.resolve(argv[++i]);
    else if (a === "--explorer") o.explorers.push(argv[++i]);
    else if (a === "--calendar") o.calendars.push(argv[++i]);
    else if (a === "--no-ots") o.ots = false;
    else if (a === "--stamp-self") o.stampSelf = true;
    else if (a === "--page-only") o.pageOnly = true;
    else if (a === "--date") o.date = argv[++i];
    else if (a === "--through") o.through = argv[++i];
    else if (a === "-h" || a === "--help") usage();
    else usage("unknown argument " + a);
  }
  for (const k of ["date", "through"]) {
    if (o[k] !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o[k] || "")) usage(`--${k} wants YYYY-MM-DD`);
    if (o[k] !== null && !isCalendarDate(o[k])) usage(`--${k} is not a calendar date: ${o[k]}`);
  }
  if (o.date !== null && o.date > utcDay()) usage(`--date may not be in the future (today utc is ${utcDay()})`);
  if (o.through !== null && o.through > utcDay()) usage(`--through may not be in the future (today utc is ${utcDay()})`);
  for (const k of ["row", "out", "config"]) if (o[k] === undefined) usage("--" + k + " wants a value");
  if (o.explorers.some(e => !e) || o.calendars.some(e => !e)) usage("--explorer / --calendar want a url");
  return o;
}

// ---- fetching (records what came back; never throws on http status)
async function fetchBytes(url, timeoutMs) {
  const started = isoNow();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "styxx-shelf/" + SHELF_VERSION } });
    const buf = Buffer.from(await r.arrayBuffer());
    const rec = { url, status: r.status, ok: r.ok, http_date: r.headers.get("date"), last_modified: r.headers.get("last-modified"), etag: r.headers.get("etag"), bytes: buf.length, sha256: r.ok ? sha256(buf) : null, fetched_at: started };
    return { rec, buf: r.ok ? buf : null };
  } catch (e) {
    return { rec: { url, status: null, ok: false, error: String(e && e.message || e), bytes: 0, sha256: null, fetched_at: started }, buf: null };
  }
}

// ---- running the pinned tools
function runNode(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout || "", stderr: (r.stderr || "").replace(/\(node:\d+\) .*DEP0128.*\n(\(Use .*\n)?/g, ""), error: r.error ? String(r.error.message) : null };
}

// ---- explorers (own fetch, so the two answers can be compared and recorded)
function makeExplorerClient(explorers, timeoutMs) {
  const cache = new Map();
  return async function header(ex, height) {
    const key = ex + "#" + height;
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      const out = { explorer: ex, height, fetched_at: isoNow() };
      try {
        const h = await fetchBytes(`${ex}/block-height/${height}`, timeoutMs);
        if (!h.buf) throw new Error(`block-height/${height}: ${h.rec.error || "http " + h.rec.status}`);
        const hash = h.buf.toString("utf8").trim();
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`block-height/${height}: not a block hash: ${hash.slice(0, 80)}`);
        const b = await fetchBytes(`${ex}/block/${hash}`, timeoutMs);
        if (!b.buf) throw new Error(`block/${hash}: ${b.rec.error || "http " + b.rec.status}`);
        const hdr = JSON.parse(b.buf.toString("utf8"));
        if (!hdr || typeof hdr.merkle_root !== "string" || typeof hdr.timestamp !== "number") throw new Error(`block/${hash}: no merkle_root/timestamp in the answer`);
        out.ok = true; out.hash = hash; out.merkle_root = hdr.merkle_root; out.timestamp = hdr.timestamp; out.header_height = hdr.height;
        out.http_date = b.rec.http_date;
      } catch (e) { out.ok = false; out.error = String(e && e.message || e); }
      return out;
    })();
    cache.set(key, p);
    return p;
  };
}

// ---- one anchor
async function checkOneAnchor(a, ctx) {
  const { base, timeoutMs, explorers, useOts, fetched, chainAnchors, explorerHeader, texts, runDate, pendingMaxDays } = ctx;
  const rec = { date: a.date, index: { status: a.status, block: a.block ?? null, seq: a.seq, anchor_line_seq: a.anchor_line_seq ?? null, text_sha256: a.text_sha256, ots_sha256: a.ots_sha256, late: a.late === true, stamped_at: a.stamped_at ?? null, posted_at: a.posted_at ?? null }, problems: [] };
  const txtName = a.file || `anchors/${a.date}.txt`, otsName = a.ots || `anchors/${a.date}.txt.ots`;
  // the text was fetched once already (it went into check_ledger as --anchor); the same bytes are checked here
  const t = texts.get(a.date) || await fetchBytes(base + txtName, timeoutMs);
  const o = await fetchBytes(base + otsName, timeoutMs);
  fetched[txtName] = t.rec; fetched[otsName] = o.rec;
  rec.text = { file: txtName, fetched: t.rec.ok, sha256: t.rec.sha256, bytes: t.rec.bytes, index_sha256_matches: t.rec.ok ? t.rec.sha256 === a.text_sha256 : null };
  rec.ots = { file: otsName, fetched: o.rec.ok, sha256: o.rec.sha256, bytes: o.rec.bytes, index_sha256_matches: o.rec.ok ? o.rec.sha256 === a.ots_sha256 : null };
  if (!t.rec.ok) rec.problems.push(`text not fetched (${t.rec.error || "http " + t.rec.status})`);
  if (!o.rec.ok) rec.problems.push(`proof not fetched (${o.rec.error || "http " + o.rec.status})`);
  if (t.rec.ok && !rec.text.index_sha256_matches) rec.problems.push(`text_sha256 FAIL: index says ${a.text_sha256}, bytes hash to ${t.rec.sha256}`);
  if (o.rec.ok && !rec.ots.index_sha256_matches) rec.problems.push(`ots_sha256 FAIL: index says ${a.ots_sha256}, bytes hash to ${o.rec.sha256}`);

  // the text, parsed; its agreement with the index entry; its place in the chain (check_ledger's --anchor answer)
  let parsed = null;
  if (t.buf) {
    rec.text.value = t.buf.toString("utf8");
    parsed = parseAnchorText(rec.text.value);
    rec.text.parsed = parsed;
    if (!parsed) rec.problems.push("text is not the anchor form");
    else {
      rec.text.index_agrees = parsed.date === a.date && parsed.head === a.head && parsed.seq === a.seq;
      if (!rec.text.index_agrees) rec.problems.push("text disagrees with its index entry (date, head or seq)");
      const ca = chainAnchors.get(rec.text.value.replace(/\s+$/, ""));
      rec.chain = ca ? { in_chain: ca.in_chain, ok: ca.ok, via_withheld: ca.via_withheld, day_lines_after: ca.day_lines_after, ledger_anchor_line: ca.ledger_anchor_line, problem: ca.problem ?? null } : { ok: false, problem: "check_ledger returned no answer for this anchor text" };
      if (!rec.chain.ok) rec.problems.push("NOT IN CHAIN" + (rec.chain.problem ? ` (${rec.chain.problem})` : rec.chain.in_chain === false ? " (no entry carries that digest at that seq)" : rec.chain.day_lines_after ? ` (${rec.chain.day_lines_after} line(s) of that day sit after seq ${a.seq})` : ""));
    }
  }

  // the proof: file digest, attestations, the block header from each explorer
  rec.proof = { bitcoin_attestations: [], pending_calendars: [], unknown_attestations: 0 };
  if (t.buf && o.buf) {
    try {
      const det = OTS.DetachedTimestampFile.deserialize(new Uint8Array(o.buf));
      const orig = OTS.DetachedTimestampFile.fromBytes(det.fileHashOp, new Uint8Array(t.buf));
      rec.proof.file_digest = OTS.Utils.bytesToHex(det.fileDigest());
      rec.proof.text_digest = OTS.Utils.bytesToHex(orig.fileDigest());
      rec.proof.digest_matches_text = OTS.Utils.arrEq(det.fileDigest(), orig.fileDigest());
      if (!rec.proof.digest_matches_text) rec.problems.push(`OTS FAIL: the proof is over ${rec.proof.file_digest}, the fetched text hashes to ${rec.proof.text_digest}`);
      const atts = [];
      for (const [msg, att] of det.timestamp.allAttestations()) {
        if (att instanceof OTS.Notary.BitcoinBlockHeaderAttestation) atts.push({ height: att.height, msg: Array.from(msg), att });
        else if (att instanceof OTS.Notary.PendingAttestation) rec.proof.pending_calendars.push(att.uri);
        else rec.proof.unknown_attestations++;
      }
      atts.sort((x, y) => x.height - y.height);
      rec.proof.pending_calendars.sort();
      if (rec.proof.digest_matches_text) {
        for (const x of atts) {
          const row = { height: x.height, expected_merkle_root: OTS.Utils.bytesToHex(x.msg.slice().reverse()), explorers: [] };
          if (useOts) {
            for (const ex of explorers) {
              const h = await explorerHeader(ex, x.height);
              const e = { explorer: ex, ok: h.ok, hash: h.hash ?? null, merkle_root: h.merkle_root ?? null, timestamp: h.timestamp ?? null, http_date: h.http_date ?? null, error: h.error ?? null, verified: false };
              if (h.ok) {
                try { e.attested_time = x.att.verifyAgainstBlockheader(x.msg.slice().reverse(), { merkleroot: h.merkle_root, time: h.timestamp }); e.verified = true; }
                catch (err) { e.verified = false; e.error = String(err && err.message || err); }
              }
              row.explorers.push(e);
            }
          }
          rec.proof.bitcoin_attestations.push(row);
        }
      }
    } catch (e) { rec.proof.error = String(e && e.message || e); rec.problems.push("OTS FAIL: " + rec.proof.error); }
  }
  rec.lowest_block = rec.proof.bitcoin_attestations.length ? rec.proof.bitcoin_attestations[0].height : null;

  // the status line
  const btc = rec.proof.bitcoin_attestations;
  if (!t.buf || !o.buf || rec.proof.error || rec.proof.digest_matches_text === false) rec.status = "FAIL: " + rec.problems.join("; ");
  else if (btc.length === 0) {
    const age = daysDiff(a.date, runDate);
    rec.pending_days = age;
    rec.status = rec.proof.pending_calendars.length === 0 && rec.proof.unknown_attestations > 0
      ? `unknown attestations only: ${rec.proof.unknown_attestations} (${age} day(s) since the anchor date)`
      : `pending (calendars only: ${rec.proof.pending_calendars.length}; ${age} day(s) since the anchor date)`;
    if (a.status === "bitcoin") { rec.problems.push(`index says bitcoin block ${a.block} but the proof carries no bitcoin attestation`); rec.status = "FAIL: " + rec.problems.join("; "); }
    else if (Number.isInteger(pendingMaxDays) && age > pendingMaxDays) rec.problems.push(`anchor ${a.date} pending for ${age} days (limit ${pendingMaxDays})`);
  } else if (!useOts) rec.status = `bitcoin attestations ${btc.length} (lowest block ${btc[0].height}); explorer check skipped (--no-ots)`;
  else {
    const n = explorers.length;
    const key = (e) => e.hash + "/" + e.merkle_root + "/" + e.timestamp;
    const answered = (row) => row.explorers.filter(e => e.ok);
    const disagreeRow = btc.find(row => new Set(answered(row).map(key)).size > 1);
    const unreachable = new Map();                 // explorer -> the first error it gave (one line per explorer, not per attestation)
    for (const row of btc) for (const e of row.explorers) if (!e.ok && !unreachable.has(e.explorer)) unreachable.set(e.explorer, `block ${row.height}: ${e.error}`);
    const allVerified = btc.every(row => row.explorers.length === n && row.explorers.every(e => e.verified));
    const lowest = btc[0];
    const k = lowest.explorers.filter(e => e.verified).length;
    if (disagreeRow) { rec.status = `explorers disagree on block ${disagreeRow.height}: not verified`; rec.problems.push(rec.status); }
    else if (allVerified) {
      const t0 = lowest.explorers[0].attested_time;
      rec.status = `bitcoin: block ${lowest.height}, header from ${n} of ${n} explorers agree (attestedTime ${new Date(t0 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")})${btc.length > 1 ? `; ${btc.length} attestations in block${distinctHeights(btc).length > 1 ? "s" : ""} ${distinctHeights(btc).join(", ")}` : ""}`;
    } else if (unreachable.size) {
      rec.status = `explorer unreachable: ${[...unreachable].map(([ex, err]) => `${ex} (${err})`).join("; ")}; header from ${k} of ${n} explorers verified: not verified`;
      rec.problems.push(rec.status);
    } else {
      const anyVerified = btc.some(row => row.explorers.some(e => e.verified));
      const errs = [...new Set(btc.flatMap(row => row.explorers.filter(e => !e.verified).map(e => `${e.explorer} block ${row.height}: ${e.error || "not verified"}`)))];
      rec.status = `${anyVerified ? "not verified" : "FAIL"}: header from ${k} of ${n} explorers verified (${errs.join("; ")})`;
      rec.problems.push(rec.status);
    }
    if (a.status === "bitcoin" && Number.isInteger(a.block) && a.block !== lowest.height) rec.problems.push(`index says block ${a.block}, the proof's lowest attestation is block ${lowest.height}`);
    rec.index_block_agrees = Number.isInteger(a.block) ? a.block === lowest.height : null;
  }
  rec.verified = /^bitcoin: block /.test(rec.status) && rec.problems.length === 0;
  rec.ok = rec.problems.length === 0;      // pending within the limit is ok (a state, not a failure); every FAIL and every disagreement is not
  return rec;
}

// ---- the shelf's own stamps (opentimestamps over the nightly report; the calendars are asked only for this)
function otsOpts(opts) { return opts.calendars.length ? { calendars: opts.calendars.slice() } : {}; }
function attestedHeights(det) { return [...det.timestamp.allAttestations()].filter(([, a]) => a instanceof OTS.Notary.BitcoinBlockHeaderAttestation).map(([, a]) => a.height).sort((x, y) => x - y); }
async function upgradeOwnStamps(repDir, opts, log) {
  // every <date>.json.ots beside the reports: still pending -> ask its calendars; bitcoin -> leave it; check the report still hashes to it
  const out = { reports: [], upgraded: [], problems: [] };
  if (!fs.existsSync(repDir)) return out;
  for (const f of fs.readdirSync(repDir).filter(x => /^\d{4}-\d{2}-\d{2}\.json\.ots$/.test(x)).sort()) {
    const p = path.join(repDir, f), rep = path.join(repDir, f.replace(/\.ots$/, ""));
    const rec = { date: f.slice(0, 10), file: f };
    try {
      const det = OTS.DetachedTimestampFile.deserialize(new Uint8Array(fs.readFileSync(p)));
      let heights = attestedHeights(det);
      if (!heights.length) {
        const changed = await quietly(() => OTS.upgrade(det, otsOpts(opts)), log);
        if (changed) { fs.writeFileSync(p, Buffer.from(det.serializeToBytes())); rec.upgraded = true; out.upgraded.push(rec.date); heights = attestedHeights(det); }
      }
      rec.status = heights.length ? "bitcoin" : "pending";
      rec.blocks = [...new Set(heights)];
      rec.calendars = [...det.timestamp.allAttestations()].filter(([, a]) => a instanceof OTS.Notary.PendingAttestation).length;
      rec.ots_sha256 = sha256(fs.readFileSync(p));
      rec.report_digest = OTS.Utils.bytesToHex(det.fileDigest());
      rec.report_present = fs.existsSync(rep);
      rec.report_sha256 = rec.report_present ? sha256(fs.readFileSync(rep)) : null;
      rec.report_matches = rec.report_present ? rec.report_sha256 === rec.report_digest : null;
      if (rec.report_matches === false) { rec.problem = `report ${rec.date}.json does not hash to its own stamp (stamped ${rec.report_digest.slice(0, 16)}, on disk ${rec.report_sha256.slice(0, 16)}): rewritten since it was stamped`; out.problems.push(rec.problem); }
    } catch (e) { rec.status = "FAIL"; rec.error = String(e && e.message || e); out.problems.push(`stamp ${f}: ${rec.error}`); }
    out.reports.push(rec);
  }
  return out;
}
async function stampOwnReport(repDir, runDate, text, opts, log) {
  const otsPath = path.join(repDir, `${runDate}.json.ots`);
  const out = { file: path.basename(otsPath), ok: false };
  try {
    const det = OTS.DetachedTimestampFile.fromBytes(new OTS.Ops.OpSHA256(), new Uint8Array(Buffer.from(text)));
    await quietly(() => OTS.stamp(det, otsOpts(opts)), log);
    const calendars = [...det.timestamp.allAttestations()].filter(([, a]) => a instanceof OTS.Notary.PendingAttestation).length;
    if (!calendars) throw new Error("no calendar answered (" + (log.filter(l => /Calendar|calendar/.test(l)).join("; ") || "no detail") + ")");
    const bytes = Buffer.from(det.serializeToBytes());
    fs.writeFileSync(otsPath, bytes);
    Object.assign(out, { ok: true, calendars, ots_sha256: sha256(bytes), report_sha256: sha256(Buffer.from(text)) });
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}

// ---- one row
async function runRow(row, opts, cfg) {
  const started = isoNow();
  const base = row.base.endsWith("/") ? row.base : row.base + "/";
  const timeoutMs = 1000 * (cfg.fetch_timeout_seconds || 60);
  const explorers = opts.explorers.length ? opts.explorers : (cfg.explorers || []);
  const tz = cfg.anchor_tz || "America/New_York";
  const pendingMaxDays = Number.isInteger(cfg.pending_max_days) ? cfg.pending_max_days : 7;
  const runDate = opts.date || utcDay();
  const pinned = JSON.parse(fs.readFileSync(TOOLS.pinned, "utf8"));
  const report = { schema: SHELF_SCHEMA, shelf_version: SHELF_VERSION, node: process.version, ran_on: ranOn(), row: row.name, base, date: runDate, run_started_at: started, explorers, ots_checked: opts.ots, pending_max_days: pendingMaxDays, pinned_tools: pinned.files, fetched: {}, commands: [], checks: {}, notes: [], problems: [] };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "styxx-shelf-"));
  const F = row.files;
  const fail = (what) => { report.problems.push(what); say("  FAIL " + what); };
  const note = (what) => { report.notes.push(what); say("  note: " + what); };

  say(`row ${row.name}  base ${base}  date ${runDate}  ran on ${report.ran_on.where}${report.ran_on.run_url ? " " + report.ran_on.run_url : ""}`);

  // (1) fetch
  const bufs = {};
  const names = Object.keys(F);
  for (const k of names) {
    const r = await fetchBytes(base + F[k], timeoutMs);
    report.fetched[F[k]] = r.rec; bufs[k] = r.buf;
    say(`  fetch ${F[k].padEnd(24)} ${r.rec.ok ? "http " + r.rec.status + "  " + String(r.rec.bytes).padStart(8) + " bytes  sha256 " + r.rec.sha256.slice(0, 16) : "FAILED " + (r.rec.error || "http " + r.rec.status)}`);
    report.commands.push(`curl -sS -o ${F[k]} --create-dirs ${base}${F[k]}`);
  }
  const fetchedCount = names.filter(k => bufs[k]).length;
  report.checks.fetch = { ok: fetchedCount === names.length, fetched: fetchedCount, total: names.length, failed: names.filter(k => !bufs[k]).map(k => F[k]) };
  if (!report.checks.fetch.ok) fail(`fetch: ${fetchedCount} of ${names.length} files fetched (missing ${report.checks.fetch.failed.join(", ")})`);

  // write the fetched bytes where the tools can read them, under the row's own relative paths
  for (const k of names) if (bufs[k]) { const p = path.join(work, F[k]); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bufs[k]); }

  // the anchors index (needed before check_ledger so every anchor text goes in as --anchor)
  let anchorsIndex = null;
  if (bufs.anchors_index) { try { anchorsIndex = JSON.parse(bufs.anchors_index.toString("utf8")); } catch (e) { fail("anchors/index.json does not parse: " + e.message); } }
  const anchorEntries = anchorsIndex && Array.isArray(anchorsIndex.anchors) ? anchorsIndex.anchors.slice().sort((x, y) => String(x.date).localeCompare(String(y.date))) : [];
  const fetchedAnchorTexts = new Map();  // date -> {rec, buf}; fetched once, used for the chain check and for the digest check
  for (const a of anchorEntries) {
    const name = a.file || `anchors/${a.date}.txt`;
    const r = await fetchBytes(base + name, timeoutMs);
    fetchedAnchorTexts.set(a.date, r);
    report.commands.push(`curl -sS -o ${name} --create-dirs ${base}${name}`);
    report.commands.push(`curl -sS -o ${a.ots || name + ".ots"} --create-dirs ${base}${a.ots || name + ".ots"}`);
  }

  // (2) the chain, with the shelf's pinned check_ledger.cjs; every fetched anchor text given as --anchor
  const anchorArgs = [];
  for (const [, r] of fetchedAnchorTexts) if (r.buf) { const txt = r.buf.toString("utf8").replace(/\s+$/, ""); if (parseAnchorText(txt)) anchorArgs.push("--anchor", txt); }
  const checkArgs = [TOOLS.check, path.join(work, F.ledger), ...(bufs.withheld ? ["--withheld", path.join(work, F.withheld)] : []), ...anchorArgs, "--json"];
  report.commands.push(`node tools/check_ledger.cjs ${F.ledger}${bufs.withheld ? " --withheld " + F.withheld : ""}${anchorArgs.filter((_, i) => i % 2).map(t => ` --anchor "${t}"`).join("")} --json`);
  let chainOut = null;
  const chainAnchors = new Map();
  if (bufs.ledger) {
    const r = runNode(checkArgs, HERE);
    try { chainOut = JSON.parse(r.stdout.trim().split("\n").pop()); } catch (e) { chainOut = null; }
    // check_ledger's own verdict decides: its `ok` folds the chain, every --anchor given and every anchor line the ledger itself carries; exit 0 means re-derives
    const problems = chainOut ? (chainOut.problems || []).slice() : [{ problem: "check_ledger gave no json: " + (r.error || r.stderr || r.stdout).slice(0, 500) }];
    const ownLines = chainOut && Array.isArray(chainOut.anchors_in_ledger) ? chainOut.anchors_in_ledger : [];
    for (const a of ownLines) if (!a.ok) problems.push({ seq: a.seq, problem: `the ledger's own anchor line for ${a.date} does not agree with the entry it pins (pins seq ${a.seq})` });
    // the chain column: the chain itself plus the ledger's own anchor lines (check_ledger's verdict minus the --anchor texts given,
    // which the anchors section reports one by one as NOT IN CHAIN). check_ledger's own ok is recorded beside it.
    const givenOk = chainOut ? (chainOut.anchors_given || []).every(a => a.ok) : null;
    const rederives = !!chainOut && r.code !== 2 && problems.length === 0;
    report.checks.chain = { ok: rederives, check_ledger_ok: chainOut ? chainOut.ok : null, exit_code: r.code, lines: chainOut ? chainOut.lines : null, file_lines: countLines(bufs.ledger), head: chainOut ? chainOut.head : null, file_sha256: chainOut ? chainOut.file_sha256 : null, kinds: chainOut ? chainOut.kinds : null, withheld: chainOut ? chainOut.withheld : null, bridged: chainOut ? chainOut.bridged : null, coverage: chainOut ? chainOut.coverage : null, anchor_lines_in_ledger: chainOut ? chainOut.anchors_in_ledger : null, own_anchor_lines_in_chain: ownLines.filter(a => a.ok).length, own_anchor_lines: ownLines.length, problems };
    if (chainOut) for (const a of chainOut.anchors_given || []) chainAnchors.set(a.text || `gate anchor ${a.date} head ${a.head} seq ${a.seq}`, a);
    if (rederives) say(`  chain re-derives: ${chainOut.lines} lines, head ${chainOut.head}; the ledger's own anchor lines in chain ${report.checks.chain.own_anchor_lines_in_chain} of ${report.checks.chain.own_anchor_lines}${givenOk === false ? "; check_ledger exit " + r.code + " ok=false because an anchor text given is not in chain (the anchors below say which)" : ""}`);
    else fail(`chain DOES NOT RE-DERIVE (check_ledger exit ${r.code}, ok ${chainOut ? chainOut.ok : "?"}): ${problems.map(p => `line ${p.line ?? "-"} seq ${p.seq ?? "-"}: ${p.problem || (p.problems || []).join("; ")}`).join(" | ").slice(0, 1200) || "an --anchor given was not in chain (see the anchors below)"}`);
    if (chainOut && chainOut.file_sha256 !== report.fetched[F.ledger].sha256) fail("check_ledger hashed different bytes than the fetch recorded");
  } else report.checks.chain = { ok: false, problems: [{ problem: "ledger not fetched" }] };

  // the row's own snapshot line, for the page and for the append-only check
  let snapLast = null;
  if (bufs.snapshots) { const ls = bufs.snapshots.toString("utf8").split("\n").filter(s => s.trim()); try { snapLast = JSON.parse(ls[ls.length - 1]); } catch (e) { snapLast = { unparsable: ls[ls.length - 1] }; } }
  report.checks.snapshot = { last_line: snapLast, agrees_with_fetched_ledger: snapLast && report.fetched[F.ledger] ? snapLast.published_file_sha256 === report.fetched[F.ledger].sha256 : null };
  if (report.checks.snapshot.agrees_with_fetched_ledger === false) note(`SNAPSHOTS.jsonl's last line names ${String(snapLast.published_file_sha256).slice(0, 16)}, the fetched ledger is ${String(report.fetched[F.ledger].sha256).slice(0, 16)} (a deploy in flight, or the files are out of step; printed, not counted)`);

  // (3) the vectors, pinned runner + pinned verifier over the row's fetched vectors
  if (bufs.vectors && bufs.vectors_base) {
    const r = runNode([TOOLS.vectors, "--vectors", path.join(work, F.vectors), "--verify", TOOLS.verify], HERE);
    const m = /(\d+) of (\d+) vectors answered as the file says/.exec(r.stdout);
    report.checks.vectors = { ok: r.code === 0 && !!m, passed: m ? +m[1] : 0, total: m ? +m[2] : null, exit_code: r.code, output: r.stdout.trim().split("\n"), stderr: r.stderr.trim() || null };
    report.commands.push(`node tools/run_vectors.cjs --vectors ${F.vectors} --verify tools/verify.js`);
    if (report.checks.vectors.ok) say(`  vectors ${m[1]} of ${m[2]}`); else fail(`vectors: ${m ? m[1] + " of " + m[2] : "runner exit " + r.code + " " + (r.stderr || r.stdout).slice(0, 300)}`);
  } else report.checks.vectors = { ok: false, passed: 0, total: null, problem: "vectors not fetched" };

  // the row's published verifier beside the pinned one (drift is reported, not failed)
  const drift = {};
  for (const [k, pin] of [["verify", pinned.files["tools/verify.js"]], ["check", pinned.files["tools/check_ledger.cjs"]]]) {
    const rec = report.fetched[F[k]];
    drift[k] = { published: F[k], published_sha256: rec ? rec.sha256 : null, pinned_sha256: pin.sha256, same: rec && rec.sha256 === pin.sha256 };
  }
  report.checks.verifier_drift = { drift: !(drift.verify.same && drift.check.same), files: drift, note: "the checks above ran the shelf's pinned tools (tools/PINNED.json), not the row's published ones" };
  say(`  verifier drift: ${report.checks.verifier_drift.drift ? "YES (" + Object.values(drift).filter(d => !d.same).map(d => d.published).join(", ") + " differ from the pinned copies)" : "no"}`);

  // (4) anchors
  const explorerHeader = makeExplorerClient(explorers, timeoutMs);
  const perAnchor = [];
  for (const a of anchorEntries) {
    const rec = await checkOneAnchor(a, { base, timeoutMs, explorers, useOts: opts.ots, fetched: report.fetched, chainAnchors, explorerHeader, texts: fetchedAnchorTexts, runDate, pendingMaxDays });
    perAnchor.push(rec);
    say(`  anchor ${a.date}  ${rec.ok ? (rec.chain && rec.chain.ok ? "in chain  " : "          ") : "FAIL      "}${rec.status}`);
    for (const p of rec.problems) say(`     ${p}`);
  }
  const verified = perAnchor.filter(r => r.verified).length, pendingN = perAnchor.filter(r => /^pending|^unknown attestations/.test(r.status)).length, anchorsOk = perAnchor.every(r => r.ok) && anchorsIndex !== null;
  const inChain = perAnchor.filter(r => r.chain && r.chain.ok).length;
  report.checks.anchors = { ok: anchorsOk, total: perAnchor.length, verified, pending: pendingN, in_chain: inChain, failed: perAnchor.filter(r => !r.ok).map(r => r.date), index_counts: anchorsIndex ? anchorsIndex.counts ?? null : null, index_written_at: anchorsIndex ? anchorsIndex.written_at ?? null : null, per_anchor: perAnchor };
  if (!anchorsIndex) fail("anchors: no index"); else if (!anchorsOk) fail(`anchors: ${report.checks.anchors.failed.length} of ${perAnchor.length} failed (${report.checks.anchors.failed.join(", ")})`);
  say(`  anchors verified ${verified} of ${perAnchor.length} (pending ${pendingN} of ${perAnchor.length}, in chain ${inChain} of ${perAnchor.length})`);
  if (opts.ots) for (const ex of explorers) report.commands.push(`# explorer ${ex}: GET ${ex}/block-height/<h> then GET ${ex}/block/<hash>; the proof's merkle path must end at that header's merkle_root`);

  // the index against the ledger's own anchor lines: a date in one and not the other is a discrepancy, not a gap
  const ledgerAnchorDates = new Set((chainOut && Array.isArray(chainOut.anchors_in_ledger) ? chainOut.anchors_in_ledger : []).map(a => a.date));
  const indexDates = new Set(anchorEntries.map(a => a.date));
  const onlyLedger = [...ledgerAnchorDates].filter(d => !indexDates.has(d)).sort();
  const onlyIndex = [...indexDates].filter(d => !ledgerAnchorDates.has(d)).sort();
  report.checks.anchor_index_vs_ledger = { ok: chainOut !== null && !onlyLedger.length && !onlyIndex.length, ledger_anchor_lines: ledgerAnchorDates.size, in_index: ledgerAnchorDates.size - onlyLedger.length, index_entries: indexDates.size, with_ledger_line: indexDates.size - onlyIndex.length, only_in_ledger: onlyLedger, only_in_index: onlyIndex };
  if (chainOut) say(`  anchor index vs ledger: ${report.checks.anchor_index_vs_ledger.in_index} of ${ledgerAnchorDates.size} ledger anchor lines are in the index; ${report.checks.anchor_index_vs_ledger.with_ledger_line} of ${indexDates.size} index entries have a ledger anchor line`);
  if (onlyLedger.length) fail(`anchors: index lists no entry for ${onlyLedger.join(", ")} although the ledger carries an anchor line for ${onlyLedger.length === 1 ? "that day" : "those days"}`);
  if (onlyIndex.length) fail(`anchors: index lists ${onlyIndex.join(", ")} with no anchor line in the ledger`);

  // (5) gaps: earliest anchor's date .. the day before the run day (America/New_York); day D's anchor is posted at 00:00 of D+1
  const runDayLocal = opts.date || zonedDay(new Date(), tz);
  const through = opts.through || addDays(runDayLocal, -1);
  const have = new Set([...indexDates, ...ledgerAnchorDates]);
  const first = anchorEntries.length ? anchorEntries[0].date : null;
  const expected = first ? daysBetween(first, through) : [];
  const gaps = expected.filter(d => !have.has(d));
  const windowWhy = opts.through ? `--through ${opts.through} was passed` : opts.date ? `the day before --date ${opts.date}` : `the day before the run day in ${tz} (${runDayLocal})`;
  report.checks.gaps = { count: gaps.length, dates: gaps, from: first, through, window_from: windowWhy, run_day_local: runDayLocal, expected_days: expected.length, anchors_in_range: expected.length - gaps.length, late: anchorEntries.filter(a => a.late === true).map(a => a.date), note: `coverage window is ${first} .. ${through} (${tz}; the end is ${windowWhy}); a day with neither an index entry nor a ledger anchor line is a gap: printed, not failed. the writer's own anchor_anomaly lines are what would explain it` };
  say(`  gaps ${gaps.length} of ${expected.length} days (${first} .. ${through}, end = ${windowWhy})${gaps.length ? ": " + gaps.join(", ") : ""}`);

  // lines pinned by nothing outside the lab: every published line after the seq the last bitcoin-attested anchor pins
  let afterAttested = null, lastAttested = null;
  if (bufs.ledger) {
    const seqs = []; for (const line of bufs.ledger.toString("utf8").split("\n")) { if (!line.trim()) continue; try { const o = JSON.parse(line); if (Number.isInteger(o.seq)) seqs.push(o.seq); } catch (e) { /* the chain check reports it */ } }
    const attested = perAnchor.filter(r => opts.ots ? r.verified : r.lowest_block !== null);
    lastAttested = attested.length ? attested.reduce((m, r) => r.index.seq > m.index.seq ? r : m) : null;
    afterAttested = lastAttested ? seqs.filter(s => s > lastAttested.index.seq).length : seqs.length;
  }
  report.checks.outside_pin = { lines_after_last_attested_head: afterAttested, last_attested_anchor: lastAttested ? { date: lastAttested.date, seq: lastAttested.index.seq, block: lastAttested.lowest_block, by: opts.ots ? "explorers" : "the proof's own attestation (--no-ots: not checked against an explorer)" } : null, note: "lines after that seq are pinned by nothing outside the lab tonight: a pending anchor, the shelf's own history and this repository are the lab's" };
  say(`  lines after the last bitcoin-attested head: ${afterAttested ?? "?"} of ${report.checks.chain.lines ?? "?"}${lastAttested ? ` (anchor ${lastAttested.date} pins seq ${lastAttested.index.seq}, block ${lastAttested.lowest_block})` : " (no attested anchor)"}`);

  // (6) append-only against the shelf's own history (a record in this repository: see the page's what-this-is list)
  const histDir = path.join(opts.out, "history", row.name);
  fs.mkdirSync(histDir, { recursive: true });
  const latestHist = path.join(histDir, "latest.json");
  let prev = null;
  if (fs.existsSync(latestHist)) { try { prev = JSON.parse(fs.readFileSync(latestHist, "utf8")); } catch (e) { prev = { unparsable: true }; } }
  const anchorsToday = {};
  for (const r of perAnchor) anchorsToday[r.date] = { text_sha256: r.text.sha256, ots_sha256: r.ots.sha256, lowest_block: r.lowest_block, calendars: r.proof.pending_calendars.length, status: r.status.split(/[:(]/)[0].trim() };
  const today = bufs.ledger ? { date: runDate, fetched_at: report.fetched[F.ledger].fetched_at, sha256: report.fetched[F.ledger].sha256, bytes: bufs.ledger.length, lines: report.checks.chain.lines, head: report.checks.chain.head, lines_after_last_attested_head: afterAttested, anchors: anchorsToday } : null;
  let ao;
  if (!today) ao = { status: "not checked", reason: "ledger not fetched", previous: prev };
  else if (!prev || prev.unparsable || !Number.isInteger(prev.bytes)) ao = { status: "no previous fetch", previous: prev, today };
  else {
    const prefixSha = bufs.ledger.length >= prev.bytes ? sha256(bufs.ledger.subarray(0, prev.bytes)) : null;
    const extends_ = prefixSha === prev.sha256;
    ao = { status: extends_ ? "extends" : "REWRITE", previous: prev, today, prefix_sha256: prefixSha, added_bytes: bufs.ledger.length - prev.bytes, added_lines: Number.isInteger(prev.lines) && Number.isInteger(today.lines) ? today.lines - prev.lines : null };
    if (!extends_) {
      const headClause = prev.head === today.head ? `head unchanged ${String(today.head).slice(0, 16)} (the chain check says whether it still re-derives)` : `head ${String(prev.head).slice(0, 16)} -> ${String(today.head).slice(0, 16)}`;
      ao.what_changed = bufs.ledger.length < prev.bytes ? `shorter: ${prev.bytes} -> ${bufs.ledger.length} bytes (${prev.lines} -> ${today.lines} lines), ${headClause}` : `the leading ${prev.bytes} bytes differ (length ${prev.bytes} -> ${bufs.ledger.length}, ${headClause})`;
      ao.row_says = snapLast ? { extends: snapLast.extends ?? null, rewrite_reason: snapLast.rewrite_reason ?? null, built_at: snapLast.built_at ?? null, lines: snapLast.lines ?? null, published_lines: snapLast.published_lines ?? null, head: snapLast.head ?? null, line: JSON.stringify(snapLast) } : null;
      fail(`REWRITE: ${ao.what_changed}; the row's SNAPSHOTS.jsonl last line says extends=${snapLast ? JSON.stringify(snapLast.extends) : "?"} rewrite_reason=${snapLast ? JSON.stringify(snapLast.rewrite_reason) : "?"}`);
      fs.writeFileSync(path.join(histDir, `rewrite-${runDate}-${started.replace(/[:]/g, "")}.json`), JSON.stringify({ previous: prev, today, row_says: ao.row_says }, null, 1) + "\n");
    }
    // the anchors the previous fetch saw: a posted anchor's text is fixed the moment it is posted
    ao.anchor_changes = [];
    for (const [d, p] of Object.entries(prev.anchors || {})) {
      const t = anchorsToday[d];
      if (!t) { ao.anchor_changes.push({ date: d, change: "gone from the index" }); continue; }
      if (p.text_sha256 && t.text_sha256 !== p.text_sha256) { ao.anchor_changes.push({ date: d, change: "text changed", previous: p.text_sha256, today: t.text_sha256 }); fail(`REWRITE: anchor ${d} text changed since ${prev.date} (${String(p.text_sha256).slice(0, 16)} -> ${String(t.text_sha256).slice(0, 16)})`); }
      else if (p.lowest_block !== null && p.lowest_block !== undefined && t.lowest_block === null) { ao.anchor_changes.push({ date: d, change: "regressed to pending", previous_block: p.lowest_block }); fail(`anchor ${d} regressed from bitcoin (block ${p.lowest_block}) to pending since ${prev.date}`); }
      else if (p.ots_sha256 && t.ots_sha256 !== p.ots_sha256) { ao.anchor_changes.push({ date: d, change: "proof changed, same block", block: t.lowest_block }); note(`anchor ${d} proof bytes changed since ${prev.date} with the same lowest block ${t.lowest_block ?? "(none)"}: an upgrade, not a rewrite`); }
    }
    for (const c of ao.anchor_changes.filter(c => c.change === "gone from the index")) note(`anchor ${c.date} was in the index on ${prev.date} and is not tonight (the index-vs-ledger check above says whether the ledger still carries its line)`);
  }
  report.checks.append_only = ao;
  if (ao.status !== "REWRITE") say(`  append-only: ${ao.status}${ao.added_bytes !== undefined ? ` (${signed(ao.added_bytes)} bytes, ${signed(ao.added_lines)} lines since ${prev.date})` : ""}`);
  // the history's latest.json moves forward only: a run for an older --date never replaces a newer record
  const keepLatest = (p) => { if (!fs.existsSync(p)) return false; try { const d = JSON.parse(fs.readFileSync(p, "utf8")).date; return typeof d === "string" && d > runDate; } catch (e) { return false; } };
  if (today) {
    fs.writeFileSync(path.join(histDir, `${runDate}.json`), JSON.stringify(today, null, 1) + "\n");
    if (keepLatest(latestHist)) note(`history/latest.json kept: its date is after ${runDate}`); else fs.writeFileSync(latestHist, JSON.stringify(today, null, 1) + "\n");
  }

  // (6b) the shelf's own earlier stamps: upgrade the pending ones, check every stamped report still hashes to its stamp
  const repDir = path.join(opts.out, "reports", row.name);
  fs.mkdirSync(repDir, { recursive: true });
  const otsLog = [];
  if (opts.stampSelf) {
    const up = await upgradeOwnStamps(repDir, opts, otsLog);
    const k = up.reports.filter(r => r.status === "bitcoin").length;
    report.checks.self_stamps = { reports: up.reports, bitcoin: k, pending: up.reports.filter(r => r.status === "pending").length, total: up.reports.length, upgraded_tonight: up.upgraded, calendars_asked: opts.calendars.length ? opts.calendars : "the library's default aggregators / the calendars named in each stamp", library_log: otsLog.slice() };
    for (const p of up.problems) fail("self-stamp: " + p);
    say(`  shelf's own earlier reports: ${k} of ${up.reports.length} bitcoin-attested, ${report.checks.self_stamps.pending} pending${up.upgraded.length ? `; upgraded tonight: ${up.upgraded.join(", ")}` : ""}`);
  } else report.checks.self_stamps = { skipped: true, note: "--stamp-self not passed: the shelf's own report is not stamped and earlier stamps are not upgraded on this run" };

  // (7) the report
  report.run_finished_at = isoNow();
  report.ok = report.problems.length === 0;
  report.exit_code = report.ok ? 0 : 1;
  report.rerun = `git clone https://github.com/fathom-lab/styxx-shelf && cd styxx-shelf && npm ci && node shelf.mjs --row ${row.name} --out ./docs --date ${runDate} --through ${through}`;
  const text = JSON.stringify(report, null, 1) + "\n";
  const repFile = path.join(repDir, `${runDate}.json`), latestRep = path.join(repDir, "latest.json");
  fs.writeFileSync(repFile, text);
  if (keepLatest(latestRep)) note(`reports/latest.json kept: its date is after ${runDate}`); else fs.writeFileSync(latestRep, text);
  fs.rmSync(work, { recursive: true, force: true });

  // (8) stamp tonight's report (after it is written: the stamp is over those bytes, so it cannot be inside them)
  let stamp = null;
  if (opts.stampSelf) {
    stamp = await stampOwnReport(repDir, runDate, text, opts, otsLog);
    if (stamp.ok) say(`  stamped the report: ${stamp.file} (${stamp.calendars} calendar${stamp.calendars === 1 ? "" : "s"} answered; sha256 ${stamp.ots_sha256.slice(0, 16)}); the proof completes on a later night's upgrade`);
    else say(`  self-stamp FAILED: ${stamp.error} (printed, counted as a problem for the exit code; the report itself is written)`);
    const summary = { schema: "styxx-shelf/stamps/v0", written_at: isoNow(), row: row.name, tonight: stamp, earlier: report.checks.self_stamps.reports || [], bitcoin: report.checks.self_stamps.bitcoin ?? 0, pending: report.checks.self_stamps.pending ?? 0, total: report.checks.self_stamps.total ?? 0, library_log: otsLog };
    fs.writeFileSync(path.join(repDir, "stamps.json"), JSON.stringify(summary, null, 1) + "\n");
  }
  const exitCode = report.ok && (!stamp || stamp.ok) ? 0 : 1;
  const summaryLine = report.ok
    ? `no check failed (${pendingN} anchor${pendingN === 1 ? "" : "s"} pending, ${gaps.length} of ${expected.length} day${expected.length === 1 ? "" : "s"} with no anchor, ${afterAttested ?? "?"} line${afterAttested === 1 ? "" : "s"} after the last bitcoin-attested head)`
    : `${report.problems.length} problem(s)`;
  say(`  ${summaryLine}; report ${path.relative(process.cwd(), repFile) || repFile}`);
  return { ...report, exit_code: exitCode, stamp };
}

// ---- the page (static: no scripts, no fetch at view time)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (h) => h ? `<span title="${esc(h)}">${esc(String(h).slice(0, 16))}</span>` : "-";
const yn = (b, yes = "yes", no = "no") => b === true ? `<b class="ok">${yes}</b>` : b === false ? `<b class="bad">${no}</b>` : "-";
const good = (b, text) => b === true ? `<b class="ok">${text}</b>` : b === false ? `<b class="bad">${text}</b>` : esc(text);

function readStamps(outDir, row) {
  const p = path.join(outDir, "reports", row, "stamps.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

function renderIndex(reports, cfg, written, outDir) {
  const ledgerKey = (r) => Object.keys(r.fetched).find(k => /ledger\.jsonl$/.test(k));
  const rows = reports.map(r => {
    const c = r.checks;
    const anchorsCell = c.anchors ? `${c.anchors.verified} of ${c.anchors.total}${c.anchors.pending ? ` (pending ${c.anchors.pending})` : ""}${c.anchors.failed && c.anchors.failed.length ? ` <b class="bad">failed ${c.anchors.failed.length}</b>` : ""}` : "-";
    return `<tr>
<td><a href="#${esc(r.row)}">${esc(r.row)}</a></td>
<td>${esc(r.run_started_at)}<br><span class="dim">${esc(r.ran_on?.where ?? "?")}</span></td>
<td class="mono">${short(r.fetched[ledgerKey(r)]?.sha256)}</td>
<td>${esc(c.chain?.lines ?? "-")}</td>
<td class="mono">${short(c.chain?.head)}</td>
<td>${yn(c.chain?.ok)}</td>
<td>${c.vectors ? good(c.vectors.ok, `${c.vectors.passed} of ${c.vectors.total ?? "?"}`) : "-"}</td>
<td>${anchorsCell}</td>
<td>${c.gaps ? `${esc(c.gaps.count)} of ${esc(c.gaps.expected_days)} days${c.gaps.count ? ` <span class="dim">(${esc(c.gaps.dates.join(", "))})</span>` : ""}` : "-"}</td>
<td>${c.append_only ? (c.append_only.status === "REWRITE" ? `<b class="bad">REWRITE</b>` : c.append_only.status === "extends" ? `<b class="ok">yes</b>` : esc(c.append_only.status)) : "-"}</td>
<td>${c.verifier_drift ? (c.verifier_drift.drift ? `<b class="bad">YES</b>` : `<b class="ok">no</b>`) : "-"}</td>
<td>${esc(c.outside_pin?.lines_after_last_attested_head ?? "-")} of ${esc(c.chain?.lines ?? "-")}</td>
<td>${r.ok ? `<b class="ok">0</b>` : `<b class="bad">1</b>`}</td>
</tr>`;
  }).join("\n");

  const details = reports.map(r => {
    const c = r.checks;
    const stamps = readStamps(outDir, r.row);
    const anchors = (c.anchors?.per_anchor || []).map(a => `<tr>
<td>${esc(a.date)}</td>
<td>${esc(a.index.seq)}</td>
<td>${a.text ? yn(a.text.index_sha256_matches) : "-"}</td>
<td>${a.ots ? yn(a.ots.index_sha256_matches) : "-"}</td>
<td>${a.chain ? yn(a.chain.ok) : "-"}</td>
<td>${a.proof?.bitcoin_attestations?.length ? esc(distinctHeights(a.proof.bitcoin_attestations).join(", ")) : esc(a.index.block ?? "-")}</td>
<td class="${a.ok ? (a.verified ? "ok" : "") : "bad"}">${esc(a.status)}${a.problems.length && !/^FAIL/.test(a.status) ? "<br>" + a.problems.map(esc).join("<br>") : ""}</td>
</tr>`).join("\n");
    const pend = c.anchors?.pending ?? 0, gapsN = c.gaps?.count ?? 0, gapsD = c.gaps?.expected_days ?? 0, after = c.outside_pin?.lines_after_last_attested_head;
    const probs = r.problems.length
      ? `<p class="bad">problems (${r.problems.length}):</p><ul>${r.problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>`
      : `<p class="ok">no check failed</p><p>(${esc(pend)} anchor${pend === 1 ? "" : "s"} pending, ${esc(gapsN)} of ${esc(gapsD)} day${gapsD === 1 ? "" : "s"} with no anchor, ${esc(after ?? "?")} line${after === 1 ? "" : "s"} after the last bitcoin-attested head)</p>`;
    const notes = (r.notes || []).length ? `<p class="dim">notes (${r.notes.length}): ${r.notes.map(esc).join(" · ")}</p>` : "";
    const ao = c.append_only || {};
    const aoText = ao.status === "REWRITE" ? `<b class="bad">REWRITE</b> — ${esc(ao.what_changed)}. the row's own SNAPSHOTS.jsonl last line: <code>${esc(ao.row_says?.line ?? "none fetched")}</code>` : ao.status === "extends" ? `extends the previous fetch (${esc(ao.previous?.date)}: ${esc(ao.previous?.bytes)} bytes, ${esc(ao.previous?.lines)} lines) by ${esc(signed(ao.added_bytes))} bytes, ${esc(signed(ao.added_lines))} lines` : esc(ao.status ?? "-");
    const aoChanges = (ao.anchor_changes || []).length ? `<p>anchor changes since the previous fetch (${esc(ao.anchor_changes.length)}): ${ao.anchor_changes.map(x => `<code>${esc(x.date)}: ${esc(x.change)}</code>`).join(", ")}</p>` : (ao.previous ? `<p class="dim">no anchor's text, proof or block changed since the previous fetch (${esc(Object.keys(ao.previous.anchors || {}).length)} compared).</p>` : "");
    const fetched = Object.entries(r.fetched).filter(([k]) => !/^anchors\/\d{4}-\d{2}-\d{2}\.txt(\.ots)?$/.test(k)).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v.status ?? v.error)}</td><td>${esc(v.http_date)}</td><td>${esc(v.bytes)}</td><td class="mono">${esc(v.sha256 ?? "-")}</td></tr>`).join("\n");
    const ivl = c.anchor_index_vs_ledger;
    const stampText = stamps
      ? `${esc(stamps.bitcoin)} of ${esc(stamps.total)} earlier report${stamps.total === 1 ? "" : "s"} bitcoin-attested, ${esc(stamps.pending)} pending${stamps.tonight ? stamps.tonight.ok ? `; tonight's report stamped (<a href="reports/${esc(r.row)}/${esc(stamps.tonight.file)}">${esc(stamps.tonight.file)}</a>, ${esc(stamps.tonight.calendars)} calendar${stamps.tonight.calendars === 1 ? "" : "s"} answered)` : `; <b class="bad">tonight's stamp failed</b>: ${esc(stamps.tonight.error)}` : ""}. ${stamps.earlier.some(x => x.report_matches === false) ? `<b class="bad">a stamped report no longer hashes to its stamp: ${esc(stamps.earlier.filter(x => x.report_matches === false).map(x => x.date).join(", "))}.</b>` : "every stamped report on disk still hashes to its stamp."}`
      : esc(c.self_stamps?.note || "not stamped on this run (--stamp-self not passed)");
    return `<section id="${esc(r.row)}">
<h2>${esc(r.row)} <span class="dim">${esc(r.base)}</span></h2>
<p>run ${esc(r.run_started_at)} → ${esc(r.run_finished_at)} on <b>${esc(r.ran_on?.where ?? "?")}</b>${r.ran_on?.run_url ? ` (<a href="${esc(r.ran_on.run_url)}">${esc(r.ran_on.run_url)}</a>, commit ${esc(String(r.ran_on.sha || "").slice(0, 12))}, attempt ${esc(r.ran_on.run_attempt)})` : ""}, shelf ${esc(r.shelf_version)}, node ${esc(r.node)}, date ${esc(r.date)}. full record: <a href="reports/${esc(r.row)}/${esc(r.date)}.json">reports/${esc(r.row)}/${esc(r.date)}.json</a> (<a href="reports/${esc(r.row)}/latest.json">latest</a>).</p>
${probs}
${notes}
<h3>chain</h3>
<p>${c.chain?.ok ? `re-derives: ${esc(c.chain.lines)} published lines (${esc(c.chain.file_lines)} file lines), head <code>${esc(c.chain.head)}</code>, kinds ${esc(JSON.stringify(c.chain.kinds))}, withheld ${esc(c.chain.withheld)} (bridged ${esc(c.chain.bridged?.length ?? 0)}), the ledger's own anchor lines in chain ${esc(c.chain.own_anchor_lines_in_chain)} of ${esc(c.chain.own_anchor_lines)}, pinned by a posted head ${esc(c.chain.coverage?.pinned)} of ${esc(c.chain.lines)} lines, not pinned because of a withheld line ${esc(c.chain.coverage?.unpinned_by_withholding)}, after the last posted head ${esc(c.chain.coverage?.after_last_anchor)}.` : `<b class="bad">does not re-derive</b> (check_ledger exit ${esc(c.chain?.exit_code)}, ok ${esc(c.chain?.check_ledger_ok)}): ${esc((c.chain?.problems || []).map(p => `line ${p.line ?? "-"} seq ${p.seq ?? "-"}: ${p.problem || (p.problems || []).join("; ")}`).join(" | ").slice(0, 2000))}`}</p>
<p class="dim">the row's SNAPSHOTS.jsonl last line ${c.snapshot?.agrees_with_fetched_ledger === true ? "names the fetched ledger's sha256" : c.snapshot?.agrees_with_fetched_ledger === false ? `names <code>${esc(String(c.snapshot.last_line?.published_file_sha256).slice(0, 16))}</code>, the fetched ledger is <code>${esc(String(r.fetched[ledgerKey(r)]?.sha256).slice(0, 16))}</code>` : "was not compared"}.</p>
<h3>vectors</h3>
<p>${c.vectors ? `${esc(c.vectors.passed)} of ${esc(c.vectors.total ?? "?")} answered as the row's vectors file says (pinned runner, pinned verifier).` : "not run"}</p>
<pre>${esc((c.vectors?.output || []).join("\n"))}</pre>
<h3>verifier drift</h3>
<p>${c.verifier_drift?.drift ? `<b class="bad">YES</b>: the row's published verifier differs from the shelf's pinned copy; the checks on this page ran the pinned copy.` : "no: the row's published verify.js and check_ledger.cjs hash to the pinned copies."}</p>
<table><tr><th>file</th><th>published sha256</th><th>pinned sha256</th><th>same</th></tr>${Object.values(c.verifier_drift?.files || {}).map(d => `<tr><td>${esc(d.published)}</td><td class="mono">${esc(d.published_sha256)}</td><td class="mono">${esc(d.pinned_sha256)}</td><td>${yn(d.same)}</td></tr>`).join("")}</table>
<h3>anchors — verified ${esc(c.anchors?.verified ?? 0)} of ${esc(c.anchors?.total ?? 0)}, pending ${esc(c.anchors?.pending ?? 0)} of ${esc(c.anchors?.total ?? 0)}, in chain ${esc(c.anchors?.in_chain ?? 0)} of ${esc(c.anchors?.total ?? 0)}</h3>
<p class="dim">"verified" means: the fetched text hashes to what the index says, the proof is over those bytes, the text's head and seq are in the fetched chain, and every bitcoin attestation's merkle path ends at the block header that ${esc(r.explorers.length)} of ${esc(r.explorers.length)} explorers return (${r.explorers.map(esc).join(", ")}). "pending" means the proof holds calendar promises only; the shelf does not ask the calendars for a row's proof, and a proof pending for more than ${esc(r.pending_max_days ?? 7)} days after its anchor date is a failed check. "explorer unreachable" is an explorer that did not answer, not a header that disagreed; both leave the anchor not verified.${r.ots_checked ? "" : " <b>explorer check skipped (--no-ots) on this run.</b>"}</p>
<table><tr><th>date</th><th>seq</th><th>text sha256</th><th>ots sha256</th><th>in chain</th><th>block(s)</th><th>status</th></tr>
${anchors}
</table>
<p>${ivl ? `index against the ledger's own anchor lines: ${esc(ivl.in_index)} of ${esc(ivl.ledger_anchor_lines)} ledger anchor lines are in the index, ${esc(ivl.with_ledger_line)} of ${esc(ivl.index_entries)} index entries have a ledger anchor line${ivl.only_in_ledger.length ? `; <b class="bad">ledger only: ${esc(ivl.only_in_ledger.join(", "))}</b>` : ""}${ivl.only_in_index.length ? `; <b class="bad">index only: ${esc(ivl.only_in_index.join(", "))}</b>` : ""}.` : ""}</p>
<h3>gaps — ${esc(c.gaps?.count ?? "-")} of ${esc(c.gaps?.expected_days ?? "-")} days</h3>
<p>window ${esc(c.gaps?.from)} .. ${esc(c.gaps?.through)} (${esc(cfg.anchor_tz || "America/New_York")}; the end is ${esc(c.gaps?.window_from)}): ${c.gaps?.count ? `no anchor for <b>${esc(c.gaps.dates.join(", "))}</b>` : "an anchor for every day"}.${c.gaps?.late?.length ? ` late anchors: ${esc(c.gaps.late.join(", "))}.` : ""} a gap is a day with neither an index entry nor a ledger anchor line; printed, not failed.</p>
<h3>append-only</h3>
<p>${aoText}</p>
${aoChanges}
<p>lines after the last bitcoin-attested head: <b>${esc(after ?? "?")} of ${esc(c.chain?.lines ?? "?")}</b>${c.outside_pin?.last_attested_anchor ? ` (anchor ${esc(c.outside_pin.last_attested_anchor.date)} pins seq ${esc(c.outside_pin.last_attested_anchor.seq)}, block ${esc(c.outside_pin.last_attested_anchor.block)}, by ${esc(c.outside_pin.last_attested_anchor.by)})` : " (no attested anchor tonight)"}. those lines are pinned by nothing outside the lab tonight.</p>
<p class="dim">the previous fetch is <a href="history/${esc(r.row)}/latest.json">history/${esc(r.row)}/latest.json</a>, a record in this repository (see "what this is not").</p>
<h3>the shelf's own stamps</h3>
<p>${stampText}</p>
<h3>fetched</h3>
<table><tr><th>file</th><th>http</th><th>date header</th><th>bytes</th><th>sha256</th></tr>
${fetched}
</table>
<p class="dim">plus ${esc(Object.keys(r.fetched).filter(k => /^anchors\/\d{4}-\d{2}-\d{2}\.txt(\.ots)?$/.test(k)).length)} anchor files (in the json record).</p>
<h3>rerun</h3>
<pre>${esc(r.rerun)}</pre>
<p class="dim">by hand, inside the clone: ${esc(r.commands.filter(x => !x.startsWith("#")).length)} commands (every curl and every node line) are listed under <code>commands</code> in the json record. the rerun carries --date and --through so the gap window is the recorded one.</p>
</section>`;
  }).join("\n");

  const after0 = reports.length === 1 ? reports[0].checks?.outside_pin?.lines_after_last_attested_head : null;
  const lines0 = reports.length === 1 ? reports[0].checks?.chain?.lines : null;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>styxx shelf</title>
<style>
:root{color-scheme:dark}
body{background:#000;color:#c8ffc8;font:14px/1.45 ui-monospace,Consolas,"Cascadia Mono",Menlo,monospace;margin:0;padding:24px 16px;max-width:1280px}
h1,h2,h3{font-weight:normal;color:#00ff00;margin:1.2em 0 .4em}
h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}
a{color:#00ffff}
table{border-collapse:collapse;width:100%;margin:.5em 0;font-size:13px}
th,td{border:1px solid #063;padding:4px 6px;text-align:left;vertical-align:top}
th{color:#00ff00;font-weight:normal;background:#031}
.ok{color:#00ff00}.bad{color:#ff5555}.dim{color:#6a9}
.mono{font-family:inherit;word-break:break-all}
code,pre{color:#00ffff;background:#021;padding:1px 4px;border-radius:2px;white-space:pre-wrap;word-break:break-all}
pre{padding:8px;overflow:auto}
section{border-top:1px solid #063;margin-top:2em}
.wrap{overflow-x:auto}
</style>
<h1>styxx shelf — the re-derivation runs somewhere that is not the box</h1>
<p>every night a github action fetches each row's published ledger, re-derives its chain with the shelf's own pinned copy of the verifier, runs the row's conformance vectors, checks every anchor the row's index lists against the chain and its opentimestamps proof against the bitcoin block header as two explorers return it, counts the days with no anchor, and compares the bytes with the previous night's fetch. this page is written by that run; it loads nothing. each row says where its run ran: a run marked "not the action (a local run)" was made on a lab machine, not by the workflow.</p>
<p>written ${esc(written)} · ${esc(reports.length)} row${reports.length === 1 ? "" : "s"} · schedule ${esc(cfg.schedule_utc)} utc · explorers ${(cfg.explorers || []).map(esc).join(", ")}</p>
<div class="wrap"><table>
<tr><th>row</th><th>fetched at / where</th><th>ledger sha256</th><th>lines</th><th>head</th><th>chain re-derives</th><th>vectors</th><th>anchors verified</th><th>gaps</th><th>append-only</th><th>verifier drift</th><th>lines after last attested head</th><th>exit</th></tr>
${rows}
</table></div>
<h2>what this is / what this is not</h2>
<ul>
<li><b>reproducible, not independent.</b> the lab that writes the ledger also controls this repository, its workflow and its pinned verifier. what a reader gets is a run they can repeat from the printed command and compare digest for digest; not a second party's word.</li>
<li><b>the anchor texts are fetched from the lab's exhibit</b> (anchors/&lt;date&gt;.txt), since the telegram supergroup they were posted to needs an account to read. the shelf checks that those bytes are what the index says, that the proof is over them, and that they name a head in the chain. it cannot see the post.</li>
<li><b>what is outside the lab is the bitcoin block header</b>, fetched from two explorers and compared. a proof attests that the anchor's bytes existed before that block; not that they were published anywhere, not at what url, not that the head covers every send.</li>
<li><b>append-only is checked against the shelf's own record of the previous fetch, kept in this repository.</b> it shows a rewrite between two nights only while that record was not itself rewritten; the record's git history is the lab's too. lines after the last bitcoin-attested head (tonight: ${after0 !== null && after0 !== undefined ? `${esc(after0)} of ${esc(lines0)}` : "see each row"}) are pinned by nothing outside the lab. a reader who kept last night's report and its .ots can show it existed before the block it names; one who did not must trust this repository's git history.</li>
<li><b>a withheld line is bridged on the lab's word.</b> withheld.json carries a digest the shelf cannot re-derive; the chain is checked through it and the lines it leaves unpinned are counted in the report.</li>
<li><b>a failure is printed, never hidden.</b> exit 1 on any failed check, with the report still written; "pending" is a state, not a pass, and a proof pending past the configured limit is a failed check; a day with no anchor is a count and a list of dates; a verifier that drifted from the pinned copy is said so, and the pinned copy is what ran.</li>
<li><b>what the shelf asks and does not ask:</b> it asks the opentimestamps calendars only to stamp and upgrade its own nightly report (--stamp-self, on in the workflow), never to verify a row's proof: a row's pending proof stays pending here until the row's writer upgrades it. it asks no bitcoin node and no telegram.</li>
</ul>
<h2>run it yourself</h2>
<pre>git clone https://github.com/fathom-lab/styxx-shelf &amp;&amp; cd styxx-shelf &amp;&amp; npm ci &amp;&amp; node shelf.mjs --row darkflobi --out ./docs</pre>
<p class="dim">node 20+. compare your docs/reports/&lt;row&gt;/&lt;date&gt;.json with the one here: the sha256 of every fetched file, the head, the per-anchor merkle roots and the block headers should agree when the url served the same bytes. each row's "rerun" line below carries the --date and --through of the recorded run.</p>
${details}
${renderOutside(outDir)}
`;
}

// ---- the outside ledgers section: the register (outside_ledgers.json) and the reports shelf_read.cjs wrote
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }
function renderOutside(outDir) {
  const reg = readJson(path.join(outDir, "outside_ledgers.json"));
  if (!reg || !Array.isArray(reg.rows)) return `<section id="outside"><h2>ledgers read by url</h2><p class="dim">no register (outside_ledgers.json) in this output folder.</p></section>`;
  const vend = readJson(path.join(outDir, "v1", "VENDORED.json"));
  const pinned = readJson(TOOLS.pinned);
  const cnt = CORE.registerCounts(reg);
  const rows = reg.rows.map(row => {
    const rep = readJson(path.join(outDir, "reports", row.name + ".json"));
    const onceRel = rep ? `reports/reads/${row.name}/${String(rep.read_at).replace(/:/g, "-")}.json` : null;
    const oncePath = onceRel ? path.join(outDir, ...onceRel.split("/")) : null;
    const onceSha = oncePath && fs.existsSync(oncePath) ? sha256(fs.readFileSync(oncePath)) : null;
    const a = rep?.anchors?.earliest;
    const place = row.anchor_place ? `${esc(row.anchor_place.kind)}${row.anchor_place.url ? `<br><code>${esc(row.anchor_place.url)}</code>` : ""}` : "none named";
    return `<tr id="outside-${esc(row.name)}">
<td>${esc(row.name)}<br><span class="dim">written by ${row.written_by === "lab" ? "the lab" : row.written_by === "outside" ? "an operator outside the lab" : esc(row.written_by)}</span>${row.withdrawn_at ? `<br><span class="dim">withdrawn ${esc(row.withdrawn_at)}</span>` : ""}</td>
<td>${esc(row.protocol)}</td>
<td class="mono"><a href="${esc(row.ledger_url)}">${esc(row.ledger_url)}</a></td>
<td>${place}</td>
<td>${rep ? `${esc(rep.read_at)}<br><a href="${esc(onceRel)}">${esc(onceRel)}</a><br><span class="dim">sha256</span> <span class="mono">${esc(onceSha ?? "kept copy missing")}</span><br><span class="dim">shelf ${esc(rep.shelf_commit)}</span>` : `<span class="dim">no report yet</span>`}</td>
<td>${rep ? `${esc(rep.bytes)}<br><span class="mono">${short(rep.sha256)}</span>` : "-"}</td>
<td>${esc(rep?.lines ?? "-")}</td>
<td class="mono">${short(rep?.head)}</td>
<td>${rep ? (rep.rederives.ok ? `<b class="ok">yes</b>` : `<b class="bad">no</b> ${esc(rep.rederives.problem_codes.join(", "))}`) : "-"}</td>
<td>${rep ? `${esc(rep.anchors.holding)} of ${esc(rep.anchors.count)}` : "-"}</td>
<td>${a ? `${esc(a.date)} seq ${esc(a.seq)}<br>text sha256 <span class="mono">${short(a.text_sha256)}</span><br>place: ${a.place_check.result === "found" ? `<b class="ok">found</b>` : a.place_check.result === "not_checked" ? esc(a.place_check.result) : `<b class="bad">${esc(a.place_check.result)}</b>`}${a.place_check.http_status !== null ? ` (http ${esc(a.place_check.http_status)})` : ""}` : "-"}</td>
<td><a href="outside.html#${esc(row.name)}">re-derive now in your browser</a></td>
</tr>`;
  }).join("\n");
  const vt = vend ? `<p>v1 rows run the kit's verifier as copied from styxx-ledger commit <code>${esc(vend.kit_commit)}</code> (${esc(vend.kit_commit_full)}, <a href="${esc(vend.kit_repo)}">${esc(vend.kit_repo)}</a>), ${esc(vend.files.length)} files, none changed (<a href="v1/VENDORED.json">v1/VENDORED.json</a>):</p>
<table><tr><th>file</th><th>kit path</th><th>sha256</th></tr>${vend.files.map(f => `<tr><td><a href="v1/${esc(f.path)}">${esc(f.path)}</a></td><td>${esc(f.kit_path)}</td><td class="mono">${esc(f.sha256)}</td></tr>`).join("")}</table>` : `<p class="bad">v1/VENDORED.json is missing from this output folder.</p>`;
  const v0t = pinned ? `<p>v0 rows run the shelf's pinned tools/verify.js (sha256 <span class="mono">${esc(pinned.files["tools/verify.js"].sha256)}</span>), served to the browser as <a href="v0/verify.js">v0/verify.js</a>.</p>` : "";
  return `<section id="outside">
<h2>${esc(CORE.registerHeading(reg))}</h2>
<p>who wrote each ledger is the row's <code>written_by</code>. ${cnt.outside_read === 0 ? `no row names a ledger written outside the lab: the ${esc(cnt.lab)} of ${esc(cnt.rows)} rows written by the lab (${esc(reg.rows.filter(r => r.written_by === "lab").map(r => r.name).join(", "))}) show the shelf reading the lab's own ledgers by url, not an outside one.` : `${esc(cnt.outside_read)} row(s) name a ledger written outside the lab; ${esc(cnt.lab)} of ${esc(cnt.rows)} are the lab's own.`} ${esc(CORE.SCORER_GATE)}</p>
<p>the register <a href="outside_ledgers.json">outside_ledgers.json</a> lists the ledgers the shelf reads with <code>shelf_read.cjs</code>, one url each, protocol v0 or v1. the shelf is the lab's: a ledger listed here, whoever wrote it, is read by the lab's shelf, with the lab's copy of the verifier and the lab's code, and the reports below are the lab's. a report says whether the bytes at the url re-derive and where the earliest anchor that holds was looked for; it says nothing about the agent behind a ledger, or whether a line records what happened. rows are appended by the lab in a dated commit and never edited; a row taken off gets withdrawn_at and stays. a v1 row for an outside operator's ledger is added when that operator has published one and asks.</p>
<div class="wrap"><table>
<tr><th>row</th><th>protocol</th><th>ledger url</th><th>anchor place</th><th>committed report (kept copy, its sha256)</th><th>bytes / sha256</th><th>lines</th><th>head</th><th>re-derives</th><th>anchors holding</th><th>earliest anchor that holds</th><th>in your browser</th></tr>
${rows}
</table></div>
<p class="dim">these reports are written when the lab runs <code>node shelf_read.cjs --row &lt;name&gt;</code> by hand; the nightly workflow runs shelf.mjs and does not write them. every read is kept at reports/reads/&lt;row&gt;/&lt;read_at&gt;.json and never rewritten; reports/&lt;row&gt;.json is the latest and is replaced by the next read. the census template's section 15 line (<code>shelf read: &lt;url&gt; sha256 &lt;64 hex&gt; at &lt;read_at&gt;</code>) names the kept copy. the report's fields: <a href="outside_report_schema.json">outside_report_schema.json</a>. the browser page fetches the ledger from its url and runs the same code (shelf_core.js and the verifiers below); it can read a host that allows a cross-origin read (github pages hosts do).</p>
${vt}
${v0t}
</section>`;
}

// ---- main
(async () => {
  const opts = parseArgs(process.argv.slice(2));
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(opts.config, "utf8")); } catch (e) { usage("cannot read config " + opts.config + ": " + e.message); }
  if (!cfg || !Array.isArray(cfg.rows) || !cfg.rows.length) usage("config has no rows");
  const rows = opts.row ? cfg.rows.filter(r => r.name === opts.row) : cfg.rows;
  if (!rows.length) usage(`no row named ${opts.row} in ${opts.config}`);
  fs.mkdirSync(opts.out, { recursive: true });
  // a report for a past --date that already exists is not rewritten in place: the night it records is history
  const runDate = opts.date || utcDay();
  for (const row of rows) {
    const p = path.join(opts.out, "reports", row.name, `${runDate}.json`);
    if (!opts.pageOnly && opts.date && runDate < utcDay() && fs.existsSync(p)) usage(`report for ${row.name} ${runDate} exists (${path.relative(process.cwd(), p)}); a rerun of a past date writes nowhere by default, pass --out <other dir>`);
  }
  const results = [];
  // --page-only: rewrite index.html from the reports already on disk; fetch nothing, run no row
  for (const row of opts.pageOnly ? [] : rows) {
    try { results.push(await runRow(row, opts, cfg)); }
    catch (e) { console.error(`row ${row.name}: crashed: ${e && e.stack || e}`); process.exitCode = 2; }
  }
  // the page shows every row that has a latest report, including rows not run tonight
  const repRoot = path.join(opts.out, "reports");
  const all = fs.existsSync(repRoot) ? fs.readdirSync(repRoot).map(d => path.join(repRoot, d, "latest.json")).filter(p => fs.existsSync(p)).map(p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }).filter(Boolean) : results;
  all.sort((a, b) => a.row.localeCompare(b.row));
  fs.writeFileSync(path.join(opts.out, "index.html"), renderIndex(all, cfg, isoNow(), opts.out));
  if (!fs.existsSync(path.join(opts.out, ".nojekyll"))) fs.writeFileSync(path.join(opts.out, ".nojekyll"), "");
  const failed = results.filter(r => r.exit_code !== 0).length;
  say(`${results.length} row(s) run, ${failed} with problems; page ${path.relative(process.cwd(), path.join(opts.out, "index.html")) || "index.html"}`);
  if (process.exitCode === 2) process.exit(2);
  if (opts.pageOnly) process.exit(0);
  process.exit(failed || results.length !== rows.length ? 1 : 0);
})().catch(e => { console.error("error: " + (e && e.stack || e)); process.exit(2); });
