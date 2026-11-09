#!/usr/bin/env node
/* test_shelf_read.mjs — node --test test/test_shelf_read.mjs (or node test/test_shelf_read.mjs)

   the outside-ledger leg: shelf_read.cjs against a local http server (no network), the report's shape against
   docs/outside_report_schema.json and against what the census scorer checks of it (styxx-ledger census.py, _shelf),
   the register's append-only rule, the vendored v1 files against VENDORED.json, the browser loader against node's
   require on the same bytes, and the page section that shelf.mjs --page-only writes.

   fixtures: test/fixtures/v1 (the kit's conformance base at 838a003, vector anchor-present, and its rewrite-one-field
   copy; FIXTURES.json says how) and test/fixtures/site (the shelf's existing v0 fixture). */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const DOCS = path.join(REPO, "docs");
const require = createRequire(import.meta.url);
const CORE = require(path.join(DOCS, "shelf_core.js"));
const V0 = require(path.join(REPO, "tools", "verify.js"));
const V1 = require(path.join(DOCS, "v1", "verify.js"));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(DOCS, "outside_report_schema.json"), "utf8"));
const FX1 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "v1", "FIXTURES.json"), "utf8"));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ---- a json-schema subset validator (type, enum, const, pattern, minimum, required, properties, additionalProperties false, items)
function validate(schema, v, at = "$") {
  const errs = [];
  const typeOf = (x) => x === null ? "null" : Array.isArray(x) ? "array" : Number.isInteger(x) ? "integer" : typeof x;
  if (schema.type) {
    const ts = [].concat(schema.type), t = typeOf(v);
    if (!ts.includes(t) && !(t === "integer" && ts.includes("number"))) { errs.push(`${at}: type ${t}, want ${ts.join("|")}`); return errs; }
  }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(schema.enum)}`);
  if ("const" in schema && v !== schema.const) errs.push(`${at}: ${JSON.stringify(v)} is not ${JSON.stringify(schema.const)}`);
  if (schema.pattern && typeof v === "string" && !new RegExp(schema.pattern).test(v)) errs.push(`${at}: ${JSON.stringify(v).slice(0, 80)} does not match ${schema.pattern}`);
  if (schema.minimum !== undefined && typeof v === "number" && v < schema.minimum) errs.push(`${at}: ${v} < ${schema.minimum}`);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of schema.required || []) if (!(k in v)) errs.push(`${at}: ${k} missing`);
    for (const k of Object.keys(v)) {
      if (schema.properties && schema.properties[k]) errs.push(...validate(schema.properties[k], v[k], `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: ${k} is not in the schema`);
    }
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)));
  return errs;
}

// ---- what the census scorer checks of a shelf report (styxx-ledger python/src/styxx_ledger/census.py, _shelf,
// lines 1160-1188 as read on 2026-11-09): the fetched report's sha256 equals the pasted one (1175, after 1174: it answered); the body names
// the registered ledger_url (1178) and the registered earliest_anchor text (1179), both as substrings of the body;
// the read time parses (1182, parse_timestamp: YYYY-MM-DDTHH:MM:SSZ) and falls at or after 00:00 of the day after the
// anchor's date in anchor_tz (1183-1187); read_before_d0 (1188) is the operator's d0, not the report's. earliest_anchor_holds (1181) is the scorer's own chain check, run here with
// the verifier on the same ledger bytes.
function midnightUtcAfter(date, tz) {   // 00:00 of date+1 in tz, as epoch ms
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  const off = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t; };
  return guess - off(guess - off(guess));
}
function scorerChecks({ reportBytes, pastedSha, ledgerUrl, earliestAnchor, at, tz, holds }) {
  const body = reportBytes.toString("utf8");
  const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at) ? Date.parse(at) : NaN;
  const date = (/ anchor (\d{4}-\d{2}-\d{2}) head /.exec(earliestAnchor) || [])[1];
  return {
    report_sha256: sha256(reportBytes) === pastedSha,
    names_ledger_url: !!ledgerUrl && body.includes(ledgerUrl),
    names_earliest_anchor_and_its_head: !!earliestAnchor && body.includes(earliestAnchor),
    earliest_anchor_holds: holds,
    read_after_the_anchors_day_ended: !!date && !isNaN(t) && t >= midnightUtcAfter(date, tz)
  };
}

// ---- the local server: /fx/<path> serves the fixtures dir, /place/<date>.txt answers the anchor text from a map,
// /blank serves a page with no anchor, /gone answers 404
let srv, base, places = {};
function start() {
  return new Promise((resolve) => {
    srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1"), p = decodeURIComponent(u.pathname);
      const send = (code, body) => { res.writeHead(code, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end(body); };
      if (p.startsWith("/fx/")) {
        const f = path.join(HERE, "fixtures", ...p.slice(4).split("/"));
        if (!f.startsWith(path.join(HERE, "fixtures")) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, "not found");
        return send(200, fs.readFileSync(f));
      }
      const m = /^\/place\/(\d{4}-\d{2}-\d{2})\.txt$/.exec(p);
      if (m) return places[m[1]] ? send(200, places[m[1]] + "\n") : send(404, "no post");
      if (p === "/blank") return send(200, "<html><body>a page with no anchor on it</body></html>");
      // withheld.json in the kit's other accepted form, {"withheld": [...]}, and a form neither accepts
      if (p === "/wrap/site-withheld.json") return send(200, JSON.stringify({ withheld: JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "site", "withheld.json"), "utf8")) }));
      if (p === "/wrap/empty-withheld.json") return send(200, JSON.stringify({ withheld: [] }));
      if (p === "/wrap/not-a-list.json") return send(200, JSON.stringify({ lines: [] }));
      return send(404, "not found");
    });
    srv.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${srv.address().port}`; resolve(); });
  });
}
function run(args) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(REPO, "shelf_read.cjs"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    ch.stdout.on("data", d => { stdout += d; }); ch.stderr.on("data", d => { stderr += d; });
    ch.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "styxx-shelf-read-test-"));
let n = 0;
async function readTo(args, name) {
  const out = path.join(tmp, "out-" + (++n));
  const r = await run([...args, "--name", name, "--out", out]);
  const latest = path.join(out, name + ".json");
  const reads = path.join(out, "reads", name);
  const once = fs.existsSync(reads) ? path.join(reads, fs.readdirSync(reads)[0]) : null;
  return { ...r, out, latestPath: latest, oncePath: once, report: fs.existsSync(latest) ? JSON.parse(fs.readFileSync(latest, "utf8")) : null };
}

before(start);
after(() => { srv.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* windows may hold a handle */ } });

