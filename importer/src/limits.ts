import { INSTRUMENT_ICON_MAX_BASE64_CHARS } from "@kerdial/core-reference-data";

/**
 * Every tunable the importer has, in one file.
 *
 * The rule, kept: a limit ships with the change that first makes it bind, and
 * with the test that shows it is not inert. Batch B made two of the six bind —
 * the discovery pair — and Batch C's `applyImport` makes the third, the apply
 * deadline. Batch D (CI-19) makes the remaining three bind, because the HTTP
 * surface is the first thing that can reach them: `IMPORT_MAX_FILE_BYTES` is
 * `@fastify/multipart`'s own `limits.fileSize` in `api/src/app.ts`,
 * `IMPORT_MAX_ROWS` is checked against the parsed row count before `plan`
 * touches a database, and `IMPORT_MAX_ROW_DETAILS` caps the response's
 * per-row array.
 *
 * **Every value below is passed through {@link ImportLimits} rather than read
 * from module scope.** That is not indirection for its own sake: this
 * project's standing rule is that a tunable must be proved to bind by
 * measuring a downstream effect **at two different values**, and a constant
 * read directly from module scope can only be asserted, never varied.
 * `instrument-resolution.test.ts` runs the same fixture at two budgets and two
 * deadlines and watches the outcome counts move;
 * `apply.integration.test.ts` runs the same plan at two apply deadlines and
 * watches `APPLY_NOT_ATTEMPTED` move.
 */

/**
 * How many discovery lookups one import request may issue in total
 * (**ESTIMATE**).
 *
 * 16 is sized for a typical personal asset file's dozen-odd rows that need a
 * lookup (unsuffixed or unknown-suffix equities, plus a few coins); the
 * committed fixture needs 19 calls on purpose, so the budget is seen to bind.
 * It is a *call* budget, not a *row* budget: a crypto row that is queried by
 * name and then by symbol spends two, and a retried rate-limited lookup spends
 * another. Counting calls is what makes the budget a bound on the thing that
 * actually costs — the provider token bucket is `capacity: 2,
 * refillPerSecond: 0.5` and non-blocking, so the third call inside two seconds
 * throws.
 */
const IMPORT_DISCOVERY_LOOKUP_BUDGET = 16;

/**
 * Wall-clock stop line for the whole discovery phase of one import
 * (**ESTIMATE**). Deliberately a third of the 30 s handler
 * timeout, so the deadline is reached and reported rather than the request
 * being killed mid-flight.
 *
 * Rows whose lookup was never attempted because this line was crossed reject
 * with `EXCHANGE_MIC_LOOKUP_UNAVAILABLE`, not `EXCHANGE_MIC_NOT_RESOLVED` —
 * the remedy differs (re-run versus give up), and re-running is the
 * designed remedy.
 */
const IMPORT_DISCOVERY_DEADLINE_MS = 10_000;

/**
 * Wall-clock stop line for the **whole request**, measured from the moment the
 * request arrived, past which `applyImport` writes no further rows.
 *
 * 25 000 ms sits under the 30 000 ms `handlerTimeout`/`connectionTimeout`/
 * `requestTimeout` triple (`api/src/app.ts:330,342,356`, VERIFIED), so the
 * user receives a **complete, honest summary of a partial import** instead of
 * a socket hang-up with no record of what landed. Rows already written stay
 * written — every `record*` commits on its own — and re-running the file skips
 * them, so the deadline degrades into "run it twice", never into "lose
 * data".
 *
 * Not an ESTIMATE in the sense the two values above are: GATE-1
 * (`ledger/src/import-throughput.benchmark.integration.test.ts`) measured a
 * 309-row import of the real profile at ~6.9 s against real Postgres, so this
 * line is roughly 3.5× the measured cost of the largest corpus this cycle
 * targets. It is a backstop for a loaded runner, not the expected path.
 *
 * ## The post-chunking measurement (EI-23, 2026-09-24)
 *
 * That 309-row figure **predates the chunked apply**, and the file that produced it no
 * longer exists (deleted by the test-diet cycle). The current numbers are
 * `pipeline/kerdial-throughput.integration.test.ts`'s, MEASURED against a real
 * Postgres container over full-fidelity Kerdial rows at
 * {@link IMPORT_APPLY_CHUNK_ROWS} = 50:
 *
 *   - **1 000 rows / 2 portfolios: 10 931 ms of apply = 91 rows/s**, 20 chunks,
 *     mean 547 ms/chunk;
 *   - **20 000 rows / 2 portfolios: 876 676 ms of apply = 23 rows/s**, 400
 *     chunks, mean 2 192 ms/chunk — first chunk 423 ms, last **5 123 ms**.
 *
 * **The rate falls as the file is consumed**, because the one recompute per
 * chunk replays the portfolio's whole timeline and that timeline is what the
 * import is growing. So this deadline is *not* "3.5× the expected cost" for a
 * Kerdial file at its own row ceiling: a 20 000-row file needs
 * `ceil(876 676 / 24 000)` ≈ **37 requests**, and the deadline's remedy —
 * "re-run the file and it imports the remainder" — is the designed path there
 * rather than a backstop. AC-436's "measured number of runs" is that figure.
 */
