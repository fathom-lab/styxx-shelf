# styxx-shelf

the re-derivation runs somewhere that is not the box. every night a github action fetches each row's published
`darkflobi.gate/entry/v0` ledger (ledger.jsonl, withheld.json, the vectors, the anchors and their opentimestamps
proofs), re-derives the chain with the shelf's own pinned copy of the verifier, runs the row's conformance vectors
(10 today), checks every anchor the row's index lists against the chain and its proof against the bitcoin block
header as two explorers return it, checks the index against the anchor lines the ledger itself carries, counts the
calendar days with no anchor, compares the bytes with the previous night's fetch (append-only, including every past
anchor's text and proof), stamps its own report through the opentimestamps calendars (`--stamp-self`), and writes
the report — the sha256 and length of every fetched file, every check's answer, every command as it can be re-run by
hand, the explorers' answers, where the run ran — to `docs/reports/<row>/<date>.json` and a static page at
`docs/index.html`. exit 0 when no check failed, 1 when any failed (the report is still written), 2 on usage or a
crash.

## what this is not

- **reproducible, not independent.** the lab that writes the ledger also controls this repository, its workflow and
  its pinned verifier. a reader gets a run they can repeat from the printed command and compare digest for digest;
  not a second party's word.
- the anchor texts are fetched from the lab's exhibit (`anchors/<date>.txt`), since the telegram supergroup they
  were posted to needs an account to read. the shelf checks that those bytes are what the index says, that the proof
  is over them, and that they name a head in the chain. it cannot see the post.
- what is outside the lab is the bitcoin block header, fetched from two explorers and compared. a proof attests that
  the anchor's bytes existed before that block; not that they were published anywhere, not at what url, not that the
  head covers every send.
- append-only is checked against the shelf's own record of the previous fetch, kept in this repository
  (`docs/history/<row>/latest.json`). it shows a rewrite between two nights only while that record was not itself
  rewritten; the record's git history is the lab's too. the lines after the last bitcoin-attested head (printed on
  every run, with the row's line count as denominator) are pinned by nothing outside the lab. a reader who kept last
  night's report and its `.ots` can show it existed before the block it names; one who did not must trust this
  repository's git history.
- a withheld line is bridged on the lab's word: `withheld.json` carries a digest the shelf cannot re-derive; the chain
  is checked through it and the lines it leaves unpinned are counted.
- the shelf asks the opentimestamps calendars only to stamp and upgrade its own nightly report (`--stamp-self`, on
  in the workflow), never to verify a row's proof: a row's pending proof stays pending here until the row's writer
  upgrades it, and a proof pending for more than `pending_max_days` (7) after its anchor date is a failed check. it
  asks no bitcoin node and no telegram.
- a day with neither an index entry nor a ledger anchor line is a count and a list of dates, not a failure: the
  writer's own anchor_anomaly lines are what would explain it. an index that omits a day the ledger carries an anchor
  line for, or lists a day the ledger does not, is a failed check. "pending" is a state, not a pass. a verifier that
  drifted from the pinned copy is said so, and the pinned copy is what ran. an explorer that did not answer is
  "explorer unreachable", distinct from two explorers that disagree; both leave the anchor not verified.
- a run made outside the workflow says so: the report's `ran_on` is either `github actions` with the run url, commit
  and attempt, or `not the action (a local run)`; the page prints it beside the row.

## run it yourself

    git clone https://github.com/fathom-lab/styxx-shelf && cd styxx-shelf
    npm ci
    node shelf.mjs --row darkflobi --out ./docs

node 20 or later. one dependency, `opentimestamps@0.4.9`, pinned by `package-lock.json`. the full cli:

    node shelf.mjs [--row <name>] [--out <dir>] [--config shelf.config.json] [--explorer <url>]... [--no-ots]
                   [--date <YYYY-MM-DD>] [--through <YYYY-MM-DD>] [--stamp-self] [--calendar <url>]...

`--date` sets the report's date and the gap window's end (the day before it); the default is today utc, and the
window's end is then the day before the run day in America/New_York (day D's anchor is posted at 00:00 of D+1). the
two differ between 00:00 and 05:00 utc, so every report records which it used and its `rerun` line carries both
`--date` and `--through`. `--date` refuses a future or non-calendar date; a past date whose report already exists is
refused too (pass another `--out`), and a run for an older date never moves `latest.json` forward. `--no-ots` skips
the explorer fetches (the proofs are still parsed and matched to the texts). `--stamp-self` stamps tonight's
report through the opentimestamps calendars (the library's default aggregators, or `--calendar` urls) and upgrades
earlier pending stamps; the tests use a fake calendar. the tests:

    node test/test_shelf.mjs

one command: a local http server serves a copy of the exhibit's ledger directory (`test/fixtures/site`, taken while
the 2026-11-07 proof was still pending), two fake explorers that answer with real block headers captured once from
blockstream.info (`test/fixtures/block_headers.json`, source and fetch time inside), a third that answers 503 and a
fake opentimestamps calendar; fourteen cases run shelf.mjs against it (the live copy passes; a rewritten field; the
ledger's own anchor line altered and rechained; a truncation after a recorded run; a same-length byte flip; an
altered anchor text; a swapped verifier; two explorers that disagree; an index that omits a ledger anchor line; one
explorer down; `--date` in the future, non-calendar and over an existing report; an anchor text swapped and a proof
regressed between two nights; a proof pending past the limit; `--stamp-self`). nothing in the tests touches the
network.

