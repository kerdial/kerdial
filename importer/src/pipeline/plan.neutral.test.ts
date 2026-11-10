import { Decimal } from "@kerdial/core-decimal";
import type { InstrumentIdentityMatch } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_IMPORT_LIMITS,
  IMPORT_REJECT_REASONS,
  IMPORT_SKIP_REASONS,
  ImportPlanRequestError,
  PARSE_REJECT_REASONS,
  computeImportFingerprint,
  planImport,
  portfolioPerformanceImporter,
  type Clock,
  type CsvImporter,
  type CurrencyCode,
  type ImportDiscoveryPort,
  type ImportFileType,
  type ImportPlan,
  type IsoDate,
  type NeutralCashMovementRow,
  type NeutralDividendRow,
  type NeutralInstrumentIdentity,
  type NeutralInstrumentRow,
  type NeutralRow,
  type NeutralTradeRow,
  type ParsedRow,
  type ParseRejectReason,
  type ParseResult,
  type PlanContext,
  type PlannedRowOutcome,
  type RowProblem,
} from "../index.js";

/**
 * **IMP-3's falsification** (OD-6(a)).
 *
 * The user's requirement is that the Portfolio Performance parsing logic stays
 * "behind a dedicated importer interface so that additional formats can be
 * added later". An interface *asserts* that. This file is the evidence: it
 * constructs the typed row shape **entirely by hand** — no CSV file is opened,
 * no bytes are lexed, no French string appears anywhere in this source — and
 * drives a downstream stage with it. A single-implementation abstraction that
 * has only ever been exercised through its one implementation is not evidence
 * of anything.
 *
 * Two halves make the claim checkable, and this is the first:
 *
 *  - **(a), here.** If the neutral layer leaked format vocabulary, this file
 *    could not compile without naming it, and the `keysOf` assertions below
 *    would fail the moment a column-shaped field appeared on a row.
 *  - **(b)**, `pnpm import-vocabulary-gate`, which scans this directory and
 *    `src/types.ts` for the eleven literals. Everything in `src/pipeline/**` is
 *    scanned, comments included; the gate strips nothing.
 *
 * **Two downstream stages are exercised, and since CI-9 both are real.**
 * `validate` (below) reads nothing but the neutral row — no field index, no
 * source cell, no format vocabulary — which is exactly the property that lets
 * it be driven from rows a second format could just as well have produced; it
 * is reached through a `CsvImporter`-typed binding, so the test exercises the
 * *contract* and not the implementation. `planImport` (the second half of this
 * file) is driven from the same hand-built rows, which is what CI-9's own
 * acceptance criteria ask for, and it reaches every reason code that is assigned to
 * plan time with **no CSV file opened anywhere in this test**.
 */

const importerUnderTest: CsvImporter = portfolioPerformanceImporter;

const TRADE_DATE: IsoDate = "2025-03-27";
const CURRENCY: CurrencyCode = "EUR";
/** A fixed instant, so nothing here reads a clock. */
const TRADE_TS = new Date("2025-03-27T15:37:00.000Z");

const instrumentRef: NeutralInstrumentIdentity = {
  isin: "FR0130000013",
  symbol: "ESEX.PA",
  displayName: "An index tracker",
};

const instrumentRow: NeutralInstrumentRow = {
  shape: "INSTRUMENT",
  isin: "FR0130000013",
  symbol: "ESEX.PA",
  displayName: "An index tracker",
  listingCurrency: CURRENCY,
  hasExpenseRatio: true,
  note: null,
};

const cashMovementRow: NeutralCashMovementRow = {
  shape: "CASH_MOVEMENT",
  direction: "IN",
  tradeDate: TRADE_DATE,
  tradeTs: TRADE_TS,
  amount: new Decimal("5600.00"),
  currency: CURRENCY,
  note: "opening balance",
};

const dividendRow: NeutralDividendRow = {
  shape: "DIVIDEND",
  tradeDate: TRADE_DATE,
  tradeTs: TRADE_TS,
  amount: new Decimal("48.00"),
  currency: CURRENCY,
  withholdingAmount: new Decimal("12.66"),
  instrumentRef,
  note: null,
};

const tradeRow: NeutralTradeRow = {
  shape: "TRADE",
  direction: "ACQUIRE",
  tradeDate: TRADE_DATE,
  tradeTs: TRADE_TS,
  quantity: new Decimal("4"),
  unitPrice: new Decimal("121.70"),
  currency: CURRENCY,
  cashCurrency: null,
  fxRateUserInput: null,
  costs: new Decimal("7.30"),
  brokerFee: new Decimal("7.30"),
  tax: null,
  instrumentRef,
  note: null,
  isCashSideDuplicate: false,
};

/** Wrap hand-built rows in the `ParseResult` the staged interface passes between its stages. */
function resultOf(rows: readonly NeutralRow[]): ParseResult {
  const parsed: readonly ParsedRow[] = rows.map((row, index) => ({
    at: { line: index + 2, index },
    ok: true,
    row,
  }));
  return { fileType: "CASH_ACCOUNT_TRANSACTIONS", rowCount: parsed.length, rows: parsed };
}

const problemOf = (row: ParsedRow): RowProblem | null => (row.ok ? null : row.problem);
const rejectionOf = (row: ParsedRow): ParseRejectReason | null => problemOf(row)?.code ?? null;

describe("the neutral row union is a complete, self-contained vocabulary", () => {
  const rows = [instrumentRow, cashMovementRow, dividendRow, tradeRow];

  it("has one member per shape, and every shape is exercised here", () => {
    expect(rows.map((row) => row.shape)).toEqual([
      "INSTRUMENT",
      "CASH_MOVEMENT",
      "DIVIDEND",
      "TRADE",
    ]);
    expect(new Set(rows.map((row) => row.shape)).size).toBe(rows.length);
  });

  it("names no source column on any field of any shape", () => {
    // An identity check, not an absence one: the exact field set of each shape
    // is pinned, so a field named after a source column fails here by name
    // rather than by a scan that might not be looking.
    expect(Object.keys(instrumentRow).sort()).toEqual([
      "displayName",
      "hasExpenseRatio",
      "isin",
      "listingCurrency",
      "note",
      "shape",
      "symbol",
    ]);
    expect(Object.keys(cashMovementRow).sort()).toEqual([
      "amount",
      "currency",
      "direction",
      "note",
      "shape",
      "tradeDate",
      "tradeTs",
    ]);
    expect(Object.keys(dividendRow).sort()).toEqual([
      "amount",
      "currency",
      "instrumentRef",
      "note",
      "shape",
      "tradeDate",
      "tradeTs",
      "withholdingAmount",
    ]);
    expect(Object.keys(tradeRow).sort()).toEqual([
      // FR-227 (FR-260, shape change): `brokerFee` and `tax` join the shape.
      // Both are named for what they *are*, not for the source cell they came
      // from — `brokerFee`, never `frais`; `tax`, never `impots` — which is the
      // property this case exists to pin and the one `pnpm
      // import-vocabulary-gate` enforces from the other direction.
      "brokerFee",
      // `cashCurrency`/`fxRateUserInput`: the foreign-currency-trade pair
      // (M-CTO — a real USD account settled through a EUR one). Named for
      // what they *are* — the settling account's currency, and the pinned
      // rate — never for the source cell (`Montant brut en devise`, `Taux de
      // change`), the same rule `brokerFee`/`tax` already follow.
      "cashCurrency",
      "costs",
      "currency",
      "direction",
      "fxRateUserInput",
      "instrumentRef",
      "isCashSideDuplicate",
      "note",
      "quantity",
      "shape",
      "tax",
      "tradeDate",
      "tradeTs",
      "unitPrice",
    ]);
  });

  it("carries the cross-file rule as a boolean, not as a source label", () => {
    // OD-1(a) reaches the format-agnostic half of the pipeline through exactly
    // one channel, and it is typed `boolean`.
    const duplicate: NeutralTradeRow = { ...tradeRow, isCashSideDuplicate: true };
    expect(typeof duplicate.isCashSideDuplicate).toBe("boolean");
    expect(duplicate.isCashSideDuplicate).not.toBe(tradeRow.isCashSideDuplicate);
  });
});

