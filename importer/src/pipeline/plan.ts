import { randomUUID } from "node:crypto";

import type { ImportMode, ImportTransferDestination } from "@kerdial/api-contracts";
import type { Decimal } from "@kerdial/core-decimal";
import {
  autoCreatedCashAccountName,
  findInstrumentsByIdentity,
  listCashAccountsWithBalances,
  listCurrencies,
  listPortfolios,
  MAX_CASH_ACCOUNTS_PER_PORTFOLIO,
  MAX_PORTFOLIOS_PER_TENANT,
  type InstrumentIdentityMatch,
} from "@kerdial/ledger";
import { tenant, transaction, withTenant, type Db } from "@kerdial/platform-db";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { ImportLimits } from "../limits.js";
import {
  destinationOf,
  PARSE_REJECT_REASONS,
  type AnyNeutralRow,
  type CurrencyCode,
  type AnyImportFileType,
  type IsoDate,
  type NeutralCurrencyExchangeRow,
  type NeutralDestination,
  type NeutralDistributionRow,
  type NeutralDividendRow,
  type NeutralDripRow,
  type NeutralFeeRow,
  type NeutralInstrumentIdentity,
  type NeutralInstrumentRow,
  type NeutralInterestRow,
  type NeutralSettledTradeRow,
  type NeutralTradeRow,
  type NeutralTransferRow,
  type ParseResult,
  type SourceRowRef,
} from "../types.js";
import {
  computeImportFingerprint,
  fingerprintIdentityKey,
  occurrenceOrdinals,
  type FingerprintFields,
  type ImportKindCode,
} from "./fingerprint.js";
import {
  computeKerdialFingerprint,
  kerdialFingerprintIdentityKey,
  type KerdialFingerprintFields,
} from "./kerdial-fingerprint.js";
import {
  indexCatalogue,
  resolveAssetRows,
  splitSymbolSuffix,
  type AssetRowInput,
  type InstrumentResolution,
  type PlannedInstrumentWrite,
} from "./instrument-resolution.js";
import type { Clock, ImportDiscoveryPort } from "./ports.js";

/**
 * `planImport` — the format-agnostic half of the pipeline.
 *
 * **Everything in this directory is scanned by `pnpm import-vocabulary-gate`,
 * comments included; the gate strips nothing.** No source column name and no
 * type label from any export format may appear in this file, in code or in
 * prose. The gate caught this file's own first draft header quoting the literal
 * it was describing.
 *
 * ## What "exhaustive" means here, and why it is not only a test
 *
 * The invariant is structural in three places at once, so a row cannot be
 * silently uncounted:
 *
 *  1. {@link planImport} builds exactly one {@link PlannedRowOutcome} per data
 *     row and **throws** if the two lengths ever disagree — an invariant check
 *     in the function, not an assertion in a test that might not be run.
 *  2. {@link summarize} is one `reduce` over a three-member discriminated
 *     union, closed by a `never` check, so adding a fourth outcome is a compile
 *     error rather than a row that counts as nothing.
 *  3. Every rejection carries exactly one code from {@link IMPORT_REJECT_REASONS}
 *     and a message. IMP-AC-13 forbids a bare "invalid row", and there is no
 *     code in the table that means it.
 *
 * ## The one contract decision this stage settles, handed over by CI-8
 *
 * `validate` rejects a non-positive cash-movement amount but leaves a
 * zero-amount dividend alone, because the type says that a dividend
 * amount "may be 0 — `plan` is what rejects that". CI-8 flagged the asymmetry
 * and left it to be decided here. **Decided: unified, in `plan`, and `validate`
 * is not changed.**
 *
 * The reason the asymmetry could not simply be kept is that the justification
 * offered for it does not survive its own second case. "A zero the user can see
 * in their file is a domain question, an invisible reconstruction artefact is a
 * parse question" is a real distinction — but a zero-amount *cash movement* is
 * just as visible as a zero-amount dividend, and `validate` rejects that one.
 * So the line was not where the argument said it was.
 *
 * The reason it could not be unified by moving the rule *into* `validate` is
 * sharper, and it is the same reason this stage exists: `planImport` takes a
 * {@link ParseResult}, and `CsvImporter`'s whole contract (OD-6(a)) is that a
 * *second* format could produce one. `plan` cannot assume some other
 * implementation's `validate` enforced anything. A positivity rule that lives
 * only in one format's `validate` is a rule the pipeline does not actually have.
 *
 * So: **`plan` is the authoritative positivity gate over every money field of
 * every neutral shape**, and `validate`'s format-specific checks stay exactly as
 * CI-8 shipped them — an earlier, better-messaged rejection of the subset one
 * format can see. Neither stage is redundant with the other: the early one gives
 * a better message, the late one is the one that cannot be bypassed. Both
 * produce the same code, `AMOUNT_NOT_POSITIVE`, which is what the asymmetry was
 * about.
 */

/** The three outcomes, mutually exclusive and exhaustive. */
export type PlannedRowOutcome =
  | { readonly at: SourceRowRef; readonly outcome: "IMPORT"; readonly write: PlannedWrite }
  | {
      readonly at: SourceRowRef;
      readonly outcome: "SKIP";
      readonly reason: ImportSkipReason;
      readonly message: string;
    }
  | {
      readonly at: SourceRowRef;
      readonly outcome: "REJECT";
      readonly reason: ImportRejectReason;
      readonly message: string;
    };

/**
 * The skip codes. A skip is a row that **parses and validates cleanly** but
 * that this cycle deliberately does not write, because something else already
 * covers it — the requirements' own definition, adopted verbatim.
 *
 * `ALREADY_IMPORTED` is a **skip, not a reject**, and the OD-7
 * amendment asks for that to be settled explicitly rather than assumed. Settled:
 * a skip. The definition of a skip has two limbs — "another row already covers
 * the same economic event" *or* "the same row was already imported in a previous
 * run (IMP-14)" — and the second limb names this case in as many words. A reject
 * is defined as the row failing "to produce a valid, importable
 * transaction/instrument"; an already-imported row produced a perfectly valid
 * one, once. The user-visible consequence is the one that matters: re-importing
 * a file the user already imported must read as "nothing to do", not as a file
 * full of errors.
 */
export const IMPORT_SKIP_REASONS = [
  /** OD-1(a)/IMP-16: the trade is carried by the other file, which is canonical for it. */
  "COVERED_BY_INVESTMENT_FILE",
  /** This exact source row, into this exact destination, is already in the ledger. */
  "ALREADY_IMPORTED",
  /** IMP-14: the catalogue already has this instrument, so there is nothing to create. */
  "INSTRUMENT_ALREADY_EXISTS",
  /**
   * A **zero-value dividend line**, which Portfolio Performance
   * emits as a corporate-action marker with no cash leg.
   *
   * It parses and validates cleanly, so by the taxonomy — a SKIP is a
   * row that *"parses and validates cleanly"* but is deliberately not
   * imported, a REJECT is a bad row — it was in the wrong category. It was
   * the single rejection of a typical cash-account file, told to the user as
   * "your file has a bad number" in a file where most rows were legitimately
   * skipped as covered by the investment file.
   *
   * A **negative** dividend amount is still a REJECT: that is a bad figure,
   * not a marker.
   */
  "ZERO_VALUE_DIVIDEND_MARKER",
  /**
   * `security-transfer` FR-584/ST-13: a **target-leg** transfer row whose units
   * are already in this portfolio — the source portfolio's own import wrote
   * them, as the linked target of its source leg, when the user named this
   * portfolio as the destination (L4). Writing the row again would count the
   * units twice.
   *
   * Its own code rather than {@link IMPORT_SKIP_REASONS}' first entry, whose
   * message says the *investment file* carries the row — false here: the other
   * portfolio's transfer does.
   */
  "COVERED_BY_TRANSFER_OUT",
] as const;

export type ImportSkipReason = (typeof IMPORT_SKIP_REASONS)[number];

/**
 * The reject codes: the six `parse`/`validate` can reach, plus the ones that
 * need a database, a provider, or a write.
 *
 * `APPLY_FAILED` and `APPLY_NOT_ATTEMPTED` are listed but **unreachable from
 * this file** — the whole point is that they are the only two a dry-run
 * cannot predict, which is why IMP-AC-14's "identical counts" property holds
 * exactly when both are zero. They belong to `apply` (CI-13) and are in the
 * table here so the table is the whole table.
 */
export const IMPORT_REJECT_REASONS = [
  ...PARSE_REJECT_REASONS,
  "INSTRUMENT_NOT_RESOLVED",
  "INSTRUMENT_AMBIGUOUS",
  "EXCHANGE_MIC_NOT_RESOLVED",
  "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
  "UNSUPPORTED_ASSET_CLASS",
  "RESOLUTION_NOT_CONFIRMED",
  "APPLY_FAILED",
  "APPLY_NOT_ATTEMPTED",
  /**
   * The six the `portfolio-export-import` cycle adds,
   * reachable only for a file that
   * carries its destination per row.
   */
  /** The named account exists under a different currency; the column is immutable by grant, so this is never an update (FR-532/SD-14). */
  "CASH_ACCOUNT_CURRENCY_MISMATCH",
  /** Creating the portfolio this row names would take the tenant past `MAX_PORTFOLIOS_PER_TENANT` — decided at plan time so a dry run does not promise a create the apply refuses (FR-539). */
  "PORTFOLIO_CAP_EXCEEDED",
  /** The same statement for `MAX_CASH_ACCOUNTS_PER_PORTFOLIO`. */
  "CASH_ACCOUNT_CAP_EXCEEDED",
  /** A reinvestment whose source row cannot be resolved inside this file — see {@link resolveReinvestmentSources}. */
  "DRIP_SOURCE_NOT_RESOLVED",
  /**
   * The asset a settled acquisition was paid with does not resolve to exactly
   * one instrument. The row is **rejected**, never demoted to an ordinary
   * cash-settled acquisition: the two write different rows, and silently
   * writing the second when the file said the first is a wrong answer a
   * dry-run summary cannot warn about.
   */
  "SETTLEMENT_INSTRUMENT_NOT_RESOLVED",
  /**
   * This code is in the plan-stage reject table, and it is declared
   * here for that reason — **and it is not reachable from the shipped Kerdial
   * format module**, which is a measured statement rather than an oversight.
   *
   * The disagreement it names (a stated target figure that is not the exchanged
   * amount multiplied by the stated rate) is a *cell-level* rule, and A2 put it
   * where the instruction for a cell-level rule puts it: in
   * `validate`, as `MALFORMED_VALUE` naming the cell and the rule
   * (`formats/kerdial-csv/index.ts`'s `inconsistentTarget`, compared at the
   * stored scale of 12 decimal places). A row refused there never reaches this
   * stage, so repeating the check here would give one rule two owners and two
   * codes — exactly what that module's own doc comment says not to
   * do. GATE-0b's verdict (**0/5 disagreed**: no `targetAmount?` parameter is
   * added to the ledger's write path) is what leaves the derived figure
   * authoritative and the stated one merely verifiable, which is why there is
   * no second, write-time disagreement for this code to describe either.
   *
   * It stays in the vocabulary because the vocabulary is the fixed reason
   * taxonomy, and because a future format that carries a target figure through a
   * channel `validate` cannot see would land here.
   */
  "CURRENCY_EXCHANGE_RATE_INCONSISTENT",
  /**
   * `security-transfer`, the two a per-row-destination file can reach
   * by stating both legs of a transfer. A target-leg row naming a source label
   * no row of the file declares — or declared by a row that is itself refused
   * — has no source to be written by: `DRIP_SOURCE_NOT_RESOLVED`'s analogue.
   */
  "TRANSFER_SOURCE_NOT_RESOLVED",
  /**
   * The two rows of a stated pair disagree — instrument, date, quantity,
   * market value, currency, or a "transfer" into its own portfolio — or one
   * side has no partner it can be written with. **Both** rows are refused,
   * never a silent Step A: the file stated a link, and writing the source leg
   * alone would record a transfer out of Kerdial the file does not describe
   * (and, ST-11, one a corrected re-import could then never upgrade).
   */
  "TRANSFER_PAIR_INCONSISTENT",
  /**
   * A lone target-leg transfer whose `transfer_cost_currency` is a well-formed
   * code this installation does not know. The column has no
   * foreign key, so without this the row would be stored with a cost in a
   * currency nothing else can name. The same literal as the catalogue's
   * `CATALOGUE_REJECT_REASONS` entry, so it shares its one sentence of copy.
   */
  "CURRENCY_UNKNOWN",
] as const;

export type ImportRejectReason = (typeof IMPORT_REJECT_REASONS)[number];

/** What `apply` (CI-13) writes for one row. */
export type PlannedWrite = PlannedInstrumentWrite | PlannedTransactionWrite;

export interface PlannedTransactionWrite {
  readonly target: "TRANSACTION";
  /**
   * All eight ledger kinds, since EI-15 gave the last two a `record*` call.
   *
   * A1 shipped this as `Exclude<ImportKindCode, "DRIP" | "CURRENCY_EXCHANGE">`
   * — deliberately narrower than {@link ImportKindCode}, so that widening the
   * *fingerprint's* kind set could not silently produce a planned row `apply`'s
   * `never`-closed `switch` had no write for. The exclusions come off here, in
   * the same edit that adds `recordDrip` and `recordCurrencyExchange` to that
   * switch, which is exactly the handover A1's comment described.
   */
  readonly kind: ImportKindCode;
  /**
   * The row's own transaction id, **allocated here rather than by the write**.
   * `null` for every Portfolio-Performance row, which lets `record*` mint its
   * own exactly as before.
   *
   * It exists because `kd1` hashes `sourceDividendId`, and a reinvestment's
   * source can be a row of the *same file*: without a pre-allocated id there is
   * no value to hash at plan time, and computing the fingerprint after the
   * write would make it unavailable to the dry run. Pre-allocating also makes
   * the re-import case agree with the first import — see
   * {@link resolveReinvestmentSources}, which is where that argument is
   * written out.
   */
  readonly id: string | null;
  /**
   * The portfolio this row is written into. **`null` means "use
   * `ctx.destination`"**, which is every Portfolio-Performance row, so no
   * pre-cycle behaviour moves.
   */
  readonly portfolioId: string | null;
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  readonly instrumentId: string | null;
  readonly quantity: Decimal | null;
  readonly unitPrice: Decimal | null;
  /** `null` for a trade: the money leg is derived from `quantity × unitPrice` (M14), never supplied. */
  readonly amount: Decimal | null;
  readonly currency: CurrencyCode;
  /**
   * The settling account's own currency, when it differs from {@link
   * PlannedTransactionWrite.currency} — carried straight from {@link
   * NeutralTradeRow.cashCurrency}. `null` on every kind but a foreign-currency
   * `TRADE`; `apply` forwards it to `POST /transactions`' `cashCurrency`.
   */
  readonly cashCurrency: CurrencyCode | null;
  /**
   * The source's own pinned FX rate, from {@link NeutralTradeRow.fxRateUserInput}.
   * `null` iff {@link PlannedTransactionWrite.cashCurrency} is `null`.
   */
  readonly fxRateUserInput: Decimal | null;
  readonly feeAmount: Decimal | null;
  /**
   * FR-227's two unfolded components of {@link PlannedTransactionWrite.feeAmount},
   * verbatim from the source cells (so a `0` cell stays a zero here — `apply`
   * is where a zero becomes *absent*, since the write contract wants a
   * component present-or-omitted and never zero, while the fingerprint wants
   * to tell the two apart). `null` on every kind but a trade.
   */
  readonly brokerFee: Decimal | null;
  readonly taxAmount: Decimal | null;
  readonly withholdingAmount: Decimal | null;
  /**
   * The settling account. **The empty string means "this row names no settling
   * account at all"** — the same convention {@link resolveTransactionInstrument}
   * already uses for a cash movement's absent instrument. Only a Kerdial
   * cashless distribution reaches it: a Portfolio-Performance row always
   * carries the request's single destination account, even on the kind that
   * moves no money (see {@link distributionWrite}).
   */
  readonly cashAccountId: string;
  readonly note: string | null;
  /** `transaction.reference`, verbatim from the source; `null` for every Portfolio-Performance row. */
  readonly reference: string | null;
  /** ID7's key, already including the occurrence ordinal. `apply` writes it verbatim. */
  readonly importFingerprint: string;

