# styxx-shelf

built to run the re-derivation somewhere that is not the box. **as of 2026-11-09 the workflow is not in this
repository and every report so far is a local run from the lab's box**: the one nightly report
(`docs/reports/darkflobi/2026-11-08.json`) says "not the action (a local run)", and the 8 reads by url under
`docs/reports/reads/` (2026-11-09) were run by hand. the workflow waits for the operator (see "the operator's setup": the file, the write permission, one run by hand);
the page's opening sentence is built from the reports on disk and says "built to run" until a report from the action
is there. once added, the github action, every night, fetches each row's published
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

## get your ledger read

for an operator outside the lab who keeps a styxx ledger (protocol v1, written with the kit at
https://github.com/fathom-lab/styxx-ledger) and wants the shelf's read of it, for example for condition (c) of the
kit's census template (`census/PREREG_census_TEMPLATE.md` there). as of 2026-11-09: requests 0 (issues on this
repository, open or closed: 0); outside ledgers read: 0.

1. **publish** `ledger.jsonl` at an https url that serves it byte for byte with no login, and `withheld.json` beside
   it if you withhold lines. post each day's anchor text at a place that holds ("anchor places", below). the ledger
   needs at least one anchor entry, which the writer makes after that day has ended in your `anchor_tz`.
2. **check it yourself** (optional): in a clone of this repository, node 20 or later, nothing to install,
   `node shelf_read.cjs --url <ledger url> --protocol v1 [--withheld-url <url>] [--place-url <url>]` prints the
   report the lab's read would write; exit 0 when the chain re-derives.
3. **ask**: open an issue at https://github.com/fathom-lab/styxx-shelf/issues/new/choose and pick "ledger read" if it
   is listed (the form is `.github/ISSUE_TEMPLATE/ledger_read.md`, which the operator adds: see "the operator's
   setup"); otherwise a plain issue giving the agent, the ledger url, the withheld url or `none`, the `anchor_tz`, the
   anchor place and why it holds, your ledger's earliest anchor text that holds (verbatim: the shelf reads that one,
   and your template's `{{earliest_anchor}}` must be this text or (c) fails), a name for the row, and who runs the
   agent. an issue needs a github account. the row, the report and that anchor text are published on the shelf's
   pages.
4. **the lab's acts, not yours**: the lab says on the issue, dated, whether your anchor place holds by the rule under
   "anchor places" (a word that does not bind the scoring: under the census template as it stands, its §9, the lab
   judges the place again at the scoring date, and that judgement is the one the scorer uses); appends a row for your
   ledger to `docs/outside_ledgers.json` (`written_by: "outside"`) in a dated commit; runs
   `node shelf_read.cjs --row <name>`; commits the report; and replies with the kept read's url. the register row is
   the lab's act: a pull request that edits the register is a request, not a row.
5. **what you paste** into the census template's section 15:
   `shelf read: <the kept read's url> sha256 <64 hex of that file> at <read_at>`, where the url has the form
   `https://fathom-lab.github.io/styxx-shelf/reports/reads/<name>/<read_at with each : written ->.json` (darkflobi's
   read at 2026-11-09T14:37:14Z is `reports/reads/darkflobi/2026-11-09T14-37-14Z.json` under that host). the census
   scorer fetches a shelf report only from under that prefix; for (c) the read must fall after your earliest anchor's
   day ended and before 00:00 of your d0. the `at` you paste is the report's own `read_at`, copied: the scorer checks
   the pasted time and does not compare it with the report's (see "ledgers read by url", below).
6. **how long**: the read itself ran in under a second on the lab's box (2 of 2 dry runs on 2026-11-09: 107 lines in
   0.6 s, 815 lines in 0.7 s). the row and the read are done by hand; with 0 requests so far the lab quotes no
   turnaround. once the workflow is in this repository, every row not withdrawn is read again each night.

the read is the lab's shelf reading your ledger with the lab's copy of the verifier: reproducible, not independent of
the lab ("what this is not"), and it says nothing about your agent or whether a line records what happened.

## anchor places

an anchor place is where a ledger's daily anchor text is posted. the rule (the kit's `PROTOCOL_v1.md` §5 and the
census template §9): **a stranger reads it without a login, and the operator cannot edit or delete a post there once
it is made.** the lab judges a place by that rule and says so on the request (step 4 of "get your ledger read"),
dated, before a row is added; the census template judges the place again at its scoring date (its §9). the word on
the request does not bind the scoring: under the template as it stands, the judgement at the scoring date is the one
the scorer uses (`--anchor-place-holds` or `--anchor-place-fails WHY`), and a place judged to fail there prints every
day of the window as unanchored. the places as the lab reads them on 2026-11-09, from what each lets the one who
posts do:

