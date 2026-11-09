"use strict";
/* chain.js: the chain of protocol v1 (sections 1, 3, 4, 5): header, entry composition, reading, checking,
   anchor text. Synchronous (node:crypto); verify.js wraps the exhibit-compatible promise API around it.

     core(entry)    = every key of the entry except entry_id
     entry_id       = sha256( JCS(core) )                         64 lowercase hex
     header_digest  = sha256( "styxx.ledger/log/v1" LF JCS(header) )
     entry_1.prev   = header_digest; entry_k.prev = entry_{k-1}.entry_id
     entry_k.seq    = entry_{k-1}.seq + 1; entry_1.seq = 1
     head           = the last entry's entry_id, or header_digest when there is no entry

   Problem records carry `line`, `seq` (an integer, or null for a reading or header problem), and either
   `code` + `problem` (a reading problem) or `codes` + `problems` (one entry's list, or a header record).
   Codes: cr_byte, unparsable, not_object, not_canonical, no_header, header_kinds; per entry: core_not_canonical,
   schema, kind_not_declared, entry_id, prev, seq, day. (duplicate_key is the python reader's alone: JSON.parse
   keeps the last of two equal keys, and this reader flags that line's bytes as not_canonical; PROTOCOL 4.) */
const crypto = require("node:crypto");
const { MAX_INT, LedgerValueError, checkValue, depthExceeds, dump, jcs, hasLoneSurrogate, isPlainObject, setOwn, own } = require("./jcs");
const { TIMESTAMP_RX, parseTimestamp, checkZone, dayOf, lateOf } = require("./day");

const LOG_SCHEMA = "styxx.ledger/log/v1";
const ENTRY_SCHEMA = "styxx.ledger/entry/v1";
const V0_LOG_SCHEMA = "darkflobi.gate/log/v0";
const HEADER_DOMAIN = LOG_SCHEMA + "\n";
const HEADER_KEYS = ["agent", "anchor_tz", "certifies", "created", "kinds", "schema"];
const REQUIRED_KINDS = ["anchor", "started"];
const RESERVED_FIELDS = ["schema", "seq", "prev", "kind", "timestamp", "day", "entry_id"];
const ANCHOR_FIELDS = ["anchor_date", "anchor_head", "anchor_head_seq", "anchor_text_sha256", "late"];
const AGENT_RX = /^[a-z0-9_-]{1,32}$/;
const KIND_RX = /^[a-z][a-z0-9_]{0,31}$/;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const HEX64_RX = /^[0-9a-f]{64}$/;
const ANCHOR_RX = /^([a-z0-9_-]{1,32}) anchor (\d{4}-\d{2}-\d{2}) head ([0-9a-f]{64}) seq (0|[1-9][0-9]*)\n?$/;

const enc = new TextEncoder();
// fatal: invalid UTF-8 is unparsable; ignoreBOM: a BOM stays in the text, so JSON.parse refuses it as python does
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isInt(v) { return typeof v === "number" && Number.isInteger(v); }
/* A withheld list's seq: an integral number with |n| <= 2^53 (10.0 and 10 are one number), else null (section 6). */
function asSeq(v) { return isInt(v) && Math.abs(v) <= MAX_INT ? v : null; }
function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("hex");
}

function coreOf(entry) {
  const c = {};
  for (const k of Object.keys(entry)) if (k !== "entry_id") setOwn(c, k, entry[k]);
  return c;
}
/* sha256(JCS(core)). Given an entry that carries entry_id, that key is left out first. */
function entryId(core) {
  const c = Object.prototype.hasOwnProperty.call(core || {}, "entry_id") ? coreOf(core) : core;
  return sha256Hex(jcs(c));
}
/* Domain-separated, so a header never passes as an entry. */
function headerDigest(header) { return sha256Hex(HEADER_DOMAIN + jcs(header)); }

// ------------------------------------------------------------------------------------------ writing side