  /* ---- the legs only a Kerdial row can carry ---- */

  /** The amount that reached the settling account, in {@link cashCurrency}; `null` unless the source stated one. */
  readonly cashAmount: Decimal | null;
  /** The FX-fee and residual cost components (FR-227's four-way itemisation); `null` on every Portfolio-Performance row. */
  readonly fxFee: Decimal | null;
  readonly otherCost: Decimal | null;
  /** The asset an asset-settled acquisition was paid with, and how much of it moved (FR-66). */
  readonly settlementInstrumentId: string | null;
  readonly settlementAmount: Decimal | null;
  readonly settlementFxRateUserInput: Decimal | null;
  /** The far leg of an exchange: what it bought, at what rate, into which account (FR-59). */
  readonly targetCurrency: CurrencyCode | null;
  readonly exchangeRate: Decimal | null;
  readonly targetCashAccountId: string | null;
  /**
   * The reinvested distribution's source, resolved. Non-`null`
   * on exactly the `DRIP` rows this plan marks for import — a row whose source
   * could not be resolved is rejected rather than planned.
   */
  readonly sourceDividendId: string | null;
  /**
   * The **file position** of that source row, when it is a row of this same
   * file. `apply`'s pass 2 reads the id it actually wrote at that position, so
   * the write and the fingerprint cannot disagree even if a chunk rolled back
   * and the row was re-planned. `null` when the source is a row the destination
   * already held.
   */
  readonly sourceRowPosition: number | null;
  /**
   * `security-transfer` FR-583: the portfolio a source-leg
   * transfer's units arrive in, as the user answered it at import — `apply`
   * writes the linked target leg there in the same call. `null` on every other
   * kind, and on a source leg nobody answered for, which is then written alone
   * (Step A, L4).
   *
   * **Not part of the fingerprint** (ST-11): the source row is the same source
   * row whichever destination was named, so a re-import that adds an answer to
   * an earlier Step-A import skips the row instead of writing a second one.
   *
   * A per-row-destination file states the destination itself, as a target-leg
   * row of the same file naming this row's label — see
   * {@link pairTransferLegs}; the same field carries it.
   */
  readonly transferTargetPortfolioId: string | null;
  /**
   * `security-transfer`: the target-leg **row's** own fields, when the
   * file stated the target as a row of its own — a pre-allocated id, its note
   * and reference, and its carried fingerprint, verbatim or `null`. `null` on
   * every other write, a Portfolio-Performance source leg included (its target
   * is synthesised by the ledger and has no row). Never hashed (ST-11).
   */
  readonly transferTargetRow: {
    readonly id: string;
    readonly note: string | null;
    readonly reference: string | null;
    readonly importFingerprint: string | null;
  } | null;
  /**
   * ND-2 (a): the cost a **lone** target leg arrived with, as the file stated
   * it — non-`null` exactly on a `TRANSFER_IN` write, which only a lone target
   * row of a per-row-destination file plans.
   */
  readonly transferCost: {
    readonly base: Decimal;
    readonly native: Decimal;
    readonly currency: CurrencyCode;
  } | null;
}

export interface ImportDestination {
  readonly portfolioId: string;
  readonly cashAccountId: string;
}

/**
 * A portfolio or a cash account a Kerdial file **names but the destination does
 * not have**. A dry run reports these; `applyImport`
 * creates them, through `createPortfolio`/`createCashAccount` and never a raw
 * insert, so every cap, grant and CHECK those two enforce still runs.
 *
 * Both carry a **pre-allocated id**, for the reason
 * {@link PlannedTransactionWrite.id} gives: the planned writes and their
 * fingerprints name these ids, and a fingerprint that cannot be computed until
 * after the write is a fingerprint a dry run cannot report.
 *
 * "Bare" is the whole shape, and it is FR-556/AC-448's point: a transactions
 * CSV imported with no catalogue package beside it creates a portfolio with a
 * name and nothing else. Every presentation field a catalogue import would
 * merge in is simply absent here.
 */
export interface PlannedPortfolioWrite {
  readonly id: string;
  readonly name: string;
}

export interface PlannedCashAccountWrite {
  readonly id: string;
  readonly portfolioId: string;
  readonly name: string;
  /** The row's own stated account currency — what lets a CSV imported alone create the account (FR-532). */
  readonly currency: CurrencyCode;
}

/** What {@link ImportPlan} says the run would create before it writes a single transaction. */
export interface PlannedDirectory {
  readonly portfolios: readonly PlannedPortfolioWrite[];
  readonly cashAccounts: readonly PlannedCashAccountWrite[];
}

export interface PlanContext {
  readonly db: Db;
  readonly tenantId: string;
  /** Absent for an asset-catalogue file; required for both transaction file types. */
  readonly destination: ImportDestination | null;
  /**
   * **The one input that decides whether this pass may issue a provider call**.
   * `"APPLY"` is confirm mode; `"DRY_RUN"` is not. It is carried
   * explicitly rather than inferred from {@link PlanContext.resolutions}'
   * length, because the length of a caller-supplied array is not a statement
   * about which pass this is: an `APPLY` that arrives with `resolutions: []`
   * used to take the dry-run branch *inside a write pass*, re-derive every MIC
   * from the provider, and persist the result to the tenant-less shared
   * `instrument` catalogue with no confirmation behind it.
   *
   * A caller cannot get this wrong by omission — it has no default, and
   * `applyImport` is only ever called for `"APPLY"`.
   */
  readonly mode: ImportMode;
  /**
   * Echoed from a prior dry-run on a confirm; empty on a dry-run. On an
   * `"APPLY"` this is the **whole** set of rows the user reviewed: a row absent
   * from it is `RESOLUTION_NOT_CONFIRMED`, whether the list is empty or merely
   * incomplete. It never selects the mode.
   */
  readonly resolutions: readonly InstrumentResolution[];
  /**
   * `security-transfer` FR-583: the user's answers to
   * {@link ImportPlan.transferDecisions}, keyed by row index — echoed on the
   * confirm exactly as {@link resolutions} is, and on every automatic
   * continuation of that confirm.
   *
   * **Optional, and absent means the same as `[]`**: every source-leg transfer
   * row is then written alone (Step A, L4), which is a legitimate answer and
   * the only one a file with no such row can give. That is what makes a
   * dropped echo dangerous rather than loud — a continuation that omitted this
   * would silently write the remaining rows alone — so the one caller that
   * re-posts (the wizard) is the one that has to carry it, and its test says so.
   *
   * A malformed list is a request that could not have been formed and throws
   * {@link ImportPlanRequestError} before any row is planned: an index that is
   * not a source-leg transfer row of this file, an index answered twice, or a
   * name that is the request's own destination portfolio (FR-577).
   */
  readonly transferDestinations?: readonly ImportTransferDestination[];
  /** `null` when no provider runtime is wired — every otherwise-unresolved row then reports, and the import still completes. */
  readonly discovery: ImportDiscoveryPort | null;
  readonly limits: ImportLimits;
  readonly clock: Clock;
  /**
   * FR-539's two caps, consulted **here** so a dry run reports
   * `PORTFOLIO_CAP_EXCEEDED`/`CASH_ACCOUNT_CAP_EXCEEDED` rather than promising
   * a create the apply refuses.
   *
   * Overridable for the same reason `createPortfolio` and `createCashAccount`
   * each take the identical parameter, whose own doc comments call it a
   * test-only escape hatch: a cap proved only at its shipped value is proved by
   * seeding 500 portfolios, which is not a test anybody runs. `applyImport`
   * forwards whatever is set here to those two functions, so the plan-time
   * check and the write-time check cannot be given different numbers.
   */
  readonly maxPortfoliosPerTenant?: number;
  readonly maxCashAccountsPerPortfolio?: number;
}

export interface ImportSummary {
  readonly imported: number;
  readonly skipped: number;
  readonly rejected: number;
  /** Grouped counts by reason code — what the review step renders. */
  readonly byReason: Readonly<Record<string, number>>;
}

export interface ImportPlan {
  readonly fileType: AnyImportFileType;
  readonly rowCount: number;
  /** Exactly one entry per data row, in file order — the exhaustiveness invariant. */
  readonly outcomes: readonly PlannedRowOutcome[];
  /** Indices into {@link outcomes} of the `IMPORT` rows, ascending by trade date then file order (ID5). */
  readonly applyOrder: readonly number[];
  /**
   * Which rule built {@link applyOrder}. `applyImport` reads it for one
   * decision: a `CHRONOLOGICAL` (ST-12) plan's chunks may span portfolios,
   * every other plan's chunk ends where the portfolio changes (KD9).
   */
  readonly applyOrderRule: ApplyOrderRule;
  readonly summary: ImportSummary;
  /** Asset-catalogue files only: the per-row proposals the dry-run offers and the confirm echoes back. */
  readonly proposals: readonly InstrumentResolution[];
  /**
   * `security-transfer` FR-583: one entry per
   * source-leg transfer row this plan marks `IMPORT`, in file order — the
   * decision the file cannot answer, because it names no destination for the
   * units it moved out (V10). The confirm answers it in
   * {@link PlanContext.transferDestinations}.
   *
   * **The asset file's proposals/resolutions shape, deliberately not a reject
   * reason**: the row's outcome is `IMPORT` either way, so answering changes the
   * planned write (one leg, or a linked pair) and never the counts — the
   * "dry-run counts equal confirm counts" property holds unchanged.
   */
  readonly transferDecisions: readonly {
    /** The row's {@link SourceRowRef.index} — the key an answer names. */
    readonly index: number;
    readonly tradeDate: IsoDate;
    readonly instrumentId: string;
    readonly quantity: Decimal;
    readonly marketValue: Decimal;
    readonly currency: CurrencyCode;
  }[];
  /**
   * What this run would create before writing any row. Both
   * lists are empty for every file whose destination is the request's, and
   * every entry is referenced by at least one `IMPORT` outcome — a portfolio
   * named only by rows this plan rejects is not reported as a create.
   */
  readonly directory: PlannedDirectory;
  /** Provider calls this plan actually issued; the decisive property is that this is 0 on a confirm. */
  readonly discoveryCallsIssued: number;
}

/**
 * Thrown for a caller error, never for a row problem. A transaction file with no
 * destination is not a row that failed to import — it is a request that could
 * not have been formed. Deliberately **not** a new reason code: the table is
 * closed, and every entry in it describes something about a *row*.
 */
export class ImportPlanRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportPlanRequestError";
  }
}

const TRANSACTION_FILE_TYPES: readonly AnyImportFileType[] = [
  "CASH_ACCOUNT_TRANSACTIONS",
  "INVESTMENT_ACCOUNT_TRANSACTIONS",
];

/**
 * The one file type whose rows each name their own destination. For every other file type `ctx.destination` is the request's single
 * destination and nothing below reads a row's own names.
 */
const PER_ROW_DESTINATION_FILE_TYPE: AnyImportFileType = "KERDIAL_TRANSACTIONS";