const IMPORT_APPLY_DEADLINE_MS = 25_000;

/**
 * How many consecutive transaction rows `applyImport` writes inside **one**
 * database transaction, with **one** portfolio recompute at the end of it
 * (`ledger`'s `TransactionWriteService.inWriteBatch`).
 *
 * **Not an ESTIMATE, and not a micro-optimisation.** Every `record*` ends in
 * `recomputeAndInvalidate`, which fully replays the portfolio's position
 * timeline; N rows written one at a time is N full replays over a timeline the
 * import is itself growing, which is quadratic. Batching makes it N/this.
 *
 * ## Why a chunk and not the whole file
 *
 * The chunk is the unit of **resumability** as much as of batching. A chunk
 * commits whole or not at all, which is what keeps two properties true at
 * once:
 *
 *   - every committed state is consistent (the write
 *     and its recompute commit together), and
 *   - {@link IMPORT_APPLY_DEADLINE_MS}'s remedy stays "re-run the file and it
 *     imports the remainder", now at chunk granularity.
 *
 * One transaction for the whole file would satisfy the first and destroy the
 * second: a file too slow for the budget would roll back entirely on every
 * attempt and never converge.
 *
 * ## Why 50
 *
 * The chunk holds this portfolio's row `FOR UPDATE` and the tenant's advisory
 * lock for its whole duration, so it is also how long a concurrent manual
 * write to the same portfolio can be made to wait. That is not a theoretical
 * consequence: `apply.cash-account-archive.integration.test.ts`'s third case
 * pins it — a `PATCH …/cash-accounts/:id {"archived": true}` arriving mid-chunk
 * cannot commit between two rows of it, and applies once the chunk does. 50
 * rows of writes is a fraction of a second even on the slow hardware this
 * change is for, and it already removes 98 % of the recomputes; a larger chunk
 * buys little and lengthens both that wait and the work a deadline throws
 * away.
 */
const IMPORT_APPLY_CHUNK_ROWS = 50;

/**
 * The largest upload one import request may carry (**ESTIMATE**), and `@fastify/multipart`'s `limits.fileSize` verbatim.
 *
 * 1 MiB, matching `api/src/app.ts`'s existing `REQUEST_BODY_LIMIT_BYTES`
 * (VERIFIED) — the same bound this API already places on every other request
 * body, so an upload is not quietly allowed to be larger than a JSON body.
 * Fastify's own `bodyLimit` does **not** apply here: a multipart request is
 * read by a custom content-type parser, and only the multipart plugin's own
 * limits bound a part.
 *
 * Measured rather than left as bare arithmetic: a personal export's
 * transaction file runs to tens of kilobytes, a few percent of this cap, so
 * it is an abuse bound, not a working constraint. The committed synthetic
 * fixture's three files are smaller still (**1 614**, **4 879** and **3 905**
 * bytes, `wc -c`).
 */
const IMPORT_MAX_FILE_BYTES = 1024 * 1024;

/**
 * The most data rows one import request may carry (**ESTIMATE**, OD-8(a)'s own suggested sizing). Over it, the request is refused whole
 * — `413`, nothing parsed further, nothing written.
 *
 * A row cap and a byte cap are not the same bound and neither implies the
 * other: 5 000 rows of this format are roughly 500 KB, so a file can be inside
 * the byte cap and outside this one, and a single enormous quoted field can be
 * outside the byte cap with two rows in it. A personal export's transaction
 * file runs to hundreds of rows, far below the cap.
 */
