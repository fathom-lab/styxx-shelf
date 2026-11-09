#!/usr/bin/env node
/* shelf_read.cjs — read one register row's ledger off its url and write the shelf's per-ledger report.

     node shelf_read.cjs --row <name> [--register docs/outside_ledgers.json] [--out docs/reports]
     node shelf_read.cjs --url <ledger url> --protocol v0|v1 [--withheld-url <url>] [--place-url <url>] [--name <n>] [--out <dir>]

   with --row: the row is read from the register (docs/outside_ledgers.json); a withdrawn row is refused.
   with --url: a dry run for a ledger not on the register; the report goes to stdout unless --out is given.

   what it does: fetches the ledger bytes (30 s timeout; and withheld.json when the row names one), records their
   sha256 and byte count, re-derives the chain (v1 with the kit's verifier vendored in docs/v1 at commit 838a003; v0
   with the shelf's pinned tools/verify.js), lists the ledger's own anchor entries, takes the earliest that holds,
   and when the row names an anchor place with a url ({date} replaced by that anchor's date) fetches it and says
   whether the anchor text is there: found / not_found / could_not_read, with the http status.

   writes <out>/<name>.json (the latest read) and <out>/reads/<name>/<read_at>.json (this read, never overwritten:
   the copy whose url and sha256 an operator pastes, since the latest is replaced by the next read). the report
   carries counts and digests only: never a line's text. the one text it carries is the earliest anchor's, which is
   public by design and which the census scorer looks for verbatim. deterministic for fixed bytes except read_at and
   shelf_commit. exit 0 when the chain re-derives, 1 when it does not or the ledger did not answer, 2 on usage.
   node 20+, standard library only. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { spawnSync } = require("child_process");

const HERE = __dirname;
const CORE = require(path.join(HERE, "docs", "shelf_core.js"));
const V1 = require(path.join(HERE, "docs", "v1", "verify.js"));
const V0 = require(path.join(HERE, "tools", "verify.js"));
const TIMEOUT_MS = 30000;
const CAP = 50 * 1024 * 1024;

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function usage(msg) {
  if (msg) console.error("error: " + msg);
  console.error("usage: node shelf_read.cjs --row <name> [--register <file>] [--out <dir>]\n       node shelf_read.cjs --url <ledger url> --protocol v0|v1 [--withheld-url <url>] [--place-url <url>] [--name <n>] [--out <dir>]");
  process.exit(2);
}
function parseArgs(argv) {
  const o = { row: null, register: path.join(HERE, "docs", "outside_ledgers.json"), out: null, url: null, protocol: null, withheldUrl: null, placeUrl: null, name: null };
  const want = (i) => { if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) usage(argv[i] + " wants a value"); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--row") o.row = want(i++);
    else if (a === "--register") o.register = path.resolve(want(i++));
    else if (a === "--out") o.out = path.resolve(want(i++));
    else if (a === "--url") o.url = want(i++);
    else if (a === "--protocol") o.protocol = want(i++);
    else if (a === "--withheld-url") o.withheldUrl = want(i++);
    else if (a === "--place-url") o.placeUrl = want(i++);
    else if (a === "--name") o.name = want(i++);
    else if (a === "-h" || a === "--help") usage();
    else usage("unknown argument " + a);
  }
  if (!!o.row === !!o.url) usage("give --row or --url, not both");
  if (o.url && o.protocol !== "v0" && o.protocol !== "v1") usage("--url wants --protocol v0 or v1");
  if (o.row && (o.protocol || o.withheldUrl || o.placeUrl || o.name)) usage("--protocol, --withheld-url, --place-url and --name go with --url");
  if (o.name !== null && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(o.name)) usage("--name is 1-32 chars of [a-z0-9_-]");
  if (o.row && o.out === null) o.out = path.join(HERE, "docs", "reports");
  return o;
}

/* {status, bytes: Buffer|null, error}; never throws. node's http/https with no keep-alive agent (fetch's pooled
   sockets trip a libuv assertion on windows when the process exits right after); 30 s for the whole read, up to 5
   redirects, at most CAP bytes. */