describe("fixtures and vendored files", () => {
  test("VENDORED.json: every file's sha256 and byte count are the file's", () => {
    const v = JSON.parse(fs.readFileSync(path.join(DOCS, "v1", "VENDORED.json"), "utf8"));
    assert.equal(v.kit_repo, "https://github.com/fathom-lab/styxx-ledger");
    assert.equal(v.kit_commit, "838a003");
    assert.deepEqual(v.files.map(f => f.path).sort(), ["LICENSE", "chain.js", "day.js", "jcs.js", "verify.js"]);
    for (const f of v.files) {
      const b = fs.readFileSync(path.join(DOCS, "v1", f.path));
      assert.equal(sha256(b), f.sha256, f.path);
      assert.equal(b.length, f.bytes, f.path);
    }
  });
  test("docs/v0/verify.js is the shelf's pinned tools/verify.js byte for byte", () => {
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO, "tools", "PINNED.json"), "utf8"));
    assert.equal(sha256(fs.readFileSync(path.join(DOCS, "v0", "verify.js"))), pinned.files["tools/verify.js"].sha256);
  });
  test("v1 fixtures hash to the kit vectors' input_sha256", () => {
    for (const [f, d] of Object.entries(FX1.files)) assert.equal(sha256(fs.readFileSync(path.join(HERE, "fixtures", "v1", f))), d.sha256, f);
  });
  test("the vendored verifier answers the two vectors as the kit's file says", () => {
    const good = V1.verifyBytesSync(fs.readFileSync(path.join(HERE, "fixtures", "v1", "ledger.jsonl")));
    assert.equal(good.ok, true); assert.equal(good.entries.length, 59); assert.equal(good.head, FX1.files["ledger.jsonl"].expect.head);
    const bad = V1.verifyBytesSync(fs.readFileSync(path.join(HERE, "fixtures", "v1", "ledger_broken.jsonl")));
    assert.equal(bad.ok, false);
    assert.deepEqual(CORE.problemCodes("v1", bad.problems), ["entry_id"]);
    assert.deepEqual(bad.problems.map(p => p.seq), [20]);
  });
});