| place | by the rule | why |
|---|---|---|
| a capture of the post by the internet archive (`https://web.archive.org/save/<url>`), made the day it is posted | holds, with a caveat | readable without a login; the capture is the archive's, not the operator's, and its time is the archive's clock. the caveat: the captured page is the operator's own and the archive takes removal requests from site owners, so the operator can have a capture removed, which by the rule's letter is a delete. the lab reads the place as holding with that caveat because a capture cannot be edited and a removal is the archive's act on a request, not the operator's own; but with a second capture of other text the same day, a removal can replace that day's post. a reader of the archive sees each capture and its time; the census scorer sees neither (below) |
| a bitcoin transaction that carries the anchor text, or its sha256 with the text posted beside it | holds | readable on any block explorer without a login; a mined transaction is not edited or removed. a fee each day |
| a discord channel | fails | reading needs an account; the poster can edit and delete |
| a telegram channel or group | fails | admins can edit and delete; a group needs an account to read (darkflobi's supergroup does) |
| an x post | fails | the author can delete it |
| a github issue, comment, discussion or gist | fails | the author can edit it |
| a mastodon or bluesky post | fails | the author can delete it |
| a page, file or git repository the operator hosts or can push to | fails | the operator can rewrite it |

in either place that holds, the operator can make more than one post on a day (two captures of a page whose text
changed between them, two transactions). the census scorer reads the posted texts only from `{{anchors_url}}`, the
operator's own index (which the template labels the writer's statement), or from texts the lab collects and hands it
(`--anchors`); it reads neither a post's time at the place nor the place's other posts (`census.py` at styxx-ledger
26cce4d). a post the index leaves out is unseen by the scorer; only a reading of the place itself finds it.