function fetchBytes(url, hops = 0) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: null, bytes: null, error: "not a url: " + url }); }
    const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!mod) return resolve({ status: null, bytes: null, error: "not http(s): " + url });
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const req = mod.get(u, { agent: false, headers: { "user-agent": "styxx-shelf-read", "accept-encoding": "identity" } }, (res) => {
      const st = res.statusCode;
      if (st >= 300 && st < 400 && res.headers.location && hops < 5) {
        res.resume();
        return fetchBytes(new URL(res.headers.location, u).href, hops + 1).then(finish);
      }
      const chunks = []; let n = 0;
      res.on("data", (c) => { n += c.length; if (n > CAP) { req.destroy(); finish({ status: st, bytes: null, error: "over " + CAP + " bytes" }); } else chunks.push(c); });
      res.on("end", () => { const ok = st >= 200 && st < 300; finish({ status: st, bytes: ok ? Buffer.concat(chunks) : null, error: ok ? null : "http " + st }); });
      res.on("error", (e) => finish({ status: st, bytes: null, error: String(e.message || e) }));
    });
    const timer = setTimeout(() => { req.destroy(); finish({ status: null, bytes: null, error: "no answer in " + TIMEOUT_MS / 1000 + " s" }); }, TIMEOUT_MS);
    req.on("error", (e) => finish({ status: null, bytes: null, error: String(e.message || e) }));
  });
}

function shelfCommit() {
  const g = (args) => spawnSync("git", ["-C", HERE, ...args], { encoding: "utf8" });
  const head = g(["rev-parse", "HEAD"]);
  if (head.status !== 0) return "unknown (git rev-parse HEAD failed in " + HERE + ")";
  const st = g(["status", "--porcelain"]);
  const dirty = st.status !== 0 || st.stdout.trim().length > 0;
  return head.stdout.trim() + (dirty ? " (uncommitted changes present)" : "");
}

