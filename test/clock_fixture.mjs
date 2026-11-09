// test-only clock for test_shelf.mjs: the shelf runs it as `node --import <this file> shelf.mjs ...`, so the child's
// "today" is the fixture's run date (SHELF_TEST_NOW, an iso instant) and its clock still ticks from there. the
// fixture's anchors end 2026-11-07 and every expected count (1 of 15 days with no anchor, the A6 guard on a past
// --date) is about a night run on 2026-11-08; without this the suite's result depended on the day it ran.
const at = Date.parse(process.env.SHELF_TEST_NOW || "");
if (Number.isFinite(at)) {
  const OFFSET = at - Date.now();
  const RealDate = Date;
  class FixtureDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + OFFSET); else super(...a); }
    static now() { return RealDate.now() + OFFSET; }
  }
  globalThis.Date = FixtureDate;
}
