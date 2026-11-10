import {
  KERDIAL_COLUMN_NAMES,
  KERDIAL_HEADER_REQUIRED_COLUMNS,
  type KerdialColumnName,
} from "../columns.js";
import {
  KERDIAL_TRANSACTIONS_FILE_TYPE,
  kerdialCsvImporter,
  type KerdialParseResult,
} from "../index.js";

/**
 * Hand-authored Kerdial CSV rows, for the suites that are about the **pipeline**
 * rather than about this format.
 *
 * ## Why this lives here and not beside the suites that use it
 *
 * `pnpm import-vocabulary-gate` scans `src/types.ts` and `src/pipeline/**` for
 * six Kerdial literals and fails on any hit — comments
 * included, test files included, and that is the point: the containment
 * property it asserts is *which module knows this format's column names*. A
 * fixture builder written inside `pipeline/` would spell four of the six while
 * testing a stage whose whole contract is that it never sees a column name, and
 * the gate would be right to refuse it.
 *
 * So the pipeline's suites describe rows in the **neutral** vocabulary — a
 * distribution, a reinvestment and its source label, a settled acquisition —
 * and every column name stays in this module, which is the one allowed to know
 * them. `pipeline/__tests__/kerdial-harness.ts` re-exports these builders so a
 * reader of one of those suites has one import to follow.
 *
 * Under `__tests__/` so `.dependency-cruiser.cjs`'s `options.exclude` keeps it
 * out of the cruise graph, exactly as the two harnesses are.
 */

/** The cells one row states. Every unstated column is simply absent from the file. */
export type Cells = Partial<Record<KerdialColumnName, string>>;

const CRLF = "\u000D\u000A";

const quote = (cell: string): string =>
  cell.includes(",") ? `"${cell.split('"').join('""')}"` : cell;

/**
 * A file carrying the header-required columns plus whatever the rows populate,
 * in the writer's own column order.
 *
 * Derived from `KERDIAL_COLUMNS` rather than transcribed: a header spelled out
 * here would be a second copy of the column table and would go stale the moment
 * a column moved.
 */
function kerdialBytes(rows: readonly Cells[]): Uint8Array {
  const populated = new Set<string>([
    ...KERDIAL_HEADER_REQUIRED_COLUMNS,
    ...rows.flatMap((row) => Object.keys(row)),
  ]);
  const header = KERDIAL_COLUMN_NAMES.filter((name) => populated.has(name));
  const lines = [
    header.join(","),
    ...rows.map((row) => header.map((name) => quote(row[name] ?? "")).join(",")),
  ];
  return new TextEncoder().encode(lines.join(CRLF) + CRLF);
}

/** `parse` + `validate` — the two stages `planImport` takes as input. */
export function parseKerdial(rows: readonly Cells[]): KerdialParseResult {
  return parseKerdialBytes(kerdialBytes(rows));
}

/** The same over already-encoded bytes — what a committed fixture is read through. */
export function parseKerdialBytes(bytes: Uint8Array): KerdialParseResult {
  return kerdialCsvImporter.validate(
    kerdialCsvImporter.parse({ bytes, fileType: KERDIAL_TRANSACTIONS_FILE_TYPE }),
  );
}

/** Where a row says it belongs, and when. Every builder below takes one. */
export interface RowSite {
  readonly portfolio: string;
  readonly account: string;
  /** The account's own currency. Defaults to {@link RowSite.currency}. */
  readonly accountCurrency?: string;
  /** The row's own currency. Defaults to `"EUR"`. */
  readonly currency?: string;
  readonly date: string;
  /** L17's carried-forward value, when the row brings one. */
  readonly carriedFingerprint?: string;
}

/** An instrument identity, as a Kerdial row states it: explicit, never inferred from a ticker suffix. */
export interface RowInstrument {
  readonly isin: string;
  readonly exchangeMic: string;
}

function siteCells(site: RowSite): Cells {
  const currency = site.currency ?? "EUR";
  return {
    date: site.date,
    portfolio: site.portfolio,
    cash_account: site.account,
    cash_account_currency: site.accountCurrency ?? currency,
    currency,
    ...(site.carriedFingerprint === undefined
      ? {}
      : { import_fingerprint: site.carriedFingerprint }),
  };
}

function instrumentCells(instrument: RowInstrument): Cells {
  return { isin: instrument.isin, exchange_mic: instrument.exchangeMic };
}

/** Cash in. */
export function cashInRow(site: RowSite, amount: string): Cells {
  return { ...siteCells(site), type: "DEPOSIT", gross_amount: amount };
}

export function acquisitionRow(
  site: RowSite,
  instrument: RowInstrument,
  quantity: string,
  unitPrice: string,
): Cells {
  return {
    ...siteCells(site),
    ...instrumentCells(instrument),
    type: "BUY",
    quantity,
    unit_price: unitPrice,
  };
}

/**
 * A cash distribution, optionally carrying the **file-local label** a
 * reinvestment of it refers to.
 */
export function distributionRow(
  site: RowSite,
  instrument: RowInstrument,
  amount: string,
  label?: string,
): Cells {
  return {
    ...siteCells(site),
    ...instrumentCells(instrument),
    type: "DIVIDEND",
    gross_amount: amount,
    ...(label === undefined ? {} : { row_ref: label }),
  };
}

/** The optional withholding of an {@link interestRow}: one amount, in the settling account's currency. */
interface RowWithholding {
  readonly amount: string;
}

/**
 * Interest earned on cash (`cash-interest`) — a deposit-shaped row with no
 * instrument, optionally carrying a withholding amount.
 */
