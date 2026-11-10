import { Decimal } from "@kerdial/core-decimal";
import { createInstrumentByIsin, type TransactionWriteService } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { KerdialTypeCode } from "../formats/kerdial-csv/columns.js";
import {
  serializeKerdialTransactions,
  type ExportedTransactionRow,
} from "../formats/kerdial-csv/serialize.js";
import { KERDIAL_CSV_LIMITS } from "../limits.js";
import { applyImport, type ImportResult } from "./apply.js";
import { planImport, type ImportPlan } from "./plan.js";
import { systemClock } from "./ports.js";
import {
  buildKerdialWriteService,
  kerdialPlanContext,
  kerdialTally,
  parseKerdialBytes,
  seedBareTenant,
  type KerdialIds,
} from "./__tests__/kerdial-harness.js";

/**
 * **EI-23** — the post-chunked-apply throughput measurement and the CSV byte-ceiling
 * finalisation, against a real Postgres container.
 *
 * ## Why this file exists
 *
 * No wall clock is guessed: the one measured datum in
 * `limits.ts` is a **pre-chunking** 309-row Portfolio-Performance import at ~6.9 s,
 * and the chunked apply replaced one recompute per row with one per 50 — so nothing in this
 * repository knew what the shipped write path costs per row. GATE-1 (EI-22)
 * measured a 14-row fixture, which is too small a sample to extrapolate a
 * 20 000-row ceiling from. This file measures the real thing: a synthetic
 * full-fidelity file, serialized by the shipped writer, imported through
 * `planImport` + `applyImport` at `KERDIAL_CSV_LIMITS.applyChunkRows`.
 *
 * ## A tripwire, not a benchmark
 *
 * The measured figures are recorded in comments beside each assertion and in
 * `limits.ts` next to the constants they justify; the **assertions** are an
 * order of magnitude looser than the measurement, exactly as GATE-1's own
 * timing test is. The host is a shared, throttling flex instance, so an
 * assertion near the measurement would be a flake generator and a number in a
 * comment is what a later reader actually needs.
 *
 * ## The file is the serializer's own output
 *
 * The rows are built as {@link ExportedTransactionRow} — the export read
 * projection's own shape — and written by `serializeKerdialTransactions`, so
 * the bytes measured here are the bytes this product emits, not a hand-typed
 * approximation of them. Every row obeys `exports.reads.ts`'s own emission
 * rules (`cash_currency`/`cash_amount` only where the ledger's resolution table
 * calls them required; a pinned rate only where the source row pinned one),
 * which is why the file round-trips rather than being refused.
 */

const IDS: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-0000000e2301",
  userId: "00000000-0000-7000-8000-0000000e2302",
  sessionId: "00000000-0000-7000-8000-0000000e2303",
};
/** `security-transfer` R-6's tenant — the interleaved file is imported into a fresh one of its own. */
const IDS_INTERLEAVED: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-0000000e2304",
  userId: "00000000-0000-7000-8000-0000000e2305",
  sessionId: "00000000-0000-7000-8000-0000000e2306",
};

/**
 * How many cycles of {@link ROWS_PER_CYCLE} rows the fixture carries.
 *
 * 100 × 10 = **1 000 rows** over two portfolios, which costs this suite ~11 s
 * of apply (MEASURED below). The **20 000-row** ceiling case was run once, at
 * `CYCLES = 2000`, and its figures are recorded in this file and in `limits.ts`
 * — it is deliberately **not** what ships here: it took **876 676 ms** of apply
 * (MEASURED 2026-09-24), which no `pnpm test` run should pay. EI-31, the gate
 * that grades AC-436/AC-437 against the limit set, is where a ceiling-sized
 * fixture belongs.
 */
const CYCLES = 100;
/** The kinds one cycle emits, in order. Ten rows, eight kinds, two portfolios. */
const ROWS_PER_CYCLE = 10;
const ROW_COUNT = CYCLES * ROWS_PER_CYCLE;

const PORTFOLIO_A = "Portefeuille principal";
const PORTFOLIO_B = "Portefeuille secondaire";
const ACCOUNT_A_EUR = "Compte espèces euro";
const ACCOUNT_A_USD = "Compte espèces dollar";
const ACCOUNT_B_EUR = "Compte espèces courant";

