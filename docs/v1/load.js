/* load.js — the shelf's own loader for the vendored v1 verifier in a browser (not a vendored file).

   the kit's js/lib files (styxx-ledger 838a003) are commonjs written for node: they call require("./jcs") and
   require("node:crypto"), and chain.js hashes a string through Buffer.from. this loader fetches each file named in
   VENDORED.json, refuses to run one whose sha256 is not the one recorded there, and runs it inside a function that
   hands it `module`, `exports`, `require` and `Buffer`. require("node:crypto") gets a sha256 written below in
   javascript (synchronous, as chain.js needs); Buffer.from(string) gets the utf-8 bytes. nothing in the vendored
   files is changed.

     ShelfV1.load(base) -> Promise<{verify, vendored, checked: [{path, sha256, matches}]}> */
(function (root) {
  "use strict";
  var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  var enc = new TextEncoder();
  function sha256Bytes(u8) {
    var n = u8.length, total = ((n + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
    m.set(u8); m[n] = 0x80;
    var bits = n * 8, hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    m[total - 8] = hi >>> 24; m[total - 7] = hi >>> 16; m[total - 6] = hi >>> 8; m[total - 5] = hi;
    m[total - 4] = lo >>> 24; m[total - 3] = lo >>> 16; m[total - 2] = lo >>> 8; m[total - 1] = lo;
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], w = new Int32Array(64);
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (k + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + k) | 0;
    }
    var s = "";
    for (i = 0; i < 8; i++) s += ("00000000" + (h[i] >>> 0).toString(16)).slice(-8);
    return s;
  }
  function toU8(v) { return typeof v === "string" ? enc.encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v); }
  var cryptoShim = {
    createHash: function (alg) {
      if (alg !== "sha256") throw new Error("only sha256 here");
      var parts = [];
      return {
        update: function (b) { parts.push(toU8(b)); return this; },
        digest: function (fmt) {
          if (fmt !== "hex") throw new Error("only hex here");
          var len = 0, i; for (i = 0; i < parts.length; i++) len += parts[i].length;
          var all = new Uint8Array(len), o = 0; for (i = 0; i < parts.length; i++) { all.set(parts[i], o); o += parts[i].length; }
          return sha256Bytes(all);
        }
      };
    }
  };
  var bufferShim = { from: function (s, encName) { if (typeof s === "string" && encName && encName !== "utf8") throw new Error("utf8 only"); return toU8(s); } };

  async function load(base) {
    base = base || "v1/";
    var vr = await fetch(base + "VENDORED.json", { cache: "no-store" });
    if (!vr.ok) throw new Error("VENDORED.json: http " + vr.status);
    var vendored = await vr.json();
    var src = {}, checked = [];
    for (var i = 0; i < vendored.files.length; i++) {
      var f = vendored.files[i];
      if (!/\.js$/.test(f.path)) continue;
      var r = await fetch(base + f.path, { cache: "no-store" });
      if (!r.ok) throw new Error(f.path + ": http " + r.status);
      var bytes = new Uint8Array(await r.arrayBuffer()), got = sha256Bytes(bytes);
      checked.push({ path: f.path, sha256: got, matches: got === f.sha256 });
      if (got !== f.sha256) throw new Error(f.path + " hashes to " + got + ", VENDORED.json says " + f.sha256 + "; not run");
      src["./" + f.path.replace(/\.js$/, "")] = new TextDecoder("utf-8").decode(bytes);
    }
    var cache = {};
    function req(name) {
      if (name === "node:crypto" || name === "crypto") return cryptoShim;
      if (cache[name]) return cache[name].exports;
      if (!(name in src)) throw new Error("the loader has no module " + name);
      var module = { exports: {} };
      cache[name] = module;
      /* eslint-disable-next-line no-new-func */
      new Function("module", "exports", "require", "Buffer", src[name] + "\n//# sourceURL=" + base + name.slice(2) + ".js")(module, module.exports, req, bufferShim);
      return module.exports;
    }
    return { verify: req("./verify"), vendored: vendored, checked: checked };
  }

  root.ShelfV1 = { load: load, sha256Hex: function (b) { return sha256Bytes(toU8(b)); } };
})(typeof self !== "undefined" ? self : this);