const IMPORT_MAX_ROWS = 5_000;

/**
 * How many per-row entries one response's `rows[]` may carry
 * (**ESTIMATE**). Past it the array is cut and
 * `rowsTruncated: true` is set.
 *
 * **The summary counts are never truncated with it.** `imported`/`skipped`/
 * `rejected`/`byReason` are folded over every row of the file; only the
 * per-row detail array — the thing that would make a 5 000-row rejection an
 * unbounded response body — is capped.
 */
const IMPORT_MAX_ROW_DETAILS = 1_000;

/** The tunables the pipeline reads, injected so a test can vary them (see this file's header). */
export interface ImportLimits {
  /** Total discovery calls this request may issue. See {@link IMPORT_DISCOVERY_LOOKUP_BUDGET}. */
  readonly discoveryLookupBudget: number;
  /** Wall-clock milliseconds the discovery phase may take. See {@link IMPORT_DISCOVERY_DEADLINE_MS}. */
  readonly discoveryDeadlineMs: number;
  /** Wall-clock milliseconds from the request's arrival past which `applyImport` writes nothing more. See {@link IMPORT_APPLY_DEADLINE_MS}. */
  readonly applyDeadlineMs: number;
  /** Transaction rows per write transaction, and per portfolio recompute. See {@link IMPORT_APPLY_CHUNK_ROWS}. */
  readonly applyChunkRows: number;
  /** Largest upload accepted, in bytes. See {@link IMPORT_MAX_FILE_BYTES}. */
  readonly maxFileBytes: number;
  /** Most data rows accepted. See {@link IMPORT_MAX_ROWS}. */
  readonly maxRows: number;
  /** Most per-row detail entries returned. See {@link IMPORT_MAX_ROW_DETAILS}. */
  readonly maxRowDetails: number;
}

/** The shipped values, as one object. Callers that have no reason to vary them pass this. */
export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  discoveryLookupBudget: IMPORT_DISCOVERY_LOOKUP_BUDGET,
  discoveryDeadlineMs: IMPORT_DISCOVERY_DEADLINE_MS,
  applyDeadlineMs: IMPORT_APPLY_DEADLINE_MS,
  applyChunkRows: IMPORT_APPLY_CHUNK_ROWS,
  maxFileBytes: IMPORT_MAX_FILE_BYTES,
  maxRows: IMPORT_MAX_ROWS,
  maxRowDetails: IMPORT_MAX_ROW_DETAILS,
};

/**
 * The Kerdial **transactions CSV** package's own set (L13/FR-535–FR-539).
 *
 * Injected through the same {@link ImportLimits} interface for the reason this
 * file's header gives and which applies unchanged here: a tunable must be
 * proved to bind by measuring a downstream effect **at two different values**,
 * and only an injected one can be varied. {@link DEFAULT_IMPORT_LIMITS} is
 * untouched by this set's existence — the Portfolio-Performance routes keep
 * 1 MiB / 5 000 / 25 s exactly.
 *
 * Five of the seven values are the Portfolio-Performance ones, and each is
 * **referenced rather than retyped**, so a change to either moves both together
 * instead of drifting:
 *
 *   - `applyChunkRows` is {@link IMPORT_APPLY_CHUNK_ROWS} — **unchanged
 *     deliberately, not by omission.** The chunk is the unit of resumability
 *     and the argument for 50 is in that constant's own comment; nothing in
 *     this cycle changes it, and it is not to be re-tuned here.
 *   - `applyDeadlineMs`, `discoveryLookupBudget`, `discoveryDeadlineMs` and
 *     `maxRowDetails` are the same constants for the same reasons.
 *
 * The two that differ:
 *
 *   - `maxFileBytes` — **MEASURED, and CONFIRMED at 8 MiB** (EI-23,
 *     2026-09-24). The original estimate was ~330 B/row and this
 *     ceiling's own arithmetic implied ~419 (8 388 608 / 20 000), at which the
 *     headroom would have been near zero. The real figure, taken from the
 *     shipped serializer's own output over full-fidelity rows — every extended
 *     column populated, a carried `import_fingerprint` on every row — is
 *     **276–277 bytes per row**, and a **20 000-row file came to 5 532 286
 *     bytes: 65,9 % of this cap, 34,1 % headroom**. No raise, because the
 *     measured value is comfortably inside it; the number is
 *     `pipeline/kerdial-throughput.integration.test.ts`'s, re-asserted in
 *     `limits.test.ts`. A text-heavy file still meets this cap before the row
 *     cap — this reader bounds a reference at 120 characters but leaves a note
 *     unbounded — which is the reason both bounds exist and neither implies the
 *     other.
 *   - `maxRows` — **ESTIMATE** (20 000): four portfolios at NFR-10's stated
 *     5 000 transactions per portfolio, which covers a household. It is **not**
 *     "NFR-10 × the 500-portfolio cap" (2 500 000), and that is deliberate.
 *     A tenant above it gets a `413` and the documented remedy — split
 *     the file by date range and import the pieces — which composes exactly,
 *     because merge-by-name is idempotent and fingerprint-skip makes an
 *     overlapping split harmless. **What EI-23 measured about this value, left
 *     for the owner rather than changed here:** a file at this ceiling takes
 *     **876 676 ms** of apply (MEASURED, 2026-09-24) and therefore ~37 requests
 *     of {@link IMPORT_APPLY_DEADLINE_MS}, because the per-chunk recompute cost
 *     grows with the timeline being imported. The row ceiling is a size bound,
 *     not a "one afternoon" bound, and the user document's split-by-date remedy
 *     is the faster path well before it.
 */
