"use strict";
/* jcs.js: the one byte form of a ledger object (protocol v1, section 2).

   For the value types the ledger admits (null, booleans, integers with |n| <= 2^53, strings without lone
   surrogates, arrays, plain objects whose keys are U+0000..U+007E, nested at most 32 containers deep) the compact
   key-sorted dump below is
   RFC 8785 (JCS). Anything else is refused at write time with a LedgerValueError carrying a stable `.code`:
   float, int_range, non_ascii_key, lone_surrogate, depth, type. `dump` is the exhibit verify.js v0 dump, unchanged. */

const MAX_INT = 9007199254740992; // 2^53
const MAX_DEPTH = 32;             // containers, the outermost counted as 1 (section 2)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

class LedgerValueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LedgerValueError";
    this.code = code;
  }
}

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function describe(v) {
  if (v === undefined) return "undefined";
  if (v && v.constructor && v.constructor.name) return v.constructor.name;
  return typeof v;
}

function checkValue(v, path, depth) {
  path = path || "$";
  depth = depth || 0;
  if (v !== null && typeof v === "object" && depth + 1 > MAX_DEPTH) {
    throw new LedgerValueError("depth", "containers nested deeper than " + MAX_DEPTH + " at " + path);
  }
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "string") {
    if (LONE_SURROGATE.test(v)) throw new LedgerValueError("lone_surrogate", "lone surrogate in a string at " + path);
    return;
  }
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new LedgerValueError("float", "float at " + path + ": the ledger carries integers, never floats");
    if (Math.abs(v) > MAX_INT) throw new LedgerValueError("int_range", "integer at " + path + " exceeds 2^53; JCS numbers are IEEE doubles");
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) checkValue(v[i], path + "[" + i + "]", depth + 1);
    return;
  }
  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) {
      for (let i = 0; i < k.length; i++) {
        if (k.charCodeAt(i) > 0x7e) throw new LedgerValueError("non_ascii_key", "non-ASCII key at " + path);
      }
      checkValue(v[k], path + "/" + k, depth + 1);
    }
    return;
  }
  // bigint, undefined, function, symbol, Date, Map, Set, typed arrays, class instances
  throw new LedgerValueError("type", "unserialisable value at " + path + ": " + describe(v));
}

/* Whether a line's json nests more than `limit` containers deep, read from its bytes (brackets outside strings),
   before any parser recurses into it. A reader reports such a line as unparsable (section 4). */
function depthExceeds(u8, limit) {
  limit = limit === undefined ? MAX_DEPTH : limit;
  let n = 0;
  for (let i = 0; i < u8.length; i++) if (u8[i] === 0x5b || u8[i] === 0x7b) n++;
  if (n <= limit) return false;
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < u8.length; i++) {
    const c = u8[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true;
      else if (c === 0x22) inStr = false;
    } else if (c === 0x22) inStr = true;
    else if (c === 0x5b || c === 0x7b) { if (++depth > limit) return true; }
    else if (c === 0x5d || c === 0x7d) depth--;
  }
  return false;
}

function byCodeUnit(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

/* The compact, key-sorted dump, unchecked (what a reader compares a line's bytes against). */
function dump(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    const parts = [];
    for (let i = 0; i < v.length; i++) parts.push(dump(v[i]));
    return "[" + parts.join(",") + "]";
  }
  const ks = Object.keys(v).sort(byCodeUnit), out = [];
  for (let j = 0; j < ks.length; j++) out.push(JSON.stringify(ks[j]) + ":" + dump(v[ks[j]]));
  return "{" + out.join(",") + "}";
}

/* Checked canonical form: refuses what the ledger does not admit, then dumps. */
function jcs(v) { checkValue(v, "$"); return dump(v); }

/* True when any string (value or key) in v holds an unpaired surrogate. Such an object has no UTF-8 dump, so a
   reader treats its line as not canonical (the python reader's dump cannot encode it either). */
function hasLoneSurrogate(v) {
  if (typeof v === "string") return LONE_SURROGATE.test(v);
  if (Array.isArray(v)) return v.some(hasLoneSurrogate);
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v)) if (LONE_SURROGATE.test(k) || hasLoneSurrogate(v[k])) return true;
  }
  return false;
}

/* Set an own enumerable property, even one named __proto__ (plain assignment would set the prototype). */
function setOwn(o, k, v) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  return o;
}

/* An own property's value, or undefined (never one inherited from Object.prototype). */
function own(o, k) {
  return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

module.exports = {
  MAX_INT, MAX_DEPTH, depthExceeds, LedgerValueError, checkValue, dump, jcs, canonicalLine: dump, hasLoneSurrogate, isPlainObject, setOwn, own
};