## what the shelf runs

`tools/verify.js`, `tools/check_ledger.cjs` and `tools/run_vectors.cjs` are copies of the row's published verifier
taken on 2026-11-08, their sha256 in `tools/PINNED.json`. every check runs these, never the fetched ones; the fetched
`verify.js` and `check_ledger.cjs` are hashed and compared, and a difference is reported as drift, not failed. to
move the pin: copy the new files in, rewrite PINNED.json with their sha256 and date, and say so in the commit.

## adding a row

a row is one entry in `shelf.config.json`:

    { "name": "<row>", "base": "https://<host>/<path>/", "files": { "ledger": "ledger.jsonl", "withheld": "withheld.json",
      "verify": "verify.js", "check": "check_ledger.cjs", "vectors": "vectors/vectors.json", "vectors_base": "vectors/base.jsonl",
      "anchors_index": "anchors/index.json", "snapshots": "SNAPSHOTS.jsonl", "stats": "STATS.json" } }

the row must publish the protocol's files (PROTOCOL.md of the exhibit, sections 1-6 and 8): the ledger bytes, the
withheld list, the vectors with their base, `anchors/index.json` in the `darkflobi.exhibit/anchors/v0` shape with
`anchors/<date>.txt` and `anchors/<date>.txt.ots` beside it, and `SNAPSHOTS.jsonl`. a row that cannot be rerun from
its printed command and digests is removed, and the removal is published on the page.

## the report

`docs/reports/<row>/<date>.json` (`styxx-shelf/report/v0`): `ran_on`, `fetched` (url, http status and date header,
bytes, sha256 per file), `checks.fetch`, `checks.chain` (check_ledger's json: lines, head, kinds, problems, withheld,
bridged, coverage, its own `ok` beside the shelf's, the ledger's own anchor lines in chain k of n), `checks.snapshot`,
`checks.vectors`, `checks.verifier_drift`, `checks.anchors` (per anchor: text and proof digests against the index,
the chain answer, every bitcoin attestation with every explorer's header and the attested time, the lowest block,
the status line, a pending proof's age), `checks.anchor_index_vs_ledger`, `checks.gaps` (with the window and where
its end came from), `checks.outside_pin` (lines after the last bitcoin-attested head), `checks.append_only` (against
`docs/history/<row>/latest.json`: the previous fetch's sha256, bytes, lines, head and every anchor's digests; the
hash of today's leading bytes; `anchor_changes`), `checks.self_stamps` (earlier stamps upgraded and re-checked),
`commands`, `notes`, `problems`, `ok`, `exit_code`, `rerun`. with `--stamp-self`, `<date>.json.ots` beside it and
`stamps.json` (tonight's stamp and the earlier ones).

## the operator's setup

the lab's github token cannot push a branch that touches `.github/`, so the operator creates and pushes this
repository himself. the steps, from the folder that holds this README:

1. create the repository: `gh repo create fathom-lab/styxx-shelf --public --description "nightly re-derivation of published darkflobi.gate ledgers"` (or the web ui).
2. `git init -b main && git add . && git commit -m "shelf v0: one row (darkflobi)" && git remote add origin https://github.com/fathom-lab/styxx-shelf.git && git push -u origin main`
   (`node_modules/` is ignored; `docs/` holds a local run's report, marked "not the action (a local run)" on the page;
   the workflow's own run replaces it).
3. settings → pages → source "deploy from a branch", branch `main`, folder `/docs`.
4. settings → actions → general → workflow permissions → "read and write permissions" (the action commits `docs/` back).
5. actions → shelf → run workflow (once by hand; the cron then runs at 07:00 utc).
6. the report appears at https://fathom-lab.github.io/styxx-shelf/ a minute or two after the commit.
