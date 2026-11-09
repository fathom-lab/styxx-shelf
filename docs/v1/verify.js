"use strict";
/* verify.js: what a stranger checks of a v1 ledger (protocol v1, sections 4, 5, 6).

   API-compatible with the exhibit's verify.js (darkflobi.gate v0): verifyBytes, verifyText, checkAnchor,
   coverage, readLog, checkChain, headOf, headerDigest, entryIdOf, sha256Hex, jcs, dump, coreOf, parseAnchorText
   keep their names, shapes and promise-returning forms. What changed with v1:

   - anchorText(agent, date, head, seq) takes the agent first (v0's fixed word "gate" is the header's agent);
     parseAnchorText returns {agent, date, head, seq}; checkAnchor(entries, a, withheld, header) also checks
     that a.agent is header.agent when a header is given.
   - localDay(ts) is dayOf(ts, tz): v1 has no fixed zone, the header's anchor_tz is used.
   - every problem record carries `seq` and a `code` / `codes` (PROTOCOL 4).
   - node only (node:crypto). The v1 verifier does not read a v0 file: it reports no_header and says why.

   Added for v1: dayOf, entryId (sync), headerDigestSync, verifyBytesSync, buildEntry, checkHeader, makeHeader.
   Nothing here writes or touches the network. */
const jcsm = require("./jcs");
const day = require("./day");
const chain = require("./chain");

const { isInt, own } = { isInt: chain.isInt, own: jcsm.own };

/* {header, entries, problems, bridged, head, file_sha256, ok}, synchronously. */
function verifyBytesSync(raw, opts) {
  const u8 = chain.toU8(raw);
  const r = chain.readBytes(u8);
  const c = chain.checkChain(r.header, r.entries, opts && opts.withheld);
  const problems = r.problems.concat(c.problems);
  return {
    header: r.header, entries: r.entries, problems, bridged: c.bridged,
    head: chain.headOf(r.header, r.entries), file_sha256: chain.sha256Hex(u8), ok: problems.length === 0
  };
}
async function verifyBytes(u8, opts) { return verifyBytesSync(u8, opts); }
async function verifyText(text, opts) { return verifyBytesSync(String(text), opts); }

/* A posted anchor ({agent, date, head, seq}, as parseAnchorText gives it) against the entries: the entry at seq
   carries that head (or the withheld list names it, when no entry at that seq is present); no entry of that day
   sits after seq; the ledger's own anchor entry for that date, if any, agrees; and, given the header, the text's
   agent is the header's. */
function checkAnchor(entries, a, withheld, header) {
  const wm = chain.withheldMap(withheld);
  let bySeq = null, after = 0, ownLine = null;
  for (const it of entries) {
    const e = it.entry, s = own(e, "seq");
    if (isInt(s) && s === a.seq) bySeq = e;
    if (own(e, "day") === a.date && isInt(s) && s > a.seq) after++;
    if (own(e, "kind") === "anchor" && own(e, "anchor_date") === a.date) ownLine = e;
  }
  const viaWithheld = bySeq === null && wm.has(a.seq);
  const inChain = viaWithheld ? wm.get(a.seq) === a.head : (bySeq !== null && own(bySeq, "entry_id") === a.head);
  const agentOk = header === null || header === undefined ? true : (jcsm.isPlainObject(header) && own(header, "agent") === a.agent);
  const out = {
    agent: a.agent === undefined ? null : a.agent, date: a.date, seq: a.seq, head: a.head,
    agent_matches: agentOk, in_chain: inChain, via_withheld: viaWithheld,
    line_at_seq: bySeq !== null ? { kind: own(bySeq, "kind"), day: own(bySeq, "day"), timestamp: own(bySeq, "timestamp") }
      : (viaWithheld ? { withheld: true } : null),
    day_lines_after: after,
    ledger_anchor_line: ownLine !== null ? {
      seq: own(ownLine, "seq"),
      agrees: own(ownLine, "anchor_head") === a.head && own(ownLine, "anchor_head_seq") === a.seq,
      late: own(ownLine, "late") === true
    } : null
  };
  out.ok = !!(agentOk && inChain && after === 0 && (ownLine === null || out.ledger_anchor_line.agrees));
  return out;
}

/* What the posted heads pin for the reader: a published entry is pinned when no withheld seq sits after it and
   at or before the first anchor head at or after it (section 6). v0's shape and semantics. */
function coverage(entries, withheld, anchorSeqs) {
  const ws = [], as = [];
  for (const w of withheld || []) { const s = w && typeof w === "object" ? chain.asSeq(w.seq) : null; if (s !== null) ws.push(s); }
  for (const s of anchorSeqs || []) if (isInt(s)) as.push(s);
  as.sort((x, y) => x - y);
  const lastAnchor = as.length ? as[as.length - 1] : 0;
  let pinned = 0, after = 0;
  const unpinned = [];
  for (const it of entries) {
    const s = own(it.entry, "seq");
    if (!isInt(s)) continue;
    if (s > lastAnchor) { after++; continue; }
    const A = as.find(x => x >= s);
    if (ws.some(w => s < w && w <= A)) unpinned.push(s); else pinned++;
  }
  unpinned.sort((x, y) => x - y);
  const ranges = [];
  for (const s of unpinned) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === s - 1) last[1] = s; else ranges.push([s, s]);
  }
  return { pinned, unpinned_by_withholding: unpinned.length, unpinned_ranges: ranges, after_last_anchor: after, withheld: ws.length, last_anchor_seq: lastAnchor };
}

module.exports = {
  LOG_SCHEMA: chain.LOG_SCHEMA, ENTRY_SCHEMA: chain.ENTRY_SCHEMA, HEADER_DOMAIN: chain.HEADER_DOMAIN,
  LedgerValueError: jcsm.LedgerValueError,
  // canonical form
  jcs: jcsm.jcs, dump: jcsm.dump, checkValue: jcsm.checkValue, coreOf: chain.coreOf,
  // digests: v0 names return promises; entryId / headerDigestSync are synchronous
  sha256Hex: async b => chain.sha256Hex(b),
  headerDigest: async h => chain.headerDigest(h),
  headerDigestSync: chain.headerDigest,
  entryIdOf: async c => chain.entryId(c),
  entryId: chain.entryId,
  // time
  dayOf: day.dayOf, localDay: day.dayOf, parseTimestamp: day.parseTimestamp, lateOf: day.lateOf, nextDay: day.nextDay,
  MAX_DEPTH: jcsm.MAX_DEPTH,
  // reading and checking
  readLog: chain.readBytes, readBytes: chain.readBytes,
  checkChain: async (h, e, w) => chain.checkChain(h, e, w),
  checkChainSync: chain.checkChain,
  headOf: async (h, e) => chain.headOf(h, e),
  verifyBytes, verifyText, verifyBytesSync, coverage,
  // anchors
  anchorText: chain.anchorText, parseAnchorText: chain.parseAnchorText, checkAnchor,
  // writing side (pure)
  buildEntry: chain.buildEntry, checkHeader: chain.checkHeader, makeHeader: chain.makeHeader
};
