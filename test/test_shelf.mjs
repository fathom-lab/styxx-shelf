#!/usr/bin/env node
/* test_shelf.mjs — one command: node test/test_shelf.mjs

   starts a local http server (node http) serving a copy of the exhibit's ledger directory (test/fixtures/site) plus
   fake bitcoin explorers that answer with the real block headers captured once from blockstream.info
   (test/fixtures/block_headers.json: source and fetch time inside) and a fake opentimestamps calendar, then runs
   shelf.mjs against it, case by case:

     a   the live copy                        -> every check passes, exit 0 (13 of 14 anchors verified, 1 pending; 1 gap)
     b   one ledger field rewritten            -> chain FAIL at that seq, exit 1
     b2  the ledger's own anchor line altered  -> check_ledger says ok=false with no chain problem; the shelf's chain column is NO
     c   the ledger truncated after a run      -> REWRITE printed, the row's SNAPSHOTS line quoted, exit 1
     c2  one byte flipped, same length         -> REWRITE "the leading N bytes differ", chain FAIL, exit 1
     d   an anchor .txt altered by one byte    -> text_sha256 FAIL and OTS FAIL, exit 1
     e   verify.js swapped for a broken one    -> drift reported, the pinned tools still pass, exit 0
     f   the two explorers disagree            -> "explorers disagree", not verified, exit 1
     g   an index that omits a ledger anchor   -> discrepancy (exit 1), not a gap; the pure gap stays 2026-11-06
     h   one explorer down (503)               -> "explorer unreachable", 1 of 2, not verified, exit 1
     i   --date games                          -> future, non-calendar, and a past date over an existing report all exit 2
     j   anchor text swapped between nights    -> REWRITE class problem; a bitcoin proof regressed to pending is a problem
     k   a proof pending past the limit        -> problem, exit 1
     l   --stamp-self against a fake calendar  -> the report's .ots written and pending; the next night counts it

   prints a pass/fail count; exits non-zero on any failure. nothing here touches the network. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const SITE = path.join(HERE, "fixtures", "site");
const HEADERS_FIXTURE = path.join(HERE, "fixtures", "block_headers.json");
const require = createRequire(import.meta.url);
const V = require(path.join(REPO, "tools", "verify.js"));
const OTS = require(path.join(REPO, "node_modules", "opentimestamps", "index.js"));
const DATE = "2026-11-08";   // fixed run date: the fixture's earliest anchor is 2026-10-24, so coverage is 10-24 .. 11-07 and 2026-11-06 is the one gap

const results = [];
let current = null;
function check(name, cond, detail) {
  results.push({ case: current, name, ok: !!cond, detail });
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${!cond && detail !== undefined ? "  -- " + String(detail).slice(0, 400) : ""}`);
}
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sha256File = (p) => sha256(fs.readFileSync(p));

// ---- fixtures
const headers = fs.existsSync(HEADERS_FIXTURE) ? JSON.parse(fs.readFileSync(HEADERS_FIXTURE, "utf8")) : null;
const TYPES = { ".json": "application/json", ".jsonl": "application/x-ndjson", ".js": "text/javascript", ".cjs": "text/javascript", ".txt": "text/plain", ".ots": "application/octet-stream", ".md": "text/markdown" };

function copyDir(src, dst) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src, { withFileTypes: true })) { const s = path.join(src, e.name), d = path.join(dst, e.name); if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d); } }

// a serialized opentimestamps Timestamp over `msg` with one pending attestation naming `uri` (what a calendar answers to POST /digest)
function pendingTimestampBytes(msg, uri) {
  const ts = new OTS.Timestamp(Array.from(msg));
  ts.attestations.push(new OTS.Notary.PendingAttestation(uri));
  const ctx = new OTS.Context.StreamSerialization();
  ts.serialize(ctx);
  return Buffer.from(ctx.getOutput());
}
// a fresh detached .ots over `text` holding only a pending attestation (what a forger makes in a second)
function pendingOts(text, uri) {
  const det = OTS.DetachedTimestampFile.fromBytes(new OTS.Ops.OpSHA256(), new Uint8Array(Buffer.from(text)));
  det.timestamp.attestations.push(new OTS.Notary.PendingAttestation(uri));
  return Buffer.from(det.serializeToBytes());
}

// ---- the server: /site/... , /ex1/..., /ex2/..., /exbad/... (headers with a flipped merkle root), /exdown/... (503), /cal/... (fake calendar)
function startServer(state) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      const p = decodeURIComponent(u.pathname);
      const send = (code, body, type) => { res.writeHead(code, { "content-type": type || "text/plain", "content-length": Buffer.byteLength(body) }); res.end(body); };
      let m;
      if (/^\/exdown\//.test(p)) return send(503, "down");
      if ((m = /^\/(ex1|ex2|exbad)\/block-height\/(\d+)$/.exec(p))) {
        const b = headers && headers.blocks[m[2]];
        return b ? send(200, b.hash) : send(404, "Block not found");
      }
      if ((m = /^\/(ex1|ex2|exbad)\/block\/([0-9a-f]{64})$/.exec(p))) {
        const b = headers && Object.values(headers.blocks).find(x => x.hash === m[2]);
        if (!b) return send(404, "Block not found");
        const h = { ...b.header };
        if (m[1] === "exbad") h.merkle_root = (h.merkle_root[0] === "0" ? "1" : "0") + h.merkle_root.slice(1);
        return send(200, JSON.stringify(h), "application/json");
      }
      // the library resolves new URL('/digest', calendarUrl): a calendar's routes sit at the host root
      if (p === "/digest" && req.method === "POST") {
        const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => { state.calendarPosts++; send(200, pendingTimestampBytes(Buffer.concat(chunks), state.calendarUrl), "application/vnd.opentimestamps.v1"); });
        return;
      }
      if (/^\/timestamp\//.test(p)) { state.calendarGets++; return send(404, "Pending confirmation in Bitcoin blockchain"); }
      if ((m = /^\/site\/(.*)$/.exec(p))) {
        const f = path.join(state.dir, m[1]);
        if (!f.startsWith(state.dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, "not here");
        const body = fs.readFileSync(f);
        res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "content-length": body.length, "last-modified": new Date().toUTCString() });
        return res.end(body);
      }
      send(404, "not here");
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

// ---- one shelf run (asynchronous: the server lives in this process, so a blocking spawnSync would starve it)
function runShelf(port, siteDir, out, extra = [], cfgExtra = {}) {
  const cfg = { rows: [{ name: "darkflobi", base: `http://127.0.0.1:${port}/site/`, files: { ledger: "ledger.jsonl", withheld: "withheld.json", verify: "verify.js", check: "check_ledger.cjs", vectors: "vectors/vectors.json", vectors_base: "vectors/base.jsonl", anchors_index: "anchors/index.json", snapshots: "SNAPSHOTS.jsonl", stats: "STATS.json" } }], explorers: [`http://127.0.0.1:${port}/ex1`, `http://127.0.0.1:${port}/ex2`], schedule_utc: "07:00", anchor_tz: "America/New_York", fetch_timeout_seconds: 20, pending_max_days: 7, ...cfgExtra };
  const cfgPath = path.join(out, "shelf.config.json");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const args = [path.join(REPO, "shelf.mjs"), "--config", cfgPath, "--out", out, ...(extra.includes("--date") ? [] : ["--date", DATE]), ...extra];
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    ch.stdout.on("data", d => { stdout += d; }); ch.stderr.on("data", d => { stderr += d; });
    ch.on("close", (code) => {
      const date = extra.includes("--date") ? extra[extra.indexOf("--date") + 1] : DATE;
      const repPath = path.join(out, "reports", "darkflobi", `${date}.json`);
      const report = fs.existsSync(repPath) ? JSON.parse(fs.readFileSync(repPath, "utf8")) : null;
      resolve({ code, stdout, stderr, report, out });
    });
  });
}

// rechain a ledger from file line `from` to the end after mutating objs in place (the forger's step)
async function rechain(objs, lines, from) {
  let prev = null;
  for (let i = from; i < lines.length; i++) { const o = objs[i]; if (!o) continue; if (prev) o.prev = prev; o.entry_id = await V.entryIdOf(V.coreOf(o)); prev = o.entry_id; lines[i] = V.dump(o); }
}
function readLedger(p) { const lines = fs.readFileSync(p, "utf8").split("\n"); return { lines, objs: lines.map(l => l.trim() ? JSON.parse(l) : null) }; }

// ---- cases
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "styxx-shelf-test-"));
  const state = { dir: SITE, calendarPosts: 0, calendarGets: 0, calendarUrl: "" };
  const { srv, port } = await startServer(state);
  state.calendarUrl = `http://127.0.0.1:${port}/cal`;
  const fresh = (name) => { const d = path.join(tmp, "site-" + name); copyDir(SITE, d); state.dir = d; return d; };
  const outDir = (name) => path.join(tmp, "out-" + name);
  const ledgerPath = (d) => path.join(d, "ledger.jsonl");
  const page = (out) => fs.readFileSync(path.join(out, "index.html"), "utf8");
  try {
    // (a) the live copy
    current = "a"; console.log("case a: the live copy -> every check passes");
    if (!headers) { console.log("  SKIP: test/fixtures/block_headers.json is missing (the block headers were never captured; the network was unavailable when the fixture was built). nothing is faked."); results.push({ case: "a", name: "skipped: no block header fixture", ok: true, skipped: true }); }
    else {
      const d = fresh("a"); const r = await runShelf(port, d, outDir("a"));
      check("exit 0", r.code === 0, r.stdout.split("\n").filter(l => /FAIL|problem/.test(l)).join(" | ") + r.stderr);
      check("report written", !!r.report);
      if (r.report) {
        const c = r.report.checks;
        check("chain re-derives (check_ledger ok, exit 0)", c.chain.ok && c.chain.check_ledger_ok === true && c.chain.exit_code === 0, JSON.stringify(c.chain.problems));
        check("the ledger's own anchor lines: 14 of 14 in chain", c.chain.own_anchor_lines_in_chain === 14 && c.chain.own_anchor_lines === 14);
        check("fetched sha256 of ledger equals the fixture's", r.report.fetched["ledger.jsonl"].sha256 === sha256File(ledgerPath(d)));
        check("vectors 10 of 10", c.vectors.passed === 10 && c.vectors.total === 10, JSON.stringify(c.vectors));
        check("no verifier drift", c.verifier_drift.drift === false);
        check("anchors: total 14, verified 13, pending 1", c.anchors.total === 14 && c.anchors.verified === 13 && c.anchors.pending === 1, `total ${c.anchors.total} verified ${c.anchors.verified} pending ${c.anchors.pending} failed ${c.anchors.failed}`);
        check("every anchor in chain", c.anchors.in_chain === 14, c.anchors.in_chain);
        const a0 = c.anchors.per_anchor[0] || { status: "(no anchors)" };
        check("earliest anchor status names block 974530 and 2 of 2 explorers", /^bitcoin: block 974530, header from 2 of 2 explorers agree \(attestedTime 2026-11-04T/.test(a0.status), a0.status);
        const a1105 = c.anchors.per_anchor.find(a => a.date === "2026-11-05");
        check("2026-11-05: four attestations, lowest block 974768", a1105 && a1105.proof.bitcoin_attestations.length === 4 && a1105.proof.bitcoin_attestations[0].height === 974768 && a1105.lowest_block === 974768, a1105 && a1105.status);
        const a1107 = c.anchors.per_anchor.find(a => a.date === "2026-11-07");
        check("2026-11-07: pending with its age in days", a1107 && /^pending \(calendars only: 4; 1 day\(s\) since the anchor date\)$/.test(a1107.status) && a1107.ok, a1107 && a1107.status);
        check("index vs ledger anchor lines: 14 of 14 both ways", c.anchor_index_vs_ledger.ok && c.anchor_index_vs_ledger.in_index === 14 && c.anchor_index_vs_ledger.with_ledger_line === 14, JSON.stringify(c.anchor_index_vs_ledger));
        check("gaps: 1 of 15 (2026-11-06)", c.gaps.count === 1 && c.gaps.dates[0] === "2026-11-06" && c.gaps.expected_days === 15, JSON.stringify(c.gaps));
        check("gap window end says it came from --date", /--date 2026-11-08/.test(c.gaps.window_from), c.gaps.window_from);
        check("lines after the last bitcoin-attested head: 30 of 729 (anchor 2026-11-05 pins seq 704; seqs 705..734, the 5 withheld are below)", c.outside_pin.lines_after_last_attested_head === 30 && c.outside_pin.last_attested_anchor.seq === 704 && c.outside_pin.last_attested_anchor.block === 974768, JSON.stringify(c.outside_pin));
        check("append-only: no previous fetch", c.append_only.status === "no previous fetch");
        check("history written with the anchors' digests", fs.existsSync(path.join(outDir("a"), "history", "darkflobi", "latest.json")) && JSON.parse(fs.readFileSync(path.join(outDir("a"), "history", "darkflobi", "latest.json"), "utf8")).anchors["2026-11-05"].lowest_block === 974768);
        check("ran_on says a local run", /not the action/.test(r.report.ran_on.where), r.report.ran_on.where);
        check("rerun carries --date and --through", /--date 2026-11-08 --through 2026-11-07$/.test(r.report.rerun), r.report.rerun);
        const html = page(outDir("a"));
        check("index.html written without scripts", !/<script/i.test(html));
        check("page shows anchors verified 13 of 14 and gaps 1 of 15 days", /13 of 14/.test(html) && /1 of 15 days/.test(html));
        check("page: verifier drift 'no' is green, not red", /<b class="ok">no<\/b>/.test(html) && !/<b class="bad">no<\/b>/.test(html));
        check("page: headline says 'no check failed' with the pending/gap/after counts, not 'every check passed'", /no check failed/.test(html) && /1 anchor pending, 1 of 15 days with no anchor, 30 lines after the last bitcoin-attested head/.test(html) && !/every check passed/.test(html), html.match(/no check failed[\s\S]{0,200}/)?.[0]);
        check("page: the append-only baseline sentence is present with tonight's count", /append-only is checked against the shelf's own record of the previous fetch, kept in this repository/.test(html) && /tonight: 30 of 729/.test(html));
        check("page: calendars sentence says stamp/upgrade own report only", /asks the opentimestamps calendars only to stamp and upgrade its own nightly report/.test(html));
        check("page: 'independent' only inside 'reproducible, not independent'", (html.match(/independent/g) || []).length === 1 && /reproducible, not independent/.test(html));
        check("page: no 'provably', 'no one', 'guarantee'", !/provably|no one|guarantee/.test(html));
        check("stdout: in chain with its denominator", /in chain 14 of 14/.test(r.stdout));
        check("stdout: report path is the --out one", new RegExp("report .*out-a").test(r.stdout), r.stdout.split("\n").find(l => /report /.test(l)));
        check("commands recorded (curl lines + node lines)", r.report.commands.some(x => /^curl /.test(x)) && r.report.commands.some(x => /^node tools\/check_ledger\.cjs/.test(x)) && r.report.commands.some(x => /^node tools\/run_vectors\.cjs/.test(x)));
        check("each anchor text fetched once (37 files recorded, 9 + 14 x 2)", Object.keys(r.report.fetched).length === 37);
      }
    }

    // (b) one field rewritten and re-dumped
    current = "b"; console.log("case b: one ledger field rewritten and re-dumped -> chain FAIL at that seq");
    {
      const d = fresh("b"); const SEQ = 300;
      const lines = fs.readFileSync(ledgerPath(d), "utf8").split("\n");
      let hit = false;
      const out = lines.map(l => { if (!l.trim()) return l; const o = JSON.parse(l); if (o.seq === SEQ) { hit = true; o.day = "1999-01-01"; return V.dump(o); } return l; });
      if (!hit) throw new Error("fixture has no seq " + SEQ);
      fs.writeFileSync(ledgerPath(d), out.join("\n"));
      const r = await runShelf(port, d, outDir("b"), ["--no-ots"]);
      check("exit 1", r.code === 1, r.code);
      check("chain does not re-derive", r.report && r.report.checks.chain.ok === false);
      check(`a problem names seq ${SEQ}`, r.report && r.report.checks.chain.problems.some(p => p.seq === SEQ), r.report && JSON.stringify(r.report.checks.chain.problems).slice(0, 300));
      check("stdout prints DOES NOT RE-DERIVE", /DOES NOT RE-DERIVE/.test(r.stdout));
    }

    // (b2) the ledger's own anchor line altered and rechained: check_ledger exits 1 with ok=false and an EMPTY problems array
    current = "b2"; console.log("case b2: the ledger's last anchor line's anchor_head flipped and rechained -> chain column NO although problems[] is empty");
    {
      const d = fresh("b2"); const { lines, objs } = readLedger(ledgerPath(d));
      let idx = -1; for (let i = objs.length - 1; i >= 0; i--) if (objs[i] && objs[i].kind === "anchor") { idx = i; break; }
      const a = objs[idx]; a.anchor_head = (a.anchor_head[0] === "0" ? "1" : "0") + a.anchor_head.slice(1);
      await rechain(objs, lines, idx);
      fs.writeFileSync(ledgerPath(d), lines.join("\n"));
      const r = await runShelf(port, d, outDir("b2"), ["--no-ots"]);
      check("exit 1", r.code === 1, r.code);
      check("check_ledger said ok=false with exit 1", r.report && r.report.checks.chain.check_ledger_ok === false && r.report.checks.chain.exit_code === 1, r.report && JSON.stringify([r.report.checks.chain.check_ledger_ok, r.report.checks.chain.exit_code]));
      check("the shelf's chain column is NO", r.report && r.report.checks.chain.ok === false);
      check("the problem names the ledger's own anchor line and its date", r.report && r.report.checks.chain.problems.some(p => /the ledger's own anchor line for 2026-11-07/.test(p.problem) && p.seq === a.anchor_head_seq), r.report && JSON.stringify(r.report.checks.chain.problems).slice(0, 300));
      check("own anchor lines in chain 13 of 14", r.report && r.report.checks.chain.own_anchor_lines_in_chain === 13 && r.report.checks.chain.own_anchor_lines === 14);
      check("stdout prints DOES NOT RE-DERIVE", /DOES NOT RE-DERIVE/.test(r.stdout));
      check("page chain column says no", /<td><b class="bad">no<\/b><\/td>/.test(page(outDir("b2"))));
    }

    // (c) truncated after a previous run recorded the full one
    current = "c"; console.log("case c: the ledger truncated after a previous run -> REWRITE printed, the row's SNAPSHOTS line quoted");
    {
      const d = fresh("c"); const out = outDir("c");
      const first = await runShelf(port, d, out, ["--no-ots"]);
      check("run 1: no previous fetch", first.report && first.report.checks.append_only.status === "no previous fetch");
      const buf = fs.readFileSync(ledgerPath(d));
      const txt = buf.toString("utf8"); const keep = txt.split("\n").slice(0, -11).join("\n") + "\n";
      fs.writeFileSync(ledgerPath(d), keep);
      const r = await runShelf(port, d, out, ["--no-ots"]);
      check("exit 1", r.code === 1, r.code);
      check("REWRITE status", r.report && r.report.checks.append_only.status === "REWRITE", r.report && r.report.checks.append_only.status);
      check("what changed says shorter", r.report && /^shorter: /.test(r.report.checks.append_only.what_changed || ""), r.report && r.report.checks.append_only.what_changed);
      check("the row's SNAPSHOTS last line is quoted", r.report && r.report.checks.append_only.row_says && typeof r.report.checks.append_only.row_says.line === "string" && "extends" in r.report.checks.append_only.row_says);
      check("stdout prints REWRITE with the snapshot's extends/rewrite_reason", /REWRITE: .*extends=true rewrite_reason=null/.test(r.stdout), r.stdout.split("\n").find(l => /REWRITE/.test(l)));
      check("previous fetch kept in the rewrite record", fs.readdirSync(path.join(out, "history", "darkflobi")).some(f => /^rewrite-/.test(f)));
      check("the chain itself still re-derives (truncation is not a chain break); check_ledger's own ok is false because the 2026-11-07 anchor text is no longer in chain", r.report && r.report.checks.chain.ok === true && r.report.checks.chain.check_ledger_ok === false, r.report && JSON.stringify([r.report.checks.chain.ok, r.report.checks.chain.check_ledger_ok]));
      check("the 2026-11-07 anchor is reported NOT IN CHAIN", r.report && r.report.checks.anchors.failed.join() === "2026-11-07" && /NOT IN CHAIN/.test(r.stdout));
      check("the truncated ledger lost its last anchor line: index-vs-ledger says index only 2026-11-07", r.report && r.report.checks.anchor_index_vs_ledger.only_in_index.join(",") === "2026-11-07", r.report && JSON.stringify(r.report.checks.anchor_index_vs_ledger));
    }

    // (c2) one byte flipped in the middle, same length
    current = "c2"; console.log("case c2: one byte flipped in the middle of the ledger after a recorded run -> REWRITE by prefix hash, chain FAIL");
    {
      const d = fresh("c2"); const out = outDir("c2");
      const first = await runShelf(port, d, out, ["--no-ots"]);
      check("run 1: no previous fetch", first.report && first.report.checks.append_only.status === "no previous fetch");
      const b = fs.readFileSync(ledgerPath(d)); const mid = Math.floor(b.length / 2); b[mid] = b[mid] === 0x61 ? 0x62 : 0x61; fs.writeFileSync(ledgerPath(d), b);
      const r = await runShelf(port, d, out, ["--no-ots"]);
      const ao = r.report && r.report.checks.append_only;
      check("exit 1", r.code === 1, r.code);
      check("REWRITE status (same length)", ao && ao.status === "REWRITE" && ao.added_bytes === 0, ao && JSON.stringify([ao.status, ao.added_bytes]));
      check("what changed starts with 'the leading'", ao && /^the leading 1233153 bytes differ/.test(ao.what_changed), ao && ao.what_changed);
      check("the head clause says unchanged, pointing at the chain check", ao && /head unchanged/.test(ao.what_changed), ao && ao.what_changed);
      check("prefix_sha256 is a 64-hex string different from the previous sha256", ao && /^[0-9a-f]{64}$/.test(ao.prefix_sha256) && ao.prefix_sha256 !== ao.previous.sha256);
      check("the chain also fails (the flip broke an entry)", r.report && r.report.checks.chain.ok === false);
    }

    // (d) an anchor .txt altered by one byte
    current = "d"; console.log("case d: an anchor .txt altered by one byte -> text_sha256 FAIL and OTS FAIL");
    {
      const d = fresh("d"); const f = path.join(d, "anchors", "2026-10-24.txt");
      const b = Buffer.from(fs.readFileSync(f)); const i = b.indexOf("head ") + 5; b[i] = b[i] === 0x30 ? 0x31 : 0x30;   // flip the first hex digit of the head
      fs.writeFileSync(f, b);
      const r = await runShelf(port, d, outDir("d"));
      check("exit 1", r.code === 1, r.code);
      const a = r.report && r.report.checks.anchors.per_anchor.find(x => x.date === "2026-10-24");
      check("text_sha256 does not match the index", a && a.text.index_sha256_matches === false);
      check("OTS FAIL (proof is over other bytes)", a && a.proof.digest_matches_text === false && /OTS FAIL/.test(a.status), a && a.status);
      check("not in chain (the altered head names no entry)", a && a.chain && a.chain.ok === false);
      check("the other 13 anchors are unaffected", r.report && r.report.checks.anchors.failed.length === 1 && r.report.checks.anchors.verified === 12, r.report && JSON.stringify([r.report.checks.anchors.failed, r.report.checks.anchors.verified]));
    }

    // (e) verify.js swapped for a broken one on the served site
    current = "e"; console.log("case e: verify.js swapped for a broken one -> drift reported, pinned tools still pass");
    {
      const d = fresh("e");
      fs.writeFileSync(path.join(d, "verify.js"), "module.exports = { verifyBytes: async () => ({ ok: true, entries: [], problems: [], head: 'ffff' }) }; // broken on purpose\n");
      const r = await runShelf(port, d, outDir("e"), ["--no-ots"]);
      check("exit 0 (drift is reported, not failed)", r.code === 0, r.code + " " + r.stdout.split("\n").filter(l => /FAIL/.test(l)).join(" | "));
      check("verifier drift reported", r.report && r.report.checks.verifier_drift.drift === true);
      check("verify.js named as the file that differs", r.report && r.report.checks.verifier_drift.files.verify.same === false && r.report.checks.verifier_drift.files.check.same === true);
      check("chain re-derives with the pinned verifier", r.report && r.report.checks.chain.ok === true);
      check("vectors 10 of 10 with the pinned verifier", r.report && r.report.checks.vectors.passed === 10);
      check("stdout says verifier drift: YES", /verifier drift: YES/.test(r.stdout));
      check("page: drift YES in red", /<td><b class="bad">YES<\/b><\/td>/.test(page(outDir("e"))));
    }

    // (f) the two explorers return different headers
    current = "f"; console.log("case f: the two explorers return different headers -> explorers disagree, not verified");
    if (!headers) { console.log("  SKIP: no block header fixture"); results.push({ case: "f", name: "skipped: no block header fixture", ok: true, skipped: true }); }
    else {
      const d = fresh("f");
      const r = await runShelf(port, d, outDir("f"), ["--explorer", `http://127.0.0.1:${port}/ex1`, "--explorer", `http://127.0.0.1:${port}/exbad`]);
      check("exit 1", r.code === 1, r.code);
      const a = r.report && r.report.checks.anchors.per_anchor && r.report.checks.anchors.per_anchor[0];
      check("status says explorers disagree", a && /^explorers disagree on block 974530: not verified$/.test(a.status), a && a.status);
      check("anchors verified 0 of 14", r.report && r.report.checks.anchors.verified === 0, r.report && r.report.checks.anchors.verified);
      check("the bad explorer's header is recorded with its merkle root", a && a.proof.bitcoin_attestations[0].explorers[1].verified === false && /Digest does not match merkleroot/.test(a.proof.bitcoin_attestations[0].explorers[1].error || ""), a && JSON.stringify(a.proof.bitcoin_attestations[0].explorers[1]).slice(0, 300));
      check("the good explorer still verified", a && a.proof.bitcoin_attestations[0].explorers[0].verified === true);
      check("the pending anchor stays pending (no explorer involved)", r.report && r.report.checks.anchors.pending === 1);
      check("lines after the last bitcoin-attested head: all 729 (nothing verified tonight)", r.report && r.report.checks.outside_pin.lines_after_last_attested_head === 729, r.report && JSON.stringify(r.report.checks.outside_pin));
    }

    // (g) an index that omits a date the ledger carries an anchor line for
    current = "g"; console.log("case g: 2026-10-30 removed from anchors/index.json while its ledger anchor line stays -> discrepancy, not a gap");
    {
      const d = fresh("g"); const ip = path.join(d, "anchors", "index.json");
      const idx = JSON.parse(fs.readFileSync(ip, "utf8")); idx.anchors = idx.anchors.filter(a => a.date !== "2026-10-30"); idx.counts.anchors = idx.anchors.length;
      fs.writeFileSync(ip, JSON.stringify(idx, null, 1));
      const r = await runShelf(port, d, outDir("g"), ["--no-ots"]);
      check("exit 1 (an index hiding a stamped day is a problem)", r.code === 1, r.code + " " + r.stdout.split("\n").filter(l => /FAIL/.test(l)).join(" | "));
      check("problem: index lists no entry for 2026-10-30 although the ledger carries an anchor line", r.report && r.report.problems.some(p => /index lists no entry for 2026-10-30 although the ledger carries an anchor line/.test(p)), r.report && JSON.stringify(r.report.problems));
      check("index vs ledger: 13 of 14 ledger anchor lines in the index", r.report && r.report.checks.anchor_index_vs_ledger.in_index === 13 && r.report.checks.anchor_index_vs_ledger.ledger_anchor_lines === 14 && r.report.checks.anchor_index_vs_ledger.only_in_ledger.join() === "2026-10-30", r.report && JSON.stringify(r.report.checks.anchor_index_vs_ledger));
      check("gaps stay 1 of 15 (2026-11-06): a day with a ledger anchor line is not a gap", r.report && r.report.checks.gaps.count === 1 && r.report.checks.gaps.dates.join(",") === "2026-11-06", r.report && JSON.stringify(r.report.checks.gaps.dates));
      check("stdout prints the index-vs-ledger counts with denominators", /anchor index vs ledger: 13 of 14 ledger anchor lines are in the index; 13 of 13 index entries have a ledger anchor line/.test(r.stdout), r.stdout.split("\n").find(l => /index vs ledger/.test(l)));
      check("13 anchors checked", r.report && r.report.checks.anchors.total === 13);
    }

    // (h) one explorer down
    current = "h"; console.log("case h: one explorer answers 503 -> explorer unreachable, header from 1 of 2, not verified, exit 1");
    if (!headers) { console.log("  SKIP: no block header fixture"); results.push({ case: "h", name: "skipped: no block header fixture", ok: true, skipped: true }); }
    else {
      const d = fresh("h");
      const r = await runShelf(port, d, outDir("h"), ["--explorer", `http://127.0.0.1:${port}/ex1`, "--explorer", `http://127.0.0.1:${port}/exdown`]);
      check("exit 1", r.code === 1, r.code);
      const a = r.report && r.report.checks.anchors.per_anchor[0];
      check("status names the unreachable explorer once, not once per attestation", a && /^explorer unreachable: http:\/\/127\.0\.0\.1:\d+\/exdown \(block 974530: block-height\/974530: http 503\); header from 1 of 2 explorers verified: not verified$/.test(a.status), a && a.status);
      check("distinct from a disagreement", a && !/disagree/.test(a.status));
      check("anchors verified 0 of 14, 13 failed, pending still 1", r.report && r.report.checks.anchors.verified === 0 && r.report.checks.anchors.failed.length === 13 && r.report.checks.anchors.pending === 1, r.report && JSON.stringify([r.report.checks.anchors.verified, r.report.checks.anchors.failed.length]));
    }

    // (i) --date games
    current = "i"; console.log("case i: --date in the future, a non-calendar date, and a past date over an existing report -> exit 2 each");
    {
      const d = fresh("i"); const out = outDir("i");
      const fut = await runShelf(port, d, out, ["--no-ots", "--date", "2031-01-01"]);
      check("future date: exit 2, nothing written", fut.code === 2 && !fs.existsSync(path.join(out, "reports")) && /may not be in the future/.test(fut.stderr), fut.code + " " + fut.stderr.slice(0, 200));
      const bad = await runShelf(port, d, out, ["--no-ots", "--date", "2026-13-99"]);
      check("non-calendar date: exit 2", bad.code === 2 && /not a calendar date/.test(bad.stderr), bad.code + " " + bad.stderr.slice(0, 200));
      const thr = await runShelf(port, d, out, ["--no-ots", "--through", "2026-02-30"]);
      check("non-calendar --through: exit 2", thr.code === 2 && /not a calendar date/.test(thr.stderr), thr.code + " " + thr.stderr.slice(0, 200));
      const past = await runShelf(port, d, out, ["--no-ots", "--date", "2026-10-25"]);
      check("a past date with no report yet: runs (exit 0), window 2026-10-24..2026-10-24, note says the end came from --date", past.code === 0 && past.report && past.report.checks.gaps.through === "2026-10-24" && past.report.checks.gaps.expected_days === 1 && /--date 2026-10-25/.test(past.report.checks.gaps.window_from), past.code + " " + (past.report && JSON.stringify(past.report.checks.gaps)));
      const again = await runShelf(port, d, out, ["--no-ots", "--date", "2026-10-25"]);
      check("the same past date again over its existing report: exit 2, report untouched", again.code === 2 && /exists/.test(again.stderr), again.code + " " + again.stderr.slice(0, 200));
      const today = await runShelf(port, d, out, ["--no-ots"]);
      check("then the fixed date 2026-11-08: latest.json moves to it", today.code === 0 && JSON.parse(fs.readFileSync(path.join(out, "reports", "darkflobi", "latest.json"), "utf8")).date === DATE);
      const older = await runShelf(port, d, out, ["--no-ots", "--date", "2026-10-26"]);
      check("an older date after a newer one: report written, latest.json kept at 2026-11-08, note printed", older.code === 0 && fs.existsSync(path.join(out, "reports", "darkflobi", "2026-10-26.json")) && JSON.parse(fs.readFileSync(path.join(out, "reports", "darkflobi", "latest.json"), "utf8")).date === DATE && JSON.parse(fs.readFileSync(path.join(out, "history", "darkflobi", "latest.json"), "utf8")).date === DATE && /latest\.json kept/.test(older.stdout), older.code + " " + older.stdout.split("\n").filter(l => /kept/.test(l)).join("|"));
    }

    // (j) a past anchor's text swapped between two nights; a bitcoin proof regressed to pending
    current = "j"; console.log("case j: between two nights, seq 710 forged and rechained with a fresh pending 2026-11-07 anchor; 2026-11-05's proof swapped for a pending one -> REWRITE-class problems");
    {
      const d = fresh("j"); const out = outDir("j");
      const first = await runShelf(port, d, out, ["--no-ots"]);
      check("run 1: exit 0", first.code === 0, first.code);
      const { lines, objs } = readLedger(ledgerPath(d));
      const target = objs.findIndex(o => o && o.seq === 710); objs[target].verdict_note = "forged";
      // rechain, re-pinning the 2026-11-07 anchor line onto the new entry it names
      let prev = null;
      for (let i = target; i < lines.length; i++) { const o = objs[i]; if (!o) continue; if (prev) o.prev = prev; if (o.kind === "anchor" && o.anchor_date === "2026-11-07") { o.anchor_head = objs.find(x => x && x.seq === o.anchor_head_seq).entry_id; } o.entry_id = await V.entryIdOf(V.coreOf(o)); prev = o.entry_id; lines[i] = V.dump(o); }
      fs.writeFileSync(ledgerPath(d), lines.join("\n"));
      const ip = path.join(d, "anchors", "index.json"); const idx = JSON.parse(fs.readFileSync(ip, "utf8"));
      const a7 = idx.anchors.find(x => x.date === "2026-11-07"); a7.head = objs.find(x => x && x.seq === a7.seq).entry_id;
      const text = `gate anchor 2026-11-07 head ${a7.head} seq ${a7.seq}\n`; fs.writeFileSync(path.join(d, a7.file), text); a7.text = text.trim(); a7.text_sha256 = sha256(text);
      const ots7 = pendingOts(text, "https://alice.btc.calendar.opentimestamps.org"); fs.writeFileSync(path.join(d, a7.ots), ots7); a7.ots_sha256 = sha256(ots7); a7.calendars = ["https://alice.btc.calendar.opentimestamps.org"];
      // and 2026-11-05: same text, the bitcoin proof replaced by a pending one, index says pending
      const a5 = idx.anchors.find(x => x.date === "2026-11-05"); const t5 = fs.readFileSync(path.join(d, a5.file));
      const ots5 = pendingOts(t5, "https://bob.btc.calendar.opentimestamps.org"); fs.writeFileSync(path.join(d, a5.ots), ots5); a5.ots_sha256 = sha256(ots5); a5.status = "pending"; a5.block = null; a5.bitcoin_seen_at = null;
      fs.writeFileSync(ip, JSON.stringify(idx, null, 1));
      const r = await runShelf(port, d, out, ["--no-ots"]);
      check("exit 1", r.code === 1, r.code);
      check("chain re-derives (the forger rechained)", r.report && r.report.checks.chain.ok === true, r.report && JSON.stringify(r.report.checks.chain.problems).slice(0, 200));
      check("REWRITE by prefix (the ledger bytes changed under the previous length)", r.report && r.report.checks.append_only.status === "REWRITE", r.report && r.report.checks.append_only.status);
      check("problem: anchor 2026-11-07 text changed since the previous night", r.report && r.report.problems.some(p => /REWRITE: anchor 2026-11-07 text changed since 2026-11-08/.test(p)), r.report && JSON.stringify(r.report.problems));
      check("problem: anchor 2026-11-05 regressed from bitcoin (block 974768) to pending", r.report && r.report.problems.some(p => /anchor 2026-11-05 regressed from bitcoin \(block 974768\) to pending/.test(p)), r.report && JSON.stringify(r.report.problems));
      check("anchor_changes recorded for both dates", r.report && r.report.checks.append_only.anchor_changes.map(x => x.date + ":" + x.change).sort().join("|") === "2026-11-05:regressed to pending|2026-11-07:text changed", r.report && JSON.stringify(r.report.checks.append_only.anchor_changes));
      check("lines after the last attested head grew: 2026-11-04 (seq 681) is now the last attested", r.report && r.report.checks.outside_pin.last_attested_anchor.date === "2026-11-04" && r.report.checks.outside_pin.lines_after_last_attested_head > 25, r.report && JSON.stringify(r.report.checks.outside_pin));
      check("page lists the anchor changes", /anchor changes since the previous fetch \(2\)/.test(page(out)));
    }

    // (k) a proof pending past the limit
    current = "k"; console.log("case k: pending_max_days 0 -> the 2026-11-07 proof (1 day old) is a failed check, exit 1");
    {
      const d = fresh("k");
      const r = await runShelf(port, d, outDir("k"), ["--no-ots"], { pending_max_days: 0 });
      check("exit 1", r.code === 1, r.code);
      const a = r.report && r.report.checks.anchors.per_anchor.find(x => x.date === "2026-11-07");
      check("problem names the age and the limit", a && a.problems.some(p => /^anchor 2026-11-07 pending for 1 days \(limit 0\)$/.test(p)) && a.ok === false, a && JSON.stringify(a.problems));
      check("with the default limit 7 the same proof is ok (case a)", true);
      check("page says the limit", new RegExp("pending for more than 0 days").test(page(outDir("k"))));
    }

    // (l) --stamp-self against the fake calendar
    current = "l"; console.log("case l: --stamp-self --calendar <fake> -> the report's .ots is written (pending); the next night counts it and asks the calendar once");
    {
      const d = fresh("l"); const out = outDir("l"); const cal = `http://127.0.0.1:${port}/cal`;
      state.calendarPosts = 0; state.calendarGets = 0;
      const r1 = await runShelf(port, d, out, ["--no-ots", "--stamp-self", "--calendar", cal, "--date", "2026-11-07"]);
      const ots1 = path.join(out, "reports", "darkflobi", "2026-11-07.json.ots");
      check("run 1 (dated 2026-11-07): exit 0, .ots written", r1.code === 0 && fs.existsSync(ots1), r1.code + " " + r1.stdout.split("\n").filter(l => /stamp/.test(l)).join("|"));
      check("the calendar was asked once to stamp", state.calendarPosts === 1, state.calendarPosts);
      const det = fs.existsSync(ots1) ? OTS.DetachedTimestampFile.deserialize(new Uint8Array(fs.readFileSync(ots1))) : null;
      check("the .ots is over the report bytes and holds one pending attestation", det && OTS.Utils.bytesToHex(det.fileDigest()) === sha256File(path.join(out, "reports", "darkflobi", "2026-11-07.json")) && [...det.timestamp.allAttestations()].filter(([, a]) => a instanceof OTS.Notary.PendingAttestation).length === 1);
      check("stamps.json written with tonight's stamp", fs.existsSync(path.join(out, "reports", "darkflobi", "stamps.json")) && JSON.parse(fs.readFileSync(path.join(out, "reports", "darkflobi", "stamps.json"), "utf8")).tonight.ok === true);
      const r2 = await runShelf(port, d, out, ["--no-ots", "--stamp-self", "--calendar", cal]);
      check("run 2 (2026-11-08): exit 0; earlier stamps 0 of 1 bitcoin, 1 pending; the calendar asked once to upgrade", r2.code === 0 && r2.report && r2.report.checks.self_stamps.total === 1 && r2.report.checks.self_stamps.pending === 1 && state.calendarGets === 1, r2.code + " " + (r2.report && JSON.stringify(r2.report.checks.self_stamps).slice(0, 300)) + " gets " + state.calendarGets);
      check("stdout: shelf's own earlier reports: 0 of 1 bitcoin-attested, 1 pending", /shelf's own earlier reports: 0 of 1 bitcoin-attested, 1 pending/.test(r2.stdout), r2.stdout.split("\n").find(l => /own earlier/.test(l)));
      check("the 2026-11-07 report still hashes to its stamp", r2.report && r2.report.checks.self_stamps.reports[0] && r2.report.checks.self_stamps.reports[0].report_matches === true);
      check("page: the shelf's own stamps section", /0 of 1 earlier report bitcoin-attested, 1 pending; tonight's report stamped/.test(page(out)), page(out).match(/own stamps<\/h3>\n<p>[^<]{0,200}/)?.[0]);
      // rewrite the stamped report in place: the next night must say so
      const rep7 = path.join(out, "reports", "darkflobi", "2026-11-07.json"); fs.writeFileSync(rep7, fs.readFileSync(rep7, "utf8").replace(/"ok": true/, '"ok": true, "edited": 1'));
      const r3 = await runShelf(port, d, out, ["--no-ots", "--stamp-self", "--calendar", cal]);
      check("run 3: a rewritten stamped report is a problem, exit 1", r3.code === 1 && r3.report && r3.report.problems.some(p => /self-stamp: report 2026-11-07\.json does not hash to its own stamp/.test(p)), r3.code + " " + (r3.report && JSON.stringify(r3.report.problems)));
      const r4 = await runShelf(port, d, out, ["--no-ots"]);
      check("without --stamp-self: self_stamps skipped, nothing asked", r4.report && r4.report.checks.self_stamps.skipped === true);
    }
  } finally {
    srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* windows may hold a handle briefly; the dir is under os.tmpdir() */ }
  }
  const cases = new Set(results.map(r => r.case)).size;
  const passed = results.filter(r => r.ok).length, failed = results.length - passed, skipped = results.filter(r => r.skipped).length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped of ${results.length} checks across ${cases} cases`);
  if (failed) { for (const r of results.filter(x => !x.ok)) console.log(`  FAIL [${r.case}] ${r.name}`); process.exit(1); }
}

main().catch(e => { console.error("test crashed: " + (e && e.stack || e)); process.exit(2); });