/** Two EUR-listed instruments and one USD-listed one, so the FX legs are real. */
const ISIN_EUR = "FRKERDEI2301";
const ISIN_EUR_B = "FRKERDEI2302";
const ISIN_USD = "USKERDEI2303";
const MIC_EUR = "XPAR";
const MIC_USD = "XNYS";

/**
 * Every off-base leg pins its own rate, so `FxRateResolver` never reaches a
 * provider — `buildKerdialWriteService`'s stubs throw, which turns "the
 * measurement never waited on a network call" into a code-path property rather
 * than a hope.
 */
const PINNED_RATE = "1.234567";

const d = (value: string): Decimal => new Decimal(value);

/** One measured run of the whole file. */
interface Measured {
  readonly bytes: number;
  readonly headerBytes: number;
  readonly parseMs: number;
  readonly planMs: number;
  readonly applyMs: number;
  readonly chunkMs: readonly number[];
  readonly plan: ImportPlan;
  readonly result: ImportResult;
}

describe("EI-23 — Kerdial CSV throughput and byte-per-row, measured against real Postgres", () => {
  let pg: MigratedPostgres;
  let db: Db;
  let run: Measured;
  let rows: readonly ExportedTransactionRow[];

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedBareTenant(pg, IDS);
    for (const [isin, mic, currency] of [
      [ISIN_EUR, MIC_EUR, "EUR"],
      [ISIN_EUR_B, MIC_EUR, "EUR"],
      [ISIN_USD, MIC_USD, "USD"],
    ] as const) {
      await createInstrumentByIsin(db, {
        kind: "SHARE",
        isin,
        exchangeMic: mic,
        listingCurrency: currency,
        displayName: `EI-23 ${isin}`,
      });
    }

    rows = buildFullFidelityRows(CYCLES);
    run = await measure(rows, IDS);

    // Printed rather than only asserted: the figures below are this suite's
    // deliverable, and a later re-measurement on different hardware needs the
    // command's own output to compare against.
    console.log(report("EI-23", run, rows));
  }, 900_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  describe("the measurement is of a correct import, not of a fast refusal", () => {
    it("imports every row of the file, with nothing failed and nothing unattempted", () => {
      expect(kerdialTally(run.plan.outcomes)).toStrictEqual({ IMPORT: ROW_COUNT });
      expect(kerdialTally(run.result.outcomes)).toStrictEqual({ IMPORT: ROW_COUNT });
      expect(run.result.applyFailed).toBe(0);
      expect(run.result.applyNotAttempted).toBe(0);
    });

    it("wrote every row through the chunked write path, one portfolio per chunk", () => {
      // `applyOrder` sorts by portfolio, so the chunk count is the per-portfolio
      // row counts divided by the chunk size and rounded up, never fewer.
      expect(run.chunkMs.length).toBeGreaterThanOrEqual(
        Math.ceil(ROW_COUNT / KERDIAL_CSV_LIMITS.applyChunkRows),
      );
    });
  });

  describe("throughput, and the run count AC-436 cites", () => {
    it("stays inside a bound an order of magnitude looser than the measurement", () => {
      // **MEASURED 2026-09-24**, shared-container lane, this exact fixture
      // (1 000 full-fidelity rows, 2 portfolios, 3 accounts, chunk 50):
      //
      //   parse 56 ms · plan 42 ms · apply 10 931 ms = **91 rows/s**
      //   20 chunks, mean 547 ms/chunk (first 612, last 374)
      //
      // and, once, at `CYCLES = 2000` — **the 20 000-row ceiling case**:
      //
      //   parse 553 ms · plan 444 ms · apply **876 676 ms** = **23 rows/s**
      //   400 chunks, mean 2 192 ms (first 423, last 5 123;
      //   first-half mean 809, second-half mean 3 574)
      //
      // **The rate is not constant, and that is the finding.** The chunked apply's one
      // recompute per chunk replays the portfolio's whole timeline, so a chunk
      // costs more the further into the file it lands: 12x between the first
      // and the last chunk of the 20 000-row run. A rate extrapolated from
      // 1 000 rows (91 rows/s) overstates the ceiling case by 4x — which is
      // exactly why this number was never guessed.
      //
      // **The run count AC-436 cites** (EI-31 must use this, not an assumed
      // one): with `applyDeadlineMs` 25 000 measured from the request's
      // arrival and ~1 000 ms of it spent on parse + plan, one request has
      // ~24 000 ms of apply, so a 20 000-row file needs
      // `ceil(876 676 / 24 000)` = **37 runs**, ~38 once each run's
      // chunk-boundary waste is counted, and more once each re-run's own
      // growing skip cost is. It is a lower bound, stated as one.
      //
      // The bounds below are ~11x the 1 000-row measurement: a tripwire for a
      // regression of an order of magnitude, not a benchmark.
      expect(run.applyMs).toBeLessThan(120_000);
      expect(run.parseMs).toBeLessThan(5_000);
      expect(run.planMs).toBeLessThan(10_000);
    });
  });

  describe("the byte ceiling, measured against the shipped writer", () => {
    it("has a mean bytes-per-row well under the ceiling's own 419 B/row assumption", () => {
      const meanBytesPerRow = Math.round((run.bytes - run.headerBytes) / ROW_COUNT);
      // **MEASURED 2026-09-24**: **276 B/row** over this fixture (276 786 bytes
      // for 1 000 rows, header 506), and **277 B/row** over the 20 000-row run,
      // whose whole file came to **5 532 286 bytes** — **65,9 % of the 8 MiB
      // `maxFileBytes`, so 34,1 % headroom**, measured rather than estimated.
      // `maxFileBytes / maxRows` assumes 419,4 B/row and the original estimate was
      // ~330; the real full-fidelity row is 66 % of the first and 84 % of the
      // second. The ceiling is **confirmed, not raised** — see `limits.ts`.
      expect(meanBytesPerRow).toBeGreaterThan(200);
      expect(meanBytesPerRow).toBeLessThan(
        Math.floor(KERDIAL_CSV_LIMITS.maxFileBytes / KERDIAL_CSV_LIMITS.maxRows),
      );
      // The whole ceiling, stated as the thing it protects: a file of
      // `maxRows` rows of this shape fits, with headroom.
      expect(meanBytesPerRow * KERDIAL_CSV_LIMITS.maxRows).toBeLessThan(
        KERDIAL_CSV_LIMITS.maxFileBytes,
      );
    });

    it("carries every tier on the file it measured, so the mean is a full-fidelity one", () => {
      // A mean taken over minimal rows would be meaninglessly small. Asserted
      // on the rows rather than on the text: each of these is a tier-X column
      // the exporter fills only when the source row had it.
      expect(rows.filter((row) => row.importFingerprint !== null)).toHaveLength(ROW_COUNT);
      expect(rows.filter((row) => row.note !== null)).toHaveLength(ROW_COUNT);
      expect(rows.filter((row) => row.reference !== null)).toHaveLength(ROW_COUNT);
      expect(rows.filter((row) => row.tradeTs !== null)).toHaveLength(ROW_COUNT);
      expect(rows.filter((row) => row.fxRateSource === "USER_PINNED").length).toBeGreaterThan(0);
      expect(rows.filter((row) => row.brokerFee !== null).length).toBeGreaterThan(0);
      expect(rows.filter((row) => row.withholdingAmount !== null).length).toBeGreaterThan(0);
      expect(rows.filter((row) => row.targetCurrency !== null).length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.kind)).size).toBeGreaterThanOrEqual(8);
      expect(new Set(rows.map((row) => row.portfolioName)).size).toBe(2);
    });
  });

  describe("security-transfer R-6 — an interleaved file with a transfer pair every day (ST-12)", () => {
    /**
     * The same ten-row cycle **plus a linked pair per cycle** — Portefeuille
     * principal → Portefeuille secondaire, a source row and its target row — so
     * the plan takes ST-12's chronological order, whose chunks span both
     * portfolios. Same 100 cycles, so 1 200 rows against the case
     * above's 1 000.
     *
     * **What this measures is the cost ST-12 moves, and why a small fixture
     * understates it.** Every recompute replays a portfolio's whole timeline,
     * so its cost grows with the file, and a file of linked pairs pays more of
     * them than a portfolio-first one: one per quantity-checked row (a SELL or
     * a TRANSFER_OUT flushes its own portfolio first) plus one per portfolio
     * per chunk. The report line prints the first- and second-half chunk means
     * so the growth is measured on this run rather than assumed.
     */
    let interleaved: Measured;
    let interleavedRows: readonly ExportedTransactionRow[];

    beforeAll(async () => {
      await seedBareTenant(pg, IDS_INTERLEAVED);
      interleavedRows = buildFullFidelityRows(CYCLES, { transfers: true });
      interleaved = await measure(interleavedRows, IDS_INTERLEAVED);
      console.log(report("R-6", interleaved, interleavedRows));
    }, 900_000);

    it("imports every row, each pair as one write whose target row is covered by it", () => {
      expect(kerdialTally(interleaved.result.outcomes)).toStrictEqual({
        IMPORT: CYCLES * (ROWS_PER_CYCLE + 1),
        COVERED_BY_TRANSFER_OUT: CYCLES,
      });
      expect(interleaved.result.applyFailed).toBe(0);
      expect(interleaved.result.applyNotAttempted).toBe(0);
    });

    it("writes it in full-size chunks that span both portfolios, not one chunk per portfolio change", () => {
      // Every written row is a transaction row (the covered target rows write
      // nothing of their own), so the chunk count is exactly the written rows
      // over the chunk size. Before the chunk-merging change a chunk ended at every portfolio change:
      // 201 chunks for this file, 801 at 400 cycles.
      expect(interleaved.chunkMs.length).toBe(
        Math.ceil((CYCLES * (ROWS_PER_CYCLE + 1)) / KERDIAL_CSV_LIMITS.applyChunkRows),
      );
    });

    it("stays inside a bound an order of magnitude looser than the measurement", () => {
      // **MEASURED 2026-09-30**, shared-container lane, this fixture (1 200
      // rows, 100 linked pairs, 2 portfolios), in the same run as the
      // portfolio-first case above:
      //
      //   interleaved     1 200 rows  apply 15 668 ms = 77 rows/s
      //                   201 chunks, mean 78 ms (first half 65, second 91)
      //   portfolio-first 1 000 rows  apply  9 780 ms = 102 rows/s, 20 chunks
      //
      // and once, at 400 cycles — **4 800 interleaved rows** — not shipped:
      //
      //   apply 222 956 ms = **22 rows/s**, 801 chunks, mean 278 ms
      //   (first 86, last 312; first half 135, second half 421)
      //
      // **The rate falls with the file, faster than portfolio-first's does**:
      // 4x the rows cost 14x the time. ST-12 multiplies the chunk count by ~10
      // and each chunk's recompute still replays its portfolio's whole
      // timeline, so the cost is quadratic in the file with ten times the
      // constant. Extrapolated (not measured) to the 20 000-row ceiling at the
      // same per-chunk growth: ~65 min of apply, ~160 automatic continuations
      // — against 876 676 ms / 37 runs portfolio-first. The apply continuation is
      // the fallback, and it still converges: every chunk commits whole.
      //
      // The same portfolio-first fixture measured 20 089 ms earlier the same
      // day (a 2x swing on this throttling host), so the bound is ~19x the
      // 1 200-row figure: a tripwire for an order of magnitude, not a benchmark.
      //
      // **The chunk-merging change, MEASURED 2026-10-07** at 400 cycles, same host, sequential runs
      // (interleaved 4 800 rows / portfolio-first 4 000 rows):
      //
      //   main                         144 925 ms = 33 rows/s / 65 196 ms
      //   + reconcile only disposals   120 890 ms, 1 601 recomputes
      //     on/after minTradeDate      (reconcile 21 317 ms -> 547 ms)
      //   + chunks span portfolios     124 680 ms, 1 664 recomputes
      //   + a quantity check flushes   110 548 ms = 43 rows/s, 936 recomputes
      //     only its own portfolio     / 61 840 ms portfolio-first, unchanged
      //
      // The remaining gap to portfolio-first is the recompute count: one more
      // quantity-checked row per pair, each replaying a growing timeline.
      expect(interleaved.applyMs).toBeLessThan(INTERLEAVED_APPLY_BOUND_MS);
    });
  });

  /* ----------------------------------------------------------- measurement */

  async function measure(
    source: readonly ExportedTransactionRow[],
    ids: KerdialIds,
  ): Promise<Measured> {
    const text = serializeKerdialTransactions(source);
    const bytes = new TextEncoder().encode(text);
    const headerBytes = new TextEncoder().encode(serializeKerdialTransactions([])).byteLength;

    const parseStartedAt = performance.now();
    const parsed = parseKerdialBytes(bytes);
    const parseMs = performance.now() - parseStartedAt;

    const planStartedAt = performance.now();
    const plan = await planImport(
      parsed,
      kerdialPlanContext(db, ids.tenantId, { mode: "APPLY", limits: KERDIAL_CSV_LIMITS }),
    );
    const planMs = performance.now() - planStartedAt;

    const { writes } = buildKerdialWriteService(db, ids.tenantId);
    const timed = timingChunks(writes);
    const applyStartedAt = performance.now();
    const result = await applyImport({
      plan,
      db,
      writes: timed.writes,
      destination: null,
      tenantId: ids.tenantId,
      updatedBySessionId: ids.sessionId,
      // The deadline is effectively disabled: this run measures the cost, and a
      // run cut short by the real 25 s line would measure the line instead.
      deadlineAt: new Date(Date.now() + 3_600_000),
      clock: systemClock,
      chunkRows: KERDIAL_CSV_LIMITS.applyChunkRows,
    });
    const applyMs = performance.now() - applyStartedAt;

    return {
      bytes: bytes.byteLength,
      headerBytes,
      parseMs,
      planMs,
      applyMs,
      chunkMs: timed.chunkMs,
      plan,
      result,
    };
  }

  /** The printed report line, built from the run itself. */
  function report(
    label: string,
    measured: Measured,
    source: readonly ExportedTransactionRow[],
  ): string {
    const rowCount = source.length;
    const chunks = measured.chunkMs.length;
    const rowsPerSecond = Math.round((rowCount * 1000) / measured.applyMs);
    const meanChunkMs = Math.round(measured.applyMs / Math.max(chunks, 1));
    const half = Math.floor(chunks / 2);
    const meanOf = (slice: readonly number[]): number =>
      Math.round(slice.reduce((total, one) => total + one, 0) / Math.max(slice.length, 1));
    return [
      `${label} rows=${String(rowCount)} bytes=${String(measured.bytes)} ` +
        `header=${String(measured.headerBytes)} ` +
        `meanBytesPerRow=${String(Math.round((measured.bytes - measured.headerBytes) / rowCount))}`,
      `${label} parseMs=${String(Math.round(measured.parseMs))} ` +
        `planMs=${String(Math.round(measured.planMs))} ` +
        `applyMs=${String(Math.round(measured.applyMs))} rowsPerSecond=${String(rowsPerSecond)}`,
      `${label} chunks=${String(chunks)} meanChunkMs=${String(meanChunkMs)} ` +
        `firstChunkMs=${String(Math.round(measured.chunkMs[0] ?? 0))} ` +
        `lastChunkMs=${String(Math.round(measured.chunkMs.at(-1) ?? 0))} ` +
        `firstHalfMeanMs=${String(meanOf(measured.chunkMs.slice(0, half)))} ` +
        `secondHalfMeanMs=${String(meanOf(measured.chunkMs.slice(half)))}`,
      `${label} rowsPer25sRequest≈${String(Math.round((rowsPerSecond * 25_000) / 1000))} ` +
        `(at this fixture's rate, before the per-chunk growth below is applied)`,
    ].join("\n");
  }
});