export const KERDIAL_CSV_LIMITS: ImportLimits = {
  discoveryLookupBudget: IMPORT_DISCOVERY_LOOKUP_BUDGET,
  discoveryDeadlineMs: IMPORT_DISCOVERY_DEADLINE_MS,
  applyDeadlineMs: IMPORT_APPLY_DEADLINE_MS,
  applyChunkRows: IMPORT_APPLY_CHUNK_ROWS,
  // MEASURED 2026-09-24 (EI-23): a 20 000-row full-fidelity file is 5 532 286
  // bytes, 65,9 % of this. Confirmed, not raised. See the doc comment above.
  maxFileBytes: 8_388_608,
  // ESTIMATE.
  maxRows: 20_000,
  maxRowDetails: IMPORT_MAX_ROW_DETAILS,
};

/**
 * The Kerdial **catalogue JSON** package's tunables.
 *
 * **A separate interface from {@link ImportLimits}, and stated rather than
 * quietly reshaped.** The catalogue has no rows, no per-row discovery and no
 * write batch — its apply is chunked in *entities* and its parse is bounded by
 * a per-string character ceiling neither of which {@link ImportLimits} has a
 * member for. Forcing it into that interface would mean inventing a `maxRows`
 * and a `discoveryLookupBudget` for a package that has neither, which is worse
 * than two interfaces. The two members both sets genuinely share are taken from
 * {@link ImportLimits} by `Pick`, so they cannot drift apart in name or type.
 *
 * The injection rule is unchanged: every value below is passed through this
 * interface rather than read from module scope, so each is testable at two
 * values (FR-539).
 */
export interface KerdialJsonLimits extends Pick<ImportLimits, "maxFileBytes" | "applyDeadlineMs"> {
  /** Catalogue entities upserted inside one database transaction. See {@link KERDIAL_JSON_LIMITS}. */
  readonly applyChunkEntities: number;
  /** Most per-entity detail entries returned; the counts are never truncated with them. */
  readonly maxEntityDetails: number;
  /** Longest base64 string the schema accepts on any field, applied **before** any decode. */
  readonly maxJsonStringChars: number;
}