describe("shelf_read on a v1 ledger (local server)", () => {
  const texts = FX1.files["ledger.jsonl"].anchor_texts;
  test("the valid ledger: re-derives, 59 lines, head, anchors 5 of 5 holding, earliest 2026-10-31 seq 9 found at its place", async () => {
    places = { "2026-10-31": texts[0] };
    const r = await readTo(["--url", `${base}/fx/v1/ledger.jsonl`, "--protocol", "v1", "--place-url", `${base}/place/{date}.txt`], "kitbot");
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const rep = r.report;
    assert.deepEqual(Object.keys(rep), CORE.REPORT_KEYS);
    assert.deepEqual(validate(SCHEMA, rep), []);
    assert.equal(rep.protocol, "v1");
    assert.equal(rep.bytes, fs.statSync(path.join(HERE, "fixtures", "v1", "ledger.jsonl")).size);
    assert.equal(rep.sha256, FX1.files["ledger.jsonl"].sha256);
    assert.equal(rep.lines, 59);
    assert.equal(rep.head, FX1.files["ledger.jsonl"].expect.head);
    assert.deepEqual(rep.rederives, { ok: true, problem_codes: [], problems: 0, withheld_lines: 0 });
    assert.equal(rep.implementations.python, "not run by the shelf");
    assert.match(rep.implementations.javascript, /^re-derives \(styxx-ledger js\/lib\/verify\.js at 838a003/);
    assert.equal(rep.anchors.count, 5); assert.equal(rep.anchors.holding, 5);
    const e = rep.anchors.earliest;
    assert.equal(e.date, "2026-10-31"); assert.equal(e.seq, 9); assert.equal(e.text, texts[0]); assert.equal(e.text_sha256, sha256(texts[0])); assert.equal(e.holds, true);
    assert.deepEqual(e.place_check, { result: "found", url: `${base}/place/2026-10-31.txt`, http_status: 200 });
    // the kept copy is the latest's bytes
    assert.equal(fs.readFileSync(r.oncePath, "utf8"), fs.readFileSync(r.latestPath, "utf8"));
    assert.equal(path.basename(r.oncePath), rep.read_at.replace(/:/g, "-") + ".json");
    // stdout names the kept copy and its sha256
    assert.ok(r.stdout.includes(sha256(fs.readFileSync(r.oncePath))), r.stdout);
  });
  test("counts only: no line's text is in the report (every note value of the ledger is absent)", async () => {
    places = { "2026-10-31": texts[0] };
    const r = await readTo(["--url", `${base}/fx/v1/ledger.jsonl`, "--protocol", "v1"], "kitbot");
    const body = fs.readFileSync(r.latestPath, "utf8");
    const notes = fs.readFileSync(path.join(HERE, "fixtures", "v1", "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(o => typeof o.note === "string").map(o => o.note);
    assert.ok(notes.length > 0);
    for (const t of notes) assert.ok(!body.includes(JSON.stringify(t)), "a note's text is in the report: " + t.slice(0, 40));
    assert.equal(r.report.anchors.earliest.place_check.result, "not_checked");
  });
  test("the broken copy: does not re-derive, problem code entry_id, exit 1", async () => {
    const r = await readTo(["--url", `${base}/fx/v1/ledger_broken.jsonl`, "--protocol", "v1"], "kitbot-broken");
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(validate(SCHEMA, r.report), []);
    assert.equal(r.report.rederives.ok, false);
    assert.deepEqual(r.report.rederives.problem_codes, ["entry_id"]);
    assert.equal(r.report.rederives.problems, 1);
    assert.equal(r.report.sha256, FX1.files["ledger_broken.jsonl"].sha256);
    assert.match(r.report.implementations.javascript, /^does not re-derive/);
  });
  test("withheld.json as {\"withheld\": []} (the kit's other form): re-derives, exit 0; an object with no withheld array: withheld_not_a_list, exit 1", async () => {
    let r = await readTo(["--url", `${base}/fx/v1/ledger.jsonl`, "--protocol", "v1", "--withheld-url", `${base}/wrap/empty-withheld.json`], "kb-wrap");
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.deepEqual(r.report.rederives, { ok: true, problem_codes: [], problems: 0, withheld_lines: 0 });
    r = await readTo(["--url", `${base}/fx/v1/ledger.jsonl`, "--protocol", "v1", "--withheld-url", `${base}/wrap/not-a-list.json`], "kb-notlist");
    assert.equal(r.code, 1);
    assert.deepEqual(r.report.rederives.problem_codes, ["withheld_not_a_list"]);
  });
  test("unwrapWithheld: a bare array, {withheld: [...]}, and anything else", () => {
    assert.deepEqual(CORE.unwrapWithheld([{ seq: 1 }]), { list: [{ seq: 1 }], code: null });
    assert.deepEqual(CORE.unwrapWithheld({ withheld: [{ seq: 2 }] }), { list: [{ seq: 2 }], code: null });
    for (const x of [null, 3, "x", {}, { withheld: {} }]) assert.deepEqual(CORE.unwrapWithheld(x), { list: [], code: "withheld_not_a_list" }, JSON.stringify(x));
  });
  test("place: not_found on a page without the text, could_not_read with the status on a 404", async () => {
    let r = await readTo(["--url", `${base}/fx/v1/ledger.jsonl`, "--protocol", "v1", "--place-url", `${base}/blank`], "kb-a");
    assert.deepEqual(r.report.anchors.earliest.place_check, { result: "not_found", url: `${base}/blank`, http_status: 200 });
    places = {};
    r = await readTo(["--url", `${base}/fx/v1/ledger.jsonl`, "--protocol", "v1", "--place-url", `${base}/place/{date}.txt`], "kb-b");
    assert.deepEqual(r.report.anchors.earliest.place_check, { result: "could_not_read", url: `${base}/place/2026-10-31.txt`, http_status: 404 });
  });
  test("a v0 ledger read as v1: no_header, exit 1", async () => {
    const r = await readTo(["--url", `${base}/fx/site/ledger.jsonl`, "--protocol", "v1"], "wrong-proto");
    assert.equal(r.code, 1);
    assert.ok(r.report.rederives.problem_codes.includes("no_header"), JSON.stringify(r.report.rederives));
  });
  test("a ledger url that answers 404: unreachable, bytes 0, sha256 null, exit 1, shape holds", async () => {
    const r = await readTo(["--url", `${base}/fx/v1/nothing.jsonl`, "--protocol", "v1"], "gone");
    assert.equal(r.code, 1);
    assert.deepEqual(validate(SCHEMA, r.report), []);
    assert.equal(r.report.bytes, 0); assert.equal(r.report.sha256, null);
    assert.deepEqual(r.report.rederives.problem_codes, ["unreachable"]);
    assert.equal(r.report.rederives.http_status, 404);
    assert.equal(r.report.anchors.earliest, null);
  });
  test("deterministic for fixed bytes except read_at and shelf_commit", async () => {
    places = { "2026-10-31": texts[0] };
    const args = ["--url", `${base}/fx/v1/ledger.jsonl`, "--protocol", "v1", "--place-url", `${base}/place/{date}.txt`];
    const a = await readTo(args, "det"); await new Promise(r => setTimeout(r, 1100)); const b = await readTo(args, "det");
    const strip = (x) => { const o = JSON.parse(JSON.stringify(x)); delete o.read_at; delete o.shelf_commit; return JSON.stringify(o, null, 1); };
    assert.equal(strip(a.report), strip(b.report));
  });
});

describe("shelf_read on a v0 ledger (the shelf's existing fixture)", () => {
  let expect;
  before(async () => {
    const withheld = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "site", "withheld.json"), "utf8"));
    expect = await V0.verifyBytes(new Uint8Array(fs.readFileSync(path.join(HERE, "fixtures", "site", "ledger.jsonl"))), { withheld });
  });
  test("with withheld.json: re-derives, lines and head as the pinned verifier says, anchors 14 of 14, earliest 2026-10-24 seq 57 found", async () => {
    const r = await readTo(["--url", `${base}/fx/site/ledger.jsonl`, "--protocol", "v0", "--withheld-url", `${base}/fx/site/withheld.json`, "--place-url", `${base}/fx/site/anchors/{date}.txt`], "dfx");
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const rep = r.report;
    assert.deepEqual(validate(SCHEMA, rep), []);
    assert.equal(rep.lines, expect.entries.length);
    assert.equal(rep.lines, 729);
    assert.equal(rep.head, expect.head);
    assert.equal(rep.rederives.ok, true); assert.equal(rep.rederives.withheld_lines, 5);
    assert.match(rep.implementations.javascript, /^re-derives \(the shelf's pinned tools\/verify\.js/);
    assert.equal(rep.anchors.count, 14); assert.equal(rep.anchors.holding, 14);
    const e = rep.anchors.earliest;
    assert.equal(e.date, "2026-10-24"); assert.equal(e.seq, 57);
    assert.equal(e.text, fs.readFileSync(path.join(HERE, "fixtures", "site", "anchors", "2026-10-24.txt"), "utf8").replace(/\s+$/, ""));
    assert.equal(e.place_check.result, "found"); assert.equal(e.place_check.http_status, 200);
  });
  test("withheld.json wrapped as {\"withheld\": [...]}: the same report as the bare array (5 withheld lines bridged, same head)", async () => {
    const a = await readTo(["--url", `${base}/fx/site/ledger.jsonl`, "--protocol", "v0", "--withheld-url", `${base}/fx/site/withheld.json`], "dfx-bare");
    const b = await readTo(["--url", `${base}/fx/site/ledger.jsonl`, "--protocol", "v0", "--withheld-url", `${base}/wrap/site-withheld.json`], "dfx-wrap");
    assert.equal(b.code, 0, b.stderr + b.stdout);
    assert.equal(b.report.rederives.withheld_lines, 5); assert.equal(b.report.head, a.report.head);
    assert.deepEqual(b.report.rederives, a.report.rederives);
  });
  test("without withheld.json the bridged lines break the chain (prev / seq), exit 1", async () => {
    const r = await readTo(["--url", `${base}/fx/site/ledger.jsonl`, "--protocol", "v0"], "dfx-nowh");
    assert.equal(r.code, 1);
    assert.equal(r.report.rederives.ok, false);
    assert.ok(r.report.rederives.problem_codes.includes("prev") || r.report.rederives.problem_codes.includes("seq"), JSON.stringify(r.report.rederives));
  });
  test("v0 problem sentences map onto the v1 code vocabulary", () => {
    assert.equal(CORE.v0Code("entry_id does not re-derive from the core"), "entry_id");
    assert.equal(CORE.v0Code("the log holds a CR byte; lines are LF"), "cr_byte");
    assert.equal(CORE.v0Code("seq is 3, expected 2"), "seq");
    assert.equal(CORE.v0Code("something new"), "other");
  });
});

describe("what the census scorer checks of the report (census.py _shelf, lines 1160-1188)", () => {
  test("a v1 read passes every check the scorer makes of a shelf report", async () => {
    const texts = FX1.files["ledger.jsonl"].anchor_texts;
    places = { "2026-10-31": texts[0] };
    const ledgerUrl = `${base}/fx/v1/ledger.jsonl`;
    const r = await readTo(["--url", ledgerUrl, "--protocol", "v1", "--place-url", `${base}/place/{date}.txt`], "census");
    const bytes = fs.readFileSync(r.oncePath);
    const line = `shelf read: ${base}/reports/reads/census/${path.basename(r.oncePath)} sha256 ${sha256(bytes)} at ${r.report.read_at}`;
    const m = /^[ \t]*shelf read: (\S+) sha256 ([0-9a-f]{64}) at (\S+)[ \t]*$/m.exec(line);   // census.py SHELF_RX, line 108
    assert.ok(m, line);
    const hold = V1.checkAnchor(V1.verifyBytesSync(fs.readFileSync(path.join(HERE, "fixtures", "v1", "ledger.jsonl"))).entries, V1.parseAnchorText(texts[0]), [], V1.verifyBytesSync(fs.readFileSync(path.join(HERE, "fixtures", "v1", "ledger.jsonl"))).header).ok;
    const c = scorerChecks({ reportBytes: bytes, pastedSha: m[2], ledgerUrl, earliestAnchor: texts[0], at: m[3], tz: "America/New_York", holds: hold });
    assert.deepEqual(c, { report_sha256: true, names_ledger_url: true, names_earliest_anchor_and_its_head: true, earliest_anchor_holds: true, read_after_the_anchors_day_ended: true });
    // and the same checks fail when they should: the latest copy after another read, a wrong ledger url, a later anchor
    assert.equal(scorerChecks({ reportBytes: Buffer.concat([bytes, Buffer.from(" ")]), pastedSha: m[2], ledgerUrl, earliestAnchor: texts[0], at: m[3], tz: "America/New_York", holds: true }).report_sha256, false);
    assert.equal(scorerChecks({ reportBytes: bytes, pastedSha: m[2], ledgerUrl: ledgerUrl + "x", earliestAnchor: texts[0], at: m[3], tz: "America/New_York", holds: true }).names_ledger_url, false);
    assert.equal(scorerChecks({ reportBytes: bytes, pastedSha: m[2], ledgerUrl, earliestAnchor: texts[1], at: m[3], tz: "America/New_York", holds: true }).names_earliest_anchor_and_its_head, false);
    assert.equal(scorerChecks({ reportBytes: bytes, pastedSha: m[2], ledgerUrl, earliestAnchor: texts[0], at: "2026-10-31T23:00:00Z", tz: "America/New_York", holds: true }).read_after_the_anchors_day_ended, false);
  });
  test("the midnight helper: 00:00 2026-11-01 new york is 04:00z (edt), 00:00 2026-11-02 is 05:00z (est)", () => {
    assert.equal(new Date(midnightUtcAfter("2026-10-31", "America/New_York")).toISOString(), "2026-11-01T04:00:00.000Z");
    assert.equal(new Date(midnightUtcAfter("2026-11-01", "America/New_York")).toISOString(), "2026-11-02T05:00:00.000Z");
  });
});

describe("the register", () => {
  const reg = JSON.parse(fs.readFileSync(path.join(DOCS, "outside_ledgers.json"), "utf8"));
  test("docs/outside_ledgers.json holds its own rules: two v0 rows (darkflobi, red), both written by the lab, no v1 row", () => {
    assert.deepEqual(CORE.checkRegister(reg), []);
    assert.deepEqual(reg.rows.map(r => r.name + ":" + r.protocol + ":" + r.written_by), ["darkflobi:v0:lab", "red:v0:lab"]);
    for (const r of reg.rows) for (const k of ["name", "protocol", "ledger_url", "anchor_place", "written_by", "added_at", "added_by", "note"]) assert.ok(k in r, r.name + " " + k);
    assert.deepEqual(CORE.registerCounts(reg), { rows: 2, lab: 2, outside_read: 0, v1: 0, withdrawn: 0 });
    assert.equal(CORE.registerHeading(reg), "ledgers read by url — 2 rows, 2 of 2 the lab's own; outside ledgers read: 0; v1 rows 0 of 2; withdrawn 0 of 2");
  });
  test("written_by is required and is lab or outside; an outside row counts as an outside ledger read until withdrawn", () => {
    const n = JSON.parse(JSON.stringify(reg));
    delete n.rows[0].written_by; n.rows[1].written_by = "someone";
    const bad = CORE.checkRegister(n).join("; ");
    assert.match(bad, /darkflobi\): written_by missing/); assert.match(bad, /red\): written_by is not "lab" or "outside"/);
    const o = JSON.parse(JSON.stringify(reg));
    o.rows.push({ name: "stranger", protocol: "v1", ledger_url: "https://example.github.io/l/ledger.jsonl", withheld_url: null, anchor_place: null, written_by: "outside", added_at: "2026-11-10", added_by: "fathom lab", note: "" });
    assert.deepEqual(CORE.checkRegister(o), []);
    assert.deepEqual(CORE.registerCounts(o), { rows: 3, lab: 2, outside_read: 1, v1: 1, withdrawn: 0 });
    o.rows[2].withdrawn_at = "2026-11-11";
    assert.equal(CORE.registerCounts(o).outside_read, 0);
  });
  // every committed version of the register, oldest first, each consecutive pair checked, then the last commit
  // against the working copy (null when the file is not there): -> list of problems, empty when the history holds
  function registerHistoryProblems(repoDir, working) {
    const git = (args) => spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
    const log = git(["log", "--reverse", "--format=%H", "--", "docs/outside_ledgers.json"]);
    if (log.status !== 0) return ["git log failed: " + log.stderr.trim()];
    const bad = [];
    const versions = [];
    for (const c of log.stdout.split(/\r?\n/).filter(Boolean)) {
      const g = git(["show", c + ":docs/outside_ledgers.json"]);
      if (g.status !== 0) { bad.push(c.slice(0, 7) + ": the register was removed (withdraw rows instead)"); continue; }
      versions.push({ c, reg: JSON.parse(g.stdout) });
    }
    for (let i = 1; i < versions.length; i++) for (const p of CORE.checkRegisterAppendOnly(versions[i - 1].reg, versions[i].reg)) bad.push(versions[i - 1].c.slice(0, 7) + " -> " + versions[i].c.slice(0, 7) + ": " + p);
    if (versions.length && working) for (const p of CORE.checkRegisterAppendOnly(versions[versions.length - 1].reg, working)) bad.push("last commit -> working copy: " + p);
    return bad;
  }
  test("append-only across every commit of the register: each consecutive pair in git log, then the last commit against the working copy", () => {
    assert.deepEqual(registerHistoryProblems(REPO, reg), []);
  });
  test("the history walk catches a committed row edit, a committed removal, and passes a committed append and withdrawal", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "git-"));
    const git = (...a) => { const g = spawnSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }); assert.equal(g.status, 0, a.join(" ") + ": " + g.stderr); return g; };
    git("init", "-q");
    fs.mkdirSync(path.join(dir, "docs"));
    const put = (r, msg) => { fs.writeFileSync(path.join(dir, "docs", "outside_ledgers.json"), JSON.stringify(r, null, 1) + "\n"); git("add", "docs/outside_ledgers.json"); git("commit", "-q", "-m", msg); };
    const v1 = JSON.parse(JSON.stringify(reg));
    put(v1, "two rows");
    const v2 = JSON.parse(JSON.stringify(v1)); v2.rows.push({ name: "stranger", protocol: "v1", ledger_url: "https://example.github.io/l/ledger.jsonl", withheld_url: null, anchor_place: null, written_by: "outside", added_at: "2026-11-10", added_by: "fathom lab", note: "" });
    put(v2, "append a row");
    const v3 = JSON.parse(JSON.stringify(v2)); v3.rows[2].withdrawn_at = "2026-11-11";
    put(v3, "withdraw it");
    assert.deepEqual(registerHistoryProblems(dir, v3), []);
    const v4 = JSON.parse(JSON.stringify(v3)); v4.rows[0].ledger_url = "https://example.org/other.jsonl";
    put(v4, "edit a row in place");
    // the working copy equals the last commit, so a HEAD-vs-working comparison sees nothing; the walk does
    const p = registerHistoryProblems(dir, v4);
    assert.equal(p.length, 1, JSON.stringify(p)); assert.match(p[0], /-> [0-9a-f]{7}: row 0 \(darkflobi\): ledger_url changed/);
    const v5 = JSON.parse(JSON.stringify(v4)); v5.rows.pop();
    put(v5, "remove a row");
    assert.ok(registerHistoryProblems(dir, v5).some(x => /a row was removed/.test(x)));
  });
  test("append-only rule: append and withdraw pass; edit, remove, reorder and re-date a withdrawal fail", () => {
    const clone = () => JSON.parse(JSON.stringify(reg));
    const row = { name: "stranger", protocol: "v1", ledger_url: "https://example.github.io/l/ledger.jsonl", withheld_url: null, anchor_place: { kind: "a public channel", url: null }, written_by: "outside", added_at: "2026-11-10", added_by: "fathom lab", note: "asked on 2026-11-10" };
    let n = clone(); n.rows.push(row);
    assert.deepEqual(CORE.checkRegisterAppendOnly(reg, n), []); assert.deepEqual(CORE.checkRegister(n), []);
    const w = clone(); w.rows[1].withdrawn_at = "2026-11-11"; w.rows[1].withdrawn_why = "its url stopped answering";
    assert.deepEqual(CORE.checkRegisterAppendOnly(reg, w), []); assert.deepEqual(CORE.checkRegister(w), []);
    n = clone(); n.rows[0].ledger_url = "https://example.org/other.jsonl";
    assert.match(CORE.checkRegisterAppendOnly(reg, n).join(), /ledger_url changed/);
    n = clone(); n.rows.pop();
    assert.match(CORE.checkRegisterAppendOnly(reg, n).join(), /a row was removed/);
    n = clone(); n.rows.reverse();
    assert.ok(CORE.checkRegisterAppendOnly(reg, n).length > 0);
    const w2 = JSON.parse(JSON.stringify(w)); w2.rows[1].withdrawn_at = "2026-11-12";
    assert.match(CORE.checkRegisterAppendOnly(w, w2).join(), /withdrawn_at changed/);
    n = clone(); n.rows.push(JSON.parse(JSON.stringify(n.rows[0])));
    assert.match(CORE.checkRegister(n).join(), /appears twice/);
  });
  test("shelf_read --row reads from the register and refuses a withdrawn row (exit 2)", async () => {
    const texts = FX1.files["ledger.jsonl"].anchor_texts;
    places = { "2026-10-31": texts[0] };
    const r2 = { schema: CORE.REGISTER_SCHEMA, rules: "test", rows: [
      { name: "kit", protocol: "v1", ledger_url: `http://127.0.0.1:1/x`, withheld_url: null, anchor_place: null, written_by: "outside", added_at: "2026-11-09", added_by: "test", note: "" },
      { name: "kitbot", protocol: "v1", ledger_url: `${base}/fx/v1/ledger.jsonl`, withheld_url: null, anchor_place: { kind: "a test place", url: `${base}/place/{date}.txt` }, written_by: "outside", added_at: "2026-11-09", added_by: "test", note: "" }
    ] };
    r2.rows[0].withdrawn_at = "2026-11-09";
    const p = path.join(tmp, "register.json"); fs.writeFileSync(p, JSON.stringify(r2));
    const out = path.join(tmp, "out-row");
    const ok = await run(["--row", "kitbot", "--register", p, "--out", out]);
    assert.equal(ok.code, 0, ok.stderr);
    const rep = JSON.parse(fs.readFileSync(path.join(out, "kitbot.json"), "utf8"));
    assert.equal(rep.ledger_url, `${base}/fx/v1/ledger.jsonl`);
    assert.equal(rep.anchors.earliest.place_check.result, "found");
    const wd = await run(["--row", "kit", "--register", p, "--out", out]);
    assert.equal(wd.code, 2); assert.match(wd.stderr, /withdrawn at 2026-11-09/);
    const none = await run(["--row", "missing", "--register", p, "--out", out]);
    assert.equal(none.code, 2);
  });
});