export function interestRow(site: RowSite, amount: string, withholding?: RowWithholding): Cells {
  return {
    ...siteCells(site),
    type: "INTEREST",
    gross_amount: amount,
    ...(withholding === undefined ? {} : { withholding_amount: withholding.amount }),
  };
}

/**
 * A standalone portfolio fee (`portfolio-cash`) — a withdrawal-shaped row,
 * optionally naming the instrument it relates to (a reference only, C-17).
 */
export function feeRow(site: RowSite, amount: string, instrument?: RowInstrument): Cells {
  return {
    ...siteCells(site),
    ...(instrument === undefined ? {} : instrumentCells(instrument)),
    type: "FEE",
    gross_amount: amount,
  };
}

/**
 * Where a row that names **no cash account** says it belongs. The one kind with
 * such a site is the cashless distribution below: it moves no money, so it has
 * no account to name, and stating one would be an unsupported leg.
 */
export type PortfolioOnlySite = Omit<RowSite, "account" | "accountCurrency">;

/**
 * A cashless share distribution — free units arrive, nothing settles. Written
 * out rather than routed through {@link siteCells} because the two account
 * cells that helper always emits are exactly the ones this kind may not carry.
 */
export function shareGrantRow(
  site: PortfolioOnlySite,
  instrument: RowInstrument,
  quantity: string,
  marketValue: string,
): Cells {
  return {
    date: site.date,
    portfolio: site.portfolio,
    currency: site.currency ?? "EUR",
    ...(site.carriedFingerprint === undefined
      ? {}
      : { import_fingerprint: site.carriedFingerprint }),
    ...instrumentCells(instrument),
    type: "SHARE_DISTRIBUTION",
    quantity,
    gross_amount: marketValue,
  };
}

/** A reinvestment, naming the label of the distribution it reinvests. */
export function reinvestmentRow(
  site: RowSite,
  instrument: RowInstrument,
  quantity: string,
  unitPrice: string,
  sourceLabel: string,
): Cells {
  return {
    ...siteCells(site),
    ...instrumentCells(instrument),
    type: "DRIP",
    quantity,
    unit_price: unitPrice,
    drip_of: sourceLabel,
  };
}

/**
 * FR-66's asset-settled acquisition: the row states **no** currency, because
 * its gross is denominated in the asset it was paid with.
 */
export function settledAcquisitionRow(
  site: RowSite,
  instrument: RowInstrument,
  quantity: string,
  settlement: { readonly symbol: string; readonly amount: string },
): Cells {
  return {
    ...siteCells(site),
    ...instrumentCells(instrument),
    type: "BUY",
    currency: "",
    quantity,
    settlement_symbol: settlement.symbol,
    settlement_amount: settlement.amount,
  };
}

/**
 * FR-59's exchange. `statedTarget` is the figure the file claims the far leg
 * came to — verified against `amount x rate`, never written.
 */
export function exchangeRow(
  site: RowSite,
  amount: string,
  far: {
    readonly currency: string;
    readonly account: string;
    readonly rate: string;
    readonly statedTarget?: string;
  },
): Cells {
  return {
    ...siteCells(site),
    type: "CURRENCY_EXCHANGE",
    gross_amount: amount,
    target_currency: far.currency,
    target_cash_account: far.account,
    exchange_rate: far.rate,
    ...(far.statedTarget === undefined ? {} : { target_amount: far.statedTarget }),
  };
}

/**
 * The `security-transfer` source leg: units leave `site.portfolio`, worth
 * `marketValue`, and — when `label` is given — the target-leg row of the same
 * file that names that label receives them. No label is a transfer out of the
 * application altogether (Step A), which is how an export writes one.
 */
export function transferOutRow(
  site: PortfolioOnlySite,
  instrument: RowInstrument,
  quantity: string,
  marketValue: string,
  label?: string,
): Cells {
  return {
    date: site.date,
    portfolio: site.portfolio,
    currency: site.currency ?? "EUR",
    ...(site.carriedFingerprint === undefined
      ? {}
      : { import_fingerprint: site.carriedFingerprint }),
    ...instrumentCells(instrument),
    type: "TRANSFER_OUT",
    quantity,
    gross_amount: marketValue,
    ...(label === undefined ? {} : { row_ref: label }),
  };
}

/**
 * The target leg. `sourceLabel` names the source-leg row it receives from;
 * without one it is a **lone** target (ND-2 (a)) and `cost` is what it arrived
 * with. `cost` is optional beside a label — informational, never read.
 */
export function transferInRow(
  site: PortfolioOnlySite,
  instrument: RowInstrument,
  quantity: string,
  marketValue: string,
  link: {
    readonly sourceLabel?: string;
    readonly cost?: { readonly base: string; readonly native: string; readonly currency: string };
  },
): Cells {
  return {
    date: site.date,
    portfolio: site.portfolio,
    currency: site.currency ?? "EUR",
    ...(site.carriedFingerprint === undefined
      ? {}
      : { import_fingerprint: site.carriedFingerprint }),
    ...instrumentCells(instrument),
    type: "TRANSFER_IN",
    quantity,
    gross_amount: marketValue,
    ...(link.sourceLabel === undefined ? {} : { transfer_of: link.sourceLabel }),
    ...(link.cost === undefined
      ? {}
      : {
          transfer_cost_base: link.cost.base,
          transfer_cost_native: link.cost.native,
          transfer_cost_currency: link.cost.currency,
        }),
  };
}

/** A disposal, the `acquisitionRow` mirror. */
export function disposalRow(
  site: RowSite,
  instrument: RowInstrument,
  quantity: string,
  unitPrice: string,
): Cells {
  return { ...acquisitionRow(site, instrument, quantity, unitPrice), type: "SELL" };
}
