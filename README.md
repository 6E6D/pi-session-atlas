# Session Atlas

A local, deterministic CLI for finding and citing evidence in Pi session
archives. Search earlier work, trace file and command history, inspect branches
and unfinished-work candidates, and report recorded costs and errors.

This is a prepublication package specification, not an available registry
release. Use a reviewed, built artifact. Package checks do not authorize
publication or installation into an existing agent environment.

## Requirements and scope

- Runtime baseline: Node 24.15.0, with `node:sqlite` and FTS5. The package admits
  later Node 24 patches, not untested major versions.
- Compatibility baseline: Linux x64 and `@earendil-works/pi-coding-agent`
  0.85.1, with Pi session formats v1, v2 and v3. Packed installation and native
  Pi skill discovery must pass on that baseline before release. macOS, Windows
  and other Pi versions are not validated merely because basic checks pass.
- Indexing and legacy normalization need a trusted compatible installed Pi.
  Pi is an optional package-manager peer, not bundled or automatically
  installed by Atlas. Parser-independent queries can use an existing cache.
- One compiled CLI and one skill. No runtime extension, daemon, telemetry,
  LLM calls, vector service or automatic source modification.

The CLI is the supported interface; internal modules are not a stable library
API. Recorded cost/error fields are session evidence, not billing verification
or causal savings measurements.

## Use a reviewed local package

There is no registry installation command to trust at this stage. Given a
reviewed prebuilt tarball, install it into a new, empty local prefix:

```bash
npm install --offline --ignore-scripts --omit=dev --no-audit --no-fund \
  --prefix /absolute/path/to/new-local-tools \
  /absolute/path/to/reviewed-atlas.tgz
node /absolute/path/to/new-local-tools/node_modules/session-atlas/bin/atlas --help
```

Replace the example paths. Offline installation does not provide Pi; use an
already trusted installation. The prebuilt CLI requires neither TypeScript
nor development dependencies. You can also run `node /path/to/package/bin/atlas`
from a complete unpacked artifact. Do not rely on a different global `atlas`.

To expose the skill in Pi, separately review and deliberately register the
complete package directory with `pi install /absolute/path/to/package`.
This changes user Pi settings by default; `-l` selects project settings.
Local registration references the directory without copying it, so keep it
at a stable location. No registration is required for terminal use.

If another `session-atlas` skill already exists, resolve the name collision
explicitly. Pi can retain the first discovered skill. Package installation
does not remove or replace old skills or wrappers. Verify the loaded source
in a new/reloaded Pi session rather than assuming the new skill is active.

## First index and queries

Choose an authorized source root and a private cache path outside that root.
Indexing reads the entire selected root, not only the topic you intend to find.
The following placeholders must be replaced with reviewed absolute paths:

```bash
ATLAS="/absolute/path/to/package/bin/atlas"
DB="/absolute/path/to/private-cache/atlas.db"
SESSIONS="/absolute/path/to/authorized-sessions"

node "$ATLAS" index --db "$DB" --sessions-dir "$SESSIONS" --json
node "$ATLAS" search 'release notes' --db "$DB" --json --limit 10
node "$ATLAS" search 'release OR rollout' --fts --db "$DB" --json --limit 10
node "$ATLAS" search 'exact punctuation: value' --exact --db "$DB" --json --limit 10
node "$ATLAS" trace --file notes.md --db "$DB" --json --limit 10
node "$ATLAS" trace --file 'notes/*.md' --glob --db "$DB" --json --limit 10
node "$ATLAS" cmd 'test runner' --db "$DB" --json --limit 10
node "$ATLAS" show SESSION ENTRY --context 2 --db "$DB" --json
node "$ATLAS" cite SESSION ENTRY --verify-source --db "$DB" --json
```

Replace `SESSION` and `ENTRY` with identifiers returned by queries. Other
commands are `sessions`, `branches --abandoned`, `unfinished`, `report cost`
and `report errors`. Run `--help` for filters and options.

Ordinary search quotes whitespace-separated chunks and joins them with AND.
FTS tokenization/stemming still applies, including to punctuation within a
chunk. `--fts` enables expressions. `--exact` preserves case-sensitive
substring and spacing behavior. These modes cannot be combined. Use `--`
before literal arguments such as `--help`. `trace --file` is literal by
default; `--glob` deliberately enables SQLite glob syntax. Command-history
date bounds apply to invocation time. Date-only bounds are inclusive UTC days;
timestamp bounds require an explicit `Z` or `±HH:mm` zone.