**what the shelf's place check reads.** shelf_read fetches one url, the row's anchor place url with `{date}` replaced
by the earliest anchor's date as `YYYY-MM-DD`, and looks in its body for that anchor's text: verbatim (`found`), its
sha256 in hex (`found_sha256`: how an explorer's json shows a transaction that carries only the digest) or its utf-8
bytes in hex (`found_hex`: how an explorer's json shows a transaction's data); otherwise `not_found`. so for an
archive capture the row names that capture's exact url, best as `https://web.archive.org/web/<YYYYMMDDhhmmss>id_/<url>`
(the captured bytes as they were; the `{date}` form cannot build the 14-digit time), and for a transaction an
explorer's json url for it (for example `https://blockstream.info/api/tx/<txid>`; a page that renders the data in the
browser's script reads `not_found`). the check says what one body carries for the earliest anchor: not that the url
is a place that holds (the lab's judgement, above), not that a transaction is mined, not when a post or a capture was
made.

an opentimestamps proof alone is not a place: it attests that bytes existed before a bitcoin block, not that they
were posted where a stranger could read them. a place not in the table is judged by the rule when an operator names
it. the lab's own two rows fail the rule: darkflobi's anchors go to a telegram supergroup that needs an account and
that the lab can edit (so the shelf reads the lab's copy, `anchors/<date>.txt`), and red's place is a page on the
lab's own site. both ledgers are the lab's, and neither is an outside window.

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

## ledgers read by url (shelf_read.cjs)

a second, smaller reader for ledgers the lab does not publish in the exhibit's shape: one url per ledger, protocol
v0 (`darkflobi.gate/*/v0`) or v1 (`styxx.ledger/*/v1`, the kit's protocol). the shelf is the lab's: a ledger read
here, whoever wrote it, is read by the lab's shelf with the lab's copy of the verifier. reproducible, not independent
of the lab. a report says whether the bytes at the url re-derive and where the earliest anchor that holds was looked
for; nothing about the agent behind the ledger, or whether a line records what happened.

    node shelf_read.cjs --row <name>                     # a register row; writes docs/reports/<name>.json
    node shelf_read.cjs --url <url> --protocol v1 [--withheld-url <url>] [--place-url <url>]   # a dry run, to stdout
    node shelf.mjs --page-only                           # rewrite docs/index.html from the reports on disk

**the register** is `docs/outside_ledgers.json`: rows `{name, protocol, ledger_url, withheld_url, anchor_place:
{kind, url} | null, written_by, added_at, added_by, note}`. `written_by` is `lab` (the lab's own agents and examples) or
`outside` (an operator outside the lab); every heading counts both. append-only: a row is added at the end, by the lab
(that it lands in a dated commit is lab practice, not something the tests check);
a row is never edited or removed; a row taken off gets `withdrawn_at` (and may get `withdrawn_why`) and stays, and
shelf_read refuses it. `docs/shelf_core.js` (`checkRegister`, `checkRegisterAppendOnly`) states the rule and the
tests hold the register to it across every commit of the file (each consecutive pair in `git log`, then the last
commit against the working copy). today: 2 rows, 2 of 2 the lab's own v0 ledgers (darkflobi, red); outside ledgers
read: 0; v1 rows 0 of 2. **a v1 row is added by the lab, with a dated commit, when an outside operator publishes a v1 ledger
and asks** (how to ask: "get your ledger read", above). an anchor place url may carry `{date}`, replaced by the earliest anchor's date as `YYYY-MM-DD` (darkflobi's anchors are
posted to a telegram supergroup that needs an account; its row names the exhibit's `anchors/<date>.txt` copy and
says so; red's names its own page, which the lab can edit).

**the v1 verifier** is the kit's (`https://github.com/fathom-lab/styxx-ledger`), copied from commit `838a003` with
`git show 838a003:js/lib/<file>` into `docs/v1/` (verify.js, chain.js, jcs.js, day.js, and the kit's LICENSE),
unchanged; `docs/v1/VENDORED.json` carries each file's sha256 and the tests hold them equal. node loads them with
`require`; the browser loads them through `docs/v1/load.js`, the shelf's own loader, which refuses a file whose sha256
is not the recorded one and hands chain.js a javascript sha256 where `node:crypto` would be. v0 rows run the pinned
`tools/verify.js` (served to the browser as `docs/v0/verify.js`, the same bytes).

**what shelf_read does:** fetches the ledger (node http/https, 30 s, up to 5 redirects; and withheld.json when the row
names one), records sha256 and byte count, re-derives the chain, composes each of the ledger's own anchor entries'
text (v1 `<agent> anchor <date> head <hex> seq <n>`, v0 `gate anchor ...`) and checks it with the verifier's
`checkAnchor` and against the entry's `anchor_text_sha256`, takes the earliest that holds, and fetches the row's
anchor place url to say what its body carries of that text: `found` (verbatim), `found_sha256` (its sha256 in hex),
`found_hex` (its utf-8 bytes in hex), `not_found` or `could_not_read`, with the http status (`not_checked` when the
row names no place url); what one url's body carries, not whether it is a place that holds ("anchor places", above).
exit 0 when the chain re-derives, 1 when not or the ledger did not answer, 2 on usage.

**the report** (`docs/outside_report_schema.json`): `shelf_commit` (git HEAD of this checkout, marked "(uncommitted
changes present)" when so), `read_at`, `ledger_url`, `bytes`, `sha256`, `protocol`, `lines` (entries after the
header), `head`, `rederives` (`ok`, `problem_codes` in the kit's code vocabulary, v0 sentences mapped onto it,
`problems`, `withheld_lines`), `implementations` (`javascript`: what ran; `python`: "not run by the shelf"),
`anchors` (`count`, `holding`, `earliest`: `date`, `seq`, `text`, `text_sha256`, `holds`, `place_check`). counts and
digests only; the one text is the earliest anchor's, public by design, which the census scorer looks for verbatim.
deterministic for fixed bytes except `read_at` and `shelf_commit`. every read is written twice: `docs/reports/<name>.json`
(the latest, replaced by the next read) and `docs/reports/reads/<name>/<read_at with each : written ->.json` (kept, never rewritten). the
census template's section 15 line names the kept copy. the page prints how old each read is (its `read_at`
against the time the page was written, and on `outside.html` against the time the browser opened it), the line count
of the nightly row that reads the same url beside it, and marks a read made from a checkout with uncommitted
changes:

    shelf read: https://fathom-lab.github.io/styxx-shelf/reports/reads/<name>/<read_at with each : written ->.json sha256 <64 hex of that file> at <read_at>

**since styxx-ledger f29ae3d (2026-11-09) `census.SHELF_HAS_V1_ROW` is True, so the census scorer reads condition (c)
from the shelf**: it fetches the report a section 15 shelf read line names, only from under
`https://fathom-lab.github.io/styxx-shelf/reports/reads/` (`census.SHELF_REPORT_PREFIX`, since 94e4181; a report on
any other host fails (c) unfetched), and checks the sha256 of its bytes, that the body names the registered
`ledger_url` and `earliest_anchor` (the text, which carries the head), that the anchor holds on the chain, and that
the time pasted on the shelf read line (`at`) falls after the anchor's day ended and before d0 (`census.py`,
`_on_the_shelf` and `_shelf`, as read at styxx-ledger 26cce4d). the scorer does not compare that time with the
report's own `read_at`, so the pasted time is the operator's word: a read made after d0, pasted with an earlier
`at`, passes both time checks. a kit fix is proposed (compare `at` with the fetched report's `read_at`); until it lands, a reader
compares the two by hand. the shelf's tests emulate the checks on the report's bytes and body and on the pasted time
(`scorerChecks`), not the host pin, and hold the proposed comparison beside them as a separate check
(`atIsTheReadAt`). (c) holds for an outside window only after the shelf has read that ledger and its report is kept
here. this sentence replaced, on 2026-11-09, one saying (c) could not hold until a kit commit set `SHELF_HAS_V1_ROW`,
which was false from f29ae3d on. every
report so far was written when the lab ran shelf_read by hand on its box; the workflow written for this repository
(not in it as of 2026-11-09) runs `npm test`, then `shelf_read.cjs --row` for every register row not withdrawn, then
shelf.mjs, each night. a register row whose protocol is not v0 or v1 is never read with a guessed verifier: shelf_read refuses the whole
register (exit 2 for every row's read, since the register no longer holds its own rules), while the page and
outside.html refuse only that row, in its place. the page: a "ledgers read by url"
section on `docs/index.html` (static, written by shelf.mjs) and `docs/outside.html`, which fetches each ledger from its
url and runs the same code in the browser (a host that allows a cross-origin read; github pages hosts do).

withheld.json may be a bare array or `{"withheld": [...]}`, as the kit's `loadWithheld` and the census scorer accept.

tests: `npm test` runs `node --test test/test_shelf_read.mjs` and then `node test/test_shelf.mjs` (each also alone:
`npm run test:read`, `npm run test:shelf`). test_shelf.mjs runs the shelf with its clock set to the fixture's night,
2026-11-08 20:00z (`test/clock_fixture.mjs`), so its counts do not depend on the day it runs. test_shelf_read.mjs:
(local http server, no network; the v1 fixtures are the kit's vectors
at 838a003, see `test/fixtures/v1/FIXTURES.json`).

## the operator's setup

done by the lab on 2026-11-08: this repository was created and pushed to `main` (everything but `.github/`), and
pages serve `main` /docs at https://fathom-lab.github.io/styxx-shelf/. what remains is the operator's, because the
lab's github token cannot write `.github/workflows/`:

1. the workflow file: add `.github/workflows/shelf.yml` to `main` (on the web: add file → create new file), with
   the contents the lab keeps outside this repository, in its working folder for the shelf, under
   `github_for_operator/shelf_dot_github/workflows/shelf.yml`.
2. write permission for workflows, at the organization (github.com/organizations/fathom-lab/settings/actions →
   workflow permissions → read and write; as of 2026-11-08 it is disabled there) and then at the repository (settings →
   actions → general → workflow permissions → "read and write permissions"). without both, the nightly commit of
   `docs/` fails and the report is only in the job log.
3. actions → shelf → run workflow, once by hand; the cron then runs at 07:00 utc. that run runs `npm test` (a red
   suite turns the job red and nothing is read or committed), the reads (an exit of 2 or more turns the job red; the
   shelf still runs), shelf.mjs (exit 2 turns it red), and the commit of `docs/`. the report appears at
   https://fathom-lab.github.io/styxx-shelf/ a minute or two after the commit.
4. the request form: add `.github/ISSUE_TEMPLATE/ledger_read.md` to `main`, with the contents the lab keeps under
   `github_for_operator/shelf_dot_github/ISSUE_TEMPLATE/ledger_read.md` in the same working folder (the lab keeps out
   of `.github/`, so this paste is the operator's too). it is the "ledger read" form of "get your ledger read"; without
   it a requester opens a plain issue with the same fields.