export async function planImport(
  validated: ParseResult<AnyNeutralRow, AnyImportFileType>,
  ctx: PlanContext,
): Promise<ImportPlan> {
  if (validated.fileType === "KERDIAL_CATALOGUE") {
    // The catalogue package has its own plan and apply stages.
    // Its entities have no trade date, no fingerprint and no write batch, so
    // forcing them through this function would mean a third write target whose
    // every other field is `null`.
    throw new ImportPlanRequestError(
      `a ${validated.fileType} package is not a file of transaction rows and has its own planning stage`,
    );
  }
  const perRowDestination = validated.fileType === PER_ROW_DESTINATION_FILE_TYPE;
  const needsDestination = TRANSACTION_FILE_TYPES.includes(validated.fileType);
  if (needsDestination && ctx.destination === null) {
    throw new ImportPlanRequestError(
      `a ${validated.fileType} file is written into a portfolio and a cash account; neither was supplied`,
    );
  }
  if (perRowDestination && ctx.destination !== null) {
    // Refused rather than ignored. A caller that supplied one believes this
    // file writes there, and half of it would: the rows would go where their
    // own cells say, and the summary would name portfolios the caller never
    // chose. That is a request that could not have been formed (see
    // {@link ImportPlanRequestError}), not a row that failed.
    throw new ImportPlanRequestError(
      `a ${validated.fileType} file names its own portfolio and cash account on every row; a request-level destination cannot be honoured`,
    );
  }
  // `security-transfer` FR-583 — checked against the file before any row is
  // planned (see {@link PlanContext.transferDestinations}).
  const transferAnswers = transferAnswersOf(validated, ctx);

  const draft: (PlannedRowOutcome | null)[] = new Array<PlannedRowOutcome | null>(
    validated.rows.length,
  ).fill(null);

  // Pass 1 — everything decidable from the row alone. Rows that survive it are
  // the only ones that reach the database or a provider.
  const assetRows: AssetRowInput[] = [];
  const transactionRows: {
    readonly at: SourceRowRef;
    readonly position: number;
    readonly row: Exclude<AnyNeutralRow, NeutralInstrumentRow>;
  }[] = [];

  validated.rows.forEach((parsed, position) => {
    if (!parsed.ok) {
      draft[position] = reject(parsed.at, parsed.problem.code, parsed.problem.message);
      return;
    }
    const shapeProblem = wrongShapeForFile(parsed.row, validated.fileType);
    if (shapeProblem !== null) {
      draft[position] = reject(parsed.at, "UNSUPPORTED_ROW_TYPE", shapeProblem);
      return;
    }
    if (parsed.row.shape === "TRADE" && parsed.row.isCashSideDuplicate) {
      // OD-1(a)/IMP-16. This is the **only** channel the cross-file rule reaches
      // this stage through, and it is a boolean: the row never reaches
      // instrument resolution at all, so a file full of these costs no lookups.
      draft[position] = skip(
        parsed.at,
        "COVERED_BY_INVESTMENT_FILE",
        "the same trade is carried by the investment-account file, which this cycle treats as canonical for trades",
      );
      return;
    }
    // A zero-value DIVIDEND is a marker, not a bad row, so it
    // is categorised before the positivity gate below rather than by it.
    // Deliberately narrow: **exactly zero**, and no withholding. A negative
    // amount is still `AMOUNT_NOT_POSITIVE`, and a zero gross carrying a
    // withholding figure is contradictory rather than a marker — both fall
    // through to `nonPositiveMoney`.
    if (
      parsed.row.shape === "DIVIDEND" &&
      parsed.row.amount.isZero() &&
      (parsed.row.withholdingAmount === null || parsed.row.withholdingAmount.isZero())
    ) {
      draft[position] = skip(
        parsed.at,
        "ZERO_VALUE_DIVIDEND_MARKER",
        "the source records a zero-value dividend line, which carries no cash leg to import",
      );
      return;
    }
    const money = nonPositiveMoney(parsed.row);
    if (money !== null) {
      draft[position] = reject(parsed.at, money.code, money.message);
      return;
    }
    const carried = malformedCarriedFingerprint(parsed.row);
    if (carried !== null) {
      // The database's own shape CHECK, applied **before** the
      // write, so a hand-forged value is a named row rejection naming the
      // column rather than a `23514` coming back from the `INSERT`.
      draft[position] = reject(parsed.at, "MALFORMED_VALUE", carried);
      return;
    }
    if (parsed.row.shape === "INSTRUMENT") {
      assetRows.push({ at: parsed.at, row: parsed.row });
    } else {
      transactionRows.push({ at: parsed.at, position, row: parsed.row });
    }
  });

  const positionOf = new Map(validated.rows.map((parsed, position) => [parsed.at.index, position]));
  const place = (at: SourceRowRef, outcome: PlannedRowOutcome): void => {
    const position = positionOf.get(at.index);
    if (position === undefined)
      throw new Error(`row index ${String(at.index)} is not in this file`);
    draft[position] = outcome;
  };

  // Pass 2 — one batched catalogue read for the whole file's distinct identity
  // set, shared by both resolution paths; and, for a file that carries
  // its destination per row, one read of the destination's own directory.
  const catalogue = indexCatalogue(
    await findInstrumentsByIdentity(ctx.db, identitySetOf(assetRows, transactionRows)),
  );
  const namedPortfolios = namedPortfoliosOf(transactionRows);
  const directory = perRowDestination ? await readDirectory(ctx, { names: namedPortfolios }) : null;
  // A Portfolio-Performance file writes into the request's one destination,
  // but a row settled in another currency cannot go through that account: it
  // is routed to the destination portfolio's account in its own currency, and
  // one is opened when there is none (see {@link Directory.settlementAccount}).
  const destinationPortfolioId = ctx.destination?.portfolioId;
  const settlementDirectory =
    !perRowDestination && needsDestination && destinationPortfolioId !== undefined
      ? await readDirectory(ctx, { id: destinationPortfolioId })
      : null;
  // `security-transfer` FR-583/L4: the portfolios the user named for the units
  // a source-leg transfer moved out — matched by name, or created by it. Read
  // only when some row was answered, so a file without one costs no query.
  const transferDirectory =
    transferAnswers.size > 0
      ? await readDirectory(ctx, { names: new Set(transferAnswers.values()), accounts: false })
      : null;
  const transferTargets = resolveTransferTargets(
    transferAnswers,
    transferDirectory,
    ctx.destination,
  );

  let proposals: readonly InstrumentResolution[] = [];
  let discoveryCallsIssued = 0;

  if (assetRows.length > 0) {
    const resolved = await resolveAssetRows({
      rows: assetRows,
      catalogue,
      discovery: ctx.discovery,
      // The mode, never `ctx.resolutions.length`.
      confirm: ctx.mode === "APPLY",
      resolutions: ctx.resolutions,
      limits: ctx.limits,
      clock: ctx.clock,
    });
    proposals = resolved.proposals;
    discoveryCallsIssued = resolved.discoveryCallsIssued;
    resolved.outcomes.forEach((outcome, index) => {
      const at = assetRows[index]!.at;
      place(
        at,
        outcome.kind === "CREATE"
          ? { at, outcome: "IMPORT", write: outcome.write }
          : outcome.kind === "SKIP"
            ? skip(at, "INSTRUMENT_ALREADY_EXISTS", outcome.message)
            : reject(at, outcome.reason, outcome.message),
      );
    });
  }

  // Pass 3 — every transaction row's destination and instrument legs resolve
  // against the two snapshots above; nothing here issues a query or a provider
  // call.
  const importable: ImportableRow[] = [];
  /** The reinvestment pass-1 index: the file-local labels, and which row declared each. */
  const labelledPosition = new Map<string, number>();
  for (const { position, row } of transactionRows) {
    if (row.shape === "DIVIDEND" && row.rowRef !== undefined)
      labelledPosition.set(row.rowRef, position);
  }

  // Read only when some row states a settled amount in a currency of its own:
  // whether the ledger needs that figure depends on the tenant's base currency,
  // which no row carries (see {@link settledAgainstBase}).
  // A Portfolio-Performance foreign-currency trade, dividend or interest
  // states one; a Kerdial file states it only where its exporter did.
  const baseCurrency = transactionRows.some(
    ({ row }) =>
      (row.shape === "TRADE" || row.shape === "DIVIDEND" || row.shape === "INTEREST") &&
      row.cashCurrency !== null &&
      row.cashCurrency !== undefined &&
      row.cashAmount !== undefined,
  )
    ? await readBaseCurrency(ctx.db, ctx.tenantId)
    : null;

  // Read only when the file has a lone target leg to check:
  // its stated cost currency is the one currency on a transaction row that no
  // foreign key and no FX resolution ever looks up.
  const knownCurrencies =
    perRowDestination &&
    transactionRows.some(
      ({ row }) =>
        row.shape === "TRANSFER" &&
        row.direction === "IN" &&
        row.sourceRef === undefined &&
        row.transferCost !== undefined,
    )
      ? new Set((await listCurrencies(ctx.db)).map(({ code }) => code))
      : null;

  /** `security-transfer` FR-584: target-leg rows, decided against the ledger below rather than written. */
  const targetLegs: TargetLegRow[] = [];
  /** `security-transfer`: target-leg rows of a per-row-destination file naming a source row of it. */
  const statedTargets: StatedTargetRow[] = [];
  /** The labels this file's source-leg transfer rows declare, and which rows declared each. */
  const transferLabels = new Map<string, number[]>();
  for (const { position, row } of transactionRows) {
    if (row.shape === "TRANSFER" && row.direction === "OUT" && row.rowRef !== undefined) {
      transferLabels.set(row.rowRef, [...(transferLabels.get(row.rowRef) ?? []), position]);
    }
  }
  for (const { at, position, row } of transactionRows) {
    const site = resolveWriteSite(
      row,
      catalogue,
      directory,
      settlementDirectory,
      ctx.destination,
      labelledPosition,
    );
    if (!site.ok) {
      place(at, reject(at, site.reason, site.message));
      continue;
    }
    if (row.shape === "TRANSFER" && row.direction === "IN") {
      if (!perRowDestination) {
        targetLegs.push({
          at,
          row,
          instrumentId: site.site.instrumentId,
          portfolioId: site.site.portfolioId ?? ctx.destination?.portfolioId ?? "",
        });
        continue;
      }
      if (row.sourceRef !== undefined) {
        // Written by its source row's call, never by its own; paired
        // below, once every source row's write site is known.
        statedTargets.push({
          at,
          position,
          row,
          sourceRef: row.sourceRef,
          instrumentId: site.site.instrumentId,
          portfolioId: site.site.portfolioId ?? "",
        });
        continue;
      }
      if (row.transferCost === undefined) {
        // ND-2 (a): a lone target is written from the cost it states, and has
        // no other source for one. Unreachable through the shipped format
        // module, which refuses the row first; checked because this stage
        // takes a `ParseResult` any implementation could have produced.
        place(
          at,
          reject(
            at,
            "MISSING_REQUIRED_VALUE",
            "a target-leg transfer row that names no source row must state the cost its units arrived with",
          ),
        );
        continue;
      }
      if (knownCurrencies !== null && !knownCurrencies.has(row.transferCost.currency)) {
        place(
          at,
          reject(
            at,
            "CURRENCY_UNKNOWN",
            `the transfer's carried cost is stated in ${row.transferCost.currency}, which this installation does not know`,
          ),
        );
        continue;
      }
    }
    let write = settledAgainstBase(transactionWriteOf(row, site.site), baseCurrency);
    const target = transferTargets.get(at.index);
    if (target !== undefined) {
      // A named destination the directory cannot honour (the portfolio cap) is
      // a refusal of this row — never a silent fall-back to writing it alone,
      // which would be a different answer from the one the user gave.
      if (!target.ok) {
        place(at, reject(at, target.reason, target.message));
        continue;
      }
      write = { ...write, transferTargetPortfolioId: target.portfolioId };
    }
    importable.push({
      at,
      position,
      write,
      carriedFingerprint: row.importFingerprint ?? null,
    });
  }
  await decideTargetLegs(ctx, targetLegs, place);
  if (perRowDestination) {
    pairTransferLegs(importable, statedTargets, transferLabels, place);
  }

  // Pass 4 — the occurrence ordinals, then the batched existence check.
  //
  // **Two phases, not one, and the reinvestments are the reason.** `kd1` hashes
  // the id of the distribution a reinvestment reinvests, and
  // that id is only known once the source row's own outcome is: a source the
  // destination already holds resolves to the *existing* row's id, a source
  // this run writes resolves to the id pre-allocated for it. So every other row
  // is decided first, and the reinvestments second, against the ids the first
  // phase settled. Splitting the occurrence ordinals with it is safe because a
  // reinvestment's identity key starts with a different kind code and can
  // therefore never share one with a row of the first phase.
  const ordinary = importable.filter((one) => one.write.kind !== "DRIP");
  const reinvestments = importable.filter((one) => one.write.kind === "DRIP");

  const resolvedIdByPosition = new Map<number, string>();
  const decide = async (rows: readonly ImportableRow[]): Promise<void> => {
    if (rows.length === 0) return;
    const fingerprints = fingerprintsOf(rows, perRowDestination);
    const existing = await selectExistingFingerprints(
      ctx.db,
      ctx.tenantId,
      portfolioIdsOf(rows, ctx.destination),
      fingerprints,
    );
    // Two rows of one file may not carry the same fingerprint. With the
    // ordinal in place they never can — that is exactly what the ordinal buys —
    // so this branch is unreachable under either shipped recipe, and it is here
    // anyway because it is what makes the recipe's correctness *load-bearing*
    // rather than merely tidy. Emitting two `IMPORT`s with one fingerprint
    // would produce one written row and one `23505` mapped to a skip at apply
    // time, i.e. a dry-run whose counts the confirm does not reproduce —
    // which is permitted for exactly two apply-only codes and this is neither.
    // A **carried** value has no ordinal at all, so for those rows this
    // is a live check rather than a redundant one.
    const seenInThisFile = new Set<string>();
    rows.forEach((one, index) => {
      const fingerprint = fingerprints[index]!;
      const portfolioId = one.write.portfolioId ?? ctx.destination?.portfolioId ?? "";
      const alreadyImported = existing.get(`${portfolioId}\u001F${fingerprint}`);
      const collidesInFile = seenInThisFile.has(`${portfolioId}\u001F${fingerprint}`);
      seenInThisFile.add(`${portfolioId}\u001F${fingerprint}`);
      if (alreadyImported !== undefined || collidesInFile) {
        // A skipped row still *has* an id in the destination, and
        // a reinvestment of it must resolve against that id or a re-import
        // would reject every reinvestment whose distribution was already
        // imported.
        if (alreadyImported !== undefined) resolvedIdByPosition.set(one.position, alreadyImported);
        place(
          one.at,
          skip(
            one.at,
            "ALREADY_IMPORTED",
            collidesInFile
              ? "an earlier row of this same file is indistinguishable from this one, so writing both would be writing one row twice"
              : "this row was already imported into this portfolio from this destination, so it is not written twice",
          ),
        );
        return;
      }
      if (one.write.id !== null) resolvedIdByPosition.set(one.position, one.write.id);
      place(one.at, {
        at: one.at,
        outcome: "IMPORT",
        write: { ...one.write, importFingerprint: fingerprint },
      });
    });
  };

  await decide(ordinary);
  // ST-12: decided over the rows this plan actually writes,
  // after the existence check — a pair the destination already holds writes
  // nothing, so it constrains no order. Reinvestments never carry a transfer,
  // so the second `decide` below cannot change the answer.
  const order: ApplyOrderRule = !perRowDestination
    ? "BY_DATE"
    : draft.some(
          (outcome) =>
            outcome?.outcome === "IMPORT" &&
            outcome.write.target === "TRANSACTION" &&
            outcome.write.transferTargetPortfolioId !== null,
        )
      ? "CHRONOLOGICAL"
      : "BY_PORTFOLIO";
  const resolvedReinvestments = resolveReinvestmentSources(
    reinvestments,
    labelledPosition,
    resolvedIdByPosition,
    draft,
    place,
    order,
  );
  await decide(resolvedReinvestments);

  const outcomes = draft.map((outcome, position) => {
    if (outcome === null) {
      // Unreachable by construction: pass 1 assigns every row to exactly one of
      // "decided now" or "one of the two resolution lists", and passes 2–4
      // decide every member of both. Checked anyway, because "a row silently
      // fell out" is the exact failure the exhaustiveness shape makes structural.
      throw new Error(`no outcome was produced for data row at position ${String(position)}`);
    }
    return outcome;
  });
  if (outcomes.length !== validated.rowCount) {
    throw new Error(
      `outcome count ${String(outcomes.length)} does not equal row count ${String(validated.rowCount)}`,
    );
  }

  return {
    fileType: validated.fileType,
    rowCount: validated.rowCount,
    outcomes,
    applyOrder: applyOrderOf(outcomes, order),
    applyOrderRule: order,
    summary: summarize(outcomes),
    proposals,
    // A per-row-destination file names its transfers' destinations itself, so
    // there is no decision to ask for.
    transferDecisions: perRowDestination ? [] : transferDecisionsOf(outcomes),
    directory: directoryActuallyUsed(
      [directory ?? settlementDirectory, transferDirectory],
      outcomes,
    ),
    discoveryCallsIssued,
  };
}

/** One row that survived pass 3, waiting for its fingerprint. */
interface ImportableRow {
  readonly at: SourceRowRef;
  /** Its index in `validated.rows` — the two passes address rows by it. */
  readonly position: number;
  readonly write: Omit<PlannedTransactionWrite, "importFingerprint">;
  /**
   * L17/FR-540's carried value, when the row brought one out of another
   * tenant's export. Checked against the destination **before** a new
   * fingerprint is computed, and stored verbatim when it does not match.
   */
  readonly carriedFingerprint: string | null;
}

function reject(at: SourceRowRef, reason: ImportRejectReason, message: string): PlannedRowOutcome {
  return { at, outcome: "REJECT", reason, message };
}

function skip(at: SourceRowRef, reason: ImportSkipReason, message: string): PlannedRowOutcome {
  return { at, outcome: "SKIP", reason, message };
}

/**
 * The single `reduce`, closed by a `never`. A fourth outcome does not compile
 * here, which is what makes exhaustiveness a property of the type rather than of
 * a test.
 */
function summarize(outcomes: readonly PlannedRowOutcome[]): ImportSummary {
  const byReason: Record<string, number> = {};
  let imported = 0;
  let skipped = 0;
  let rejected = 0;
  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case "IMPORT":
        imported += 1;
        break;
      case "SKIP":
        skipped += 1;
        byReason[outcome.reason] = (byReason[outcome.reason] ?? 0) + 1;
        break;
      case "REJECT":
        rejected += 1;
        byReason[outcome.reason] = (byReason[outcome.reason] ?? 0) + 1;
        break;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }
  return { imported, skipped, rejected, byReason };
}