/* Refuse (code header_form, timestamp or anchor_tz) a header a v1 writer may not write. */
function checkHeader(header) {
  const bad = msg => { throw new LedgerValueError("header_form", msg); };
  if (!isPlainObject(header)) bad("header is not an object");
  const keys = Object.keys(header);
  const extra = keys.filter(k => !HEADER_KEYS.includes(k)).sort();
  const missing = HEADER_KEYS.filter(k => !keys.includes(k));
  if (extra.length || missing.length) bad("header keys: missing " + JSON.stringify(missing) + ", not allowed " + JSON.stringify(extra));
  if (header.schema !== LOG_SCHEMA) bad("header schema is not " + LOG_SCHEMA);
  if (typeof header.created !== "string" || !TIMESTAMP_RX.test(header.created)) bad("created is not YYYY-MM-DDTHH:MM:SSZ");
  parseTimestamp(header.created);
  checkZone(header.anchor_tz);
  if (typeof header.agent !== "string" || !AGENT_RX.test(header.agent)) bad("agent is not 1-32 chars of [a-z0-9_-]");
  const c = header.certifies;
  if (typeof c !== "string" || !c.trim() || c.includes("\n") || Array.from(c).length > 500) {
    bad("certifies is not one sentence (a non-empty line of at most 500 chars)");
  }
  const k = header.kinds;
  if (!Array.isArray(k) || !k.every(x => typeof x === "string" && KIND_RX.test(x))) bad("kinds is not a list of kind names ([a-z][a-z0-9_]{0,31})");
  const sortedUnique = Array.from(new Set(k)).sort();
  if (sortedUnique.length !== k.length || sortedUnique.some((x, i) => x !== k[i])) bad("kinds is not sorted and unique");
  if (!REQUIRED_KINDS.every(r => k.includes(r))) bad("kinds must contain anchor and started");
  checkValue(header, "$");
}

function makeHeader(created, anchorTz, agent, certifies, kinds) {
  const header = {
    schema: LOG_SCHEMA, created, anchor_tz: anchorTz, agent, certifies,
    kinds: Array.from(new Set(kinds || [])).sort()
  };
  checkHeader(header);
  return header;
}

/* The entry a writer appends: chain keys, day from the header's anchor_tz, the kind's fields, entry_id. Pure:
   no file is touched. Refusal order (the python package's): fields shape, reserved field, kind, started/anchor
   shape, seq/prev form, timestamp, zone, an anchor's `late` against section 5's rule, value types. */
function buildEntry(header, seq, prev, kind, timestamp, fields) {
  if (!isPlainObject(fields)) throw new LedgerValueError("type", "fields must be an object");
  for (const k of Object.keys(fields)) {
    if (RESERVED_FIELDS.includes(k) || k.startsWith("_")) throw new LedgerValueError("reserved_field", "field " + JSON.stringify(k) + " is the ledger's to set");
  }
  const kinds = isPlainObject(header) ? own(header, "kinds") : undefined;
  if (typeof kind !== "string" || !Array.isArray(kinds) || !kinds.includes(kind)) {
    throw new LedgerValueError("kind_not_declared", "kind " + JSON.stringify(kind) + " is not in header.kinds");
  }
  if (kind === "started") {
    const w = own(fields, "writer");
    if (!(isPlainObject(w) && typeof w.name === "string" && w.name && typeof w.version === "string" && w.version)) {
      throw new LedgerValueError("started_writer", "a started entry carries writer {name, version}");
    }
  }
  if (kind === "anchor") {
    const has = f => Object.prototype.hasOwnProperty.call(fields, f);
    if (!ANCHOR_FIELDS.every(has) || !DATE_RX.test(String(fields.anchor_date)) || !HEX64_RX.test(String(fields.anchor_head))
        || !isInt(fields.anchor_head_seq) || !HEX64_RX.test(String(fields.anchor_text_sha256)) || typeof fields.late !== "boolean") {
      throw new LedgerValueError("anchor_form", "an anchor entry carries " + ANCHOR_FIELDS.join(", ") + " in form");
    }
  }
  if (!isInt(seq) || seq < 1) throw new LedgerValueError("type", "seq must be an integer >= 1");
  if (typeof prev !== "string" || !HEX64_RX.test(prev)) throw new LedgerValueError("type", "prev must be 64 lowercase hex");
  const day = dayOf(timestamp, header.anchor_tz);
  if (kind === "anchor" && fields.late !== lateOf(fields.anchor_date, timestamp, header.anchor_tz)) {
    throw new LedgerValueError("anchor_form", "late is " + !fields.late + " by section 5's rule for an anchor of " + fields.anchor_date + " written at " + timestamp);
  }
  const core = { schema: ENTRY_SCHEMA, seq, prev, kind, timestamp, day };
  for (const k of Object.keys(fields)) setOwn(core, k, fields[k]);
  const entry = coreOf(core);
  entry.entry_id = sha256Hex(jcs(core));
  return entry;
}