describe("the browser loader (docs/v1/load.js)", () => {
  function sandbox(tamper) {
    const fakeFetch = async (url) => {
      const rel = String(url).replace(/^v1\//, "");
      const f = path.join(DOCS, "v1", rel);
      if (!fs.existsSync(f)) return { ok: false, status: 404 };
      let b = fs.readFileSync(f);
      if (tamper && rel === tamper) b = Buffer.concat([b, Buffer.from("\n// changed\n")]);
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), json: async () => JSON.parse(b.toString("utf8")) };
    };
    // one realm, as in a browser: `self` and `fetch` are handed in; node has no `require` or `module` in this scope
    const ctx = {};
    new Function("self", "fetch", "require", "module", "exports", fs.readFileSync(path.join(DOCS, "v1", "load.js"), "utf8"))(ctx, fakeFetch, undefined, undefined, undefined);
    return ctx;
  }
  test("its sha256 is sha256", () => {
    const ctx = sandbox();
    for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "ünïcode"]) assert.equal(ctx.ShelfV1.sha256Hex(s), sha256(Buffer.from(s, "utf8")));
  });
  test("loads the vendored files after checking their hashes and answers as node's require does", async () => {
    const ctx = sandbox();
    const L = await ctx.ShelfV1.load("v1/");
    assert.equal(L.checked.length, 4); assert.ok(L.checked.every(c => c.matches));
    for (const f of ["ledger.jsonl", "ledger_broken.jsonl"]) {
      const b = new Uint8Array(fs.readFileSync(path.join(HERE, "fixtures", "v1", f)));
      const a = await CORE.readLedger({ protocol: "v1", bytes: b, withheld: [], verifier: L.verify });
      const n = await CORE.readLedger({ protocol: "v1", bytes: b, withheld: [], verifier: V1 });
      assert.equal(JSON.stringify(a), JSON.stringify(n), f);
    }
  });
  test("refuses to run a file that does not hash to VENDORED.json", async () => {
    const ctx = sandbox("chain.js");
    await assert.rejects(ctx.ShelfV1.load("v1/"), /chain\.js hashes to [0-9a-f]{64}, VENDORED\.json says/);
  });
});