describe("validate, driven from hand-built rows with no CSV anywhere", () => {
  it("passes every well-formed shape through unchanged, preserving order and identity", () => {
    const input = resultOf([instrumentRow, cashMovementRow, dividendRow, tradeRow]);
    const output = importerUnderTest.validate(input);

    // The exhaustiveness shape that is required, with its positive companions:
    // non-empty, and one output row per input row in the same order.
    expect(input.rowCount).toBeGreaterThan(0);
    expect(output.rows).toHaveLength(input.rowCount);
    expect(output.rowCount).toBe(input.rowCount);
    expect(output.rows.map((row) => row.at.index)).toEqual([0, 1, 2, 3]);

    // Identity, not merely equality: a `validate` that rebuilt every row would
    // pass an equality check while quietly re-deriving values it must not
    // touch.
    expect(output.rows).toEqual(input.rows);
    output.rows.forEach((row, index) => expect(row).toBe(input.rows[index]));
  });

  it("rejects a trade whose reconstructed unit price is not positive (AMOUNT_NOT_POSITIVE)", () => {
    // CI-8's contract decision 1, carried in from GATE-2. ID4 subtracts
    // the costs from the gross on an acquisition, so a row whose costs meet or
    // exceed its gross value produces a price a positive-amount database CHECK
    // will refuse. Refusing it here means it lands in the dry-run's rejected
    // count with a reason the user can read, instead of surfacing three batches
    // later as an apply-time failure — which is what makes the dry-run summary
    // equal to what the confirm does.
    const negative: NeutralTradeRow = { ...tradeRow, unitPrice: new Decimal("-10.00") };
    const zero: NeutralTradeRow = { ...tradeRow, unitPrice: new Decimal("0") };
    const positive: NeutralTradeRow = { ...tradeRow, unitPrice: new Decimal("0.000000000001") };

    const output = importerUnderTest.validate(resultOf([negative, zero, positive]));
    expect(output.rows.map(rejectionOf)).toEqual([
      "AMOUNT_NOT_POSITIVE",
      "AMOUNT_NOT_POSITIVE",
      // The positive companion: the boundary is `> 0`, not "anything small".
      null,
    ]);
    // IMP-AC-13: never a bare "invalid row".
    const [first] = output.rows;
    expect(first!.ok).toBe(false);
    expect(!first!.ok && first!.problem.message.length).toBeGreaterThan(0);
  });

  it("enforces the cash-movement amount invariant the type comment states", () => {
    // The type writes `amount` on a cash movement as "always > 0". Enforcing it
    // here is what makes that comment true rather than aspirational.
    const zero: NeutralCashMovementRow = { ...cashMovementRow, amount: new Decimal("0") };
    expect(importerUnderTest.validate(resultOf([zero])).rows.map(rejectionOf)).toEqual([
      "AMOUNT_NOT_POSITIVE",
    ]);
  });

  it("refuses a figure too large for the ledger's own column, at validate rather than at the INSERT", () => {
    // `transaction.quantity`/`unit_price` are `numeric(38,18)` — 20 digits
    // before the point — and `gross_amount`/`fee_amount`/`withholding_amount`
    // are `numeric(38,12)`, 26. Nothing used to bound magnitude anywhere, so a
    // quantity of 10^20 planned cleanly and then took a `22003 numeric field
    // overflow` from the driver on the write path. That is both a worse place
    // to find out (a real transaction is spent, and the dry-run/confirm
    // identity breaks for a row a dry run could have refused) and the error
    // object that used to carry the failed query into the response body.
    const twentyOneDigits = new Decimal("1".padEnd(21, "0"));
    const twentyDigits = new Decimal("9".repeat(20));
    const twentySevenDigits = new Decimal("1".padEnd(27, "0"));

    const rows: readonly NeutralRow[] = [
      { ...tradeRow, quantity: twentyOneDigits },
      { ...tradeRow, unitPrice: twentyOneDigits },
      { ...tradeRow, costs: twentySevenDigits },
      { ...cashMovementRow, amount: twentySevenDigits },
      { ...dividendRow, amount: twentySevenDigits },
      { ...dividendRow, withholdingAmount: twentySevenDigits },
      // Both factors are individually storable and their product is not: 20
      // digits times 20 digits is 39-40 digits, well past `gross_amount`'s 26.
      // A per-field rule alone would let this one through to the driver.
      { ...tradeRow, quantity: twentyDigits, unitPrice: twentyDigits },
      // The positive companions, at and just inside the two boundaries — the
      // rule is "too large to store", not "large".
      { ...tradeRow, quantity: twentyDigits, unitPrice: new Decimal("0.000001") },
      { ...cashMovementRow, amount: new Decimal("9".repeat(26)) },
      { ...dividendRow, withholdingAmount: new Decimal("9".repeat(26)) },
    ];

    const output = importerUnderTest.validate(resultOf(rows));
    expect(output.rows.map(rejectionOf)).toEqual([
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
      null,
      null,
      null,
    ]);
    // IMP-AC-13: the reason says which figure and which ceiling, never a bare
    // "invalid row" — and the product case names the derived figure, so the
    // user is not left looking for a cell that carries it.
    expect(problemOf(output.rows[0]!)?.message).toContain("21 digits before the decimal point");
    expect(problemOf(output.rows[0]!)?.message).toContain("at most 20");
    expect(problemOf(output.rows[3]!)?.message).toContain("at most 26");
    expect(problemOf(output.rows[6]!)?.message).toContain(
      "quantity multiplied by its reconstructed unit price",
    );
  });

  it("leaves the zero-amount dividend to plan, as the type assigns it", () => {
    // A deliberate asymmetry with the two rules above, and the type's rather
    // than this stage's: `NeutralDividendRow.amount`'s own type comment says
    // "may be 0 — `plan` is what rejects that". Pinned so the asymmetry is a
    // recorded decision and not an oversight discovered later.
    const zero: NeutralDividendRow = { ...dividendRow, amount: new Decimal("0") };
    expect(importerUnderTest.validate(resultOf([zero])).rows.map(rejectionOf)).toEqual([null]);
  });

  it("a NEGATIVE dividend amount is still a rejection — a marker is exactly zero, nothing else", () => {
    // The companion that keeps `plan`'s new SKIP narrow. A zero-value line is
    // a corporate-action marker Portfolio Performance really emits; a negative
    // gross is a bad figure, and moving it into the skip bucket would hide it.
    // `validate` still passes both through — the positivity gate is `plan`'s,
    // per the type — so this asserts `validate`'s half and `plan.integration`'s
    // corpus case asserts the other.
    const negative: NeutralDividendRow = { ...dividendRow, amount: new Decimal("-1.00") };
    expect(importerUnderTest.validate(resultOf([negative])).rows.map(rejectionOf)).toEqual([null]);
  });

  it("rejects neutral values no schema downstream would accept", () => {
    const badDate: NeutralTradeRow = { ...tradeRow, tradeDate: "2025-02-31" };
    const badCurrency: NeutralDividendRow = { ...dividendRow, currency: "eur" };
    const overLongName: NeutralInstrumentRow = {
      ...instrumentRow,
      displayName: "n".repeat(201),
    };
    const overLongNote: NeutralCashMovementRow = {
      ...cashMovementRow,
      note: "n".repeat(2001),
    };
    const negativeCosts: NeutralTradeRow = { ...tradeRow, costs: new Decimal("-1") };

    const output = importerUnderTest.validate(
      resultOf([badDate, badCurrency, overLongName, overLongNote, negativeCosts]),
    );
    expect(output.rows.map(rejectionOf)).toEqual([
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
      "MALFORMED_VALUE",
    ]);

    // Positive companions, one per rule: the same row one character shorter,
    // or one day earlier, passes — so these are five real bounds and not a
    // `validate` that rejects everything it is shown.
    const insideTheBounds = importerUnderTest.validate(
      resultOf([
        { ...badDate, tradeDate: "2025-02-28" },
        { ...badCurrency, currency: "EUR" },
        { ...overLongName, displayName: "n".repeat(200) },
        { ...overLongNote, note: "n".repeat(2000) },
        { ...negativeCosts, costs: new Decimal("0") },
      ]),
    );
    expect(insideTheBounds.rows.map(rejectionOf)).toEqual([null, null, null, null, null]);
  });

  it("uses only reason codes from the published table", () => {
    const output = importerUnderTest.validate(
      resultOf([
        { ...tradeRow, unitPrice: new Decimal("-1") },
        { ...tradeRow, tradeDate: "not-a-date" },
      ]),
    );
    const codes = output.rows.map(rejectionOf).filter((code) => code !== null);
    expect(codes).toHaveLength(2);
    for (const code of codes) {
      expect(PARSE_REJECT_REASONS).toContain(code);
    }
    // The two `validate` can reach from a neutral row. The other four
    // (`MALFORMED_ROW`, `MISSING_REQUIRED_VALUE`, `UNSUPPORTED_ROW_TYPE`,
    // `UNSUPPORTED_LEG`) all need a *source cell* to decide, so they belong to
    // `parse` and are proven there — stated rather than left as a silent gap in
    // this file's coverage.
    expect(new Set(codes)).toEqual(new Set(["AMOUNT_NOT_POSITIVE", "MALFORMED_VALUE"]));
  });
});