/**
 * ID5's write order: ascending trade date, then file order as the tiebreaker.
 * `tradeTs` is deliberately **not** the sort key for a single-destination file
 * — the timezone choice can never move a row to a different calendar date, and
 * it is the calendar date the ledger's valuation invalidation walks from (M20:
 * because the order is ascending, each write's recompute window shrinks over
 * the run).
 *
 * A row with no trade date (an instrument row) sorts by file order alone.
 *
 * ## The per-row-destination order
 *
 * A file that writes to many portfolios sorts `(portfolioId, tradeDate,
 * tradeTs, fileRowIndex)` instead. Three consequences, each the reason a
 * simpler key is wrong:
 *
 *  - **`portfolioId` leads**, so a run of consecutive rows shares one
 *    portfolio. `applyImport` breaks its chunk when the next row's portfolio
 *    differs. (That used to be stated as "a chunk's lock set is exactly one
 *    portfolio"; a transfer row with a destination locks two — F-7, and
 *    `apply.ts`'s chunk loop says why that is still no new deadlock shape.)
 *    Within a portfolio the order is exactly the one above, so M20's
 *    narrowing argument is untouched.
 *  - **`tradeTs` joins the key**, below the date and above the file index. It
 *    cannot move a row to another calendar date, so it changes nothing M20
 *    relies on; what it buys is a reinvestment written after the
 *    distribution it reinvests even when a hand-authored file lists them the
 *    other way round on the same day. A row with no stated time sorts before
 *    one that has a time on the same date.
 *  - Across portfolios the order is arbitrary but **stable**, which is what
 *    `seq` allocation needs; replay is per portfolio and orders on
 *    `(trade_date, seq)`, so a cross-portfolio interleaving moves no figure.
 *
 * ## A file that writes a stated transfer pair (`security-transfer`, ST-12)
 *
 * The last bullet stops being true the moment one row writes into **two**
 * portfolios: a stated pair's source row writes its target leg at the source
 * row's turn, so the target portfolio's history now depends on when the
 * *source* portfolio's run is written. Portfolio-first provably fails a round
 * trip — P1 → P2 on one date, P2 → P1 later, then a P1 sale: with P1 first
 * the sale precedes the units coming back, with P2 first P2's transfer
 * precedes the units arriving, and either oversells — and it reorders a
 * target against its portfolio's own same-date rows by which id sorts first.
 * No portfolio order works, because a round trip is a cycle.
 *
 * So such a file drops the leading `portfolioId` and is written in global
 * `(tradeDate, tradeTs, fileRowIndex)` order. An exported file lists its rows
 * in `(trade_date, seq)` across portfolios, so file order *is* the original
 * `seq` order and every same-date tie reproduces. `applyImport` does **not**
 * break such a file's chunks where the portfolio changes: it used to,
 * and an interleaved file then paid ~10x the chunks — each a full recompute of
 * a growing timeline — for no correctness gain (R-6).
 */
function applyOrderOf(outcomes: readonly PlannedRowOutcome[], order: ApplyOrderRule): number[] {
  const keyed = outcomes
    .map((outcome, index) => ({ index, outcome }))
    .filter((one) => one.outcome.outcome === "IMPORT")
    .map((one) => ({
      index: one.index,
      key: one.outcome.outcome === "IMPORT" ? sortKeyOf(one.outcome.write, order) : [""],
    }));
  return keyed.sort((left, right) => compareSortKeys(left, right)).map((one) => one.index);
}

/**
 * Which of {@link applyOrderOf}'s three orders a plan uses:
 *
 *  - `BY_DATE` — ID5's, every single-destination file;
 *  - `BY_PORTFOLIO` — KD9's, a per-row-destination file with no stated pair;
 *  - `CHRONOLOGICAL` — ST-12's, a per-row-destination file writing at least
 *    one stated pair.
 */
type ApplyOrderRule = "BY_DATE" | "BY_PORTFOLIO" | "CHRONOLOGICAL";

/** The tuple {@link applyOrderOf} sorts on, so the comparator and the ordering assertion read one definition. */
interface ApplySortKey {
  readonly index: number;
  readonly key: readonly string[];
}

function sortKeyOf(
  write: PlannedWrite | PlannedTransactionDraft,
  order: ApplyOrderRule,
): readonly string[] {
  if (write.target !== "TRANSACTION") return [""];
  if (order === "BY_DATE") return [write.tradeDate];
  const chronological = [
    write.tradeDate,
    // A stated time sorts after an unstated one on the same date, and every
    // stated time sorts among the others: an ISO instant is lexicographically
    // ordered, so no arithmetic on a timestamp is involved.
    write.tradeTs === null ? "" : write.tradeTs.toISOString(),
  ];
  return order === "CHRONOLOGICAL" ? chronological : [write.portfolioId ?? "", ...chronological];
}