describe("the committed reports in docs/reports", () => {
  test("every register row's report (when present) holds the schema, names the row's url, and equals its kept copy", () => {
    const reg = JSON.parse(fs.readFileSync(path.join(DOCS, "outside_ledgers.json"), "utf8"));
    for (const row of reg.rows) {
      const p = path.join(DOCS, "reports", row.name + ".json");
      if (!fs.existsSync(p)) continue;
      const rep = JSON.parse(fs.readFileSync(p, "utf8"));
      assert.deepEqual(Object.keys(rep), CORE.REPORT_KEYS, row.name);
      assert.deepEqual(validate(SCHEMA, rep), [], row.name);
      assert.equal(rep.ledger_url, row.ledger_url);
      assert.equal(rep.protocol, row.protocol);
      const once = path.join(DOCS, "reports", "reads", row.name, rep.read_at.replace(/:/g, "-") + ".json");
      assert.ok(fs.existsSync(once), "kept copy missing for " + row.name);
      assert.equal(fs.readFileSync(once, "utf8"), fs.readFileSync(p, "utf8"), row.name);
    }
  });
});

describe("the page", () => {
  test("the readme says (c) cannot hold until the kit flips SHELF_HAS_V1_ROW, and who wrote the register's ledgers", () => {
    const r = fs.readFileSync(path.join(REPO, "README.md"), "utf8").replace(/\s+/g, " ");
    assert.ok(r.includes("until a styxx-ledger commit sets `census.SHELF_HAS_V1_ROW`, the census scorer prints condition (c) as \"stated, unverified\" and no window opens"));
    assert.ok(r.includes("2 of 2 the lab's own v0 ledgers (darkflobi, red); outside ledgers read: 0; v1 rows 0 of 2"));
  });
  test("shelf.mjs --page-only writes the outside ledgers section: every register row, its committed report, the kit commit and hashes, no script", () => {
    const out = path.join(tmp, "page");
    fs.cpSync(DOCS, out, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(REPO, "shelf.mjs"), "--page-only", "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    const sec = html.slice(html.indexOf('<section id="outside">'));
    assert.ok(sec.length > 100);
    assert.ok(!/<script/i.test(html));
    const reg = JSON.parse(fs.readFileSync(path.join(out, "outside_ledgers.json"), "utf8"));
    for (const row of reg.rows) { assert.ok(sec.includes(`id="outside-${row.name}"`), row.name); assert.ok(sec.includes(`outside.html#${row.name}`), row.name); }
    assert.ok(sec.includes("<h2>ledgers read by url — 2 rows, 2 of 2 the lab&#39;s own; outside ledgers read: 0; v1 rows 0 of 2; withdrawn 0 of 2</h2>"), "the section heading");
    assert.ok(!/<h2>outside ledgers/.test(sec), "the heading must not call the lab's ledgers outside ones");
    assert.ok(sec.includes("written by the lab"));
    assert.ok(sec.includes("until a styxx-ledger commit sets census.SHELF_HAS_V1_ROW, the census scorer prints condition (c) as &quot;stated, unverified&quot; and no window opens"));
    assert.match(sec, /the shelf is the lab's/);
    assert.match(sec, /read by the lab's shelf/);
    const v = JSON.parse(fs.readFileSync(path.join(out, "v1", "VENDORED.json"), "utf8"));
    assert.ok(sec.includes(v.kit_commit) && v.files.every(f => sec.includes(f.sha256)));
    assert.ok(!/independent|provably|no one|nobody|breakthrough|\bfirst\b|honest|truth/i.test(sec), "a banned word in the section");
    assert.equal((html.match(/independent/g) || []).length, 1);
  });
  test("outside.html says whose shelf it is, the could-not-read line, and loads the verifiers it shows", () => {
    const h = fs.readFileSync(path.join(DOCS, "outside.html"), "utf8");
    assert.match(h, /the shelf is the lab's/);
    assert.match(h, /read by the lab's shelf/);
    assert.match(h, /could not read: the host did not allow a cross-origin read, or it is offline/);
    assert.match(h, /could not read: the ledger url answered http /);
    assert.match(h, /<h1>styxx shelf — ledgers read by url, re-derived in your browser<\/h1>/);
    assert.ok(!/outside ledgers, re-derived/.test(h));
    assert.ok(h.includes('until a styxx-ledger commit sets census.SHELF_HAS_V1_ROW, the census scorer prints condition (c) as "stated, unverified" and no window opens'));
    assert.ok(h.includes('var SHELF_HOME = "https://fathom-lab.github.io/styxx-shelf/";') && !h.includes("new URL(onceRel, location.href)"), "the section 15 line names the published host");
    assert.ok(h.includes("ShelfCore.unwrapWithheld("), "the browser unwraps withheld.json as the kit does");
    assert.match(h, /re-derive now in your browser/);
    for (const s of ["shelf_core.js", "v0/verify.js", "v1/load.js"]) assert.ok(h.includes(`<script src="${s}"></script>`), s);
    assert.ok(!/provably|no one|nobody|breakthrough|\bfirst\b/i.test(h));
  });
});

// ---- the 2026-11-09 improvement sweep: the page's sentence on where reports ran (rank 1), the staleness line
// (rank 34), outside.html's opening sentence (rank 40), and the refusal of a protocol the shelf does not know (rank 58)
describe("2026-11-09: where reports ran, how old a read is, a plain opening, an unknown protocol refused", () => {
  const pageOnly = (out) => spawnSync(process.execPath, [path.join(REPO, "shelf.mjs"), "--page-only", "--out", out], { encoding: "utf8" });
  const flat = (h) => h.replace(/\s+/g, " ");
  const v2row = { name: "vtwo", protocol: "v2", ledger_url: "https://example.org/vtwo/ledger.jsonl", withheld_url: null, anchor_place: null, written_by: "outside", added_at: "2026-11-09", added_by: "test", note: "a protocol the shelf does not know" };

  test("protocolRefusal: null for v0 and v1; a refusal sentence for anything else, and readLedger throws it", async () => {
    assert.equal(CORE.protocolRefusal("v0"), null);
    assert.equal(CORE.protocolRefusal("v1"), null);
    for (const p of ["v2", "V1", "", null, undefined, 1]) assert.match(CORE.protocolRefusal(p), /^refused: protocol .* is not v0 or v1; the shelf reads no row whose protocol it does not know, and guesses no verifier for it$/, String(p));
    await assert.rejects(CORE.readLedger({ protocol: "v2", bytes: new Uint8Array(0), withheld: [], verifier: V0 }), /refused: protocol "v2"/);
  });

  test("ageText: minutes, hours, days; null when unreadable or backwards", () => {
    assert.equal(CORE.ageText("2026-11-08T21:27:15Z", "2026-11-09T06:26:01Z"), "8 h 58 min");
    assert.equal(CORE.ageText("2026-11-09T06:26:01Z", "2026-11-09T06:30:59Z"), "4 min");
    assert.equal(CORE.ageText("2026-11-07T06:00:00Z", "2026-11-09T07:05:00Z"), "2 d 1 h 5 min");
    assert.equal(CORE.ageText("2026-11-09T06:00:00Z", "2026-11-09T05:00:00Z"), null);
    assert.equal(CORE.ageText("not a time", "2026-11-09T05:00:00Z"), null);
  });

  // the refusal is CORE.checkRegister's rule: one unknown-protocol row refuses the whole register, so every row's read
  // fails (exit 2), the v0 rows too. read()'s own guard in shelf_read.cjs is not reachable from the cli.
  test("shelf_read refuses the whole register when one row has an unknown protocol (exit 2 for that row and for a v0 row), writes nothing", async () => {
    const reg = JSON.parse(fs.readFileSync(path.join(DOCS, "outside_ledgers.json"), "utf8"));
    reg.rows.push(v2row);
    const p = path.join(tmp, "register-v2.json"); fs.writeFileSync(p, JSON.stringify(reg));
    for (const name of ["vtwo", "red"]) {
      const out = path.join(tmp, "out-v2-" + name);
      const r = await run(["--row", name, "--register", p, "--out", out]);
      assert.equal(r.code, 2, name);
      assert.match(r.stderr, /the register does not hold its own rules: .*protocol is not v0 or v1/, name);
      assert.ok(!fs.existsSync(out), "nothing written for " + name);
    }
  });

  test("the page refuses an unknown protocol row in its place: no report, no browser link, not in the staleness line", () => {
    const out = path.join(tmp, "page-v2");
    fs.cpSync(DOCS, out, { recursive: true });
    const reg = JSON.parse(fs.readFileSync(path.join(out, "outside_ledgers.json"), "utf8"));
    reg.rows.push(v2row);
    fs.writeFileSync(path.join(out, "outside_ledgers.json"), JSON.stringify(reg));
    // a report file under that name must not be shown: the view refuses the row, it does not guess a verifier for it
    fs.writeFileSync(path.join(out, "reports", "vtwo.json"), fs.readFileSync(path.join(out, "reports", "red.json")));
    const r = pageOnly(out);
    assert.equal(r.status, 0, r.stderr);
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    const tr = html.slice(html.indexOf('<tr id="outside-vtwo">'), html.indexOf("</tr>", html.indexOf('<tr id="outside-vtwo">')));
    assert.ok(tr.length > 0);
    assert.ok(tr.includes("refused: protocol &quot;v2&quot; is not v0 or v1"), tr);
    assert.ok(!tr.includes("outside.html#vtwo") && !tr.includes("re-derives") && !tr.includes("reports/reads/vtwo"), tr);
    const how = html.slice(html.indexOf("<p>how old each read is:"), html.indexOf("</p>", html.indexOf("<p>how old each read is:")));
    assert.ok(how.includes("darkflobi: read") && !how.includes("vtwo"), how);
  });

  test("outside.html refuses an unknown protocol row (run in a stub page): refusal text, no button; a v0 row keeps its button", async () => {
    const h = fs.readFileSync(path.join(DOCS, "outside.html"), "utf8");
    assert.ok(!/: window\.LedgerVerify;/.test(h), "the verifier choice must not fall through to v0 for any protocol");
    const js = h.slice(h.lastIndexOf("<script>") + "<script>".length, h.lastIndexOf("</script>"));
    const reg = JSON.parse(fs.readFileSync(path.join(DOCS, "outside_ledgers.json"), "utf8"));
    const twoRows = { ...reg, rows: [reg.rows[0], v2row] };
    const served = { "outside_ledgers.json": Buffer.from(JSON.stringify(twoRows)) };
    const fakeFetch = async (url) => {
      const rel = String(url);
      let b = served[rel];
      if (!b && !/^https?:/.test(rel) && fs.existsSync(path.join(DOCS, rel))) b = fs.readFileSync(path.join(DOCS, rel));
      if (!b) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
    };
    const stub = () => ({ innerHTML: "", textContent: "", children: [], appendChild(c) { this.children.push(c); }, addEventListener() {}, querySelector(q) { return this["q:" + q] || (this["q:" + q] = stub()); } });
    const els = { counts: stub(), vendored: stub(), rows: stub() };
    const document = { getElementById: (id) => els[id], createElement: () => stub() };
    const ShelfV1 = { load: () => Promise.reject(new Error("not loaded in this test")), sha256Hex: () => "" };
    new Function("window", "document", "fetch", "ShelfCore", "ShelfV1", js)({ crypto: globalThis.crypto, LedgerVerify: V0 }, document, fakeFetch, CORE, ShelfV1);
    for (let i = 0; i < 300 && els.rows.children.length < 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(els.rows.children.length, 2);
    const [v0sec, v2sec] = els.rows.children;
    assert.equal(v2sec.id, "vtwo");
    assert.match(v2sec.innerHTML, /refused: protocol &quot;v2&quot; is not v0 or v1/);
    assert.ok(!/<button>/.test(v2sec.innerHTML), "no button on a refused row");
    assert.ok(/<button>/.test(v0sec.innerHTML), "the v0 row keeps its button");
    assert.match(v0sec.innerHTML, /how old: read \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z, (\d+ d )?(\d+ h )?\d+ min before this page was opened \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z, this browser's clock\)/);
  });

  test("index.html: the opening says built to run nightly, the workflow is not here, every report a local run, with counts from disk", () => {
    const out = path.join(tmp, "page-where");
    fs.cpSync(DOCS, out, { recursive: true });
    const r = pageOnly(out);
    assert.equal(r.status, 0, r.stderr);
    const html = flat(fs.readFileSync(path.join(out, "index.html"), "utf8"));
    assert.ok(html.includes("<h1>styxx shelf — a re-derivation built to run somewhere that is not the box</h1>"));
    assert.ok(!html.includes("every night a github action fetches"), "the old sentence");
    assert.ok(!html.includes("the re-derivation runs somewhere that is not the box"), "the old heading");
    const nightly = fs.readdirSync(path.join(out, "reports")).filter(d => d !== "reads" && fs.statSync(path.join(out, "reports", d)).isDirectory())
      .flatMap(d => fs.readdirSync(path.join(out, "reports", d)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)));
    const reads = fs.readdirSync(path.join(out, "reports", "reads")).flatMap(d => fs.readdirSync(path.join(out, "reports", "reads", d)));
    const wf = fs.existsSync(path.join(REPO, ".github", "workflows", "shelf.yml"));
    assert.match(html, /as of \d{4}-\d{2}-\d{2} no report here came from that action/);
    if (!wf) assert.ok(html.includes("the workflow is not in this repository yet (the operator adds it)"));
    assert.ok(html.includes(`every report so far is a local run from the lab's box — ${nightly.length} of ${nightly.length} nightly report`), "counts from disk");
    assert.ok(html.includes(`the ${reads.length} read${reads.length === 1 ? "" : "s"} by url kept under reports/reads/`));
    const reg = JSON.parse(fs.readFileSync(path.join(out, "outside_ledgers.json"), "utf8"));
    assert.ok(html.includes(` · 1 nightly row · ${reg.rows.length} rows read by url · `), "the header names both kinds of row");
    assert.ok(html.includes("every read here so far was written when the lab ran"));
  });

  test("index.html: once a report from the action is on disk, the opening says so with the count", () => {
    const out = path.join(tmp, "page-action");
    fs.cpSync(DOCS, out, { recursive: true });
    const rep = JSON.parse(fs.readFileSync(path.join(out, "reports", "darkflobi", "2026-11-08.json"), "utf8"));
    rep.date = "2026-11-09"; rep.ran_on = { where: "github actions", run_url: "https://github.com/fathom-lab/styxx-shelf/actions/runs/1", run_id: "1", run_attempt: "1", sha: "0".repeat(40), runner_os: "Linux" };
    fs.writeFileSync(path.join(out, "reports", "darkflobi", "2026-11-09.json"), JSON.stringify(rep));
    const r = pageOnly(out);
    assert.equal(r.status, 0, r.stderr);
    const html = flat(fs.readFileSync(path.join(out, "index.html"), "utf8"));
    assert.ok(html.includes("a github action runs every night to fetch each row"));
    assert.ok(html.includes("of the 2 nightly reports on disk, 1 ran in the action and 1 were local runs from the lab's box"));
    assert.ok(!html.includes("no report here came from that action"));
  });

  test("index.html: how old each read is, against the page's written time and the nightly row's count, and a dirty-tree read marked", () => {
    const out = path.join(tmp, "page-age");
    fs.cpSync(DOCS, out, { recursive: true });
    const r = pageOnly(out);
    assert.equal(r.status, 0, r.stderr);
    const html = flat(fs.readFileSync(path.join(out, "index.html"), "utf8"));
    const written = html.match(/<p>written (\S+) · /)[1];
    const night = JSON.parse(fs.readFileSync(path.join(out, "reports", "darkflobi", "latest.json"), "utf8"));
    const reg = JSON.parse(fs.readFileSync(path.join(out, "outside_ledgers.json"), "utf8"));
    for (const row of reg.rows) {
      const rep = JSON.parse(fs.readFileSync(path.join(out, "reports", row.name + ".json"), "utf8"));
      let s = `${row.name}: read ${rep.read_at}, ${CORE.ageText(rep.read_at, written)} before this page was written, ${rep.lines} lines`;
      if (row.ledger_url === night.base + "ledger.jsonl") s += `; the nightly row darkflobi read the same url at ${night.run_started_at} and counted ${night.checks.chain.lines} lines, ${CORE.ageText(night.run_started_at, rep.read_at)} before this read (+${rep.lines - night.checks.chain.lines} lines from the earlier count to the later: the ledger grows`;
      assert.ok(html.includes(s), s);
      const dirty = /uncommitted changes present/.test(rep.shelf_commit);
      const after = html.slice(html.indexOf(s) + s.length, html.indexOf(s) + s.length + 400).split(/\. [a-z]+: read /)[0];
      assert.equal(after.includes("read from a shelf checkout with uncommitted changes"), dirty, row.name);
    }
  });

  test("index.html: a later read with fewer lines than the earlier nightly count is a red line, never 'the ledger grows'", () => {
    const out = path.join(tmp, "page-fewer");
    fs.cpSync(DOCS, out, { recursive: true });
    const rep = JSON.parse(fs.readFileSync(path.join(out, "reports", "darkflobi.json"), "utf8"));
    const lp = path.join(out, "reports", "darkflobi", "latest.json");
    const night = JSON.parse(fs.readFileSync(lp, "utf8"));
    assert.ok(Date.parse(rep.read_at) > Date.parse(night.run_started_at), "fixture: the read is later than the nightly run");
    night.checks.chain.lines = rep.lines + 113;
    fs.writeFileSync(lp, JSON.stringify(night, null, 1));
    const r = pageOnly(out);
    assert.equal(r.status, 0, r.stderr);
    const html = flat(fs.readFileSync(path.join(out, "index.html"), "utf8"));
    assert.ok(html.includes(`counted ${rep.lines + 113} lines`));
    assert.ok(html.includes('(<b class="bad">fewer lines at the later time (-113 from the earlier count): growth does not explain it</b>)'));
    assert.ok(!html.includes("the ledger grows"));
    // equal counts still read as growth (zero lines added)
    night.checks.chain.lines = rep.lines;
    fs.writeFileSync(lp, JSON.stringify(night, null, 1));
    assert.equal(pageOnly(out).status, 0);
    const h2 = flat(fs.readFileSync(path.join(out, "index.html"), "utf8"));
    assert.ok(h2.includes("(+0 lines from the earlier count to the later: the ledger grows"));
    assert.ok(!h2.includes("fewer lines at the later time"));
  });

  test("outside.html opens with a plain sentence of what a reader can check, before anything else", () => {
    const h = fs.readFileSync(path.join(DOCS, "outside.html"), "utf8");
    const afterH1 = h.slice(h.indexOf("</h1>") + 5).trimStart();
    assert.ok(afterH1.startsWith(`<p id="what">what you can check here: press a row's button`), afterH1.slice(0, 120));
    assert.ok(afterH1.includes("<code>node shelf_read.cjs --row &lt;name&gt;</code>"));
  });

  test("the readme says the workflow is not in the repository and every report so far is a local run, dated", () => {
    const r = fs.readFileSync(path.join(REPO, "README.md"), "utf8").replace(/\s+/g, " ");
    assert.ok(r.includes("**as of 2026-11-09 the workflow is not in this repository and every report so far is a local run from the lab's box**"));
    assert.ok(!r.includes("the re-derivation runs somewhere that is not the box. every night a github action"));
    assert.ok(!r.includes("the nightly workflow runs shelf.mjs and does not write them"));
  });

  test("the readme's operator setup lists only what remains (no repo create or push) and says shelf_read refuses the whole register", () => {
    const r = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
    const setup = r.slice(r.indexOf("## the operator's setup")).replace(/\s+/g, " ");
    assert.ok(setup.startsWith("## the operator's setup done by the lab on 2026-11-08: this repository was created and pushed"));
    assert.ok(!setup.includes("gh repo create") && !setup.includes("git init") && !setup.includes("git push"));
    assert.ok(setup.includes("github_for_operator/shelf_dot_github/workflows/shelf.yml"));
    assert.ok(setup.includes("github.com/organizations/fathom-lab/settings/actions"));
    const flatR = r.replace(/\s+/g, " ");
    assert.ok(flatR.includes("shelf_read refuses the whole register (exit 2 for every row's read"));
    assert.ok(!flatR.includes("is refused by shelf_read (exit 2), by the page"));
  });
});