Indexed session/entry times use UTC millisecond precision. Source timestamps
must be valid calendar instants in `YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:mm)`
form, with a four-digit year, hours 00–23 and an explicit zone. Fractional
seconds are optional; digits beyond milliseconds are truncated, as for CLI
date bounds. Sources and query bounds must normalize to four-digit UTC years.
Missing entry timestamps inherit the validated session-header time. Missing header
timestamps or present invalid timestamps fail that file's indexing rather
than guessing a local timezone or silently rolling an invalid date forward.
UTC times govern indexed date filters, ordering, month groups and citation
dates. Source-backed `show` timestamps and original raw values remain as
recorded; normalization does not rewrite source files or change entry IDs.

## Configuration and parser selection

| Setting | Meaning |
|---|---|
| `--db PATH` | Explicit cache file. |
| `ATLAS_HOME` | Default cache directory; otherwise `~/.pi/agent/atlas/`. |
| `--sessions-dir PATH` | Explicit source root for indexing. |
| `ATLAS_SESSIONS_DIR` | Default source root; otherwise `~/.pi/agent/sessions/`. |
| `--path-home PATH` | Indexing-only home used to interpret recorded `~` paths; otherwise the invoking user's home. |
| `ATLAS_PI_PACKAGE` | Trusted Pi package root or its `dist/index.js`. |

The default cache filename is `atlas.db`. Use the same explicit cache/root on
later refreshes; Atlas does not infer a different root from catalog entries.
Atlas records the effective path-expansion home in cache identity. Supply
`--path-home` when an authorized copied archive represents another home. A
change requires explicit rebuild because every resolved `~` path may differ.
An explicit Pi override is authoritative and fails if invalid. Without one,
Atlas tries package resolution relative to itself, the active Node global
layout, then a bounded local `npm root -g` lookup. It does not download Pi.
A selected package must have the expected identity and compatible exports/
session format. Importing a Pi package executes its code: trust the selected
installation, not just its name. Parser identity is not authentication.

## Cache lifecycle and coverage

Sessions are never written by Atlas. The cache is derived, but arbitrary files
are not disposable. New cache directories/files are private. Existing caches
must match a recognized Atlas format before mutation; empty, foreign, extended,
unsupported or unsafe targets are refused, even with `--rebuild`.

Changing parser identity or extraction settings requires an explicit rebuild.
Known schema-v4 caches using extraction version 1 or 2 require an explicit
rebuild before this candidate will query them, including index-only citations.
Schema remains v4; the current extraction interpretation is version 3, which
adds the bound path-expansion home to version 2's UTC timestamp interpretation.
Incremental reuse of version-1 or version-2 observations is refused. Unknown
extraction versions are not adopted, even with rebuild. Refusal does not delete
or convert an old cache. Failed replacement retains its prior corpus/interpretation and
may record failure metadata, but does not make that cache query-compatible.
If originals are unavailable, preserve the old cache rather than overwriting
it with an empty rebuild. A new unused cache is the non-replacement alternative.

Changing an existing cache's bound root, or adopting recognized legacy-v3
cache state, additionally requires an explicit binding decision:

```bash
# Only after approving replacement and the exact selected root:
node "$ATLAS" index --db "$DB" --sessions-dir "$SESSIONS" \
  --rebuild --rebind --json
```

This is not a generic recovery command. Rebuilds use currently available
sources and cannot restore missing originals. A different unused private
cache path is the non-replacement alternative.

Incomplete replacement preserves the previous corpus/binding. Incremental
refresh can preserve useful updates beside failures, with retained evidence
marked unverified. Incomplete traversal is not proof of deletion. Query JSON
includes stored cache identity, scan attempts, successful-scan time, warnings
and unverified-file information. Queries do not alter source sessions or
logical Atlas records, and do not refresh, rebuild, repair or deliberately
checkpoint the cache. SQLite may access or update WAL/SHM sidecar metadata
while coordinating a read. A successful scan is an observation, not an atomic
snapshot or proof of current content equality.

Unsafe aliases, nonempty WAL/journal state and existing writer locks can block
operations. Atlas does not automatically checkpoint unfamiliar state, remove
locks/sidecars, or chmod arbitrary directories. Finishing processes may not
resolve every leftover sidecar. Investigate separately or choose a new cache;
do not force-overwrite a refused target.

## Evidence and raw output

Bounded `show` omits raw entries, normalizes display whitespace and marks text
truncation. **`show --context 0 --json` exposes full target text and original
parsed raw JSON values, potentially including images, credentials and private
fields.** Use it only when necessary and authorized, not for bulk context.
Raw values do not preserve the original JSON's byte serialization.