// ----------------------------------------------------------------------------------------------- anchor

/* `<agent> anchor <YYYY-MM-DD> head <64 hex> seq <n>`, byte for byte (section 5). */
function anchorText(agent, date, head, seq) {
  if (typeof agent !== "string" || !AGENT_RX.test(agent) || typeof date !== "string" || !DATE_RX.test(date)
      || typeof head !== "string" || !HEX64_RX.test(head) || !isInt(seq) || seq < 0 || seq > MAX_INT) {
    throw new LedgerValueError("anchor_form", "anchor fields out of form");
  }
  return agent + " anchor " + date + " head " + head + " seq " + BigInt(seq).toString();
}

/* The fields of a text that IS the anchor form (one trailing LF tolerated; seq at most 2^53), else null. */
function parseAnchorText(text) {
  if (typeof text !== "string") return null;
  const m = ANCHOR_RX.exec(text);
  if (!m || m[4].length > 16 || BigInt(m[4]) > BigInt(MAX_INT)) return null;
  return { agent: m[1], date: m[2], head: m[3], seq: parseInt(m[4], 10) };
}

// ---------------------------------------------------------------------------------------------- reading

function splitLines(u8) {
  const out = [];
  let start = 0, hasCR = false;
  for (let i = 0; i <= u8.length; i++) {
    if (i === u8.length || u8[i] === 0x0a) { out.push({ line: out.length + 1, bytes: u8.subarray(start, i) }); start = i + 1; }
    else if (u8[i] === 0x0d) hasCR = true;
  }
  return { lines: out, hasCR };
}
function isBlank(b) {   // python bytes.strip(): ASCII whitespace
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0b && c !== 0x0c) return false;
  }
  return true;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function toU8(raw) {
  if (typeof raw === "string") return enc.encode(raw);
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new TypeError("expected bytes (Uint8Array, Buffer, ArrayBuffer) or a string");
}

/* {header, entries: [{line, entry}], problems}. Never throws on content. */
function readBytes(raw) {
  const u8 = toU8(raw);
  let header = null, firstSchema;
  const entries = [], problems = [];
  const sp = splitLines(u8);
  if (sp.hasCR) problems.push({ line: null, seq: null, code: "cr_byte", problem: "the log holds a CR byte; lines are LF" });
  for (const ln of sp.lines) {
    const n = ln.line;
    if (isBlank(ln.bytes)) continue;
    if (depthExceeds(ln.bytes)) {
      problems.push({ line: n, seq: null, code: "unparsable", problem: "unparsable: containers nested deeper than 32 (section 2)" });
      continue;
    }
    let obj;
    try { obj = JSON.parse(dec.decode(ln.bytes)); }
    catch (e) { problems.push({ line: n, seq: null, code: "unparsable", problem: "unparsable: " + (e && e.name ? e.name : "error") }); continue; }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) { problems.push({ line: n, seq: null, code: "not_object", problem: "not an object" }); continue; }
    let canonical = false;
    try { canonical = !hasLoneSurrogate(obj) && bytesEqual(enc.encode(dump(obj)), ln.bytes); } catch (e2) { canonical = false; }
    if (!canonical) problems.push({ line: n, seq: null, code: "not_canonical", problem: "the line's bytes are not the canonical dump of its object" });
    if (firstSchema === undefined) firstSchema = own(obj, "schema") === undefined ? null : own(obj, "schema");
    if (header === null && entries.length === 0 && own(obj, "schema") === LOG_SCHEMA) { header = obj; continue; }
    entries.push({ line: n, entry: obj });
  }
  if (header === null) {
    let why = entries.length ? "no header on line 1" : "no header: the file holds no v1 header line";
    if (firstSchema === V0_LOG_SCHEMA) why += " (line 1 is a protocol v0 header; this verifier reads v1 only)";
    problems.push({ line: 1, seq: null, code: "no_header", problem: why });
  }
  return { header, entries, problems };
}