/* the report, in its fixed key order (CORE.REPORT_KEYS) */
async function read(row) {
  const readAt = isoNow();
  const verifier = row.protocol === "v1" ? V1 : V0;
  const f = await fetchBytes(row.ledger_url);
  let withheld = [], withheldNote = null;
  if (row.withheld_url) {
    const w = await fetchBytes(row.withheld_url);
    if (w.bytes) {
      // a bare array or {"withheld": [...]}, as the kit's loadWithheld and the census scorer both accept
      try { const u = CORE.unwrapWithheld(JSON.parse(w.bytes.toString("utf8"))); withheld = u.list; withheldNote = u.code; }
      catch (e) { withheldNote = "withheld_unparsable"; }
    } else withheldNote = "withheld_unreachable";
  }
  const rep = { shelf_commit: shelfCommit(), read_at: readAt, ledger_url: row.ledger_url, bytes: 0, sha256: null, protocol: row.protocol, lines: null, head: null, rederives: null, implementations: null, anchors: null };
  if (!f.bytes) {
    rep.rederives = { ok: false, problem_codes: ["unreachable"], problems: 0, http_status: f.status };
    rep.implementations = { javascript: "not run: the ledger did not answer (" + f.error + ")", python: "not run by the shelf" };
    rep.anchors = { count: 0, holding: 0, earliest: null };
    return rep;
  }
  rep.bytes = f.bytes.length;
  rep.sha256 = sha256(f.bytes);
  const r = await CORE.readLedger({ protocol: row.protocol, bytes: new Uint8Array(f.bytes), withheld, verifier });
  rep.lines = r.lines;
  rep.head = r.head;
  const codes = r.rederives.problem_codes.slice();
  if (withheldNote) codes.push(withheldNote);
  rep.rederives = { ok: r.rederives.ok && !withheldNote, problem_codes: codes.sort(), problems: r.rederives.problems, withheld_lines: withheld.length };
  rep.implementations = {
    javascript: (r.rederives.ok ? "re-derives" : "does not re-derive") + " (" + (row.protocol === "v1" ? "styxx-ledger js/lib/verify.js at 838a003, vendored in docs/v1" : "the shelf's pinned tools/verify.js, darkflobi.gate v0") + ")",
    python: "not run by the shelf"
  };
  const e = CORE.earliestAnchor(r.anchors.list);
  let earliest = null;
  if (e) {
    const url = CORE.placeUrl(row.anchor_place, e.date);
    let place;
    if (!row.anchor_place) place = { result: "not_checked", why: "the row names no anchor place", url: null, http_status: null };
    else if (!url) place = { result: "not_checked", why: "the row's anchor place has no url", url: null, http_status: null };
    else {
      const p = await fetchBytes(url);
      place = { result: CORE.placeVerdict(p.bytes ? p.status : null, p.bytes ? p.bytes.toString("utf8") : null, e.text), url, http_status: p.status };
    }
    earliest = { date: e.date, seq: e.seq, text: e.text, text_sha256: e.text_sha256, holds: e.holds, place_check: place };
  }
  rep.anchors = { count: r.anchors.count, holding: r.anchors.holding, earliest };
  return rep;
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  let row;
  if (o.row) {
    let reg;
    try { reg = JSON.parse(fs.readFileSync(o.register, "utf8")); } catch (e) { usage("cannot read register " + o.register + ": " + e.message); }
    const bad = CORE.checkRegister(reg);
    if (bad.length) usage("the register does not hold its own rules: " + bad.join("; "));
    row = reg.rows.find(r => r.name === o.row);
    if (!row) usage("no row named " + o.row + " in " + o.register);
    if (row.withdrawn_at) usage("row " + o.row + " was withdrawn at " + row.withdrawn_at + "; the shelf does not read it");
  } else {
    row = { name: o.name || "dry-run", protocol: o.protocol, ledger_url: o.url, withheld_url: o.withheldUrl, anchor_place: o.placeUrl ? { kind: "given on the command line", url: o.placeUrl } : null };
  }
  const rep = await read(row);
  const text = JSON.stringify(rep, null, 1) + "\n";
  if (o.out) {
    const latest = path.join(o.out, row.name + ".json");
    const stamp = rep.read_at.replace(/:/g, "-");
    const once = path.join(o.out, "reads", row.name, stamp + ".json");
    if (fs.existsSync(once)) usage("a read at " + rep.read_at + " already exists (" + once + "); a past read is never rewritten");
    fs.mkdirSync(path.dirname(once), { recursive: true });
    fs.writeFileSync(once, text);
    fs.writeFileSync(latest, text);
    for (const p of [once, latest]) if (fs.readFileSync(p, "utf8") !== text) { console.error("error: the write to " + p + " did not land"); process.exit(2); }
    const a = rep.anchors.earliest;
    console.log(`${row.name}: ${rep.bytes} bytes sha256 ${rep.sha256}; ${rep.lines === null ? "-" : rep.lines} lines, head ${rep.head}; re-derives ${rep.rederives.ok ? "yes" : "NO (" + rep.rederives.problem_codes.join(", ") + ")"}; anchors holding ${rep.anchors.holding} of ${rep.anchors.count}; earliest ${a ? a.date + " seq " + a.seq + ", place " + a.place_check.result + (a.place_check.http_status !== null ? " (http " + a.place_check.http_status + ")" : "") : "none"}`);
    console.log(`report ${path.relative(process.cwd(), once)} sha256 ${sha256(Buffer.from(text, "utf8"))} (also ${path.relative(process.cwd(), latest)})`);
  } else process.stdout.write(text);
  process.exitCode = rep.rederives.ok ? 0 : 1;
})().catch(e => { console.error("error: " + (e && e.stack || e)); process.exit(2); });
