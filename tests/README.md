# Test inventory

`npm test` runs `tests/*.test.ts`; `npm run check` also typechecks and builds.
The runner reports the current count. Test filenames describe behaviour, not
the Atlas release in which a test was introduced.

## Separate review probes

Files in `tests/review/` are retained explicit-run regressions and historical
acceptance probes, not part of the default-suite acceptance claim. The rename
does not promote them into that suite or change any assertion.

| File | Scope and status |
|---|---|
| `review/safety-boundary-probes.ts` | Four retained safety regressions; historical findings were adjudicated, not pending. |
| `review/query-and-boundary-probes.ts` | Six retained independent query/boundary regressions. |
| `review/timestamp-legacy-cache-probes.ts` | Three independently selectable calendar/record-kind/precision probes and two historical genuine-old-cache acceptance cases. |

The two genuine-old-cache cases require `ATLAS_REVIEW_LEGACY_BIN` pointing to a
verified extraction-1 artifact and the historical extraction-3 target. One
asserts that the rebuilt cache is extraction 3. They are **not current-release
acceptance** and must not be represented as passed against extraction 4. Their
assertions are retained, not relaxed. Current older-cache refusal/rebuild
regressions also exist in `timestamps.test.ts` and `context-edit-usage.test.ts`.

## Naming and provenance

`fixtures/atlas-v3-schema.sql` deliberately keeps its schema version. Session
format versions, parser-identity fixtures and old extraction values identify
actual compatibility cases; they are not stale Atlas release numbers.

The following lookup preserves the relationship to earlier review records and
Git history. Those records retain their original filenames and measurements.

| Earlier path under `tests/` | Current path |
|---|---|
| `prepublication-cache.test.ts` | [cache-safety.test.ts](cache-safety.test.ts) |
| `prepublication-cli.test.ts` | [cli-contracts.test.ts](cli-contracts.test.ts) |
| `prepublication-commands.test.ts` | [command-query-contracts.test.ts](command-query-contracts.test.ts) |
| `prepublication-evidence.test.ts` | [source-evidence-contracts.test.ts](source-evidence-contracts.test.ts) |
| `prepublication-package.test.ts` | [package-contracts.test.ts](package-contracts.test.ts) |
| `prepublication-support.ts` | [sandbox-support.ts](sandbox-support.ts) |
| `queries-m2.test.ts` | [retrieval-queries.test.ts](retrieval-queries.test.ts) |
| `queries-m3.test.ts` | [investigation-queries.test.ts](investigation-queries.test.ts) |
| `queries-m4.test.ts` | [report-queries.test.ts](report-queries.test.ts) |
| `pi-087.test.ts` | [context-edit-usage.test.ts](context-edit-usage.test.ts) |
| `review/unit-7-probes.ts` | [review/safety-boundary-probes.ts](review/safety-boundary-probes.ts) |
| `review/final-review-probes.ts` | [review/query-and-boundary-probes.ts](review/query-and-boundary-probes.ts) |
| `review/r6-successor-probes.ts` | [review/timestamp-legacy-cache-probes.ts](review/timestamp-legacy-cache-probes.ts) |