/**
 * `inWriteBatch`, timed. The proxy is `kerdial-harness.ts`'s `recordingBatches`
 * shape, including its `#private`-field trap: every method is bound to the real
 * service rather than reached through the receiver.
 */
function timingChunks(writes: TransactionWriteService): {
  readonly writes: TransactionWriteService;
  readonly chunkMs: number[];
} {
  const chunkMs: number[] = [];
  const proxy = new Proxy(writes, {
    get(target, property, receiver) {
      void receiver;
      if (property === "inWriteBatch") {
        return async (run: (batch: unknown) => Promise<void>): Promise<void> => {
          const startedAt = performance.now();
          try {
            await target.inWriteBatch(run as Parameters<typeof target.inWriteBatch>[0]);
          } finally {
            chunkMs.push(performance.now() - startedAt);
          }
        };
      }
      const value: unknown = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  return { writes: proxy, chunkMs };
}

/* -------------------------------------------------------------- the fixture */

/**
 * `CYCLES` repetitions of a ten-row cycle: eight kinds over two portfolios and
 * three cash accounts, every row carrying the extended tier (a time, a
 * reference, a note, a carried fingerprint) and each kind carrying its own
 * legs — the cost itemisation, the withholding leg, the exchange's target leg.
 *
 * The carried fingerprints are L17's channel: a backup of a tenant that
 * was itself restored carries one per row, which is both the realistic case for
 * this format and the byte-heaviest one, so the mean measured over it is a
 * conservative input to the ceiling arithmetic.
 *
 * **The one leg deliberately absent is the settlement one** (the asset-settled
 * acquisition, FR-66). Its four columns are the only tier-X group no row here
 * fills, and leaving it out *raises* the measured mean rather than flattering
 * it: such a row carries no unit price and no ISO currency, so it is a shorter
 * line than the ordinary acquisition it would replace.
 */
function buildFullFidelityRows(
  cycles: number,
  options: { readonly transfers?: true } = {},
): readonly ExportedTransactionRow[] {
  const rows: ExportedTransactionRow[] = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const date = dateOfCycle(cycle);
    const dividendRef = `d${String(cycle)}`;
    const cycleStart = rows.length;
    // The portfolio-first fixture's clock cycles every 25 rows, which with a
    // ten-row cycle never puts a reinvestment's time before its dividend's; a
    // twelve-row cycle would, on some days — a hand-authored-file artefact an
    // export cannot produce. The interleaved fixture keeps each day's clock
    // monotone instead, and the portfolio-first one is left exactly as measured.
    const minuteOf = (): number =>
      30 + (options.transfers === true ? rows.length - cycleStart : rows.length % 25);
    const push = (partial: Partial<ExportedTransactionRow> & { kind: KerdialTypeCode }): void => {
      rows.push({
        ...emptyRow,
        tradeDate: date,
        tradeTs: new Date(`${date}T08:${String(minuteOf()).padStart(2, "0")}:00Z`),
        seq: rows.length + 1,
        reference: `REF-${date.split("-").join("")}-${String(rows.length).padStart(6, "0")}`,
        note: "Ordre transmis depuis l'application mobile",
        importFingerprint: `kd1:${String(rows.length).padStart(64, "0")}`,
        ...partial,
      });
    };

    push({
      kind: "DEPOSIT",
      portfolioName: PORTFOLIO_A,
      cashAccountName: ACCOUNT_A_EUR,
      cashAccountCurrency: "EUR",
      grossAmount: d("5000"),
      currency: "EUR",
    });
    push({
      kind: "BUY",
      portfolioName: PORTFOLIO_A,
      cashAccountName: ACCOUNT_A_EUR,
      cashAccountCurrency: "EUR",
      instrument: { isin: ISIN_EUR, exchangeMic: MIC_EUR, symbol: null },
      quantity: d("12"),
      unitPrice: d("87.6543"),
      currency: "EUR",
      ...costLeg,
    });
    push({
      kind: "SELL",
      portfolioName: PORTFOLIO_A,
      cashAccountName: ACCOUNT_A_EUR,
      cashAccountCurrency: "EUR",
      instrument: { isin: ISIN_EUR, exchangeMic: MIC_EUR, symbol: null },
      quantity: d("3"),
      unitPrice: d("95.2109"),
      currency: "EUR",
      ...costLeg,
    });
    push({
      kind: "DIVIDEND",
      portfolioName: PORTFOLIO_A,
      cashAccountName: ACCOUNT_A_USD,
      cashAccountCurrency: "USD",
      instrument: { isin: ISIN_USD, exchangeMic: MIC_USD, symbol: null },
      grossAmount: d("42.75"),
      currency: "USD",
      fxRate: d(PINNED_RATE),
      fxRateSource: "USER_PINNED",
      withholdingAmount: d("6.41"),
      rowRef: dividendRef,
    });
    push({
      kind: "DRIP",
      portfolioName: PORTFOLIO_A,
      cashAccountName: ACCOUNT_A_USD,
      cashAccountCurrency: "USD",
      instrument: { isin: ISIN_USD, exchangeMic: MIC_USD, symbol: null },
      quantity: d("0.4"),
      unitPrice: d("90.125"),
      currency: "USD",
      fxRate: d(PINNED_RATE),
      fxRateSource: "USER_PINNED",
      dripOf: dividendRef,
      ...costLeg,
    });
    push({
      kind: "CURRENCY_EXCHANGE",
      portfolioName: PORTFOLIO_A,
      cashAccountName: ACCOUNT_A_EUR,
      cashAccountCurrency: "EUR",
      grossAmount: d("250"),
      currency: "EUR",
      targetCurrency: "USD",
      targetAmount: d("308.64175"),
      exchangeRate: d(PINNED_RATE),
      targetCashAccountName: ACCOUNT_A_USD,
      ...costLeg,
    });
    push({
      kind: "SHARE_DISTRIBUTION",
      portfolioName: PORTFOLIO_A,
      instrument: { isin: ISIN_EUR, exchangeMic: MIC_EUR, symbol: null },
      quantity: d("1"),
      grossAmount: d("5.25"),
      currency: "EUR",
    });
    push({
      kind: "DEPOSIT",
      portfolioName: PORTFOLIO_B,
      cashAccountName: ACCOUNT_B_EUR,
      cashAccountCurrency: "EUR",
      grossAmount: d("3000"),
      currency: "EUR",
    });
    push({
      kind: "BUY",
      portfolioName: PORTFOLIO_B,
      cashAccountName: ACCOUNT_B_EUR,
      cashAccountCurrency: "EUR",
      instrument: { isin: ISIN_EUR_B, exchangeMic: MIC_EUR, symbol: null },
      quantity: d("5"),
      unitPrice: d("45.5"),
      currency: "EUR",
      ...costLeg,
    });
    push({
      kind: "WITHDRAWAL",
      portfolioName: PORTFOLIO_B,
      cashAccountName: ACCOUNT_B_EUR,
      cashAccountCurrency: "EUR",
      grossAmount: d("120.5"),
      currency: "EUR",
    });
    if (options.transfers === true) {
      // `security-transfer` R-6: 2 of the day's 10 net units of the EUR share
      // move from A to B, at the end of the day — after every other row of it,
      // so the source always holds them. The target row carries the cost the
      // export writes; the import recomputes it rather than reading it.
      const label = `t${String(cycle)}`;
      const transferAt = new Date(`${date}T20:00:00Z`);
      const leg = {
        tradeTs: transferAt,
        instrument: { isin: ISIN_EUR, exchangeMic: MIC_EUR, symbol: null },
        quantity: d("2"),
        grossAmount: d("181.2"),
        currency: "EUR",
      } as const;
      push({ ...leg, kind: "TRANSFER_OUT", portfolioName: PORTFOLIO_A, rowRef: label });
      push({
        ...leg,
        kind: "TRANSFER_IN",
        portfolioName: PORTFOLIO_B,
        transferOf: label,
        transferCostBase: d("170.5"),
        transferCostNative: d("170.5"),
        transferCostCurrency: "EUR",
      });
    }
  }
  return rows;
}

/**
 * R-6's bound, **~19x the 1 200-row interleaved measurement** (see the case's
 * own comment) — the same posture as the portfolio-first case's bounds: a
 * tripwire for an order of magnitude, not a benchmark, because the host
 * throttles.
 */
const INTERLEAVED_APPLY_BOUND_MS = 300_000;

/** One calendar day per cycle, from a date inside the 25-year trade-date floor. */
function dateOfCycle(cycle: number): string {
  const day = new Date(Date.UTC(2021, 0, 4) + cycle * 86_400_000);
  return day.toISOString().slice(0, 10);
}

/** The four itemised costs and their combined total — the exporter writes both. */
const costLeg = {
  feeAmount: d("8.35"),
  brokerFee: d("4.95"),
  fxFee: d("1.25"),
  tradeTax: d("1.65"),
  otherCost: d("0.5"),
} as const;

/** Every column absent; each builder above overrides the ones its kind carries. */
const emptyRow: ExportedTransactionRow = {
  kind: "DEPOSIT",
  tradeDate: "2021-01-04",
  tradeTs: null,
  seq: 0,
  portfolioName: PORTFOLIO_A,
  cashAccountName: null,
  cashAccountCurrency: null,
  instrument: null,
  quantity: null,
  unitPrice: null,
  grossAmount: null,
  currency: null,
  feeAmount: null,
  brokerFee: null,
  fxFee: null,
  tradeTax: null,
  otherCost: null,
  cashCurrency: null,
  cashAmount: null,
  fxRate: null,
  fxRateSource: null,
  withholdingAmount: null,
  targetCurrency: null,
  targetAmount: null,
  exchangeRate: null,
  targetCashAccountName: null,
  settlement: null,
  settlementAmount: null,
  rowRef: null,
  dripOf: null,
  transferOf: null,
  transferCostBase: null,
  transferCostNative: null,
  transferCostCurrency: null,
  reference: null,
  note: null,
  importFingerprint: null,
};