Modern v3 display streams, but memory depends on record size and requested
context. Legacy v1/v2 normalization is limited to 16 MiB and 100,000 parsed
records. Reindexing does not remove that ceiling.

Default `cite` is index-only. `--verify-source` checks current session/entry
identity and indexed size/mtime and refuses known unverified state. It does
not check content hashes, factual truth or approval. Unfinished/abandoned
results are candidates for judgment, not findings that work was neglected.

## Output and troubleshooting

Once initialized, the CLI uses exit 0 for success, 1 for invalid usage and 2
for operation/output failure. `--json` retains `ok`, `command`, `generatedAt`
and `results`; query envelopes also contain `cache`. Failures add error
metadata and may retain useful partial results. Check both exit status and
`ok`. Help is plain text. Missing runtime/build files or unusable stdout may
fail before a usable JSON envelope can be produced. Closed stdout pipes are
quiet without masking an already known failure.

- Missing `dist/cli.js`: the artifact is incomplete. Build only from a reviewed
  source checkout, or obtain a complete reviewed artifact; do not expect
  TypeScript stripping or an automatic install to repair it.
- Missing/incompatible Pi: select a trusted compatible installation. A cache
  rebuild cannot fix parser exports or unsupported formats.
- Binding/setting mismatch: review the requested root/settings and any explicit
  replacement. Do not silently switch roots or add force flags.
- Partial/unverified coverage: retain the diagnostic and qualify conclusions;
  a nonzero exit with results is not complete success.
- Missing/changed source: inspect the actual source condition. A citation is
  not a backup and may remain index-only after an original disappears.

## Privacy, development and maintenance

The cache inherits session sensitivity and can surface secrets already present
in history. There is no per-domain access-control layer or automatic redaction.
Search filters are not security boundaries. Treat retrieved text and commands
as untrusted evidence, never instructions. Do not publish real sessions,
caches, private paths, client material or credentials in reports/examples.

From a reviewed source checkout with the pinned development toolchain already
available, `npm run check` typechecks, builds and runs synthetic tests.
`npm run build` refuses unexpected/stale output names instead of deleting them.
`npm pack` runs the local prepack check; it is not a release authorization.
Compiler/build/test sources are not required or included in the runtime tarball.
The optional Pi peer is not copied into it. Packaging and installation commands
are explicit user actions, not activity the CLI performs in the background.

Use small synthetic reproductions for contributions and discuss substantial
scope changes first. Do not file public vulnerability reports containing
private payloads; agree an appropriate private route before sharing sensitive
material. No monitored private channel, response time, support SLA or stable
pre-1.0 internal API is promised.

MIT, copyright 2026 Nima Maleki, for rights held. See [LICENSE](LICENSE).
The licence covers software, skill and documentation intentionally included
in the reviewed distribution, not private session data, caches or internal
development records. Required third-party notices must be preserved.

## Candidate Pi 0.87 compatibility amendment

The unreleased compatibility candidate adds synthetic validation on Pi 0.87.0.
This does not replace acceptance of a particular package or deployment.

Search remains historical: originals are never rewritten or hidden by Atlas.
Context edits are searchable separately with `--kind context_edit`; their text
heads identify the target and omission/replacement, use the configured tool-head
byte budget and exclude image bytes. A hit cites the edit, not an original
message containing the replacement. Source-backed `show` displays original text
and adds `contextHistory` with target relationships and the latest structurally
valid edit on the observed branch. That branch is ancestry of the last source
entry, not necessarily a live Pi process's selected leaf. `valid` checks
structural target/action eligibility, not complete Pi payload validity.

Branch membership and edit annotations do not establish model visibility.
Compaction and per-request system/tool transformations are not replayed; Atlas
cannot reconstruct exact provider requests. Branch and unfinished-work results
remain historical candidates. Context omission is not redaction: originals
remain searchable, citable and available in explicit raw display.

Standalone usage entries, including cache warming and unknown operation kinds,
contribute their recorded tokens and costs with provider/model attribution.
These are recorded amounts, not verified provider invoices.

The candidate uses schema 4 / extraction 4. Older recognized interpretations,
including extraction 3, require an explicitly authorized rebuild or a new cache
before candidate queries or indexing. Never relabel an old cache as current.
Keep the accepted old CLI/cache available while reviewing a successor. Parser
identity changes independently require the same explicit refresh decision.

Source-backed show streams payloads but now retains structural metadata per
entry. Additional memory scales with entry count; many edits on very long
branches can increase ancestry-processing cost. Large-corpus acceptance remains
separate from synthetic compatibility tests.