function compareSortKeys(left: ApplySortKey, right: ApplySortKey): number {
  for (let at = 0; at < Math.max(left.key.length, right.key.length); at += 1) {
    const a = left.key[at] ?? "";
    const b = right.key[at] ?? "";
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.index - right.index;
}

/**
 * A shape that cannot occur in the declared file type. Unreachable from this
 * cycle's own `parse`, and checked anyway: `planImport` takes a
 * {@link ParseResult}, and `CsvImporter`'s contract is that a second format
 * could have produced one.
 */
function wrongShapeForFile(row: AnyNeutralRow, fileType: AnyImportFileType): string | null {
  const isInstrument = row.shape === "INSTRUMENT";
  if (fileType === "ASSETS") {
    return isInstrument ? null : "a transaction row cannot occur in an asset-catalogue file";
  }
  if (isInstrument) return "an instrument row cannot occur in a transaction file";
  if (fileType === PER_ROW_DESTINATION_FILE_TYPE) return null;
  // The three shapes only a per-row-destination file can produce. They name a
  // second account, a settlement asset or a source row this file type has no
  // channel for, so there is nothing to write them against.
  return row.shape === "CURRENCY_EXCHANGE" || row.shape === "SETTLED_TRADE" || row.shape === "DRIP"
    ? `a ${row.shape} row cannot occur in a ${fileType} file`
    : null;
}

/**
 * The positivity gate this stage owns (see this file's header on why it is here
 * and not only in `validate`). Every money field of every shape, checked against
 * the same rule the database's own `positive` CHECKs enforce, before a row can
 * reach a write.
 */
function nonPositiveMoney(
  row: AnyNeutralRow,
): { readonly code: "AMOUNT_NOT_POSITIVE" | "MALFORMED_VALUE"; readonly message: string } | null {
  const notPositive = (
    value: Decimal,
    label: string,
  ): { code: "AMOUNT_NOT_POSITIVE"; message: string } | null =>
    value.greaterThan(0)
      ? null
      : { code: "AMOUNT_NOT_POSITIVE", message: `${label} is not greater than zero` };
  const notNegative = (
    value: Decimal | null | undefined,
    label: string,
  ): { code: "MALFORMED_VALUE"; message: string } | null =>
    value !== null && value !== undefined && value.lessThan(0)
      ? { code: "MALFORMED_VALUE", message: `${label} is negative` }
      : null;
  /** The four-way itemisation FR-227 unfolds the combined leg into; absent components are simply absent. */
  const costLeg = (leg: {
    readonly costs: Decimal | null;
    readonly brokerFee: Decimal | null;
    readonly tax: Decimal | null;
    readonly fxFee?: Decimal | null;
    readonly otherCost?: Decimal | null;
  }): { readonly code: "MALFORMED_VALUE"; readonly message: string } | null =>
    notNegative(leg.costs, "the combined cost figure") ??
    notNegative(leg.brokerFee, "the broker fee") ??
    notNegative(leg.fxFee, "the currency-conversion fee") ??
    notNegative(leg.tax, "the trade tax") ??
    notNegative(leg.otherCost, "the residual cost");

  const withholdingBelowGross = (income: {
    readonly amount: Decimal;
    readonly currency: string;
    readonly cashCurrency?: string | null;
    readonly withholdingAmount: Decimal | null;
  }): { readonly code: "MALFORMED_VALUE"; readonly message: string } | null =>
    income.withholdingAmount !== null &&
    (income.cashCurrency ?? income.currency) === income.currency &&
    income.withholdingAmount.greaterThanOrEqualTo(income.amount)
      ? { code: "MALFORMED_VALUE", message: "la retenue doit être inférieure au montant brut" }
      : null;

  switch (row.shape) {
    case "INSTRUMENT":
      return null;
    case "CASH_MOVEMENT":
      return notPositive(row.amount, "the cash movement amount");
    // `portfolio-cash`: strictly positive, as `transaction_gross_amount_positive` requires.
    case "FEE":
      return notPositive(row.amount, "the fee amount");
    // A withholding strictly below the gross when both are in one currency —
    // refused here so the dry run and the confirm agree. The write
    // service applies the same rule to both kinds; the withholding is
    // in the settling account's currency, so across currencies the comparison
    // is the write service's, against the converted principal.
    case "DIVIDEND":
      return (
        notPositive(row.amount, "the dividend amount") ??
        notNegative(row.withholdingAmount, "the withholding amount") ??
        withholdingBelowGross(row)
      );
    case "INTEREST":
      // `cash-interest`: strictly positive (CI-L2, no zero-value marker
      // skip — CI-D10), and the withholding bound above.
      return (
        notPositive(row.amount, "the interest amount") ??
        notNegative(row.withholdingAmount, "the withholding amount") ??
        withholdingBelowGross(row)
      );
    case "TRADE":
      return (
        notPositive(row.quantity, "the traded quantity") ??
        notPositive(row.unitPrice, "the unit price") ??
        costLeg(row)
      );
    case "DISTRIBUTION":
      // Both figures, for the same reason every other shape's are
      // checked here — the market value lands in `gross_amount`, whose `> 0`
      // CHECK this kind satisfies rather than relaxes (F1/T-38).
      return (
        notPositive(row.quantity, "the distributed quantity") ??
        notPositive(row.marketValue, "the distribution's market value")
      );
    case "TRANSFER":
      // `security-transfer`: the distribution's two figures, for the same
      // reason — the market value lands in `gross_amount` on both legs.
      return (
        notPositive(row.quantity, "the transferred quantity") ??
        notPositive(row.marketValue, "the transfer's market value")
      );
    case "CURRENCY_EXCHANGE":
      // The stated rate is checked for positivity here and for *consistency*
      // with the stated target figure in `validate`, where a
      // cell-level rule belongs — see `CURRENCY_EXCHANGE_RATE_INCONSISTENT`'s own entry
      // in {@link IMPORT_REJECT_REASONS} on why that check is not repeated.
      return (
        notPositive(row.amount, "the exchanged amount") ??
        notPositive(row.exchangeRate, "the stated exchange rate") ??
        costLeg(row)
      );
    case "SETTLED_TRADE":
      return (
        notPositive(row.quantity, "the acquired quantity") ??
        notPositive(row.settlementAmount, "the settlement amount") ??
        costLeg(row)
      );
    case "DRIP":
      return (
        notPositive(row.quantity, "the reinvested quantity") ??
        notPositive(row.unitPrice, "the unit price") ??
        costLeg(row)
      );
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

/**
 * `transaction.import_fingerprint`'s own shape CHECK (MEASURED,
 * `platform/db/src/schema/transaction.ts`), applied at **plan** time.
 *
 * The Kerdial format module applies the identical regular expression while
 * mapping the cell, so a hand-forged value in a real file is refused one stage
 * earlier with a better message — and this check is still not redundant, for
 * the reason this file's header gives about the positivity gate: `planImport`
 * takes a {@link ParseResult}, and it cannot assume some other implementation's
 * `validate` enforced anything. A value that reaches the database and comes
 * back as a `23514` is the outcome both checks exist to prevent.
 */
const CARRIED_FINGERPRINT_SHAPE = /^[a-z0-9]{1,8}:[0-9a-f]{64}$/;

function malformedCarriedFingerprint(row: AnyNeutralRow): string | null {
  if (row.shape === "INSTRUMENT") return null;
  const carried = row.importFingerprint;
  if (carried === undefined) return null;
  return CARRIED_FINGERPRINT_SHAPE.test(carried)
    ? null
    : "the carried import-fingerprint column is not a recipe-prefixed sha-256 digest, so it cannot be a fingerprint any run of this importer wrote";
}

function identitySetOf(
  assetRows: readonly AssetRowInput[],
  transactionRows: readonly { readonly row: AnyNeutralRow }[],
): { readonly isins: string[]; readonly symbols: string[] } {
  const isins = new Set<string>();
  const symbols = new Set<string>();
  const add = (identity: NeutralInstrumentIdentity): void => {
    if (identity.isin !== null) isins.add(identity.isin.trim().toUpperCase());
    if (identity.symbol !== null) symbols.add(splitSymbolSuffix(identity.symbol).symbol);
  };
  for (const { row } of assetRows)
    add({ isin: row.isin, symbol: row.symbol, displayName: row.displayName });
  for (const { row } of transactionRows) {
    if (
      row.shape === "DIVIDEND" ||
      row.shape === "TRADE" ||
      row.shape === "DISTRIBUTION" ||
      row.shape === "TRANSFER" ||
      row.shape === "DRIP" ||
      row.shape === "SETTLED_TRADE"
    ) {
      add(row.instrumentRef);
    }
    // `portfolio-cash` PC-L14: a FEE's optional reference resolves against the
    // same batched read as a trade's identity.
    if (row.shape === "FEE" && row.instrumentRef !== null) add(row.instrumentRef);
    // FR-66's settlement asset is a second identity on the same row, and it
    // must be in the same batched read or resolving it would cost one query
    // per settled acquisition.
    if (row.shape === "SETTLED_TRADE") add(row.settlementRef);
  }
  return { isins: [...isins], symbols: [...symbols] };
}

/** Every portfolio name the file mentions — what bounds {@link readDirectory}'s per-portfolio account reads. */
function namedPortfoliosOf(
  transactionRows: readonly { readonly row: Exclude<AnyNeutralRow, NeutralInstrumentRow> }[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const { row } of transactionRows) {
    const read = destinationOf(row);
    if (read.present) names.add(read.destination.portfolioName);
  }
  return names;
}

/* ----------------------------------------------------------------- *
 * `security-transfer` — where a transfer's units went,               *
 * and whether a target-leg row is already in the ledger             *
 * ----------------------------------------------------------------- */

/**
 * {@link PlanContext.transferDestinations}, checked against the file and
 * keyed by row index. Throws {@link ImportPlanRequestError} for the two shapes
 * of answer that could not have come from this file's own dry run: an index
 * that is not a source-leg transfer row of it (out of range included), and an
 * index answered twice.
 *
 * **"A source-leg transfer row of this file", not "one this plan imports".**
 * An apply continuation re-posts every answer the user gave, and the rows the
 * earlier runs already wrote now plan `ALREADY_IMPORTED`; refusing their
 * answers would turn every continuation into a 400. An answer for a row this
 * plan does not write is simply unused.
 */
function transferAnswersOf(
  validated: ParseResult<AnyNeutralRow, AnyImportFileType>,
  ctx: PlanContext,
): ReadonlyMap<number, string> {
  const answers = ctx.transferDestinations ?? [];
  const byIndex = new Map<number, string>();
  if (answers.length === 0) return byIndex;
  if (ctx.destination === null) {
    throw new ImportPlanRequestError(
      `a ${validated.fileType} file is not written into a single destination, so it has no transfer whose destination could be answered`,
    );
  }
  const sourceLegs = new Set<number>();
  for (const parsed of validated.rows) {
    if (parsed.ok && parsed.row.shape === "TRANSFER" && parsed.row.direction === "OUT") {
      sourceLegs.add(parsed.at.index);
    }
  }
  for (const answer of answers) {
    if (!sourceLegs.has(answer.index)) {
      throw new ImportPlanRequestError(
        `a transfer destination names row ${String(answer.index)}, which is not a source-leg transfer row of this file`,
      );
    }
    if (byIndex.has(answer.index)) {
      throw new ImportPlanRequestError(
        `a transfer destination is given twice for row ${String(answer.index)}`,
      );
    }
    byIndex.set(answer.index, answer.portfolioName);
  }
  return byIndex;
}

/**
 * Each answered row's destination, resolved through the directory — an
 * existing portfolio by its exact name, any other name allocated for creation
 * (L4) under the tenant's portfolio cap, which is a refusal of the row that
 * named it (`PORTFOLIO_CAP_EXCEEDED`), never a silent Step A.
 *
 * Resolved in ascending row order so that, when the cap leaves room for only
 * some of several new names, which ones fit does not depend on the order the
 * client happened to list its answers in.
 *
 * **Naming the request's own portfolio throws** (FR-577): a transfer moves
 * units *between two* portfolios, and the ledger refuses the pair anyway
 * (`TransferDestinationIsSourceError`). Refusing the request here says so
 * before the dry run reports a count the confirm could not honour.
 */
function resolveTransferTargets(
  answers: ReadonlyMap<number, string>,
  transferDirectory: Directory | null,
  requestDestination: ImportDestination | null,
): ReadonlyMap<number, PortfolioResolution> {
  const resolved = new Map<number, PortfolioResolution>();
  if (transferDirectory === null) return resolved;
  for (const [index, name] of [...answers].sort(([a], [b]) => a - b)) {
    const target = transferDirectory.portfolio(name);
    // Lowercased: the request's id may be spelt in uppercase, and
    // Postgres reads both spellings as the same portfolio.
    if (
      target.ok &&
      requestDestination !== null &&
      target.portfolioId.toLowerCase() === requestDestination.portfolioId.toLowerCase()
    ) {
      throw new ImportPlanRequestError(
        `row ${String(index)}'s transfer destination is the portfolio this file is imported into; a transfer moves units between two different portfolios`,
      );
    }
    resolved.set(index, target);
  }
  return resolved;
}

/** One target-leg row that resolved an instrument, waiting to be matched against the ledger. */
interface TargetLegRow {
  readonly at: SourceRowRef;
  readonly row: NeutralTransferRow;
  readonly instrumentId: string;
  readonly portfolioId: string;
}

/**
 * FR-584/FR-585 (OD-8 (a)): a target-leg row is **never
 * written** by this importer — the linked target leg is created by its source
 * leg's write, in the source portfolio's own import. So a target-leg row is
 * either already in the ledger, and skipped `COVERED_BY_TRANSFER_OUT`, or it is
 * not, and rejected `UNSUPPORTED_ROW_TYPE` with the remedy.
 *
 * **One batched read** of every `TRANSFER_IN` row of the portfolios these rows
 * are imported into — linked *or* severed, since a severed target still proves
 * the source leg was recorded. Nothing is read for a file with no such row.
 *
 * A row matches a target with the same instrument, trade date, quantity,
 * market value (at the stored 12-dp scale, the fingerprint's own
 * normalisation) and currency. **The k-th identical row claims the k-th
 * matching target**, in file order against `(trade_date, seq)` order, so two
 * rows can never be covered by one target, and a third identical row against
 * two targets is refused rather than skipped.
 *
 * Never matched against a source leg of the same file: the read sees only
 * committed rows, and a source leg of this file would name a destination
 * *other* than this portfolio (naming this one is refused as a request error).
 *
 * **The consequence, stated for the user in the reject message** (R-5):
 * import the source portfolio's file first. Imported the other way round, the
 * row is refused here and the destination's later disposals of those units
 * oversell; re-importing this file once the source file is in writes them,
 * because a refused row stored no fingerprint.
 */
async function decideTargetLegs(
  ctx: PlanContext,
  rows: readonly TargetLegRow[],
  place: (at: SourceRowRef, outcome: PlannedRowOutcome) => void,
): Promise<void> {
  if (rows.length === 0) return;
  const targets = await selectTransferTargets(ctx.db, ctx.tenantId, [
    ...new Set(rows.map((one) => one.portfolioId)),
  ]);
  const claimed = new Set<string>();
  for (const one of rows) {
    const value = one.row.marketValue.toFixed(12);
    const match = targets.find(
      (target) =>
        !claimed.has(target.id) &&
        target.portfolioId === one.portfolioId &&
        target.instrumentId === one.instrumentId &&
        target.tradeDate === one.row.tradeDate &&
        target.quantity !== null &&
        target.quantity.equals(one.row.quantity) &&
        target.grossAmount.toFixed(12) === value &&
        target.txnCurrency === one.row.currency,
    );
    if (match !== undefined) {
      claimed.add(match.id);
      place(
        one.at,
        skip(
          one.at,
          "COVERED_BY_TRANSFER_OUT",
          "these units are already in this portfolio: another portfolio's transfer out recorded them here when this portfolio was named as its destination",
        ),
      );
      continue;
    }
    place(
      one.at,
      reject(
        one.at,
        "UNSUPPORTED_ROW_TYPE",
        "units arriving from another account are recorded by that account's transfer out, and no such transfer into this portfolio matches this row (same instrument, date, quantity, value and currency); import the source portfolio's file first, naming this portfolio as the destination of its transfer, then import this file again",
      ),
    );
  }
}

/** {@link decideTargetLegs}' one read, inside `withTenant` for the reason {@link selectExistingFingerprints} gives. */
async function selectTransferTargets(
  db: Db,
  tenantId: string,
  portfolioIds: readonly string[],
): Promise<
  readonly {
    readonly id: string;
    readonly portfolioId: string;
    readonly instrumentId: string | null;
    readonly tradeDate: string;
    readonly quantity: Decimal | null;
    readonly grossAmount: Decimal;
    readonly txnCurrency: string | null;
  }[]
> {
  if (portfolioIds.length === 0) return [];
  return withTenant(db, tenantId, async (tx) =>
    tx
      .select({
        id: transaction.id,
        portfolioId: transaction.portfolioId,
        instrumentId: transaction.instrumentId,
        tradeDate: transaction.tradeDate,
        quantity: transaction.quantity,
        grossAmount: transaction.grossAmount,
        txnCurrency: transaction.txnCurrency,
      })
      .from(transaction)
      .where(
        and(
          eq(transaction.tenantId, tenantId),
          inArray(transaction.portfolioId, [...portfolioIds]),
          eq(transaction.kind, "TRANSFER_IN"),
        ),
      )
      .orderBy(asc(transaction.tradeDate), asc(transaction.seq)),
  );
}

/** A target-leg row of a per-row-destination file that names its source row, waiting to be paired with it. */
interface StatedTargetRow {
  readonly at: SourceRowRef;
  readonly position: number;
  readonly row: NeutralTransferRow;
  /** The label of the source-leg row this row is the target of. */
  readonly sourceRef: string;
  readonly instrumentId: string;
  readonly portfolioId: string;
}

/**
 * `security-transfer` (FR-587, FR-589): a transfer a per-row-destination
 * file states as **two** rows — a source leg declaring a label, and a target
 * leg naming it — becomes **one** planned write, the source's, carrying the
 * target row's portfolio (resolved or created by name like any row's, V13) and
 * the target row's own id, note, reference and carried fingerprint. The target
 * row is then `SKIP` `COVERED_BY_TRANSFER_OUT`, so every row still has exactly
 * one outcome and the counts read "1 + 1" for a pair, as on the other format.
 *
 * The target row's stated cost is **not read**: the write recomputes it from
 * the source portfolio's reconstructed replay, which reproduces the
 * exported figure whenever the file reproduces the history — which is what
 * ST-12's order is for.
 *
 * Refusals — the `resolveReinvestmentSources` shape, and never a silent Step
 * A, because the file stated a link:
 *
 *  - the label is declared by no row, by more than one, or by a row this plan
 *    already refused → the target `TRANSFER_SOURCE_NOT_RESOLVED`;
 *  - the two rows disagree on instrument, date, quantity, market value (at the
 *    stored 12-dp scale) or currency, name the **same** portfolio (FR-577), or
 *    a second target names an already-claimed source (FR-565) → **both**
 *    `TRANSFER_PAIR_INCONSISTENT`;
 *  - a source row declaring a label no target row pairs with — its target was
 *    refused, or is missing — → `TRANSFER_PAIR_INCONSISTENT` too. An exported
 *    file declares a label only on a source that has a target (FR-588), so a
 *    label with no partner means the other half of this pair did not survive,
 *    and writing this half alone would record a different event.
 *
 * Mutates `importable` in place: a paired source is replaced with its widened
 * write, a refused one is removed.
 */
function pairTransferLegs(
  importable: ImportableRow[],
  targets: readonly StatedTargetRow[],
  labels: ReadonlyMap<string, readonly number[]>,
  place: (at: SourceRowRef, outcome: PlannedRowOutcome) => void,
): void {
  const at = new Map(importable.map((one, index) => [one.position, index]));
  const paired = new Map<number, StatedTargetRow>();
  const refused = new Map<number, string>();

  for (const target of targets) {
    const declared = labels.get(target.sourceRef) ?? [];
    const sourceIndex = declared.length === 1 ? at.get(declared[0]!) : undefined;
    if (declared.length !== 1 || sourceIndex === undefined) {
      place(
        target.at,
        reject(
          target.at,
          "TRANSFER_SOURCE_NOT_RESOLVED",
          declared.length === 0
            ? "this row is the receiving leg of a transfer whose source row it names by a label no row of this file declares"
            : declared.length > 1
              ? "this row names its source row by a label more than one row of this file declares, so which transfer it receives is not stated"
              : "the source row of this transfer was itself refused, so there is no transfer for this row to receive",
        ),
      );
      continue;
    }
    const source = importable[sourceIndex]!;
    const disagreement =
      refused.has(source.position) || paired.has(source.position)
        ? "a second receiving row names the same source row, and a transfer has one receiving leg"
        : pairDisagreement(source.write, target);
    if (disagreement !== null) {
      const earlier = paired.get(source.position);
      if (earlier !== undefined) {
        paired.delete(source.position);
        place(earlier.at, reject(earlier.at, "TRANSFER_PAIR_INCONSISTENT", disagreement));
      }
      refused.set(source.position, disagreement);
      place(target.at, reject(target.at, "TRANSFER_PAIR_INCONSISTENT", disagreement));
      continue;
    }
    paired.set(source.position, target);
  }

  // Every labelled source row: paired, refused with its target, or left with
  // no partner at all.
  for (const [, positions] of labels) {
    for (const position of positions) {
      const index = at.get(position);
      if (index !== undefined && !paired.has(position) && !refused.has(position)) {
        refused.set(
          position,
          "this row declares a label for its receiving leg, and no receiving row of this file is paired with it — that row is missing or was refused — so writing this row alone would record a transfer out of the application the file does not describe",
        );
      }
    }
  }

  for (const [position, target] of paired) {
    const index = at.get(position)!;
    const source = importable[index]!;
    importable[index] = {
      ...source,
      write: {
        ...source.write,
        transferTargetPortfolioId: target.portfolioId,
        transferTargetRow: {
          // Pre-allocated for the reason every per-row-destination row's id is.
          id: randomUUID(),
          note: target.row.note,
          reference: target.row.reference ?? null,
          importFingerprint: target.row.importFingerprint ?? null,
        },
      },
    };
    place(
      target.at,
      skip(
        target.at,
        "COVERED_BY_TRANSFER_OUT",
        "these units are recorded by the transfer out this row names, which writes this receiving leg in the same operation — it is not written a second time",
      ),
    );
  }
  for (const [position, message] of refused) {
    const index = at.get(position);
    if (index === undefined) continue;
    const source = importable[index]!;
    place(source.at, reject(source.at, "TRANSFER_PAIR_INCONSISTENT", message));
  }
  // Removed last, highest index first, so every index above stays valid.
  for (const index of [...refused.keys()]
    .map((position) => at.get(position))
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => b - a)) {
    importable.splice(index, 1);
  }
}

/** The first way a stated pair's two rows disagree, or `null` when they describe one transfer. */
function pairDisagreement(source: PlannedTransactionDraft, target: StatedTargetRow): string | null {
  const disagrees = (what: string): string =>
    `this transfer's two rows disagree about ${what}, so they do not describe one transfer`;
  if (source.kind !== "TRANSFER_OUT") return disagrees("which of them is the source leg");
  if (source.portfolioId === target.portfolioId) {
    return "this transfer's two rows name the same portfolio, and a transfer moves units between two different portfolios";
  }
  if (source.instrumentId !== target.instrumentId) return disagrees("the instrument");
  if (source.tradeDate !== target.row.tradeDate) return disagrees("the date");
  if (source.quantity === null || !source.quantity.equals(target.row.quantity)) {
    return disagrees("the quantity");
  }
  if (source.amount === null || source.amount.toFixed(12) !== target.row.marketValue.toFixed(12)) {
    return disagrees("the market value");
  }
  if (source.currency !== target.row.currency) return disagrees("the currency");
  return null;
}

/**
 * {@link ImportPlan.transferDecisions}: the source-leg transfer rows this plan
 * writes, in file order. Built from the final outcomes, so a row the plan
 * rejected or skipped — `ALREADY_IMPORTED` on a continuation included — asks
 * nothing.
 */
function transferDecisionsOf(
  outcomes: readonly PlannedRowOutcome[],
): ImportPlan["transferDecisions"][number][] {
  const decisions: ImportPlan["transferDecisions"][number][] = [];
  for (const outcome of outcomes) {
    if (outcome.outcome !== "IMPORT" || outcome.write.target !== "TRANSACTION") continue;
    const write = outcome.write;
    if (write.kind !== "TRANSFER_OUT" || write.quantity === null || write.amount === null) continue;
    decisions.push({
      index: outcome.at.index,
      tradeDate: write.tradeDate,
      instrumentId: write.instrumentId ?? "",
      quantity: write.quantity,
      marketValue: write.amount,
      currency: write.currency,
    });
  }
  return decisions;
}

/* ------------------------------------------------------- *
 * The destination's own directory, read once per run      *
 * ------------------------------------------------------- */

type AccountResolution =
  | { readonly ok: true; readonly cashAccountId: string }
  | { readonly ok: false; readonly reason: ImportRejectReason; readonly message: string };

type PortfolioResolution =
  | { readonly ok: true; readonly portfolioId: string }
  | { readonly ok: false; readonly reason: ImportRejectReason; readonly message: string };

/**
 * The tenant's portfolios and their cash accounts, indexed by name, plus the
 * resolve-or-mark-to-be-created rule over them.
 *
 * **Every id it hands out is real**, whether the row is one this read found or
 * one this run will create: a created entity's id is allocated here so that the
 * planned writes and their fingerprints can name it before anything is written.
 * `applyImport` creates each one through the shipped `createPortfolio` /
 * `createCashAccount`, passing the id back — never through a raw insert, so the
 * caps, the grants and the CHECKs those two enforce all still run.
 */
interface Directory {
  portfolio(name: string): PortfolioResolution;
  account(portfolioId: string, name: string, currency: CurrencyCode): AccountResolution;
  /**
   * The account a row settled in `currency` goes through: `preferredAccountId`
   * when it is in that currency (every row of a single-currency file), else
   * the portfolio's first unarchived account in `currency` by name, else one
   * opened under {@link autoCreatedCashAccountName} — so a crypto export that
   * mixes EUR- and USD-settled rows lands each in an account of its own
   * currency instead of failing the ledger's account-currency check.
   */
  settlementAccount(
    portfolioId: string,
    preferredAccountId: string,
    currency: CurrencyCode,
  ): AccountResolution;
  readonly planned: PlannedDirectory;
}

interface DirectoryAccount {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly archived: boolean;
}

async function readDirectory(
  ctx: PlanContext,
  scope:
    | {
        readonly names: ReadonlySet<string>;
        /**
         * `false` for a directory only ever asked for portfolios — the
         * `security-transfer` destinations, whose target leg names no cash
         * account — so no account is read for them. Its `account` and
         * `settlementAccount` are then not to be called.
         */
        readonly accounts?: false;
      }
    | { readonly id: string },
): Promise<Directory> {
  // A request-level destination is already an id the caller checked, so the
  // tenant's portfolio list is not read for it — only its accounts are.
  const portfolios =
    "id" in scope ? [{ id: scope.id, name: "" }] : await listPortfolios(ctx.db, ctx.tenantId);
  const portfolioIdByName = new Map(portfolios.map((one) => [one.name, one.id]));
  const accountsByPortfolio = new Map<string, Map<string, DirectoryAccount>>();
  const accountCount = new Map<string, number>();

  // Only the portfolios this file actually writes into. Reading the cash
  // accounts of every portfolio of a 500-portfolio tenant to import a file
  // that mentions two of them would be a per-tenant cost paid per import.
  for (const one of portfolios) {
    if ("names" in scope && (scope.accounts === false || !scope.names.has(one.name))) continue;
    const snapshot = await listCashAccountsWithBalances(ctx.db, {
      tenantId: ctx.tenantId,
      portfolioId: one.id,
    });
    const accounts = snapshot?.accounts ?? [];
    accountsByPortfolio.set(
      one.id,
      new Map(
        accounts.map((account) => [
          account.name,
          {
            id: account.id,
            name: account.name,
            currency: account.currency,
            archived: account.archived,
          },
        ]),
      ),
    );
    accountCount.set(one.id, accounts.length);
  }

  const portfolioCap = ctx.maxPortfoliosPerTenant ?? MAX_PORTFOLIOS_PER_TENANT;
  const accountCap = ctx.maxCashAccountsPerPortfolio ?? MAX_CASH_ACCOUNTS_PER_PORTFOLIO;
  let portfolioCount = portfolios.length;
  const newPortfolios: PlannedPortfolioWrite[] = [];
  const newCashAccounts: PlannedCashAccountWrite[] = [];

  const account = (
    portfolioId: string,
    name: string,
    currency: CurrencyCode,
  ): AccountResolution => {
    const accounts = accountsByPortfolio.get(portfolioId) ?? new Map<string, DirectoryAccount>();
    accountsByPortfolio.set(portfolioId, accounts);
    const existing = accounts.get(name);
    if (existing !== undefined) {
      // SD-14/FR-532: the column is immutable by grant, so this path does not
      // attempt a coercion — the row is refused and the account keeps the
      // currency it has.
      return existing.currency === currency
        ? { ok: true, cashAccountId: existing.id }
        : {
            ok: false,
            reason: "CASH_ACCOUNT_CURRENCY_MISMATCH",
            message: `the account this row names already exists in ${existing.currency} and this row states ${currency}; an account's currency cannot be changed`,
          };
    }
    const count = accountCount.get(portfolioId) ?? 0;
    if (count >= accountCap) {
      return {
        ok: false,
        reason: "CASH_ACCOUNT_CAP_EXCEEDED",
        message: `this row names an account its portfolio does not have, and that portfolio already holds the maximum of ${String(accountCap)}`,
      };
    }
    const id = randomUUID();
    accounts.set(name, { id, name, currency, archived: false });
    accountCount.set(portfolioId, count + 1);
    newCashAccounts.push({ id, portfolioId, name, currency });
    return { ok: true, cashAccountId: id };
  };

  return {
    portfolio(name) {
      const existing = portfolioIdByName.get(name);
      if (existing !== undefined) return { ok: true, portfolioId: existing };
      if (portfolioCount >= portfolioCap) {
        return {
          ok: false,
          reason: "PORTFOLIO_CAP_EXCEEDED",
          message: `this row names a portfolio the destination does not have, and the destination already holds the maximum of ${String(portfolioCap)}`,
        };
      }
      const id = randomUUID();
      portfolioIdByName.set(name, id);
      accountsByPortfolio.set(id, new Map());
      accountCount.set(id, 0);
      portfolioCount += 1;
      newPortfolios.push({ id, name });
      return { ok: true, portfolioId: id };
    },
    account,
    settlementAccount(portfolioId, preferredAccountId, currency) {
      const accounts = [...(accountsByPortfolio.get(portfolioId)?.values() ?? [])];
      const preferred = accounts.find((one) => one.id === preferredAccountId);
      // Not an account of this portfolio's snapshot: leave the request's
      // choice alone and let the ledger say what is wrong with it.
      if (preferred === undefined || preferred.currency === currency) {
        return { ok: true, cashAccountId: preferredAccountId };
      }
      const sameCurrency = accounts
        .filter((one) => one.currency === currency && !one.archived)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
      if (sameCurrency !== undefined) return { ok: true, cashAccountId: sameCurrency.id };
      return account(portfolioId, autoCreatedCashAccountName(currency), currency);
    },
    planned: { portfolios: newPortfolios, cashAccounts: newCashAccounts },
  };
}

/**
 * The entities the plan actually promises to create: everything
 * {@link readDirectory} allocated an id for **that at least one `IMPORT` row
 * names**.
 *
 * A row can be marked to-be-created and then rejected for a reason discovered
 * later — its instrument does not resolve, its reinvestment source is missing,
 * the destination already holds it. Reporting a create for a portfolio that no
 * surviving row writes into would make a dry run promise an empty portfolio,
 * and `applyImport` would then create one.
 *
 * Merged over every directory the plan read (`security-transfer`): the
 * settlement accounts of the request's own portfolio, and the portfolios the
 * user named as transfer destinations — which a row names through
 * {@link PlannedTransactionWrite.transferTargetPortfolioId}.
 */
function directoryActuallyUsed(
  directories: readonly (Directory | null)[],
  outcomes: readonly PlannedRowOutcome[],
): PlannedDirectory {
  const used = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.outcome !== "IMPORT" || outcome.write.target !== "TRANSACTION") continue;
    const write = outcome.write;
    for (const id of [
      write.portfolioId,
      write.cashAccountId,
      write.targetCashAccountId,
      write.transferTargetPortfolioId,
    ]) {
      if (id !== null && id !== "") used.add(id);
    }
  }
  const planned = directories.flatMap((directory) => (directory === null ? [] : [directory]));
  return {
    portfolios: planned.flatMap((one) =>
      one.planned.portfolios.filter((portfolio) => used.has(portfolio.id)),
    ),
    cashAccounts: planned.flatMap((one) =>
      one.planned.cashAccounts.filter((account) => used.has(account.id)),
    ),
  };
}