function withheldMap(withheld) {
  const m = new Map();
  for (const w of withheld || []) {
    const s = w && typeof w === "object" ? asSeq(w.seq) : null;
    if (s !== null && typeof w.entry_id === "string") m.set(s, w.entry_id);
  }
  return m;
}
function declaredKinds(header) {
  const k = isPlainObject(header) ? own(header, "kinds") : undefined;
  return Array.isArray(k) ? k.filter(x => typeof x === "string") : [];
}
const nul = v => (v === undefined ? null : v);

/* {problems, bridged}. A withheld seq is bridged on its published digest (section 6): when the next entry
   present is not that seq, `prev` advances to the withheld digest and the expected seq moves past it. */
function checkChain(header, entries, withheld) {
  const bad = [], bridged = [];
  if (header === null || header === undefined) {
    bad.push({ line: 1, seq: null, codes: ["no_header"], problems: ["no header"] });
    return { problems: bad, bridged };
  }
  const kinds = declaredKinds(header);
  if (!REQUIRED_KINDS.every(r => kinds.includes(r))) {
    bad.push({ line: 1, seq: null, codes: ["header_kinds"], problems: ["header.kinds missing anchor or started"] });
  }
  const wm = withheldMap(withheld);
  const tz = own(header, "anchor_tz");
  let prev;
  try { prev = headerDigest(header); }
  catch (err) { prev = null; bad.push({ line: 1, seq: null, codes: ["not_canonical"], problems: ["header not canonicalisable: " + err.message] }); }
  let wantSeq = 1;
  for (const it of entries) {
    const e = it.entry, codes = [], texts = [];
    const add = (c, t) => { codes.push(c); texts.push(t); };
    const s = own(e, "seq");
    while (wm.has(wantSeq) && s !== wantSeq) { prev = wm.get(wantSeq); bridged.push(wantSeq); wantSeq++; }
    const core = coreOf(e);
    let want = null;
    try { want = entryId(core); } catch (err) { add("core_not_canonical", "core not canonicalisable: " + err.message); }
    if (own(core, "schema") !== ENTRY_SCHEMA) add("schema", "schema is not " + ENTRY_SCHEMA);
    const kind = own(core, "kind");
    if (typeof kind !== "string" || !kinds.includes(kind)) add("kind_not_declared", "kind " + JSON.stringify(nul(kind)) + " not in header.kinds");
    if (want !== null && own(e, "entry_id") !== want) add("entry_id", "entry_id does not re-derive from the core");
    if (nul(own(e, "prev")) !== prev) add("prev", "prev does not name the line before");
    if (!(isInt(s) && s === wantSeq)) add("seq", "seq is " + JSON.stringify(nul(s)) + ", expected " + wantSeq);
    try {
      if (dayOf(own(core, "timestamp"), tz) !== own(core, "day")) add("day", "day does not re-derive from timestamp");
    } catch (err) { add("day", "day does not re-derive: " + err.message); }
    if (codes.length) bad.push({ line: it.line, seq: nul(s), codes, problems: texts });
    const eid = own(e, "entry_id");
    prev = typeof eid === "string" ? eid : prev;
    wantSeq = (isInt(s) ? s : wantSeq) + 1;
  }
  return { problems: bad, bridged };
}

function headOf(header, entries) {
  if (entries.length) {
    const h = own(entries[entries.length - 1].entry, "entry_id");
    return typeof h === "string" ? h : null;
  }
  if (header === null || header === undefined) return null;
  try { return headerDigest(header); } catch (e) { return null; }
}

module.exports = {
  LOG_SCHEMA, ENTRY_SCHEMA, V0_LOG_SCHEMA, HEADER_DOMAIN, HEADER_KEYS, REQUIRED_KINDS, RESERVED_FIELDS, ANCHOR_FIELDS,
  AGENT_RX, KIND_RX, DATE_RX, HEX64_RX, ANCHOR_RX,
  isInt, asSeq, sha256Hex, coreOf, entryId, headerDigest, checkHeader, makeHeader, buildEntry, anchorText, parseAnchorText,
  readBytes, withheldMap, declaredKinds, checkChain, headOf, toU8
};