/**
 * The shipped catalogue-JSON values.
 *
 *   - `maxFileBytes` — 32 MiB, from the icon arithmetic,
 *     **re-derived and CONFIRMED by EI-23 (2026-09-24)**. The three inputs are
 *     MEASURED constants, re-read that day rather than quoted:
 *     `INSTRUMENT_ICON_MAX_BYTES` 262 144 →
 *     {@link KerdialJsonLimits.maxJsonStringChars} 349 528 base64 characters
 *     (`core/reference-data/src/instrument-icon.ts:63,86`),
 *     `INSTRUMENT_ICON_TENANT_ROW_CAP` 500
 *     (`ledger/src/instrument-icon-service.ts:63`) and
 *     `MAX_PORTFOLIOS_PER_TENANT` 500 (`ledger/src/portfolio-service.ts:178`).
 *     So this ceiling admits **95 maximal icons** (33 554 432 / 349 528), and
 *     the realistic tenant — NFR-10's 200 instruments plus ~10
 *     portfolios, at 40 KiB each, i.e. 210 × 54 614 ≈ 11,5 MB — sits at **34 %
 *     of it**. The non-icon body is negligible beside that: GATE-1's whole
 *     catalogue document, icons included, measured **3 350 bytes** for six
 *     entities (MEASURED, `api/src/exports/exports.round-trip.integration.test.ts`),
 *     so 210 entities of body are ~0,3 % of this cap. **The 40 KiB per icon
 *     remains an ESTIMATE** — no icon corpus exists to measure — but the
 *     conclusion does not turn on it: the cap is an icon budget, it holds for
 *     every realistic tenant, and the pathological one is the designed
 *     `413 EXPORT_TOO_LARGE` with `?icons=omitted` as the remedy, never a
 *     truncated file. Unchanged at 32 MiB.
 *
 *     The reasoning behind the order of magnitude, recorded because it is
 *     the thing a reader will question: one request buffers the file,
 *     `JSON.parse` materialises an object graph over it and the schema builds a
 *     third validated copy, so peak memory is roughly 3–5× the file — 32 MiB
 *     puts the realistic worst case near 160 MiB and refuses the pathological
 *     one at the door. The deliberate non-remedy is recorded too: no per-route
 *     concurrency bound is added (SD-13/FR-554), because a per-tenant cap would
 *     bound a single-household instance at 1.
 *   - `applyDeadlineMs` — 25 000, sized under the MEASURED 30 000 ms
 *     handler/connection/request timeout triple exactly as
 *     {@link IMPORT_APPLY_DEADLINE_MS} is, and referencing that constant rather
 *     than repeating the number.
 *   - `applyChunkEntities` — **ESTIMATE** (200). A catalogue apply is upserts
 *     with no recompute, so the chunk is about resumability and lock duration
 *     rather than about the quadratic {@link IMPORT_APPLY_CHUNK_ROWS} exists to
 *     remove; it is deliberately **not** tied to that constant.
 *   - `maxEntityDetails` — mirrors {@link IMPORT_MAX_ROW_DETAILS} and is that
 *     constant, not a second copy of `1 000`.
 *   - `maxJsonStringChars` — **derived**, and derived *by import*: it is
 *     `INSTRUMENT_ICON_MAX_BASE64_CHARS` (MEASURED,
 *     `core/reference-data/src/instrument-icon.ts`, itself
 *     `4 * ceil(INSTRUMENT_ICON_MAX_BYTES / 3)` = 349 528). Writing `349_528`
 *     here instead would be a second hand-written copy that drifts the first
 *     time the byte ceiling moves — which is the exact failure that file's own
 *     comment records.
 */
export const KERDIAL_JSON_LIMITS: KerdialJsonLimits = {
  // Re-derived and confirmed 2026-09-24 (EI-23): 95 maximal icons, and the
  // realistic tenant at 34 % of it. See the doc comment above.
  maxFileBytes: 33_554_432,
  applyDeadlineMs: IMPORT_APPLY_DEADLINE_MS,
  // ESTIMATE.
  applyChunkEntities: 200,
  maxEntityDetails: IMPORT_MAX_ROW_DETAILS,
  maxJsonStringChars: INSTRUMENT_ICON_MAX_BASE64_CHARS,
};

/**
 * The one place `ApplyContext.deadlineAt` is derived, so the controller
 * (CI-16) and every test compute it the same way.
 *
 * `startedAt` is when the **request** arrived, not when `apply` began: the
 * budget this line protects is the 30 s handler timeout, which starts ticking
 * at the request, and parsing plus planning have already spent some of it by
 * the time `applyImport` is called.
 */
export function applyDeadlineAt(startedAt: Date, limits: ImportLimits): Date {
  return new Date(startedAt.getTime() + limits.applyDeadlineMs);
}