/* ------------------------------------------- *
 * Per-row resolution: destination + instrument *
 * ------------------------------------------- */

/** Every resolved id one planned write needs, before its figures are read off the row. */
interface WriteSite {
  readonly id: string | null;
  readonly portfolioId: string | null;
  /** `""` when the row has no instrument leg; see {@link resolveTransactionInstrument}. */
  readonly instrumentId: string;
  /** `""` when the row names no settling account — only a cashless distribution of a per-row-destination file. */
  readonly cashAccountId: string;
  readonly settlementInstrumentId: string | null;
  readonly targetCashAccountId: string | null;
  /** Pass 1: where in this file the row a reinvestment names was declared; `null` for every other kind. */
  readonly sourceRowPosition: number | null;
}

type WriteSiteResolution =
  | { readonly ok: true; readonly site: WriteSite }
  | { readonly ok: false; readonly reason: ImportRejectReason; readonly message: string };

function resolveWriteSite(
  row: Exclude<AnyNeutralRow, NeutralInstrumentRow>,
  catalogue: ReturnType<typeof indexCatalogue>,
  directory: Directory | null,
  settlementDirectory: Directory | null,
  requestDestination: ImportDestination | null,
  labelledPosition: ReadonlyMap<string, number>,
): WriteSiteResolution {
  const instrument = resolveTransactionInstrument(row, catalogue);
  if (!instrument.ok) return instrument;

  let settlementInstrumentId: string | null = null;
  if (row.shape === "SETTLED_TRADE") {
    const settlement = resolveIdentity(row.settlementRef, catalogue);
    if (!settlement.ok) {
      // Never demoted to an ordinary cash-settled acquisition: see this code's
      // entry in {@link IMPORT_REJECT_REASONS}.
      return {
        ok: false,
        reason: "SETTLEMENT_INSTRUMENT_NOT_RESOLVED",
        message: `the asset this row was paid with does not resolve to one instrument — ${settlement.message}`,
      };
    }
    settlementInstrumentId = settlement.instrumentId;
  }

  if (directory === null) {
    // Every Portfolio-Performance row: the request's single destination, and
    // `portfolioId: null` so `apply` reads it from its own context exactly as
    // it did before this cycle.
    const destination = requestDestination!;
    const currency = settlementCurrencyOf(row);
    const account =
      settlementDirectory === null || currency === null
        ? ({ ok: true, cashAccountId: destination.cashAccountId } as const)
        : settlementDirectory.settlementAccount(
            destination.portfolioId,
            destination.cashAccountId,
            currency,
          );
    if (!account.ok) return account;
    return {
      ok: true,
      site: {
        id: null,
        portfolioId: null,
        instrumentId: instrument.instrumentId,
        cashAccountId: account.cashAccountId,
        settlementInstrumentId,
        targetCashAccountId: null,
        sourceRowPosition: null,
      },
    };
  }

  const read = destinationOf(row);
  if (!read.present) {
    return {
      ok: false,
      reason: "MISSING_REQUIRED_VALUE",
      message: `this row does not name a complete destination; it is missing ${read.missing.length} of the three fields that identify one`,
    };
  }
  const destination: NeutralDestination = read.destination;
  const portfolio = directory.portfolio(destination.portfolioName);
  if (!portfolio.ok) return portfolio;

  let cashAccountId = "";
  if (destination.cashAccount !== null) {
    const account = directory.account(
      portfolio.portfolioId,
      destination.cashAccount.name,
      destination.cashAccount.currency,
    );
    if (!account.ok) return account;
    cashAccountId = account.cashAccountId;
  }

  // FR-59's far leg names an account of its own, in the same portfolio,
  // matched by `(portfolio, name)`, created with the currency the row states,
  // refused when an existing account disagrees. (A withholding names none
  // since the net-dividend change: it leaves the principal's account.)
  let targetCashAccountId: string | null = null;
  if (row.shape === "CURRENCY_EXCHANGE") {
    const account = directory.account(
      portfolio.portfolioId,
      row.targetCashAccountName,
      row.targetCurrency,
    );
    if (!account.ok) return account;
    targetCashAccountId = account.cashAccountId;
  }

  return {
    ok: true,
    site: {
      // Pre-allocated: see {@link PlannedTransactionWrite.id}.
      id: randomUUID(),
      portfolioId: portfolio.portfolioId,
      instrumentId: instrument.instrumentId,
      cashAccountId,
      settlementInstrumentId,
      targetCashAccountId,
      sourceRowPosition:
        row.shape === "DRIP" ? (labelledPosition.get(row.sourceRef) ?? null) : null,
    },
  };
}