/**
 * CI-9 — `planImport`'s skeleton: the exhaustive outcomes and the named
 * reason codes, driven from the same hand-built rows above.
 *
 * **The database is a stub here, and that is the point of this file, not a
 * shortcut.** `planImport` reads two things from Postgres — the catalogue
 * identity set and the fingerprint existence set — and both are
 * *inputs* to the outcome logic this file is about. Their real SQL is proved
 * against a real Postgres in `plan.instrument-lookup.integration.test.ts` and
 * `plan.idempotency.integration.test.ts`; what stays here is the property IMP-3
 * demands, which is that the whole format-agnostic stage runs on rows a second
 * format could have produced, with no bytes and no French string anywhere in
 * the source.
 */

/** Discriminated on the selected field names rather than on the table object, so this stub imports no schema and stays a stub of the *contract*. */
function stubDb(options: {
  readonly catalogue?: readonly InstrumentIdentityMatch[];
  readonly storedFingerprints?: readonly string[];
  /** `security-transfer` FR-583: the tenant's portfolios, read by name only when a transfer destination was answered. */
  readonly portfolios?: readonly { readonly id: string; readonly name: string }[];
  /** `security-transfer` FR-584: the destination's target-leg rows, read only when the file has a target-leg row. */
  readonly transferTargets?: readonly {
    readonly id: string;
    readonly tradeDate: string;
    readonly quantity: Decimal;
    readonly grossAmount: Decimal;
    readonly instrumentId?: string;
    readonly txnCurrency?: string;
  }[];
}): Db {
  const catalogueRows = options.catalogue ?? [];
  // The fingerprint read selects three columns since the
  // `portfolio-export-import` cycle, and this stub states all three because the
  // stage it feeds reads all three: `portfolio_id` because one file may write
  // into many portfolios and the existence check is scoped exactly as the
  // partial unique index is, and `id` because a *skipped* row
  // still has one — a reinvestment of a distribution the destination already
  // held resolves against it. A stub that answered only
  // the fingerprint would make every match invisible.
  const fingerprintRows = (options.storedFingerprints ?? []).map((importFingerprint, index) => ({
    id: `00000000-0000-7000-8000-0000000f${String(index).padStart(4, "0")}`,
    portfolioId: PORTFOLIO,
    importFingerprint,
  }));
  // The destination portfolio's one EUR account, which every row here
  // settles in, so nothing is routed elsewhere.
  const accountRows = [
    {
      cashAccountId: CASH_ACCOUNT,
      name: "Account",
      currency: "EUR",
      archivedAt: null,
      amount: null,
      calcEpoch: 0,
    },
  ];
  // `security-transfer`'s two plan-stage reads, each answered by the field
  // that only it selects: `listPortfolios` selects `hasIcon`, and the
  // target-leg read `grossAmount`. Neither is issued unless the file needs it,
  // so every earlier case here is answered exactly as before.
  const portfolioRows = (options.portfolios ?? []).map((one) => ({
    ...one,
    tenantId: TENANT,
    hasIcon: false,
  }));
  const transferTargetRows = (options.transferTargets ?? []).map((one) => ({
    portfolioId: PORTFOLIO,
    instrumentId: RESOLVED_INSTRUMENT,
    txnCurrency: CURRENCY,
    ...one,
  }));
  const chain = (rows: readonly unknown[]): unknown => ({
    leftJoin: () => chain(rows),
    where: () => chain(rows),
    orderBy: () => chain(rows),
    then: (
      onFulfilled: (value: readonly unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
  });
  const handle = {
    select: (fields: Record<string, unknown>) => ({
      from: () =>
        chain(
          "importFingerprint" in fields
            ? fingerprintRows
            : "cashAccountId" in fields
              ? accountRows
              : "hasIcon" in fields
                ? portfolioRows
                : "grossAmount" in fields
                  ? transferTargetRows
                  : catalogueRows,
        ),
    }),
    /**
     * `execute` and `transaction` exist because the fingerprint read runs
     * inside `withTenant` since GATE-1: `transaction` carries
     * RLS, so a read outside a tenant-scoped transaction returns nothing at all
     * for the real `app_web` role. The stub runs the callback against itself
     * and answers the `set_config` statement with nothing, which is exactly
     * what a stub of that contract owes.
     */
    execute: () => Promise.resolve(undefined),
    transaction: <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(handle),
  };
  return handle as unknown as Db;
}

const PORTFOLIO = "00000000-0000-7000-8000-00000000d001";
const CASH_ACCOUNT = "00000000-0000-7000-8000-00000000d002";
const TENANT = "00000000-0000-7000-8000-00000000d003";

/** A clock nothing real drives; `planImport` reads it only to set the discovery deadline. */
const fixedClock: Clock = {
  now: () => new Date("2026-08-25T00:00:00.000Z"),
  sleep: () => Promise.resolve(),
};

function planContext(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    db: stubDb({}),
    tenantId: TENANT,
    destination: { portfolioId: PORTFOLIO, cashAccountId: CASH_ACCOUNT },
    mode: "DRY_RUN",
    resolutions: [],
    discovery: null,
    limits: DEFAULT_IMPORT_LIMITS,
    clock: fixedClock,
    ...overrides,
  };
}

const catalogued = (
  id: string,
  overrides: Partial<InstrumentIdentityMatch> = {},
): InstrumentIdentityMatch => ({
  id,
  kind: "SHARE",
  isin: "FR0130000013",
  exchangeMic: "XPAR",
  symbol: "ESEX",
  primaryIdentifier: "ISIN",
  displayName: "An index tracker",
  ...overrides,
});

const RESOLVED_INSTRUMENT = "00000000-0000-7000-8000-00000000e001";

/** A row `parse`/`validate` already refused, handed to `plan` exactly as the staged interface hands it over. */
function refused(index: number, code: ParseRejectReason, message: string): ParsedRow {
  return { at: { line: index + 2, index }, ok: false, problem: { code, message } };
}

function accepted(index: number, row: NeutralRow): ParsedRow {
  return { at: { line: index + 2, index }, ok: true, row };
}

function resultOfRows(fileType: ImportFileType, rows: readonly ParsedRow[]): ParseResult {
  return { fileType, rowCount: rows.length, rows };
}

const outcomeOf = (outcome: PlannedRowOutcome): string =>
  outcome.outcome === "IMPORT" ? "IMPORT" : outcome.reason;

describe("planImport, driven from hand-built rows with no CSV anywhere (CI-9)", () => {
  /**
   * The independent row count the positive companion requires. It is a
   * `\n`-separated manifest of neutral descriptors — **not** a CSV, and
   * deliberately not derived from `rows.length` — so "the outcome count equals
   * the row count" is checked against something that did not come from the same
   * array.
   */
  const MANIFEST = `
cash movement in, well formed
dividend, well formed
trade, well formed
trade, already carried by the other file
dividend, zero amount
row the earlier stage refused: field count
row the earlier stage refused: unparseable cell
row the earlier stage refused: required cell empty
row the earlier stage refused: modelled by no kind here
row the earlier stage refused: a cost leg this kind forbids
trade, identifier matches nothing in the catalogue
trade, identifier matches two catalogue rows
trade, already imported once into this destination
`;
  const manifestRowCount = MANIFEST.split("\n").filter((line) => line.trim() !== "").length;

  const ambiguousRef: NeutralInstrumentIdentity = {
    isin: "US0200000018",
    symbol: null,
    displayName: "A dual-listed company",
  };
  const unknownRef: NeutralInstrumentIdentity = {
    isin: "FR0130000104",
    symbol: null,
    displayName: "Not in the catalogue",
  };

  const alreadyImportedTrade: NeutralTradeRow = {
    ...tradeRow,
    quantity: new Decimal("7"),
    unitPrice: new Decimal("11.50"),
  };

  const alreadyImportedFingerprint = computeImportFingerprint({
    kindCode: "BUY",
    tradeDate: TRADE_DATE,
    instrumentId: RESOLVED_INSTRUMENT,
    quantity: new Decimal("7"),
    unitPrice: new Decimal("11.50"),
    amount: null,
    currency: CURRENCY,
    feeAmount: new Decimal("7.30"),
    // `tradeRow`'s combined figure is a broker fee alone (see its definition),
    // and this hash must be the one `plan` computes for that row or the
    // already-imported case stops being about idempotency.
    brokerFee: new Decimal("7.30"),
    taxAmount: null,
    withholdingAmount: null,
    cashAccountId: CASH_ACCOUNT,
    occurrence: 1,
  });

  const rows: readonly ParsedRow[] = [
    accepted(0, cashMovementRow),
    accepted(1, dividendRow),
    accepted(2, tradeRow),
    accepted(3, { ...tradeRow, isCashSideDuplicate: true }),
    accepted(4, { ...dividendRow, amount: new Decimal("0") }),
    refused(5, "MALFORMED_ROW", "the row has a different number of fields from the header"),
    refused(6, "MALFORMED_VALUE", "a cell could not be parsed"),
    refused(7, "MISSING_REQUIRED_VALUE", "a cell this row's kind requires is empty"),
    refused(8, "UNSUPPORTED_ROW_TYPE", "this row's kind is not modelled by this cycle"),
    refused(9, "UNSUPPORTED_LEG", "a cost figure on a kind whose schema forbids that leg"),
    accepted(10, { ...tradeRow, instrumentRef: unknownRef }),
    accepted(11, { ...tradeRow, instrumentRef: ambiguousRef }),
    accepted(12, alreadyImportedTrade),
  ];

  const catalogue: InstrumentIdentityMatch[] = [
    catalogued(RESOLVED_INSTRUMENT),
    catalogued("00000000-0000-7000-8000-00000000e002", {
      isin: "US0200000018",
      exchangeMic: "XETR",
      symbol: "XABE",
      displayName: "A dual-listed company, Xetra line",
    }),
    catalogued("00000000-0000-7000-8000-00000000e003", {
      isin: "US0200000018",
      exchangeMic: "XNAS",
      symbol: "XABEG",
      displayName: "A dual-listed company, other line",
    }),
  ];

  async function planTheRows(): Promise<ImportPlan> {
    return planImport(
      resultOfRows("CASH_ACCOUNT_TRANSACTIONS", rows),
      planContext({
        db: stubDb({ catalogue, storedFingerprints: [alreadyImportedFingerprint] }),
      }),
    );
  }

  it("produces exactly one outcome per data row, in file order", async () => {
    const plan = await planTheRows();
    expect(plan.rowCount).toBe(manifestRowCount);
    expect(plan.outcomes).toHaveLength(manifestRowCount);
    expect(plan.outcomes.map((outcome) => outcome.at.index)).toEqual(
      Array.from({ length: manifestRowCount }, (_, index) => index),
    );
  });

  it("satisfies the exhaustiveness triple, not a single equality", async () => {
    const plan = await planTheRows();
    const { imported, skipped, rejected } = plan.summary;
    // (1) the three counts sum to the row count,
    expect(imported + skipped + rejected).toBe(plan.rowCount);
    // (2) the row count is what an independent count of the input says it is,
    expect(plan.rowCount).toBe(manifestRowCount);
    // (3) and the whole thing is not vacuously true of an empty file.
    expect(plan.rowCount).toBeGreaterThan(0);
    // The positive companion the rule actually demands: every one of the three
    // buckets was reached, so a run that classified everything one way cannot
    // pass by summing correctly.
    expect(imported).toBeGreaterThan(0);
    expect(skipped).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it("gives every row exactly one named outcome, never a bare invalid row", async () => {
    const plan = await planTheRows();
    expect(plan.outcomes.map(outcomeOf)).toEqual([
      "IMPORT",
      "IMPORT",
      "IMPORT",
      "COVERED_BY_INVESTMENT_FILE",
      "AMOUNT_NOT_POSITIVE",
      "MALFORMED_ROW",
      "MALFORMED_VALUE",
      "MISSING_REQUIRED_VALUE",
      "UNSUPPORTED_ROW_TYPE",
      "UNSUPPORTED_LEG",
      "INSTRUMENT_NOT_RESOLVED",
      "INSTRUMENT_AMBIGUOUS",
      "ALREADY_IMPORTED",
    ]);
    for (const outcome of plan.outcomes) {
      if (outcome.outcome === "IMPORT") continue;
      expect(outcome.message.length).toBeGreaterThan(0);
      const table: readonly string[] =
        outcome.outcome === "SKIP" ? IMPORT_SKIP_REASONS : IMPORT_REJECT_REASONS;
      expect(table).toContain(outcome.reason);
    }
  });

  it("names both candidates when an identifier matches more than one instrument", async () => {
    const plan = await planTheRows();
    const ambiguous = plan.outcomes[11]!;
    expect(ambiguous.outcome).toBe("REJECT");
    expect(ambiguous.outcome === "REJECT" && ambiguous.message).toContain(
      "00000000-0000-7000-8000-00000000e002",
    );
    expect(ambiguous.outcome === "REJECT" && ambiguous.message).toContain(
      "00000000-0000-7000-8000-00000000e003",
    );
  });

  it("a zero-value dividend is a NAMED SKIP, and a negative one is still a rejection", async () => {
    // The plan-stage half of the zero-value-dividend rule. The reject taxonomy draws the line these
    // two rows fall on either side of: a SKIP "parses and validates cleanly"
    // but is deliberately not imported; a REJECT is a bad row. The source
    // format emits a zero-value income line as a corporate-action
    // marker with no cash leg, which is the first; a negative gross is the
    // second, and folding it into the skip bucket would hide a real problem.
    const plan = await planImport(
      resultOfRows("CASH_ACCOUNT_TRANSACTIONS", [
        accepted(0, { ...dividendRow, amount: new Decimal("0"), withholdingAmount: null }),
        accepted(1, { ...dividendRow, amount: new Decimal("-1.00"), withholdingAmount: null }),
        // A zero gross that nonetheless carries a withholding figure is
        // contradictory, not a marker — it stays a rejection too, which is
        // what keeps the new skip narrow.
        accepted(2, {
          ...dividendRow,
          amount: new Decimal("0"),
          withholdingAmount: new Decimal("1.00"),
        }),
      ]),
      planContext({}),
    );

    const outcomes = plan.outcomes.map((outcome) =>
      outcome.outcome === "IMPORT" ? "IMPORT" : outcome.reason,
    );
    expect(outcomes).toEqual([
      "ZERO_VALUE_DIVIDEND_MARKER",
      "AMOUNT_NOT_POSITIVE",
      "AMOUNT_NOT_POSITIVE",
    ]);
    // The categories, not just the codes: the marker is a skip and the other
    // two are rejections, which is the whole substance of the issue.
    expect(plan.summary).toMatchObject({ imported: 0, skipped: 1, rejected: 2 });
    // And the message names the line rather than a bad number. Narrowed on
    // the discriminant, because `PlannedRowOutcome`'s IMPORT arm carries no
    // `message` — the union is what makes that a compile error rather than an
    // `undefined` at runtime.
    const marker = plan.outcomes[0]!;
    if (marker.outcome !== "SKIP") throw new Error("the marker row was not skipped");
    expect(marker.reason).toBe("ZERO_VALUE_DIVIDEND_MARKER");
    expect(marker.message).toContain("zero-value dividend");
  });

  it("a single-currency dividend whose withholding is not below the gross is refused at plan time, as INTEREST is", async () => {
    // The write service refuses it on confirm (row-safe), so the dry run must
    // not show IMPORT for it. One cent below the gross still imports.
    const plan = await planImport(
      resultOfRows("CASH_ACCOUNT_TRANSACTIONS", [
        accepted(0, { ...dividendRow, withholdingAmount: new Decimal("48.00") }),
        accepted(1, { ...dividendRow, withholdingAmount: new Decimal("47.99") }),
      ]),
      planContext({ db: stubDb({ catalogue: [catalogued(RESOLVED_INSTRUMENT)] }) }),
    );
    const refused = plan.outcomes[0]!;
    if (refused.outcome !== "REJECT") throw new Error("the equal withholding was not rejected");
    expect(refused.reason).toBe("MALFORMED_VALUE");
    expect(refused.message).toContain("la retenue doit être inférieure au montant brut");
    expect(plan.outcomes[1]!.outcome).toBe("IMPORT");
  });

  it("orders the writes by trade date, ascending, and lists only the imported rows", async () => {
    const dated = (index: number, tradeDate: IsoDate): ParsedRow =>
      accepted(index, { ...cashMovementRow, tradeDate });
    const plan = await planImport(
      resultOfRows("CASH_ACCOUNT_TRANSACTIONS", [
        dated(0, "2026-03-05"),
        accepted(1, { ...cashMovementRow, amount: new Decimal("0") }),
        dated(2, "2025-01-02"),
        dated(3, "2026-03-05"),
      ]),
      planContext({}),
    );
    // Ascending by date; the same-date pair keeps file order; the rejected row
    // is absent rather than present with a marker.
    expect(plan.applyOrder).toEqual([2, 0, 3]);
    expect(plan.summary.imported).toBe(3);
  });

  it("refuses a request that names no destination, rather than inventing a reason code for it", async () => {
    await expect(
      planImport(
        resultOfRows("CASH_ACCOUNT_TRANSACTIONS", [accepted(0, cashMovementRow)]),
        planContext({ destination: null }),
      ),
    ).rejects.toBeInstanceOf(ImportPlanRequestError);
    // Positive companion: the same file with a destination plans normally, so
    // this is a precondition and not a stage that refuses everything.
    const plan = await planImport(
      resultOfRows("CASH_ACCOUNT_TRANSACTIONS", [accepted(0, cashMovementRow)]),
      planContext({}),
    );
    expect(plan.summary.imported).toBe(1);
  });
});

describe("the zero-amount rule, unified in plan (CI-9's decision on the tension CI-8 flagged)", () => {
  it("rejects a zero-amount dividend that `validate` deliberately let through", async () => {
    // CI-8 left this asymmetry open and asked CI-9 to settle it.
    // Settled: `plan` is the authoritative positivity gate over every money
    // field of every shape, because `planImport` accepts a `ParseResult` that a
    // *second* format could have produced and cannot assume that
    // implementation's `validate` enforced anything. `validate`'s own
    // format-specific checks are unchanged — they are an earlier, better-worded
    // rejection of the subset one format can see.
    const zeroDividend: NeutralDividendRow = { ...dividendRow, amount: new Decimal("0") };
    const stillValid = importerUnderTest.validate(resultOf([zeroDividend]));
    expect(stillValid.rows.map(rejectionOf)).toEqual([null]);

    const plan = await planImport(
      resultOfRows("CASH_ACCOUNT_TRANSACTIONS", [accepted(0, zeroDividend)]),
      {
        db: stubDb({}),
        tenantId: TENANT,
        destination: { portfolioId: PORTFOLIO, cashAccountId: CASH_ACCOUNT },
        mode: "DRY_RUN",
        resolutions: [],
        discovery: null,
        limits: DEFAULT_IMPORT_LIMITS,
        clock: fixedClock,
      },
    );
    expect(plan.outcomes.map(outcomeOf)).toEqual(["AMOUNT_NOT_POSITIVE"]);
  });

  it("applies the same rule to every money field of every shape, which is what makes it unified", async () => {
    const plan = await planImport(
      resultOfRows("CASH_ACCOUNT_TRANSACTIONS", [
        accepted(0, { ...cashMovementRow, amount: new Decimal("0") }),
        accepted(1, { ...dividendRow, amount: new Decimal("-1") }),
        accepted(2, { ...tradeRow, quantity: new Decimal("0") }),
        accepted(3, { ...tradeRow, unitPrice: new Decimal("0") }),
        // The positive companion: the same four shapes, one increment above the
        // boundary, all pass. The rule is `> 0`, not "refuse everything".
        accepted(4, cashMovementRow),
        accepted(5, dividendRow),
        accepted(6, tradeRow),
      ]),
      planContext({ db: stubDb({ catalogue: [catalogued(RESOLVED_INSTRUMENT)] }) }),
    );
    expect(plan.outcomes.map(outcomeOf)).toEqual([
      "AMOUNT_NOT_POSITIVE",
      "AMOUNT_NOT_POSITIVE",
      "AMOUNT_NOT_POSITIVE",
      "AMOUNT_NOT_POSITIVE",
      "IMPORT",
      "IMPORT",
      "IMPORT",
    ]);
  });
});

describe("planImport over an asset-catalogue file (CI-9/CI-10, the remaining codes)", () => {
  const assetRow = (index: number, overrides: Partial<NeutralInstrumentRow>): ParsedRow =>
    accepted(index, { ...instrumentRow, ...overrides });

  /**
   * A port that answers, and counts. **Counting rather than throwing is the
   * point**: a `forbiddenDiscovery` that throws is caught by
   * `DiscoveryBudget` and turned into `"UNAVAILABLE"`, so a confirm that
   * wrongly re-derived would still look like a clean set of rejections. A
   * counter distinguishes "no call was made" from "a call was made and failed",
   * and the same port is used for the confirm and the dry-run halves so the two
   * counts are comparable.
   */
  function countingDiscovery(): ImportDiscoveryPort & { readonly calls: number } {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async search() {
        calls += 1;
        await Promise.resolve();
        return [
          {
            displayName: "resolved by lookup",
            currency: CURRENCY,
            exchangeMic: "XAMS",
            matchQuality: "EXACT" as const,
          },
        ];
      },
    };
  }

  it("reaches every asset-side reason code in one run, and imports in the same run", async () => {
    const discovery: ImportDiscoveryPort = {
      async search({ query }) {
        await Promise.resolve();
        // An identified row is looked up by its identifier; this one's provider
        // is down, which is a different outcome from "answered with nothing".
        if (query === "FR0130000138") {
          throw Object.assign(new Error("down"), { name: "ProviderUnavailable" });
        }
        return [];
      },
    };
    const plan = await planImport(
      resultOfRows("ASSETS", [
        assetRow(0, { isin: "FR0130000112", symbol: "AAA.PA" }),
        assetRow(1, { isin: "FR0130000013", symbol: "ESEX.PA" }),
        assetRow(2, { isin: "FR0130000120", symbol: "BBB.DU" }),
        assetRow(3, { isin: "FR0130000138", symbol: "CCC.DU" }),
        assetRow(4, { isin: null, symbol: "DDD", displayName: "A property fund" }),
      ]),
      planContext({
        destination: null,
        discovery,
        db: stubDb({ catalogue: [catalogued(RESOLVED_INSTRUMENT)] }),
      }),
    );

    expect(plan.outcomes.map(outcomeOf)).toEqual([
      // Resolved by the suffix table, with no lookup at all.
      "IMPORT",
      // Already in the catalogue (IMP-14).
      "INSTRUMENT_ALREADY_EXISTS",
      // The lookup answered, and nothing came back.
      "EXCHANGE_MIC_NOT_RESOLVED",
      // The lookup could not run to completion — a different remedy, hence a
      // different code.
      "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
      // Rule K branch 4.
      "UNSUPPORTED_ASSET_CLASS",
    ]);
    expect(plan.proposals.map((one) => one.index)).toEqual([0]);
    expect(plan.summary).toEqual({
      imported: 1,
      skipped: 1,
      rejected: 3,
      byReason: {
        INSTRUMENT_ALREADY_EXISTS: 1,
        EXCHANGE_MIC_NOT_RESOLVED: 1,
        EXCHANGE_MIC_LOOKUP_UNAVAILABLE: 1,
        UNSUPPORTED_ASSET_CLASS: 1,
      },
    });
  });

  it("refuses a confirm-mode row that was never reviewed, and issues no provider call doing it", async () => {
    const plan = await planImport(
      resultOfRows("ASSETS", [
        assetRow(0, { isin: "FR0130000112", symbol: "AAA.PA" }),
        assetRow(1, { isin: "FR0130000120", symbol: "BBB.DU" }),
      ]),
      planContext({
        destination: null,
        mode: "APPLY",
        discovery: countingDiscovery(),
        resolutions: [
          {
            index: 0,
            action: "CREATE",
            kind: "SHARE",
            kindSource: "USER",
            nameSuggestsFund: false,
            exchangeMic: "XPAR",
            micSource: "USER",
            matchQuality: "EXACT",
          },
        ],
      }),
    );
    expect(plan.outcomes.map(outcomeOf)).toEqual(["IMPORT", "RESOLUTION_NOT_CONFIRMED"]);
    expect(plan.discoveryCallsIssued).toBe(0);
  });

  it("an APPLY whose resolutions list is EMPTY issues no provider call and creates nothing", async () => {
    // The empty list used to be indistinguishable from a dry run, because
    // confirm mode was `resolutions.length > 0`. Both rows below reach
    // discovery on a dry run (row 1 has no suffix the table knows; row 0 does,
    // but a `.PA` row still produces a `CREATE`) — so on the old code this
    // request re-derived and `apply` then wrote provider-derived MICs into the
    // shared catalogue. Now it is a no-op that reports every row.
    const counted = countingDiscovery();
    const rows = resultOfRows("ASSETS", [
      assetRow(0, { isin: "FR0130000112", symbol: "AAA.PA" }),
      assetRow(1, { isin: "FR0130000120", symbol: "BBB.DU" }),
    ]);
    const plan = await planImport(
      rows,
      planContext({ destination: null, mode: "APPLY", discovery: counted, resolutions: [] }),
    );
    expect(counted.calls).toBe(0);
    expect(plan.discoveryCallsIssued).toBe(0);
    expect(plan.outcomes.map(outcomeOf)).toEqual([
      "RESOLUTION_NOT_CONFIRMED",
      "RESOLUTION_NOT_CONFIRMED",
    ]);
    // Nothing to write: no `IMPORT` row, so `apply` has nothing to persist.
    expect(plan.applyOrder).toEqual([]);
    expect(plan.proposals).toEqual([]);

    // THE POSITIVE COMPANION, on the same rows and the same port: a DRY_RUN
    // does reach the provider, and row 0 does resolve. Without this half, a
    // pipeline that had simply stopped resolving anything would pass above.
    const dryRunCounted = countingDiscovery();
    const dryRun = await planImport(
      rows,
      planContext({
        destination: null,
        mode: "DRY_RUN",
        discovery: dryRunCounted,
        resolutions: [],
      }),
    );
    expect(dryRunCounted.calls).toBeGreaterThan(0);
    expect(dryRun.discoveryCallsIssued).toBe(dryRunCounted.calls);
    expect(dryRun.outcomes.map(outcomeOf)).toEqual(["IMPORT", "IMPORT"]);
    expect(dryRun.proposals).toHaveLength(2);
  });

  /**
   * IMP-AC-14 for an asset file, on the confirm.
   *
   * `proposals` carries only `CREATE` rows, so the list a confirm echoes back
   * never mentions a row the catalogue already covers. Until this, a confirm
   * consulted **only** that list, so those rows came back
   * `RESOLUTION_NOT_CONFIRMED` while their own dry run had called them
   * `INSTRUMENT_ALREADY_EXISTS` — the same file, the same server, two different
   * summaries, in the direction that reads worst to a user. The first case is the
   * whole-file instance of that (every row catalogued, so `resolutions` is
   * `[]`); the second is the mixed-file one. **They are one bug and this is one fix**:
   * an unlisted row is re-decided against the catalogue snapshot `plan` had
   * already read, and only a row the catalogue cannot account for is refused.
   *
   * The two catalogue entries below are matched through two *different*
   * branches — one by identifier plus the exchange a suffix names, one by
   * identifier alone with no usable suffix — because a fix that only wired up
   * the branch its own test used would pass a single-branch suite.
   */
  const CATALOGUED_BY_SUFFIX = "00000000-0000-7000-8000-00000000e002";
  const CATALOGUED_BY_ISIN = "00000000-0000-7000-8000-00000000e003";
  const twoCataloguedInstruments = [
    catalogued(CATALOGUED_BY_SUFFIX),
    catalogued(CATALOGUED_BY_ISIN, {
      isin: "FR0130000120",
      exchangeMic: "XAMS",
      symbol: "BBB",
    }),
  ];
  /** Matches `catalogued(...)`'s first entry through the suffix table (`.PA` → `XPAR`). */
  const suffixMatchedRow = { isin: "FR0130000013", symbol: "ESEX.PA" };
  /** Matches the second entry by identifier alone: `.DU` is deliberately not in the suffix table. */
  const isinMatchedRow = { isin: "FR0130000120", symbol: "BBB.DU" };
  /** In neither catalogue entry, and with no usable suffix — so a dry run must reach the provider for it. */
  const uncataloguedRow = { isin: "FR0130000138", symbol: "CCC.DU" };

  it("an all-catalogued file reports the same triple on the confirm as on its own dry run", async () => {
    const rows = resultOfRows("ASSETS", [
      assetRow(0, suffixMatchedRow),
      assetRow(1, isinMatchedRow),
    ]);
    const db = stubDb({ catalogue: twoCataloguedInstruments });

    const dryRun = await planImport(
      rows,
      planContext({ destination: null, db, discovery: countingDiscovery() }),
    );
    expect(dryRun.outcomes.map(outcomeOf)).toEqual([
      "INSTRUMENT_ALREADY_EXISTS",
      "INSTRUMENT_ALREADY_EXISTS",
    ]);
    // `proposals` is empty for exactly the reason the bug existed: there is no
    // `CREATE` row to propose. This is what `ImportWizard.tsx` then posts.
    expect(dryRun.proposals).toEqual([]);

    const counted = countingDiscovery();
    const confirm = await planImport(
      rows,
      planContext({
        destination: null,
        db,
        mode: "APPLY",
        discovery: counted,
        resolutions: dryRun.proposals,
      }),
    );

    expect(confirm.summary).toEqual(dryRun.summary);
    expect(confirm.outcomes.map(outcomeOf)).toEqual(dryRun.outcomes.map(outcomeOf));
    expect(confirm.summary).toEqual({
      imported: 0,
      skipped: 2,
      rejected: 0,
      byReason: { INSTRUMENT_ALREADY_EXISTS: 2 },
    });
    // The empty-confirmed-list invariant, on a counter and on a port that would have answered:
    // the catalogue branch is a read of a batch `plan` had already performed,
    // not a second resolution pass.
    expect(counted.calls).toBe(0);
    expect(confirm.discoveryCallsIssued).toBe(0);
    expect(confirm.applyOrder).toEqual([]);
  });

  it("a mixed file agrees too, and the confirm still creates only what was reviewed", async () => {
    const rows = resultOfRows("ASSETS", [
      assetRow(0, uncataloguedRow),
      assetRow(1, suffixMatchedRow),
      assetRow(2, isinMatchedRow),
    ]);
    const db = stubDb({ catalogue: twoCataloguedInstruments });

    const dryRunCounted = countingDiscovery();
    const dryRun = await planImport(
      rows,
      planContext({ destination: null, db, discovery: dryRunCounted }),
    );
    expect(dryRun.outcomes.map(outcomeOf)).toEqual([
      "IMPORT",
      "INSTRUMENT_ALREADY_EXISTS",
      "INSTRUMENT_ALREADY_EXISTS",
    ]);
    // The positive companion to the confirm's zero: the dry run really did
    // reach the provider, for the one row that needed it and no other.
    expect(dryRunCounted.calls).toBe(1);
    expect(dryRun.proposals.map((one) => one.index)).toEqual([0]);

    const counted = countingDiscovery();
    const confirm = await planImport(
      rows,
      planContext({
        destination: null,
        db,
        mode: "APPLY",
        discovery: counted,
        resolutions: dryRun.proposals,
      }),
    );

    expect(confirm.summary).toEqual(dryRun.summary);
    expect(confirm.outcomes.map(outcomeOf)).toEqual(dryRun.outcomes.map(outcomeOf));
    expect(counted.calls).toBe(0);
    expect(confirm.discoveryCallsIssued).toBe(0);
    // The confirm writes the row the user reviewed, with the MIC the user saw —
    // not one this pass re-derived.
    expect(confirm.applyOrder).toEqual([0]);
    const created = confirm.outcomes[0]!;
    if (created.outcome !== "IMPORT") throw new Error("unreachable");
    expect(created.write).toMatchObject({ target: "INSTRUMENT", exchangeMic: "XAMS" });
  });

  it("POSITIVE COMPANION: a row the catalogue cannot account for is still refused on a confirm", async () => {
    // Without this the fix could be "skip everything unlisted", which is the empty-confirmed-list rule's
    // hole reopened with a different label. The row below is absent from both
    // the catalogue and the echoed list, and a dry run would have had to call
    // the provider to place it.
    const counted = countingDiscovery();
    const plan = await planImport(
      resultOfRows("ASSETS", [assetRow(0, suffixMatchedRow), assetRow(1, uncataloguedRow)]),
      planContext({
        destination: null,
        db: stubDb({ catalogue: twoCataloguedInstruments }),
        mode: "APPLY",
        discovery: counted,
        resolutions: [],
      }),
    );
    expect(plan.outcomes.map(outcomeOf)).toEqual([
      "INSTRUMENT_ALREADY_EXISTS",
      "RESOLUTION_NOT_CONFIRMED",
    ]);
    expect(counted.calls).toBe(0);
    expect(plan.applyOrder).toEqual([]);
    expect(plan.proposals).toEqual([]);
  });

  it("refuses a shape that cannot occur in the declared file type, from either side", async () => {
    // Unreachable from this cycle's own `parse`, and checked anyway: the stage
    // takes a `ParseResult`, and a second format could have produced one.
    const inAssets = await planImport(
      resultOfRows("ASSETS", [accepted(0, cashMovementRow)]),
      planContext({ destination: null }),
    );
    const inTransactions = await planImport(
      resultOfRows("INVESTMENT_ACCOUNT_TRANSACTIONS", [accepted(0, instrumentRow)]),
      planContext({}),
    );
    expect(inAssets.outcomes.map(outcomeOf)).toEqual(["UNSUPPORTED_ROW_TYPE"]);
    expect(inTransactions.outcomes.map(outcomeOf)).toEqual(["UNSUPPORTED_ROW_TYPE"]);
  });
});

/**
 * `security-transfer` FR-583/FR-584 (V12, L4, OD-8 (a))
 * — the destination decision and the target-leg match, driven from hand-built
 * transfer rows. The two new plan-stage reads (the portfolio list, the
 * target-leg rows) are answered by the stub above; their real SQL, and their
 * exact statement count, are `plan.integration.test.ts`'s.
 */
describe("planImport — a transfer's destination decision and its target-leg rows", () => {
  type TransferRow = Extract<NeutralRow, { shape: "TRANSFER" }>;
  const sourceLeg: TransferRow = {
    shape: "TRANSFER",
    direction: "OUT",
    tradeDate: "2025-07-09",
    tradeTs: null,
    quantity: new Decimal("0.01"),
    marketValue: new Decimal("1240.80"),
    currency: CURRENCY,
    instrumentRef,
    note: null,
  };
  const targetLeg: TransferRow = { ...sourceLeg, direction: "IN" };

  const WALLET = "00000000-0000-7000-8000-00000000d0a1";
  const portfolios = [
    { id: PORTFOLIO, name: "Exchange" },
    { id: WALLET, name: "Wallet" },
  ];
  const catalogue = [catalogued(RESOLVED_INSTRUMENT)];

  const plan = (
    rows: readonly NeutralRow[],
    overrides: Partial<PlanContext> = {},
    db: Parameters<typeof stubDb>[0] = {},
  ): Promise<ImportPlan> =>
    planImport(
      resultOfRows(
        "INVESTMENT_ACCOUNT_TRANSACTIONS",
        rows.map((row, index) => accepted(index, row)),
      ),
      planContext({ db: stubDb({ catalogue, portfolios, ...db }), ...overrides }),
    );

  const writeOf = (outcome: PlannedRowOutcome) => {
    if (outcome.outcome !== "IMPORT" || outcome.write.target !== "TRANSACTION") {
      throw new Error(`expected a planned transaction write, got ${outcomeOf(outcome)}`);
    }
    return outcome.write;
  };

  it("AC-465: an unanswered source leg is IMPORT alone (Step A), and the plan asks where its units went", async () => {
    const planned = await plan([sourceLeg]);
    const write = writeOf(planned.outcomes[0]!);
    expect(write.kind).toBe("TRANSFER_OUT");
    expect(write.amount?.toFixed(2)).toBe("1240.80");
    expect(write.quantity?.toFixed(2)).toBe("0.01");
    expect(write.unitPrice).toBeNull();
    expect(write.transferTargetPortfolioId).toBeNull();
    // Carried for the fingerprint, as a distribution's is; never routed to a
    // settlement account of its own (a transfer has no cash leg).
    expect(write.cashAccountId).toBe(CASH_ACCOUNT);
    expect(planned.directory).toEqual({ portfolios: [], cashAccounts: [] });
    expect(planned.transferDecisions).toEqual([
      {
        index: 0,
        tradeDate: "2025-07-09",
        instrumentId: RESOLVED_INSTRUMENT,
        quantity: new Decimal("0.01"),
        marketValue: new Decimal("1240.80"),
        currency: CURRENCY,
      },
    ]);
  });

  it("answering changes the planned write, never the outcome, the counts or the fingerprint", async () => {
    const rows = [tradeRow, sourceLeg];
    const unanswered = await plan(rows);
    const toExisting = await plan(rows, {
      transferDestinations: [{ index: 1, portfolioName: "Wallet" }],
    });
    const toNew = await plan(rows, {
      transferDestinations: [{ index: 1, portfolioName: "Cold storage" }],
    });

    expect(writeOf(toExisting.outcomes[1]!).transferTargetPortfolioId).toBe(WALLET);
    // An existing portfolio is matched, not re-created.
    expect(toExisting.directory.portfolios).toEqual([]);
    // A new name is created by the import (L4), under the id the write names.
    const created = writeOf(toNew.outcomes[1]!).transferTargetPortfolioId;
    expect(toNew.directory.portfolios).toEqual([{ id: created, name: "Cold storage" }]);
    expect([PORTFOLIO, WALLET]).not.toContain(created);

    // The "dry-run counts equal confirm counts" property, re-verified: the
    // three plans agree on every count and every outcome…
    expect(toExisting.summary).toEqual(unanswered.summary);
    expect(toNew.summary).toEqual(unanswered.summary);
    expect(toExisting.outcomes.map(outcomeOf)).toEqual(["IMPORT", "IMPORT"]);
    // …and the destination is not hashed (ST-11), so the answered source leg
    // is the same source row an unanswered import would have written.
    expect(writeOf(toExisting.outcomes[1]!).importFingerprint).toBe(
      writeOf(unanswered.outcomes[1]!).importFingerprint,
    );
  });

  it("refuses a malformed answer list as a request error, before any row is planned", async () => {
    const rows = [tradeRow, sourceLeg];
    const malformed: readonly (readonly { index: number; portfolioName: string }[])[] = [
      // out of range
      [{ index: 7, portfolioName: "Wallet" }],
      // a row of this file that is not a source-leg transfer
      [{ index: 0, portfolioName: "Wallet" }],
      // the same row twice
      [
        { index: 1, portfolioName: "Wallet" },
        { index: 1, portfolioName: "Cold storage" },
      ],
      // the portfolio this file is imported into (FR-577)
      [{ index: 1, portfolioName: "Exchange" }],
    ];
    for (const transferDestinations of malformed) {
      await expect(plan(rows, { transferDestinations })).rejects.toBeInstanceOf(
        ImportPlanRequestError,
      );
    }
    // A target-leg row cannot be answered either: nothing of it is written.
    await expect(
      plan([targetLeg], { transferDestinations: [{ index: 0, portfolioName: "Wallet" }] }, {}),
    ).rejects.toBeInstanceOf(ImportPlanRequestError);
  });

  it("the request's portfolio id spelt in uppercase is still the portfolio a transfer cannot name (FR-577)", async () => {
    const rows = [tradeRow, sourceLeg];
    const toItself = { transferDestinations: [{ index: 1, portfolioName: "Exchange" }] };
    const upper = PORTFOLIO.toUpperCase();
    expect(upper).not.toBe(PORTFOLIO);

    const lowercase = await plan(rows, toItself).catch((e: unknown) => e);
    const uppercase = await plan(rows, {
      ...toItself,
      destination: { portfolioId: upper, cashAccountId: CASH_ACCOUNT },
    }).catch((e: unknown) => e);

    expect(lowercase).toBeInstanceOf(ImportPlanRequestError);
    expect(uppercase).toBeInstanceOf(ImportPlanRequestError);
    expect((uppercase as Error).message).toBe((lowercase as Error).message);
  });

  it("refuses the row, never falls back to Step A, when a new destination would pass the portfolio cap", async () => {
    const planned = await plan(
      [sourceLeg, { ...sourceLeg, tradeDate: "2025-10-16", marketValue: new Decimal("1187.30") }],
      {
        maxPortfoliosPerTenant: portfolios.length,
        transferDestinations: [
          { index: 0, portfolioName: "Cold storage" },
          { index: 1, portfolioName: "Wallet" },
        ],
      },
    );
    expect(planned.outcomes.map(outcomeOf)).toEqual(["PORTFOLIO_CAP_EXCEEDED", "IMPORT"]);
    expect(writeOf(planned.outcomes[1]!).transferTargetPortfolioId).toBe(WALLET);
    expect(planned.directory.portfolios).toEqual([]);
  });

  describe("FR-584/FR-585 — a target-leg row is matched against the ledger, never written", () => {
    const target = (id: string) => ({
      id,
      tradeDate: "2025-07-09",
      quantity: new Decimal("0.010000000000000000"),
      grossAmount: new Decimal("1240.800000000000"),
    });

    it("the k-th identical row claims the k-th matching target, and a surplus one is refused", async () => {
      const twoTargets = [target("t-1"), target("t-2")];
      const matched = await plan([targetLeg, targetLeg], {}, { transferTargets: twoTargets });
      expect(matched.outcomes.map(outcomeOf)).toEqual([
        "COVERED_BY_TRANSFER_OUT",
        "COVERED_BY_TRANSFER_OUT",
      ]);

      // One target cannot cover two rows: the second is refused, not skipped.
      const oneTarget = await plan(
        [targetLeg, targetLeg],
        {},
        { transferTargets: [target("t-1")] },
      );
      expect(oneTarget.outcomes.map(outcomeOf)).toEqual([
        "COVERED_BY_TRANSFER_OUT",
        "UNSUPPORTED_ROW_TYPE",
      ]);
      expect(oneTarget.applyOrder).toEqual([]);
      expect(oneTarget.transferDecisions).toEqual([]);
    });

    it("OD-8 (a): an unmatched row is UNSUPPORTED_ROW_TYPE, naming the remedy; any differing figure is unmatched", async () => {
      // Each variant faces one **unclaimed** target alone, so a refusal is the
      // figure's doing and not the target already being taken.
      const variants: readonly TransferRow[] = [
        { ...targetLeg, marketValue: new Decimal("1240.81") },
        { ...targetLeg, quantity: new Decimal("0.02") },
        { ...targetLeg, tradeDate: "2025-07-10" },
        { ...targetLeg, currency: "USD" },
      ];
      for (const variant of variants) {
        const refused = await plan([variant], {}, { transferTargets: [target("t-1")] });
        expect(refused.outcomes.map(outcomeOf)).toEqual(["UNSUPPORTED_ROW_TYPE"]);
        expect(refused.summary.imported).toBe(0);
        const message =
          refused.outcomes[0]!.outcome === "REJECT" ? refused.outcomes[0]!.message : "";
        expect(message).toContain("import the source portfolio's file first");
      }
      // Positive companion: the unaltered row against the same target matches.
      const matched = await plan([targetLeg], {}, { transferTargets: [target("t-1")] });
      expect(matched.outcomes.map(outcomeOf)).toEqual(["COVERED_BY_TRANSFER_OUT"]);
      // And with no target at all — the ledger holds no transfer into here.
      const none = await plan([targetLeg]);
      expect(none.outcomes.map(outcomeOf)).toEqual(["UNSUPPORTED_ROW_TYPE"]);
    });
  });
});
