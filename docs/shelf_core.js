/* shelf_core.js — what the shelf reads off a register row's ledger bytes, one code path for node (shelf_read.cjs)
   and the browser (outside.html). no network and no file access here: the caller fetches, this file counts.

     readLedger({protocol: "v0" | "v1", bytes: Uint8Array, withheld: array | null, verifier})
       -> {lines, head, rederives: {ok, problem_codes, problems}, anchors: {count, holding, list}}

   v1: verifier is the kit's verify.js (docs/v1, vendored from styxx-ledger 838a003). v0: verifier is the shelf's
   pinned tools/verify.js (docs/v0/verify.js is the same bytes). `lines` counts the entries after the header (the
   published lines; a withheld line is not one). an anchor is the ledger's own anchor entry: its text is composed
   from the entry (v1 "<agent> anchor <date> head <hex> seq <n>", v0 "gate anchor <date> head <hex> seq <n>") and
   checked with the verifier's own checkAnchor; `holds` is that answer. nothing here returns a line's text.

   register rules (checkRegister, checkRegisterAppendOnly): rows are appended, never edited or removed; a row taken
   off the shelf gets `withdrawn_at` (and may get `withdrawn_why`) and stays. */
(function (root, factory) {
  if (typeof module === "object" && module && module.exports) module.exports = factory();
  else root.ShelfCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var REGISTER_SCHEMA = "styxx-shelf/outside_ledgers/v0";
  var ROW_KEYS = ["name", "protocol", "ledger_url", "withheld_url", "anchor_place", "written_by", "added_at", "added_by", "note"];
  // who wrote the ledger a row names: "lab" (the lab's own agents and examples) or "outside" (an operator outside the lab)
  var WRITERS = ["lab", "outside"];
  var ROW_OPTIONAL = ["withheld_url", "withdrawn_at", "withdrawn_why"];
  var REPORT_KEYS = ["shelf_commit", "read_at", "ledger_url", "bytes", "sha256", "protocol", "lines", "head", "rederives", "implementations", "anchors"];

  // v0's verifier writes a sentence per problem; the shelf reads it into the v1 code vocabulary (PROTOCOL_v1 section 4)
  var V0_CODES = [
    [/CR byte/, "cr_byte"], [/^unparsable/, "unparsable"], [/^not an object/, "not_object"],
    [/not the canonical dump/, "not_canonical"], [/^no header/, "no_header"], [/^core not canonicalisable/, "core_not_canonical"],
    [/^schema is not/, "schema"], [/^entry_id does not/, "entry_id"], [/^prev does not/, "prev"], [/^seq is /, "seq"],
    [/^day does not|^timestamp unreadable/, "day"]
  ];
  function v0Code(text) {
    for (var i = 0; i < V0_CODES.length; i++) if (V0_CODES[i][0].test(String(text))) return V0_CODES[i][1];
    return "other";
  }
  function problemCodes(protocol, problems) {
    var set = {};
    (problems || []).forEach(function (p) {
      if (protocol === "v1") {
        if (p.code) set[p.code] = 1;
        (p.codes || []).forEach(function (c) { set[c] = 1; });
      } else {
        if (p.problem) set[v0Code(p.problem)] = 1;
        (p.problems || []).forEach(function (t) { set[v0Code(t)] = 1; });
      }
    });
    return Object.keys(set).sort();
  }

  function cmpAnchor(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq; }

  async function readLedger(o) {
    var V = o.verifier, protocol = o.protocol, withheld = Array.isArray(o.withheld) ? o.withheld : [];
    if (protocol !== "v0" && protocol !== "v1") throw new Error("protocol must be v0 or v1");
    var r = protocol === "v1" ? V.verifyBytesSync(o.bytes, { withheld: withheld }) : await V.verifyBytes(o.bytes, { withheld: withheld });
    var agent = protocol === "v1" && r.header && typeof r.header.agent === "string" ? r.header.agent : null;
    var list = [];
    for (var i = 0; i < r.entries.length; i++) {
      var e = r.entries[i].entry;
      if (!e || e.kind !== "anchor") continue;
      var date = e.anchor_date, head = e.anchor_head, seq = e.anchor_head_seq, text = null;
      try { text = protocol === "v1" ? V.anchorText(agent, date, head, seq) : V.anchorText(date, head, seq); } catch (err) { text = null; }
      var item = { date: typeof date === "string" ? date : null, seq: typeof seq === "number" ? seq : null, line_seq: e.seq, text: text, text_sha256: null, sha256_matches_entry: false, holds: false };
      if (text !== null) {
        item.text_sha256 = await V.sha256Hex(text);
        item.sha256_matches_entry = item.text_sha256 === e.anchor_text_sha256;
        var a = V.parseAnchorText(text);
        var ck = a ? (protocol === "v1" ? V.checkAnchor(r.entries, a, withheld, r.header) : V.checkAnchor(r.entries, a, withheld)) : { ok: false };
        item.holds = !!ck.ok && item.sha256_matches_entry;
      }
      list.push(item);
    }
    list.sort(function (x, y) { return cmpAnchor({ date: x.date || "", seq: x.seq || 0 }, { date: y.date || "", seq: y.seq || 0 }); });
    var codes = problemCodes(protocol, r.problems);
    return {
      lines: r.entries.length,
      head: r.head,
      rederives: { ok: r.ok === true, problem_codes: codes, problems: r.problems.length },
      anchors: { count: list.length, holding: list.filter(function (x) { return x.holds; }).length, list: list }
    };
  }

  /* the earliest anchor that holds, else the earliest there is, else null */
  function earliestAnchor(list) {
    var holding = (list || []).filter(function (x) { return x.holds; });
    return holding[0] || (list || [])[0] || null;
  }

  /* an anchor place url may carry {date}: the anchor's date goes in its place */
  function placeUrl(place, date) {
    if (!place || typeof place.url !== "string" || !place.url) return null;
    return place.url.split("{date}").join(date || "");
  }
  /* found / not_found / could_not_read, given what the fetch returned */
  function placeVerdict(status, bodyText, anchorText) {
    if (bodyText === null || bodyText === undefined || !(status >= 200 && status < 300)) return "could_not_read";
    return String(bodyText).indexOf(anchorText) >= 0 ? "found" : "not_found";
  }

  // ---- the register
  function isDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(s); }
  function checkRow(row, i) {
    var bad = [], at = "row " + i + (row && row.name ? " (" + row.name + ")" : "");
    if (!row || typeof row !== "object" || Array.isArray(row)) return [at + ": not an object"];
    Object.keys(row).forEach(function (k) { if (ROW_KEYS.indexOf(k) < 0 && ROW_OPTIONAL.indexOf(k) < 0) bad.push(at + ": key " + k + " is not a register key"); });
    ROW_KEYS.forEach(function (k) { if (ROW_OPTIONAL.indexOf(k) < 0 && !Object.prototype.hasOwnProperty.call(row, k)) bad.push(at + ": " + k + " missing"); });
    if (typeof row.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(row.name)) bad.push(at + ": name is not [a-z0-9_-], 1-32 chars");
    if (row.protocol !== "v0" && row.protocol !== "v1") bad.push(at + ": protocol is not v0 or v1");
    if (typeof row.ledger_url !== "string" || !/^https?:\/\//.test(row.ledger_url)) bad.push(at + ": ledger_url is not an http(s) url");
    if (row.withheld_url !== undefined && row.withheld_url !== null && (typeof row.withheld_url !== "string" || !/^https?:\/\//.test(row.withheld_url))) bad.push(at + ": withheld_url is not null or an http(s) url");
    if (row.anchor_place !== null) {
      var p = row.anchor_place;
      if (!p || typeof p !== "object" || typeof p.kind !== "string" || !p.kind || !(p.url === null || (typeof p.url === "string" && /^https?:\/\//.test(p.url)))) bad.push(at + ": anchor_place is not null or {kind, url}");
      else Object.keys(p).forEach(function (k) { if (k !== "kind" && k !== "url") bad.push(at + ": anchor_place key " + k); });
    }
    if (WRITERS.indexOf(row.written_by) < 0) bad.push(at + ": written_by is not \"lab\" or \"outside\"");
    if (!isDate(row.added_at)) bad.push(at + ": added_at is not a date");
    if (typeof row.added_by !== "string" || !row.added_by) bad.push(at + ": added_by missing");
    if (typeof row.note !== "string") bad.push(at + ": note is not a string");
    if (row.withdrawn_at !== undefined && !isDate(row.withdrawn_at)) bad.push(at + ": withdrawn_at is not a date");
    return bad;
  }
  function checkRegister(reg) {
    var bad = [];
    if (!reg || reg.schema !== REGISTER_SCHEMA) bad.push("schema is not " + REGISTER_SCHEMA);
    if (!reg || !Array.isArray(reg.rows)) return bad.concat(["rows is not a list"]);
    var seen = {};
    reg.rows.forEach(function (r, i) {
      bad = bad.concat(checkRow(r, i));
      if (r && typeof r.name === "string") { if (seen[r.name]) bad.push("row " + i + ": name " + r.name + " appears twice"); seen[r.name] = 1; }
    });
    return bad;
  }
  /* the counts every heading about the register prints: rows, the lab's own, outside ledgers read (not withdrawn),
     v1 rows, withdrawn */
  function registerCounts(reg) {
    var R = reg && Array.isArray(reg.rows) ? reg.rows : [];
    return {
      rows: R.length,
      lab: R.filter(function (r) { return r.written_by === "lab"; }).length,
      outside_read: R.filter(function (r) { return r.written_by === "outside" && !r.withdrawn_at; }).length,
      v1: R.filter(function (r) { return r.protocol === "v1"; }).length,
      withdrawn: R.filter(function (r) { return !!r.withdrawn_at; }).length
    };
  }
  /* "ledgers read by url — 2 rows, 2 of 2 the lab's own; outside ledgers read: 0; v1 rows 0 of 2; withdrawn 0 of 2" */
  function registerHeading(reg) {
    var c = registerCounts(reg);
    return "ledgers read by url — " + c.rows + " row" + (c.rows === 1 ? "" : "s") + ", " + c.lab + " of " + c.rows + " the lab's own; outside ledgers read: " + c.outside_read + "; v1 rows " + c.v1 + " of " + c.rows + "; withdrawn " + c.withdrawn + " of " + c.rows;
  }
  /* withheld.json as the kit reads it (styxx-ledger js/bin/styxx-ledger.cjs loadWithheld): a bare array, or an object
     whose withheld is an array. -> {list, code}: code is null, or "withheld_not_a_list" */
  function unwrapWithheld(w) {
    if (Array.isArray(w)) return { list: w, code: null };
    if (w && typeof w === "object" && Array.isArray(w.withheld)) return { list: w.withheld, code: null };
    return { list: [], code: "withheld_not_a_list" };
  }
  /* until a styxx-ledger commit sets census.SHELF_HAS_V1_ROW, the census scorer prints condition (c) as "stated,
     unverified" and no window opens: said on the readme, the shelf page and outside.html */
  var SCORER_GATE = "until a styxx-ledger commit sets census.SHELF_HAS_V1_ROW, the census scorer prints condition (c) as \"stated, unverified\" and no window opens: a section 15 line pasted today is printed back by the scorer, not fetched and not checked.";

  /* next may only append rows, and add withdrawn_at / withdrawn_why to a row that has none */
  function checkRegisterAppendOnly(prev, next) {
    var bad = [];
    var P = prev && Array.isArray(prev.rows) ? prev.rows : [], N = next && Array.isArray(next.rows) ? next.rows : [];
    if (N.length < P.length) bad.push("rows went from " + P.length + " to " + N.length + ": a row was removed (withdraw it instead)");
    for (var i = 0; i < Math.min(P.length, N.length); i++) {
      var a = P[i], b = N[i], keys = {};
      Object.keys(a).concat(Object.keys(b)).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        var same = JSON.stringify(a[k]) === JSON.stringify(b[k]);
        if (same) return;
        var addedWithdrawal = (k === "withdrawn_at" || k === "withdrawn_why") && a[k] === undefined && b[k] !== undefined;
        if (!addedWithdrawal) bad.push("row " + i + " (" + a.name + "): " + k + " changed");
      });
    }
    return bad;
  }

  return {
    REGISTER_SCHEMA: REGISTER_SCHEMA, REPORT_KEYS: REPORT_KEYS, ROW_KEYS: ROW_KEYS, WRITERS: WRITERS, SCORER_GATE: SCORER_GATE,
    registerCounts: registerCounts, registerHeading: registerHeading, unwrapWithheld: unwrapWithheld,
    readLedger: readLedger, earliestAnchor: earliestAnchor, problemCodes: problemCodes, v0Code: v0Code,
    placeUrl: placeUrl, placeVerdict: placeVerdict,
    checkRegister: checkRegister, checkRegisterAppendOnly: checkRegisterAppendOnly
  };
});