/** The currency a row's cash leg moves in; `null` for a row with none (a cashless distribution). */
function settlementCurrencyOf(
  row: Exclude<AnyNeutralRow, NeutralInstrumentRow>,
): CurrencyCode | null {
  switch (row.shape) {
    case "TRADE":
      return row.cashCurrency ?? row.currency;
    case "DIVIDEND":
      return row.cashCurrency ?? row.currency;
    // `cash-interest` I-5: routed like a deposit, in its settlement currency.
    case "INTEREST":
      return row.cashCurrency ?? row.currency;
    // `portfolio-cash`: routed like a deposit, in its settlement currency.
    case "FEE":
      return row.cashCurrency ?? row.currency;
    case "CASH_MOVEMENT":
      return row.currency;
    // `security-transfer`: no cash leg at all, so a transfer is never routed to
    // (nor opens) a settlement account in its currency. It still carries the
    // request's account for the fingerprint, as a distribution does. The last
    // three shapes never reach the routing that reads this (a
    // Portfolio-Performance file cannot produce them).
    case "TRANSFER":
    case "DISTRIBUTION":
    case "CURRENCY_EXCHANGE":
    case "SETTLED_TRADE":
    case "DRIP":
      return null;
    default: {
      // `cash-interest` I-5: a `default: return null` silently skipped routing
      // for an unlisted shape — the next one is a compile error here instead.
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

type TransactionInstrumentResolution =
  | { readonly ok: true; readonly instrumentId: string }
  | { readonly ok: false; readonly reason: ImportRejectReason; readonly message: string };

/**
 * The three-step order, applied in memory against the one batched catalogue
 * read.
 *
 * **When the ticker's suffix resolved an exchange, that lookup is
 * authoritative** — a zero-match result is `INSTRUMENT_NOT_RESOLVED`, not a
 * fall-through to the ISIN-alone step. The file said which exchange the trade
 * happened on; quietly attaching it to a listing on a *different* exchange
 * because that is the only one in the catalogue would produce a plausible,
 * silent, wrong answer, which is the one outcome a dry-run summary cannot warn
 * the user about.
 */
function resolveTransactionInstrument(
  row: Exclude<AnyNeutralRow, NeutralInstrumentRow>,
  catalogue: ReturnType<typeof indexCatalogue>,
): TransactionInstrumentResolution {
  if (
    row.shape === "CASH_MOVEMENT" ||
    row.shape === "CURRENCY_EXCHANGE" ||
    row.shape === "INTEREST"
  ) {
    return { ok: true, instrumentId: "" };
  }
  // `portfolio-cash` (PC-L14): a FEE's instrument is optional. Absent, it
  // resolves to no instrument; stated, it resolves exactly as a trade's does,
  // with the same refusal when it does not (AC-586).
  if (row.shape === "FEE") {
    return row.instrumentRef === null
      ? { ok: true, instrumentId: "" }
      : resolveIdentity(row.instrumentRef, catalogue);
  }
  return resolveIdentity(row.instrumentRef, catalogue);
}

/**
 * One identity against the catalogue snapshot.
 *
 * **A stated market identifier wins outright over the ticker's suffix**.
 * `SYMBOL_SUFFIX_TO_MIC`'s table is
 * an *inference* from a ticker written the way one particular export writes
 * them; a format that carries the code as its own column has no need of it, and
 * consulting it anyway would let a suffix the other format's convention assigns
 * override a code this file states outright. So the suffix table is read only
 * when no code was stated — which is the Portfolio-Performance case, unchanged.
 */
function resolveIdentity(
  identity: NeutralInstrumentIdentity,
  catalogue: ReturnType<typeof indexCatalogue>,
): TransactionInstrumentResolution {
  const split = identity.symbol === null ? null : splitSymbolSuffix(identity.symbol);
  const exchangeMic = identity.exchangeMic ?? split?.exchangeMic ?? null;

  if (identity.isin !== null) {
    const byIsin = catalogue.byIsin(identity.isin);
    const candidates =
      exchangeMic == null ? byIsin : byIsin.filter((match) => match.exchangeMic === exchangeMic);
    return oneOf(candidates, describeIdentity(identity));
  }

  if (split === null || split.symbol === "") {
    return {
      ok: false,
      reason: "INSTRUMENT_NOT_RESOLVED",
      message:
        "the row carries neither an identifier nor a ticker, so no instrument can be resolved for it",
    };
  }
  const bySymbol = catalogue
    .bySymbol(split.symbol)
    .filter((match) => match.primaryIdentifier === "SYMBOL");
  return oneOf(bySymbol, describeIdentity(identity));
}

function oneOf(
  candidates: readonly InstrumentIdentityMatch[],
  described: string,
): TransactionInstrumentResolution {
  if (candidates.length === 1) return { ok: true, instrumentId: candidates[0]!.id };
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "INSTRUMENT_NOT_RESOLVED",
      message: `no instrument in the catalogue matches ${described}`,
    };
  }
  return {
    ok: false,
    reason: "INSTRUMENT_AMBIGUOUS",
    message: `${described} matches more than one instrument and the row does not say which: ${candidates
      .map((candidate) => candidate.id)
      .join(", ")}`,
  };
}

function describeIdentity(identity: NeutralInstrumentIdentity): string {
  const parts = [identity.isin, identity.symbol, identity.displayName].filter(
    (one) => one != null && one !== "",
  );
  return parts.length > 0 ? parts.join(" / ") : "this row's instrument reference";
}

/* ----------------------------------------- *
 * Reinvestment, in two passes               *
 * ----------------------------------------- */

/**
 * Pass 1, run after every other row's outcome is settled.
 *
 * A reinvestment names its source by a **file-local label**, not by an id: the
 * file cannot know the destination's transaction ids. Four ways that can fail,
 * and all four are decided **here**, at plan time, so the dry run and the
 * confirm agree:
 *
 *  1. the label names no row of this file;
 *  2. the row it names is not a distribution (unreachable through the shipped
 *     format, whose column table allows the label only on that kind, and
 *     checked because `planImport` takes a {@link ParseResult} any
 *     implementation could have produced);
 *  3. the row it names is itself rejected, so no id will exist for it;
 *  4. the row it names is written **after** this one in {@link applyOrderOf}'s
 *     order, so its id would not exist yet when this row is written. The ordering
 *     argument says this cannot happen for an exported file; a hand-authored one can
 *     do it, and it gets a named reason rather than an `InvalidDripSourceError`
 *     from the ledger.
 *
 * The surviving rows come back carrying `sourceDividendId` — **the id the
 * source has in the destination**, which is the pre-allocated one when this run
 * writes it and the existing one when the destination already held it. That
 * single rule is what makes a re-import idempotent: on the first run the
 * reinvestment's fingerprint is hashed over the id the distribution was written
 * with, and on the second run the distribution is `ALREADY_IMPORTED` and
 * resolves to that same id, so the reinvestment hashes to the same value and is
 * skipped too rather than duplicated ("without this, a re-import
 * would reject every DRIP").
 */
function resolveReinvestmentSources(
  reinvestments: readonly ImportableRow[],
  labelledPosition: ReadonlyMap<string, number>,
  resolvedIdByPosition: ReadonlyMap<number, string>,
  draft: readonly (PlannedRowOutcome | null)[],
  place: (at: SourceRowRef, outcome: PlannedRowOutcome) => void,
  order: ApplyOrderRule,
): ImportableRow[] {
  const resolved: ImportableRow[] = [];
  for (const one of reinvestments) {
    const label = one.write.sourceRowPosition;
    const refused = (message: string): void => {
      place(one.at, reject(one.at, "DRIP_SOURCE_NOT_RESOLVED", message));
    };
    if (label === null) {
      refused(
        "this row reinvests a distribution it identifies by a label no row of this file declares",
      );
      continue;
    }
    const sourceOutcome = draft[label];
    if (
      sourceOutcome === null ||
      sourceOutcome === undefined ||
      sourceOutcome.outcome === "REJECT"
    ) {
      refused(
        "the row this one reinvests was itself refused, so there is no transaction for it to be attached to",
      );
      continue;
    }
    const sourceDividendId = resolvedIdByPosition.get(label);
    if (sourceDividendId === undefined) {
      refused(
        "the row this one reinvests is not written and is not already present in the destination, so it has no id",
      );
      continue;
    }
    if (!writtenBefore(sourceOutcome, label, one, order)) {
      refused(
        "the row this one reinvests is written after it, so its id would not yet exist at the moment this row is written",
      );
      continue;
    }
    resolved.push({ ...one, write: { ...one.write, sourceDividendId } });
  }
  return resolved;
}

/**
 * The ordering assertion, made rather than assumed: the source's position in
 * {@link applyOrderOf}'s order is earlier than this row's.
 *
 * Compared through the same key the order is built from, so the two cannot
 * disagree. A per-row-destination file is the only one that reaches here, so
 * the key always includes the time — and the portfolio, unless the file writes
 * a stated transfer pair (ST-12's chronological order).
 */
function writtenBefore(
  sourceOutcome: PlannedRowOutcome,
  sourcePosition: number,
  reinvestment: ImportableRow,
  order: ApplyOrderRule,
): boolean {
  // A source the destination already holds is written; there is nothing to
  // order against.
  if (sourceOutcome.outcome !== "IMPORT") return true;
  const source: ApplySortKey = {
    index: sourcePosition,
    key: sortKeyOf(sourceOutcome.write, order),
  };
  const here: ApplySortKey = {
    index: reinvestment.position,
    key: sortKeyOf(reinvestment.write, order),
  };
  return compareSortKeys(source, here) < 0;
}

/* -------------------------------- *
 * Building one row's planned write *
 * -------------------------------- */

/** Every extended leg, absent. Spread by the builders of the kinds that carry none of them. */
const NO_EXTENDED_LEGS = {
  cashAmount: null,
  fxFee: null,
  otherCost: null,
  settlementInstrumentId: null,
  settlementAmount: null,
  settlementFxRateUserInput: null,
  targetCurrency: null,
  exchangeRate: null,
  targetCashAccountId: null,
  sourceDividendId: null,
  sourceRowPosition: null,
  // `security-transfer`: set by `planImport` from the user's answer or from
  // the file's own target-leg row, never read off the row being built, so every
  // builder starts them absent.
  transferTargetPortfolioId: null,
  transferTargetRow: null,
  transferCost: null,
} as const;

type PlannedTransactionDraft = Omit<PlannedTransactionWrite, "importFingerprint">;

function transactionWriteOf(
  row: Exclude<AnyNeutralRow, NeutralInstrumentRow>,
  site: WriteSite,
): PlannedTransactionDraft {
  switch (row.shape) {
    case "CASH_MOVEMENT":
      return {
        target: "TRANSACTION",
        kind: row.direction === "IN" ? "DEPOSIT" : "WITHDRAWAL",
        id: site.id,
        portfolioId: site.portfolioId,
        tradeDate: row.tradeDate,
        tradeTs: row.tradeTs,
        instrumentId: null,
        quantity: null,
        unitPrice: null,
        amount: row.amount,
        currency: row.currency,
        cashCurrency: null,
        fxRateUserInput: row.fxRateUserInput ?? null,
        feeAmount: null,
        brokerFee: null,
        taxAmount: null,
        withholdingAmount: null,
        cashAccountId: site.cashAccountId,
        note: row.note,
        reference: row.reference ?? null,
        ...NO_EXTENDED_LEGS,
      };
    case "DIVIDEND":
      return dividendWrite(row, site);
    case "INTEREST":
      return interestWrite(row, site);
    case "FEE":
      return feeWrite(row, site);
    case "TRADE":
      return tradeWrite(row, site);
    case "DISTRIBUTION":
      return distributionWrite(row, site);
    case "TRANSFER":
      return transferWrite(row, site);
    case "CURRENCY_EXCHANGE":
      return currencyExchangeWrite(row, site);
    case "SETTLED_TRADE":
      return settledTradeWrite(row, site);
    case "DRIP":
      return reinvestmentWrite(row, site);
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function dividendWrite(row: NeutralDividendRow, site: WriteSite): PlannedTransactionDraft {
  return {
    target: "TRANSACTION",
    kind: "DIVIDEND",
    id: site.id,
    portfolioId: site.portfolioId,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    instrumentId: site.instrumentId,
    quantity: null,
    unitPrice: null,
    amount: row.amount,
    currency: row.currency,
    cashCurrency: row.cashCurrency ?? null,
    fxRateUserInput: row.fxRateUserInput ?? null,
    feeAmount: null,
    brokerFee: null,
    taxAmount: null,
    withholdingAmount: row.withholdingAmount,
    cashAccountId: site.cashAccountId,
    note: row.note,
    reference: row.reference ?? null,
    ...NO_EXTENDED_LEGS,
    cashAmount: row.cashAmount ?? null,
  };
}

/** `cash-interest`: {@link dividendWrite} with no instrument. */
function interestWrite(row: NeutralInterestRow, site: WriteSite): PlannedTransactionDraft {
  return {
    target: "TRANSACTION",
    kind: "INTEREST",
    id: site.id,
    portfolioId: site.portfolioId,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    instrumentId: null,
    quantity: null,
    unitPrice: null,
    amount: row.amount,
    currency: row.currency,
    cashCurrency: row.cashCurrency ?? null,
    fxRateUserInput: row.fxRateUserInput ?? null,
    feeAmount: null,
    brokerFee: null,
    taxAmount: null,
    withholdingAmount: row.withholdingAmount,
    cashAccountId: site.cashAccountId,
    note: row.note,
    reference: row.reference ?? null,
    ...NO_EXTENDED_LEGS,
    cashAmount: row.cashAmount ?? null,
  };
}

/**
 * `portfolio-cash`: a WITHDRAWAL-shaped write with an optional instrument
 * reference — the site's `""` (no reference stated) is written as `null`.
 */
function feeWrite(row: NeutralFeeRow, site: WriteSite): PlannedTransactionDraft {
  return {
    target: "TRANSACTION",
    kind: "FEE",
    id: site.id,
    portfolioId: site.portfolioId,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    instrumentId: site.instrumentId === "" ? null : site.instrumentId,
    quantity: null,
    unitPrice: null,
    amount: row.amount,
    currency: row.currency,
    cashCurrency: row.cashCurrency ?? null,
    fxRateUserInput: row.fxRateUserInput ?? null,
    feeAmount: null,
    brokerFee: null,
    taxAmount: null,
    withholdingAmount: null,
    cashAccountId: site.cashAccountId,
    note: row.note,
    reference: row.reference ?? null,
    ...NO_EXTENDED_LEGS,
    cashAmount: row.cashAmount ?? null,
  };
}

/**
 * The cashless share-distribution kind.
 *
 * Two things it does **not** do. It sets no `unitPrice` — free shares have no
 * price, and the create schema refuses one on this kind — and `amount` carries
 * the **market value** the source wrote, which the ledger stores as
 * `gross_amount` and contributes to no cost basis.
 *
 * `cashAccountId` is still carried for a Portfolio-Performance row, and that is
 * not a contradiction: the write below never sends it (this kind names no
 * account), but it is part of ID7's fingerprint for every kind, where it means
 * "the destination the user chose for this import". Two imports of one file
 * into two accounts of the same portfolio are different intents and must not
 * skip each other — a property of the import, not of the transaction's legs.
 * A per-row-destination file states no account on this kind at all, so it
 * carries `""` and `kd1` hashes the absence.
 */
function distributionWrite(row: NeutralDistributionRow, site: WriteSite): PlannedTransactionDraft {
  return {
    target: "TRANSACTION",
    kind: "SHARE_DISTRIBUTION",
    id: site.id,
    portfolioId: site.portfolioId,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    instrumentId: site.instrumentId,
    quantity: row.quantity,
    unitPrice: null,
    amount: row.marketValue,
    currency: row.currency,
    cashCurrency: null,
    fxRateUserInput: row.fxRateUserInput ?? null,
    feeAmount: null,
    brokerFee: null,
    taxAmount: null,
    withholdingAmount: null,
    cashAccountId: site.cashAccountId,
    note: row.note,
    reference: row.reference ?? null,
    ...NO_EXTENDED_LEGS,
  };
}

/**
 * `security-transfer`: a source-leg transfer — the distribution's shape
 * (no price, no cost leg, the market value in `amount`, and the request's
 * account carried for the fingerprint only), under its own kind.
 *
 * A **linked** target-leg row never reaches here: `planImport` decides it
 * against the ledger ({@link decideTargetLegs}) or pairs it with its source row
 * ({@link pairTransferLegs}), because a linked target leg is written by its
 * source leg's call. The one target leg that does is a **lone** one of a
 * per-row-destination file (ND-2 (a)), written from the cost it states.
 */
function transferWrite(row: NeutralTransferRow, site: WriteSite): PlannedTransactionDraft {
  const inbound = row.direction === "IN";
  if (inbound && row.transferCost === undefined) {
    throw new Error("a target-leg transfer row is written only alone, and only with its cost");
  }
  return {
    target: "TRANSACTION",
    kind: inbound ? "TRANSFER_IN" : "TRANSFER_OUT",
    id: site.id,
    portfolioId: site.portfolioId,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    instrumentId: site.instrumentId,
    quantity: row.quantity,
    unitPrice: null,
    amount: row.marketValue,
    currency: row.currency,
    cashCurrency: null,
    fxRateUserInput: row.fxRateUserInput ?? null,
    feeAmount: null,
    brokerFee: null,
    taxAmount: null,
    withholdingAmount: null,
    cashAccountId: site.cashAccountId,
    note: row.note,
    reference: row.reference ?? null,
    ...NO_EXTENDED_LEGS,
    transferCost: inbound ? (row.transferCost ?? null) : null,
  };
}

/**
 * The ledger's cash-leg table (`TransactionWriteService.#resolveCashLeg`) keys
 * on the tenant's base currency, which a source row cannot know: a settled
 * amount is **required** when the account is in a third currency (a EUR-priced
 * coin bought out of a USD balance) and **refused** when the account is in the
 * base currency, where the ledger derives it as `gross × fx_rate` itself. A
 * format that can state the figure states it on every foreign-settled trade,
 * and this drops it on the one shape where the ledger would refuse it.
 */
function settledAgainstBase(
  write: PlannedTransactionDraft,
  baseCurrency: CurrencyCode | null,
): PlannedTransactionDraft {
  if (write.cashAmount === null || write.cashCurrency !== baseCurrency) return write;
  return { ...write, cashAmount: null };
}

async function readBaseCurrency(db: Db, tenantId: string): Promise<CurrencyCode> {
  const [row] = await withTenant(db, tenantId, async (tx) =>
    tx.select({ baseCurrency: tenant.baseCurrency }).from(tenant).where(eq(tenant.id, tenantId)),
  );
  if (row === undefined) throw new Error(`planImport: no tenant row for ${tenantId}`);
  return row.baseCurrency;
}

function tradeWrite(row: NeutralTradeRow, site: WriteSite): PlannedTransactionDraft {
  return {
    target: "TRANSACTION",
    kind: row.direction === "ACQUIRE" ? "BUY" : "SELL",
    id: site.id,
    portfolioId: site.portfolioId,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    instrumentId: site.instrumentId,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    // M14: the money leg of a trade is derived from `quantity × unitPrice`, and
    // the create schema forbids supplying it. Absent here for the same reason,
    // and absent from the fingerprint's `fixed(amount)` slot with it.
    amount: null,
    currency: row.currency,
    // A foreign-currency trade's own two figures, straight from the neutral
    // row — see `NeutralTradeRow.cashCurrency`'s own doc comment. Both `null`
    // on the ordinary same-currency trade, which is `tradeWrite`'s only case
    // before that pair existed.
    cashCurrency: row.cashCurrency,
    fxRateUserInput: row.fxRateUserInput,
    // FT-41: the fold survives *at the leg total* — `costs` is still the sum
    // of the source's cost figures and still what lands in `fee_amount`,
    // bit-identically, which is what keeps every pre-cycle total unmoved. The
    // figures it was folded from now travel beside it.
    feeAmount: row.costs,
    brokerFee: row.brokerFee,
    taxAmount: row.tax,
    withholdingAmount: null,
    cashAccountId: site.cashAccountId,
    note: row.note,
    reference: row.reference ?? null,
    ...NO_EXTENDED_LEGS,
    cashAmount: row.cashAmount ?? null,
    fxFee: row.fxFee ?? null,
    otherCost: row.otherCost ?? null,
  };
}

/**
 * FR-59's exchange. `amount`/`currency` are the leg that leaves; the far leg is
 * `targetCurrency` at `exchangeRate`, into `targetCashAccountId`.
 *
 * The stated target figure is **not** carried into the write and is not checked
 * here — see `CURRENCY_EXCHANGE_RATE_INCONSISTENT`'s entry in
 * {@link IMPORT_REJECT_REASONS}. The ledger derives `target_amount = amount ×
 * exchangeRate` and has no parameter that overrides it (GATE-0b, 0/5), so the
 * rate is the whole input and the figure is a check `validate` already made.
 */
function currencyExchangeWrite(
  row: NeutralCurrencyExchangeRow,
  site: WriteSite,
): PlannedTransactionDraft {
  return {
    target: "TRANSACTION",
    kind: "CURRENCY_EXCHANGE",
    id: site.id,
    portfolioId: site.portfolioId,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    instrumentId: null,
    quantity: null,
    unitPrice: null,
    amount: row.amount,
    currency: row.currency,
    cashCurrency: null,
    fxRateUserInput: row.fxRateUserInput,
    feeAmount: row.costs,
    brokerFee: row.brokerFee,
    taxAmount: row.tax,
    withholdingAmount: null,
    cashAccountId: site.cashAccountId,
    note: row.note,
    reference: row.reference ?? null,
    ...NO_EXTENDED_LEGS,
    fxFee: row.fxFee,
    otherCost: row.otherCost,
    targetCurrency: row.targetCurrency,
    exchangeRate: row.exchangeRate,
    targetCashAccountId: site.targetCashAccountId,
  };
}

/**
 * FR-66/AC52's asset-settled acquisition. `currency` is deliberately absent —
 * the gross is denominated in the settlement asset, which is the ledger's own
 * `txn_currency XOR txn_settlement_instrument_id` stated in the neutral
 * vocabulary — so this is the one write shape whose `currency` slot carries the
 * empty string and whose `kd1` hashes a `null` currency.
 */
function settledTradeWrite(row: NeutralSettledTradeRow, site: WriteSite): PlannedTransactionDraft {
  return {
    target: "TRANSACTION",
    kind: "BUY",
    id: site.id,
    portfolioId: site.portfolioId,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    instrumentId: site.instrumentId,
    quantity: row.quantity,
    unitPrice: null,
    amount: null,
    currency: "",
    cashCurrency: null,
    fxRateUserInput: null,
    feeAmount: row.costs,
    brokerFee: row.brokerFee,
    taxAmount: row.tax,
    withholdingAmount: null,
    cashAccountId: site.cashAccountId,
    note: row.note,
    reference: row.reference ?? null,
    ...NO_EXTENDED_LEGS,
    fxFee: row.fxFee,
    otherCost: row.otherCost,
    settlementInstrumentId: site.settlementInstrumentId,
    settlementAmount: row.settlementAmount,
    settlementFxRateUserInput: row.settlementFxRateUserInput,
  };
}

/**
 * FR-10/AC6's reinvestment — structurally an acquisition, with a mandatory link
 * to the distribution it reinvests.
 *
 * `sourceRowPosition` is carried out of the *label*
 * {@link NeutralDripRow.sourceRef} names, resolved in
 * {@link resolveReinvestmentSources}; `sourceDividendId` is filled in there and
 * is `null` at this point on purpose, so a row that reaches the fingerprint
 * without having gone through pass 1 hashes visibly differently rather than
 * plausibly.
 */
function reinvestmentWrite(row: NeutralDripRow, site: WriteSite): PlannedTransactionDraft {
  return {
    target: "TRANSACTION",
    kind: "DRIP",
    id: site.id,
    portfolioId: site.portfolioId,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs,
    instrumentId: site.instrumentId,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    amount: null,
    currency: row.currency,
    cashCurrency: row.cashCurrency,
    fxRateUserInput: row.fxRateUserInput,
    feeAmount: row.costs,
    brokerFee: row.brokerFee,
    taxAmount: row.tax,
    withholdingAmount: null,
    cashAccountId: site.cashAccountId,
    note: row.note,
    reference: row.reference ?? null,
    ...NO_EXTENDED_LEGS,
    cashAmount: row.cashAmount ?? null,
    fxFee: row.fxFee,
    otherCost: row.otherCost,
    sourceRowPosition: site.sourceRowPosition,
  };
}

/* ------------------------- *
 * The two fingerprint recipes *
 * ------------------------- */

/**
 * One value per row, in the caller's order.
 *
 * Three channels, in order, and the first two are what KD8 is about:
 *
 *  1. **A carried value is used verbatim** and is not re-fingerprinted. It is
 *     checked against the destination first, and when it does not match, it is
 *     what gets stored — because re-fingerprinting would move the stored value
 *     on every export/import cycle, which is exactly what makes the *second*
 *     round trip non-idempotent.
 *  2. A per-row-destination file's own rows are fingerprinted `kd1`, whose key
 *     includes the portfolio because one file writes to many.
 *  3. Everything else is `pp2`, unchanged.
 *
 * The occurrence ordinal is computed over the identity keys of the rows that
 * actually need one; a carried value has none, and is excluded from the
 * ordinal's input so it cannot shift another row's.
 *
 * ## F-F — a carried fingerprint survives a restore, into a tenant that never
 * imported the file it names
 *
 * csv-import's F-E decided that editing an imported row leaves its fingerprint
 * in place: the row still originates from that source line. Channel 1 above
 * extends the same value one step further — out of one installation's export
 * and into **another tenant**, where `pp2:…` names a Portfolio-Performance file
 * that tenant never saw, and `kd1:…` a Kerdial file it never imported.
 *
 * **This is expected, and it is not a bug to fix.** The value is inert data on
 * an inert column: the only mechanism that ever reads `import_fingerprint` is
 * the equality check in {@link selectExistingFingerprints}, which is scoped
 * `(tenant_id, portfolio_id, import_fingerprint)` — the partial unique index's
 * own key — so a fingerprint can only ever match another row of the **same**
 * tenant and the **same** portfolio. It names a provenance, it does not grant
 * one: nothing looks the source file up, nothing reports it, and no cross-
 * tenant read exists for it to participate in.
 *
 * Re-fingerprinting on the way in would be the alternative, and it is the one
 * KD8 refused: the stored value would then move on every round trip, so
 * the *second* export/import cycle would duplicate every row instead of
 * skipping it. The inert-but-foreign value is the price of idempotence, paid
 * knowingly.
 *
 * The user-facing half of this is `IMPORT_EDITED_ROW_NOTICE`
 * (`core/api-contracts/src/import-notice.ts`), whose third sentence states that
 * the attachment survives a restore — a clause on F-E's own sentence, not a
 * second notice.
 *
 * ## A carried value copied onto another row is trusted too
 *
 * Channel 1 checks a carried value's shape, not that it belongs to its row. A
 * hand-edited file that pastes one row's `import_fingerprint` onto a different
 * transaction of the same portfolio therefore has that transaction skipped as
 * `ALREADY_IMPORTED`. **Accepted, by owner decision (2026-10-13):** the column
 * is for exports, the outcome is a visible skip in the summary, the reach is
 * one portfolio of the user's own tenant, and duplicates within the file are
 * still caught. Re-deriving `kd1` to compare would refuse correctly edited
 * exported rows whose edited field is part of the key.
 */
function fingerprintsOf(rows: readonly ImportableRow[], perRowDestination: boolean): string[] {
  const computed = rows
    .map((one, index) => ({ one, index }))
    .filter(({ one }) => one.carriedFingerprint === null);
  const identityKeys = computed.map(({ one }) =>
    perRowDestination
      ? kerdialFingerprintIdentityKey(kerdialFingerprintFieldsOf(one.write, 1))
      : fingerprintIdentityKey(fingerprintFieldsOf(one.write, 1)),
  );
  const ordinals = occurrenceOrdinals(identityKeys);

  const byIndex = new Map<number, string>();
  computed.forEach(({ one, index }, at) => {
    const occurrence = ordinals[at]!;
    byIndex.set(
      index,
      perRowDestination
        ? computeKerdialFingerprint(kerdialFingerprintFieldsOf(one.write, occurrence))
        : computeImportFingerprint(fingerprintFieldsOf(one.write, occurrence)),
    );
  });
  return rows.map((one, index) => one.carriedFingerprint ?? byIndex.get(index)!);
}

/** Every portfolio the batched existence check has to be scoped by, matching the partial unique index's own key. */
function portfolioIdsOf(
  rows: readonly ImportableRow[],
  requestDestination: ImportDestination | null,
): string[] {
  const ids = new Set<string>();
  for (const one of rows) {
    const id = one.write.portfolioId ?? requestDestination?.portfolioId ?? "";
    if (id !== "") ids.add(id);
  }
  return [...ids];
}

function fingerprintFieldsOf(
  write: PlannedTransactionDraft,
  occurrence: number,
): FingerprintFields {
  return {
    kindCode: write.kind,
    tradeDate: write.tradeDate,
    instrumentId: write.instrumentId,
    quantity: write.quantity,
    unitPrice: write.unitPrice,
    amount: write.amount,
    currency: write.currency,
    feeAmount: write.feeAmount,
    brokerFee: write.brokerFee,
    taxAmount: write.taxAmount,
    withholdingAmount: write.withholdingAmount,
    cashAccountId: write.cashAccountId,
    occurrence,
  };
}

/**
 * `kd1`'s field set. Every `""` an id or code slot could carry
 * becomes `null`, because the recipe's own `text()` maps `null` to `""` and
 * this file's "no such leg" convention is the empty string: routing both
 * through one representation is what keeps "this row names no settling account"
 * and "this row's settling account is the empty-named one" from being
 * indistinguishable had the convention ever changed.
 */
function kerdialFingerprintFieldsOf(
  write: PlannedTransactionDraft,
  occurrence: number,
): KerdialFingerprintFields {
  const orNull = (value: string | null): string | null =>
    value === null || value === "" ? null : value;
  return {
    kindCode: write.kind,
    tradeDate: write.tradeDate,
    portfolioId: write.portfolioId ?? "",
    instrumentId: orNull(write.instrumentId),
    settlementInstrumentId: orNull(write.settlementInstrumentId),
    quantity: write.quantity,
    unitPrice: write.unitPrice,
    grossAmount: write.amount ?? write.settlementAmount,
    currency: orNull(write.currency),
    cashAccountId: orNull(write.cashAccountId),
    cashCurrency: orNull(write.cashCurrency),
    cashAmount: write.cashAmount,
    targetCurrency: orNull(write.targetCurrency),
    // `kd1` hashes the *stored* target amount, which the ledger derives from the
    // rate rather than reading from the file. Derived here for the same
    // reason: the hash has to describe the row the database will hold.
    targetAmount:
      write.exchangeRate === null || write.amount === null
        ? null
        : write.amount.times(write.exchangeRate),
    targetCashAccountId: orNull(write.targetCashAccountId),
    feeAmount: write.feeAmount,
    brokerFee: write.brokerFee,
    fxFee: write.fxFee,
    taxAmount: write.taxAmount,
    otherCost: write.otherCost,
    withholdingAmount: write.withholdingAmount,
    sourceDividendId: orNull(write.sourceDividendId),
    occurrence,
  };
}

/**
 * The check: **one** batched read over the whole file's fingerprints, never
 * one per row — widened to carry the carried-forward values
 * in the same `IN` list as the computed ones, and to return the matched
 * row's **id** alongside, which is what lets a reinvestment resolve against a
 * distribution the destination already held.
 *
 * Scoped by `(tenant_id, portfolio_id)` exactly as the partial unique index is,
 * so the read and the constraint that backs it agree by construction — for a
 * file that writes to many portfolios, by the set of them. A row carrying
 * `NULL` — every manually-entered transaction — cannot match any member of the
 * list and is therefore invisible to an import, which is correct: it was not
 * created from that source line.
 *
 * **Inside `withTenant`, and that is load-bearing rather than tidy** (found by
 * GATE-1). `transaction` carries RLS, and the predicate is
 * `tenant_id = current_setting('app.tenant_id')`; a bare `db.select()` outside
 * a tenant-scoped transaction therefore returns **zero rows** for the real
 * `app_web` role — the `eq(transaction.tenantId, …)` above is the *intent*, not
 * the scoping. Every other read this stage makes goes through a `ledger`
 * service that opens its own `withTenant`, and the one table this module reads
 * directly was the one that escaped it. MEASURED symptom, before the fix: a
 * re-import of a file already imported planned **every** row `IMPORT`, and only
 * the `23505` race backstop turned them into skips at apply time — which the
 * `DRIP` path cannot be saved by, because its pre-allocated source id names a
 * row the backstop then refuses to write.
 */
async function selectExistingFingerprints(
  db: Db,
  tenantId: string,
  portfolioIds: readonly string[],
  fingerprints: readonly string[],
): Promise<Map<string, string>> {
  if (fingerprints.length === 0 || portfolioIds.length === 0) return new Map();
  const rows = await withTenant(db, tenantId, async (tx) =>
    tx
      .select({
        id: transaction.id,
        portfolioId: transaction.portfolioId,
        importFingerprint: transaction.importFingerprint,
      })
      .from(transaction)
      .where(
        and(
          eq(transaction.tenantId, tenantId),
          inArray(transaction.portfolioId, [...new Set(portfolioIds)]),
          inArray(transaction.importFingerprint, [...new Set(fingerprints)]),
        ),
      ),
  );
  const found = new Map<string, string>();
  for (const row of rows) {
    if (row.importFingerprint === null) continue;
    found.set(`${row.portfolioId}\u001F${row.importFingerprint}`, row.id);
  }
  return found;
}
