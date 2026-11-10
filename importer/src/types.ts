import type { Decimal } from "@kerdial/core-decimal";

/**
 * `importer`'s shared vocabulary.
 *
 * **IMP-3, binding on every declaration below and enforced rather than
 * asserted:** no member of the neutral vocabulary carries a Portfolio
 * Performance column name, a French type label, or a comma-decimal string.
 * `pnpm import-vocabulary-gate` (`tools/gates/src/import-vocabulary/`) scans
 * this file and `src/pipeline/**` for the eleven format literals and fails on
 * any hit — so a leak is a red gate, not a review note.
 *
 * Every amount here is a `Decimal`, every date an {@link IsoDate}, every
 * enumerated value one of this repository's own vocabularies. A second format
 * would have to produce exactly these shapes and nothing else; that is what
 * OD-6(a) means by "behind a dedicated importer interface".
 */

/**
 * Plain ISO calendar date string, `YYYY-MM-DD`, no time-of-day component.
 *
 * Structurally identical to `@kerdial/core-domain`'s `IsoDate` and
 * `@kerdial/market-ports`'s, and deliberately **not** imported from either:
 * fixes this package's dependency list and `core/domain` is not
 * on it, so importing it here would widen the package's graph for two string
 * aliases. `core/domain/src/types.ts`'s own header already records the same
 * duplication with `market/ports` as deliberate and not to be collapsed as a
 * side effect of an unrelated task; this is the third instance of it, recorded
 * the same way rather than fixed silently.
 */
export type IsoDate = string;

/** ISO 4217 three-letter currency code (e.g. `"EUR"`, `"USD"`). See {@link IsoDate} on the duplication. */
export type CurrencyCode = string;

/**
 * Which of the three files the caller says it is handing over. The MVP has the
 * user select this explicitly; there is no sniffing (the user request,
 * verbatim: "No automatic file-type detection is necessary").
 */
export type ImportFileType =
  "ASSETS" | "CASH_ACCOUNT_TRANSACTIONS" | "INVESTMENT_ACCOUNT_TRANSACTIONS";

/**
 * The `portfolio-export-import` cycle's two packages, and
 * with them **every** file type this importer knows. This is the union
 * `core/api-contracts`'s `IMPORT_FILE_TYPES` mirrors by value, and the one
 * `import-file-types.mirror.test.ts` guards.
 *
 * ## Why the two members are added here and not to {@link ImportFileType}
 *
 * They were, in a first draft, and it does not compile — the failure
 * is worth recording rather than rediscovering. Two shipped call sites narrow
 * on a file type and assume the narrowing leaves exactly one alternative:
 *
 *  - `formats/portfolio-performance/index.ts`:
 *    `input.fileType === "ASSETS" ? mapAssetsRow(…) : mapTransactionRow(…, input.fileType)`,
 *    where `mapTransactionRow` takes the two transaction types by name;
 *  - `api/src/imports/imports.controller.ts`'s
 *    `#parse(bytes, fileType: ParseResult["fileType"])`, which hands its
 *    argument straight to that `parse`.
 *
 * Widening the union in place makes both a type error, and the repairs land in
 * the one format module FR-551 freezes and in a controller this cycle's import
 * routes do not otherwise touch. So the **vocabulary** widens here and the
 * **default** stays narrow: {@link ParseInput}, {@link ParseResult} and
 * {@link CsvImporter} take the file type as a parameter defaulting to
 * {@link ImportFileType}, so every existing reference keeps the meaning it had
 * and the format that needs the new members names them. It is the same
 * technique {@link AnyNeutralRow} is the bound for on the row axis, applied to
 * the second one.
 *
 * **Both members land in one edit**, although only the first has a pipeline
 * behind it at this point of the cycle: the wire mirror and its drift test can
 * only be written once against a settled pair, and adding the catalogue member
 * later would pay `Record<ImportFileTypeName, …>`'s compile errors in `web`
 * twice.
 */
export type AnyImportFileType = ImportFileType | "KERDIAL_TRANSACTIONS" | "KERDIAL_CATALOGUE";

/** Where a row came from, for reporting. `line` is 1-based in the file (header = 1). */
export interface SourceRowRef {
  readonly line: number;
  /** 0-based index among data rows — the stable key `resolutions[]` and the UI address rows by. */
  readonly index: number;
}

/**
 * The per-row destination a multi-portfolio file names.
 *
 * **Optional keys, never `| null`, and that is checkable rather than
 * stylistic.** `formats/portfolio-performance/columns.ts` constructs every
 * object literal of the shapes that mix this in; a *required* field — even one
 * typed `| null` — would force an edit there, and FR-551 says the
 * Portfolio-Performance importer passes through this cycle **unmodified**. An
 * edit to its column module makes that claim false in letter even where it is
 * true in behaviour.
 *
 * The cost, stated rather than discovered: optional keys weaken exhaustiveness
 * at the type level. {@link destinationOf} is the answer — it is the **only**
 * site in this package that reads these three fields, so the "a Kerdial row
 * always carries a destination, a Portfolio-Performance row never does"
 * invariant is asserted once instead of at each call site.
 */
export interface NeutralDestinationFields {
  /** Matched against `portfolio.name` (unique per tenant), or created. */
  readonly portfolioName?: string;
  /** Matched against `(portfolio, name)`, or created. */
  readonly cashAccountName?: string;
  /**
   * The named account's own currency. Required beside a `cashAccountName`
   * because it is what lets a transactions file imported **alone** create the
   * account (FR-532); an account that already exists under a *different*
   * currency is a per-row rejection, never an update — the column is immutable
   * by grant.
   */
  readonly cashAccountCurrency?: CurrencyCode;
}

/**
 * Two per-row values a source format may carry that no neutral shape had a
 * place for.
 *
 * **Optional keys on {@link NeutralDestinationFields}' rule**, and for the same
 * checkable FR-551 reason: the Portfolio-Performance module constructs every
 * object literal of the shapes that mix this in and must not be edited. A
 * Portfolio-Performance row carries neither — that export has no reference
 * column and no fingerprint of its own — so both are simply absent there.
 */
export interface NeutralCarriedFields {
  /** `transaction.reference`, verbatim. */
  readonly reference?: string;
  /**
   * The row's **original** `transaction.import_fingerprint`, carried verbatim
   * out of one tenant's export and back in (L17/FR-540/FR-541). Checked against
   * the destination's existing fingerprints *before* a new one is computed, and
   * stored as-is when it does not match — re-fingerprinting it would move the
   * stored value on every export/import round trip, which is exactly what makes
   * the second round trip non-idempotent.
   *
   * Its shape (`^[a-z0-9]{1,8}:[0-9a-f]{64}$`) is the database's own CHECK and
   * is validated before the write, never sent down to come back as a `23514`.
   */
  readonly importFingerprint?: string;
}

/** A resolved per-row destination. See {@link destinationOf}. */
export interface NeutralDestination {
  readonly portfolioName: string;
  /**
   * `null` on the one kind that names no settling account at all — a
   * `DISTRIBUTION`, for which no money moved (the column table lists
   * `cash_account` as applying to "all but `SHARE_DISTRIBUTION`"). The name and
   * the currency travel together because neither is usable alone: the currency
   * is what lets a transactions file imported on its own **create** the account.
   */
  readonly cashAccount: { readonly name: string; readonly currency: CurrencyCode } | null;
}

/** {@link destinationOf}'s result: the destination invariant, made a value. */
export type NeutralDestinationRead =
  | { readonly present: true; readonly destination: NeutralDestination }
  | {
      /**
       * `missing.length === 3` is a row that names **no** destination at all —
       * a Portfolio-Performance row, which takes the whole request's single
       * destination instead. Any strict subset is a **malformed** row, and
       * telling the two apart is why this is not a bare `null`.
       */
      readonly present: false;
      readonly missing: readonly (keyof NeutralDestinationFields)[];
    };

/**
 * The one place `portfolioName`/`cashAccountName`/`cashAccountCurrency` are
 * read. Pure; no clock, no I/O.
 *
 * The invariant, in one function: a row names a portfolio and either both or
 * neither of the cash-account pair. A row carrying one half of that pair, or a
 * cash account with no portfolio, is reported here rather than half-resolved by
 * a caller that only checked the field it happened to care about.
 */
export function destinationOf(row: NeutralDestinationFields): NeutralDestinationRead {
  const { portfolioName, cashAccountName, cashAccountCurrency } = row;
  const absent = (["portfolioName", "cashAccountName", "cashAccountCurrency"] as const).filter(
    (key) => row[key] === undefined,
  );
  if (portfolioName === undefined) return { present: false, missing: absent };
  if (cashAccountName === undefined && cashAccountCurrency === undefined) {
    return { present: true, destination: { portfolioName, cashAccount: null } };
  }
  if (cashAccountName === undefined || cashAccountCurrency === undefined) {
    return { present: false, missing: absent };
  }
  return {
    present: true,
    destination: {
      portfolioName,
      cashAccount: { name: cashAccountName, currency: cashAccountCurrency },
    },
  };
}

/**
 * The neutral row shape. Discriminated on `shape` so a
 * consumer's `switch` can be closed by a `never` check.
 *
 * **This union is deliberately *not* widened with
 * {@link KerdialNeutralRow}'s three members, and the reason is the same FR-551
 * one {@link NeutralDestinationFields} records.** Three `switch`es are closed
 * over it by a `never` check — `pipeline/plan.ts`'s `nonPositiveMoney`,
 * `api`'s `rowSourceOf`, and
 * `formats/portfolio-performance/index.ts`'s `validateNeutralRow` — and the
 * third is inside the Portfolio-Performance module this cycle may not touch.
 * A per-format union is what EI-3's
 * acceptance criterion allows ("`NeutralRow` **or its per-format
 * equivalent**"); the stage that gives the Kerdial rows a `plan` reads
 * `NeutralRow | KerdialNeutralRow`, leaving every Portfolio-Performance
 * consumer's exhaustiveness intact.
 */
export type NeutralRow =
  | NeutralInstrumentRow
  | NeutralCashMovementRow
  | NeutralDividendRow
  | NeutralTradeRow
  | NeutralDistributionRow
  | NeutralTransferRow
  | NeutralInterestRow
  | NeutralFeeRow;

/**
 * The three shapes only a Kerdial transactions file can produce — the ledger kinds the Portfolio-Performance export has no
 * representation for at all.
 */
export type KerdialNeutralRow =
  NeutralCurrencyExchangeRow | NeutralSettledTradeRow | NeutralDripRow;

/**
 * Every neutral shape any format can produce — the upper bound the staged
 * interface is parameterised over (see {@link CsvImporter}).
 *
 * It is **not** the same thing as widening {@link NeutralRow}: the three
 * `switch`es closed over that union by a `never` check keep seeing exactly the
 * six Portfolio-Performance shapes, so none of them has to grow a case for a
 * row its format cannot produce. This alias is only ever used as a *bound*,
 * and the one consumer that genuinely handles all nine — `pipeline/plan.ts` —
 * names it explicitly.
 */
export type AnyNeutralRow = NeutralRow | KerdialNeutralRow;

export interface NeutralInstrumentRow {
  readonly shape: "INSTRUMENT";
  readonly isin: string | null;
  readonly symbol: string | null;
  readonly displayName: string;
  readonly listingCurrency: CurrencyCode;
  /** Present iff the source carried a total-expense-ratio figure. Rule K reads it; nothing else does. */
  readonly hasExpenseRatio: boolean;
  readonly note: string | null;
}

export interface NeutralCashMovementRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "CASH_MOVEMENT";
  readonly direction: "IN" | "OUT";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  /** Always > 0 where the source is well formed; `direction` carries the sign. */
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  /**
   * A rate the **source pinned** for this row (FR-56/FR-57). An optional key on
   * {@link NeutralCarriedFields}' rule; absent means the source format has no
   * such column, which is the Portfolio-Performance case for this shape.
   */
  readonly fxRateUserInput?: Decimal;
  readonly note: string | null;
}

export interface NeutralDividendRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "DIVIDEND";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  /** Gross. **May be 0** — that rejection is assigned to `plan`, not to `validate`; see `validate`'s own doc comment for why the trade-side rule differs. */
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  /**
   * The tax withheld at source: **one amount, denominated by the
   * settling account's currency** — the principal's cash currency — and
   * converted at the principal's rate. It has no currency, rate or account of
   * its own.
   */
  readonly withholdingAmount: Decimal | null;
  /** The rate the source pinned for the dividend's own leg. Optional on the same rule. */
  readonly fxRateUserInput?: Decimal;
  /** The settling account's own currency when it differs from {@link NeutralDividendRow.currency} — see {@link NeutralTradeRow.cashCurrency}. Optional on the same rule. */
  readonly cashCurrency?: CurrencyCode;
  /** The amount that reached the settling account, in {@link NeutralDividendRow.cashCurrency}. Optional on the same rule; see {@link NeutralTradeRow.cashAmount} for when a source states it at all. */
  readonly cashAmount?: Decimal;
  /**
   * A **file-local** label this row can be referred to by, from a
   * {@link NeutralDripRow.sourceRef} in the same file (the column table's
   * `row_ref`, the two-pass DRIP resolution). Not an id, and meaningless
   * outside the one file that declared it. Optional on the same rule.
   */
  readonly rowRef?: string;
  readonly instrumentRef: NeutralInstrumentIdentity;
  readonly note: string | null;
}

/**
 * **Interest earned on cash** — its own
 * shape, never a flag on {@link NeutralCashMovementRow}: a forgotten flag
 * would silently write a DEPOSIT, the misclassification this shape exists to
 * remove, while a new shape is found by the compiler at every `never` switch.
 *
 * {@link NeutralDividendRow}'s fields minus `instrumentRef` and `rowRef`: a
 * gross, its currency, an optional withholding amount in the settling
 * account's currency, an optional cross-currency settlement. Both formats
 * produce it, so it is in {@link NeutralRow}.
 */
export interface NeutralInterestRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "INTEREST";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  /** Gross. Strictly positive (CI-L2): a 0 is refused by `plan`, with no zero-value marker skip (CI-D10). */
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  /** {@link NeutralDividendRow.withholdingAmount}'s rule: one amount in the settling account's currency. */
  readonly withholdingAmount: Decimal | null;
  /** The rate the source pinned for the interest's own leg. Optional on the same rule. */
  readonly fxRateUserInput?: Decimal;
  /** The settling account's own currency when it differs from {@link NeutralInterestRow.currency}. Optional on the same rule. */
  readonly cashCurrency?: CurrencyCode;
  /** The amount that reached the settling account, in {@link NeutralInterestRow.cashCurrency}. Optional on the same rule. */
  readonly cashAmount?: Decimal;
  readonly note: string | null;
}

/**
 * **A standalone portfolio fee** — its
 * own shape, never a flag on {@link NeutralCashMovementRow}, for
 * {@link NeutralInterestRow}'s reason (CI-D5): a forgotten flag would silently
 * write a WITHDRAWAL, the misclassification this kind removes.
 *
 * {@link NeutralCashMovementRow}'s fields minus `direction` (a fee is always
 * cash out), plus an **optional** instrument reference (PC-L14): `null` is a
 * fee on the portfolio as a whole. No withholding, no cost leg. Both formats
 * produce it, so it is in {@link NeutralRow}.
 */
export interface NeutralFeeRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "FEE";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  /** The amount debited. Strictly positive: a 0 is refused by `plan`. */
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  /** The holding the fee relates to, when the source names one — a reference only, with no position effect. */
  readonly instrumentRef: NeutralInstrumentIdentity | null;
  /** The rate the source pinned for the fee's own leg. Optional on {@link NeutralCarriedFields}' rule. */
  readonly fxRateUserInput?: Decimal;
  /** The settling account's own currency when it differs from {@link NeutralFeeRow.currency}. Optional on the same rule. */
  readonly cashCurrency?: CurrencyCode;
  /** The amount that left the settling account, in {@link NeutralFeeRow.cashCurrency}. Optional on the same rule. */
  readonly cashAmount?: Decimal;
  readonly note: string | null;
}

/**
 * **A cashless share distribution** — the shape this package
 * refused to build until the ledger could hold it.
 *
 * Shares arrive, with a market value and **no cash counterpart anywhere in the
 * source**: there is no account it settles through, no price per unit and no
 * cost leg, which is exactly why it is its own shape rather than a `TRADE`
 * with a zero price (the ledger refuses that at three CHECKs) or a `DIVIDEND`
 * with a quantity.
 */
export interface NeutralDistributionRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "DISTRIBUTION";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  /** The number of shares distributed; positive, and the whole effect of the row. */
  readonly quantity: Decimal;
  /**
   * What those shares were worth on `tradeDate`, in {@link currency}. Recorded
   * and **never capitalised**: it lands in `gross_amount`, satisfying that
   * column's `> 0` CHECK honestly, and contributes nothing to the cost basis.
   */
  readonly marketValue: Decimal;
  readonly currency: CurrencyCode;
  /** The rate the source pinned for this row (FR-56/FR-57). Optional on {@link NeutralCarriedFields}' rule. */
  readonly fxRateUserInput?: Decimal;
  readonly instrumentRef: NeutralInstrumentIdentity;
  readonly note: string | null;
}

/**
 * **A security transfer between two accounts** — units leave (`OUT`, the source leg) or arrive (`IN`, the target leg)
 * with a market value and no cash counterpart anywhere: no price per unit, no
 * cost leg, no settling account. The {@link NeutralDistributionRow} shape with
 * a direction.
 *
 * The cost that moves is **not** here: it is the source portfolio's PMP share,
 * which only the ledger's replay knows. {@link marketValue} is the flow each
 * portfolio's performance sees (L3), never a cost.
 *
 * Neither leg names the *other* account: a source file does not say where the
 * units went, which is why the destination is a decision the user answers at
 * import (FR-583) rather than a field of this row.
 */
export interface NeutralTransferRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "TRANSFER";
  readonly direction: "IN" | "OUT";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  /** The moved count; positive, and `direction` carries the sign. */
  readonly quantity: Decimal;
  /** What the moved units were worth on `tradeDate`, in {@link currency}; positive. */
  readonly marketValue: Decimal;
  readonly currency: CurrencyCode;
  /** The rate the source pinned for this row (FR-56/FR-57). Optional on {@link NeutralCarriedFields}' rule. */
  readonly fxRateUserInput?: Decimal;
  readonly instrumentRef: NeutralInstrumentIdentity;
  readonly note: string | null;
  /*
   * The three keys below are what a format that states **both** legs of a
   * transfer, each as a row of one file, carries — optional keys on {@link NeutralDividendRow.rowRef}'s own
   * precedent, so a format that states only one leg constructs neither.
   */
  /**
   * `OUT` only: the **file-local** label a target-leg row of the same file
   * names this row by — {@link NeutralDividendRow.rowRef}'s namesake, and just
   * as meaningless outside the one file that declared it.
   */
  readonly rowRef?: string;
  /**
   * `IN` only: the label of the source-leg row this row is the target of. A
   * target-leg row **without** one is a *lone* target — its source is in no
   * file, because the portfolio it left was deleted (OD-7 (c)) — and is
   * written on its own with {@link transferCost} (ND-2 (a)).
   */
  readonly sourceRef?: string;
  /**
   * `IN` only: the cost the units arrived with, as the file states it.
   * **Required** for a lone target (there is no source to re-derive it from),
   * informational beside a {@link sourceRef}: a linked target's cost is the
   * source portfolio's own replay, recomputed by the write.
   */
  readonly transferCost?: {
    readonly base: Decimal;
    readonly native: Decimal;
    readonly currency: CurrencyCode;
  };
}

export interface NeutralTradeRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "TRADE";
  readonly direction: "ACQUIRE" | "DISPOSE";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  readonly quantity: Decimal;
  /** Already direction-corrected by ID4, and guaranteed > 0 by `validate` (`AMOUNT_NOT_POSITIVE`). */
  readonly unitPrice: Decimal;
  /**
   * The trade's own currency: the source's foreign-currency triplet's
   * currency when the source populated one (a foreign-currency trade settled
   * through a different-currency cash account), otherwise the settlement
   * currency itself — today's only case before that triplet was read.
   */
  readonly currency: CurrencyCode;
  /**
   * The settling account's own currency, when it differs from {@link
   * NeutralTradeRow.currency} — `null` in the ordinary case where the trade
   * and the account are the same currency, which is when `currency` already
   * *is* the settling currency and nothing extra needs to be said.
   *
   * Carried straight through to `POST /transactions`' `cashCurrency` (FR-253),
   * which is what lets a USD trade settle out of a EUR account.
   */
  readonly cashCurrency: CurrencyCode | null;
  /**
   * The source's own `Taux de change`, pinned so `POST /transactions`' FR-56/
   * FR-57 rate precedence uses the *exact* rate the broker applied instead of
   * re-resolving a market rate for the trade date (which may not agree to the
   * last digit, and may not exist at all for a non-trading day the broker's
   * own venue still quoted). `null` iff {@link NeutralTradeRow.cashCurrency}
   * is `null` — the two are set together or not at all.
   */
  readonly fxRateUserInput: Decimal | null;
  /**
   * The single combined fee leg (OD-2(a)); `null` iff the source carried no
   * cost figure at all.
   *
   * **The fold survives here and that is deliberate** (FT-41).
   * `costs` is still the sum of the source's two cost figures — each treated as
   * zero when absent — and is still what reaches `fee_amount`, bit for bit, so
   * no historical total moves. What changes is that the two figures it was
   * folded from are now *also* carried, beside it, as
   * {@link NeutralTradeRow.brokerFee} and {@link NeutralTradeRow.tax}.
   */
  readonly costs: Decimal | null;
  /**
   * The source's broker-fee figure, unfolded out of {@link NeutralTradeRow.costs}
   * (FR-227). `null` iff the source carried no such figure — which is a
   * different statement from "it carried a zero", and FR-213's "absent, never
   * zero" needs the two distinguishable this far up.
   *
   * *Which* source column that is, is the format layer's business and is named
   * only there: this file is inside the vocabulary gate's fence.
   */
  readonly brokerFee: Decimal | null;
  /**
   * The source's trade-tax figure, unfolded on the same rule as
   * {@link NeutralTradeRow.brokerFee}. The one this cycle exists to stop
   * losing.
   */
  readonly tax: Decimal | null;
  /**
   * The FX-fee component, unfolded out of {@link NeutralTradeRow.costs} on
   * {@link NeutralTradeRow.brokerFee}'s rule. An **optional key** — the
   * Portfolio-Performance export itemises two cost figures, not four, so it
   * simply has no such column.
   */
  readonly fxFee?: Decimal;
  /** The residual cost component, on {@link NeutralTradeRow.fxFee}'s rule. */
  readonly otherCost?: Decimal;
  /**
   * The amount that actually moved through the settling account, in
   * {@link NeutralTradeRow.cashCurrency}, when the source states it rather than
   * leaving the ledger to derive it. Optional on the same rule; a source that
   * states **both** it and a rate where the ledger's own resolution table
   * derives one is refused by the ledger, so a well-formed file states it only
   * where that table calls it required.
   */
  readonly cashAmount?: Decimal;
  readonly instrumentRef: NeutralInstrumentIdentity;
  readonly note: string | null;
  /**
   * OD-1(a): true when this row is a trade appearing in a *cash-account* file,
   * i.e. the copy this cycle deliberately does not write. A boolean the neutral
   * layer understands — `plan` reads it and never learns which file, or which
   * source label, produced it.
   */
  readonly isCashSideDuplicate: boolean;
}

/**
 * A `CURRENCY_EXCHANGE` — cash out
 * of one currency and into another at a **stated** rate, with no instrument leg
 * anywhere. Its own shape rather than two cash movements: one row moves money
 * in two currencies, and a pair would lose the rate that ties them.
 */
export interface NeutralCurrencyExchangeRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "CURRENCY_EXCHANGE";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  /** The amount leaving {@link NeutralCurrencyExchangeRow.currency}. */
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  readonly targetCurrency: CurrencyCode;
  /** Units of `targetCurrency` per one unit of `currency` — **this is what the write takes**. */
  readonly exchangeRate: Decimal;
  /**
   * The target amount as the file **stated** it, when it stated one.
   *
   * **Verified, never written**: the ledger derives
   * `target_amount = amount × exchangeRate` and there is no parameter that
   * overrides it, so a stated figure can only be checked against the derived
   * one and the row refused when the two disagree. Carried so that check is
   * possible at all; `null` when the column was absent or empty.
   */
  readonly targetAmountStated: Decimal | null;
  /** The cash-account **name** the target currency arrived in; its currency must be `targetCurrency`. */
  readonly targetCashAccountName: string;
  /** Pins the *source* currency's rate to base (FR-56/FR-57). `null` when the file left `fx_rate` empty. */
  readonly fxRateUserInput: Decimal | null;
  /** The combined cost leg, on {@link NeutralTradeRow.costs}'s rule. */
  readonly costs: Decimal | null;
  readonly brokerFee: Decimal | null;
  readonly fxFee: Decimal | null;
  readonly tax: Decimal | null;
  readonly otherCost: Decimal | null;
  readonly note: string | null;
}

/**
 * FR-66/AC52's asset-settled `BUY` — "buy 2 ETH paying
 * 0.1 BTC" as **one** row. `settlementAmount` is denominated in the settlement
 * asset, not in any ISO currency, which is why this shape carries no `currency`
 * at all: the ledger's own
 * `txn_currency XOR txn_settlement_instrument_id` is the same statement.
 */
export interface NeutralSettledTradeRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "SETTLED_TRADE";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  /** The asset acquired (the ETH). */
  readonly instrumentRef: NeutralInstrumentIdentity;
  readonly quantity: Decimal;
  /** The asset paid with (the BTC). */
  readonly settlementRef: NeutralInstrumentIdentity;
  /** How much of the settlement asset moved — the row's `gross_amount`, in that asset. */
  readonly settlementAmount: Decimal;
  /** Pins the settlement asset's own rate to base (FR-56/FR-57). */
  readonly settlementFxRateUserInput: Decimal | null;
  /** The combined cost leg — the one leg of this kind that genuinely moves cash, hence the destination fields. */
  readonly costs: Decimal | null;
  readonly brokerFee: Decimal | null;
  readonly fxFee: Decimal | null;
  readonly tax: Decimal | null;
  readonly otherCost: Decimal | null;
  readonly note: string | null;
}

/**
 * A `DRIP` — structurally a buy, with
 * a **mandatory** link to the dividend it reinvests.
 *
 * {@link NeutralDripRow.sourceRef} is a **file-local** label, not an id: the
 * file cannot know the destination tenant's transaction ids, so the link is
 * resolved in two passes at plan time against the `row_ref` of
 * a `DIVIDEND` row of the same file.
 */
export interface NeutralDripRow extends NeutralDestinationFields, NeutralCarriedFields {
  readonly shape: "DRIP";
  readonly tradeDate: IsoDate;
  readonly tradeTs: Date | null;
  readonly instrumentRef: NeutralInstrumentIdentity;
  readonly quantity: Decimal;
  readonly unitPrice: Decimal;
  readonly currency: CurrencyCode;
  /** The file-local label of the `DIVIDEND` row this reinvests. */
  readonly sourceRef: string;
  /** The settling account's own currency when it differs — see {@link NeutralTradeRow.cashCurrency}. */
  readonly cashCurrency: CurrencyCode | null;
  /**
   * The amount that moved through the settling account — see
   * {@link NeutralTradeRow.cashAmount}. An **optional key**, like every other
   * field this cycle added to a neutral shape: the three Kerdial-only shapes
   * are constructed by one module today, but a hand-built literal in a test is
   * a second constructor, and making the whole addition uniform means no reader
   * has to remember which half of the vocabulary uses which convention.
   */
  readonly cashAmount?: Decimal;
  readonly fxRateUserInput: Decimal | null;
  readonly costs: Decimal | null;
  readonly brokerFee: Decimal | null;
  readonly fxFee: Decimal | null;
  readonly tax: Decimal | null;
  readonly otherCost: Decimal | null;
  readonly note: string | null;
}

export interface NeutralInstrumentIdentity {
  readonly isin: string | null;
  readonly symbol: string | null;
  readonly displayName: string | null;
  /**
   * The market identifier code the source **stated**, when it states one at all.
   *
   * An **optional key** on {@link NeutralDestinationFields}' rule: the
   * Portfolio-Performance export has no such column, and its identities are
   * resolved through `SYMBOL_SUFFIX_TO_MIC`'s suffix table instead — an
   * inference this one does not need, because here the code is a column.
   */
  readonly exchangeMic?: string;
}

/**
 * The subset of the reason-code table that `parse`/`validate` can
 * reach. The rest of the table (`INSTRUMENT_NOT_RESOLVED`,
 * `EXCHANGE_MIC_NOT_RESOLVED`, `ALREADY_IMPORTED`, `APPLY_FAILED`, …) needs a
 * database, a provider or a write, and lands with the stage that can reach it.
 *
 * Listed as a runtime array, not only as a union type: the tests assert its
 * exact membership, so a code silently added or dropped is visible as a
 * cardinality change rather than as a type that still compiles.
 */
export const PARSE_REJECT_REASONS = [
  /** Field count differs from the header's (FR-53). */
  "MALFORMED_ROW",
  /** A cell cannot be parsed under OD-10(a)'s strict rules, or carries a value this format is not known to write. */
  "MALFORMED_VALUE",
  /** A column this row's type requires is empty (IMP-4). */
  "MISSING_REQUIRED_VALUE",
  /** A row type this cycle does not model, or one that cannot occur in the declared file. */
  "UNSUPPORTED_ROW_TYPE",
  /** A cost figure on a row kind whose schema forbids that leg (M12). */
  "UNSUPPORTED_LEG",
  /** Zero or negative where `positiveDecimal` requires `> 0` (IMP-18). */
  "AMOUNT_NOT_POSITIVE",
] as const;

export type ParseRejectReason = (typeof PARSE_REJECT_REASONS)[number];

/**
 * One rejected row, with exactly one named reason. IMP-AC-13 forbids a bare
 * "invalid row", so `message` is required and every producer says which rule
 * refused the row.
 */
export interface RowProblem {
  readonly code: ParseRejectReason;
  readonly message: string;
}

/**
 * The whole-file failures. None can be attributed to a single row, so none is a
 * `RowProblem`; each is reported as the `code` of the HTTP layer's `400`
 * (`api/src/imports/imports.controller.ts` passes {@link ImportFileError.code}
 * straight into the problem document, so these strings are user-visible).
 *
 * The first two belong to the Portfolio Performance importer. The three `KERDIAL_CSV_*` ones belong to
 * the Kerdial CSV importer, and widening this union is
 * **additive**: nothing in this repository switches on it exhaustively (grep at
 * the time of writing: one `instanceof` in the controller, and the format
 * modules that throw).
 */
export type FileProblemCode =
  | "HEADER_MISMATCH"
  | "MALFORMED_FILE"
  /**
   * The file's leading version-marker comment names a format version this build
   * does not read. (The marker's own text is not written here: this file is
   * inside `import-vocabulary-gate`'s containment fence for the Kerdial literal
   * set too.)
   */
  | "KERDIAL_CSV_VERSION_UNSUPPORTED"
  /** The header names a column this format has no definition for — refused by name, never ignored. */
  | "KERDIAL_CSV_UNKNOWN_COLUMN"
  /** The header omits a column every row needs; named in the message, and discovered before any row is read. */
  | "KERDIAL_CSV_MISSING_COLUMN";

/**
 * Thrown by `parse` — and only by `parse` — when the file cannot be read as
 * rows at all. `CsvImporter.parse`'s contract is "throws only on a file-level
 * failure"; every per-row failure is a {@link RowProblem} inside the result,
 * because FR-53 requires the other rows of the same file to still be reported.
 */
export class ImportFileError extends Error {
  constructor(
    readonly code: FileProblemCode,
    message: string,
  ) {
    super(message);
    this.name = "ImportFileError";
  }
}

export interface ParseInput<TFileType extends AnyImportFileType = ImportFileType> {
  readonly bytes: Uint8Array;
  readonly fileType: TFileType;
}

export type ParsedRow<TRow extends AnyNeutralRow = NeutralRow> =
  | { readonly at: SourceRowRef; readonly ok: true; readonly row: TRow }
  | {
      readonly at: SourceRowRef;
      readonly ok: false;
      readonly problem: RowProblem;
      /**
       * The neutral row, **when one was built before the row was refused**.
       *
       * Present for a `validate` rejection: `parse` had already produced a
       * well-formed row and only the neutral-only rules refused it, so the
       * content is known and worth reporting. Absent for a `parse` rejection,
       * where failing to produce a row is precisely what happened.
       *
       * Nothing in the pipeline reads this — `plan` branches on `ok` alone. It
       * exists so the response boundary can tell the user *what the line said*,
       * which a reason code and a line number could not: on a 300-row export,
       * « ligne 95 — montant non strictement positif » does not say which
       * holding, and the rows that most need explaining are exactly the
       * `validate` rejections that used to arrive with no content at all.
       */
      readonly row?: TRow;
    };

export interface ParseResult<
  TRow extends AnyNeutralRow = NeutralRow,
  TFileType extends AnyImportFileType = ImportFileType,
> {
  readonly fileType: TFileType;
  /** Data rows only, header excluded; the exhaustiveness invariant is stated against this. */
  readonly rowCount: number;
  /** `length === rowCount`, in file order. */
  readonly rows: readonly ParsedRow<TRow>[];
}

/**
 * The contract a second format would have to satisfy (ID2, OD-6(a)). `parse`
 * and `validate` are the only stages allowed to know that any particular
 * export format exists.
 *
 * **The type parameter is what let the second format join this contract rather
 * than re-declare it**. A Kerdial
 * transactions file produces three shapes the Portfolio-Performance export has
 * no representation for at all, and its format module declared its own
 * `KerdialCsvImporter`/`KerdialParseResult` triple for exactly as long as this
 * interface was fixed to {@link NeutralRow}. Parameterising it instead — with
 * {@link NeutralRow} as the **default**, so every existing reference reads
 * unchanged and `formats/portfolio-performance/**` needs no edit (FR-551) —
 * collapses the two contracts back into one. `readonly` arrays are covariant,
 * so a `ParseResult<NeutralRow>` is still a `ParseResult<AnyNeutralRow>`,
 * which is what lets `planImport` take either.
 */
export interface CsvImporter<
  TRow extends AnyNeutralRow = NeutralRow,
  TFileType extends AnyImportFileType = ImportFileType,
> {
  readonly formatKey: string;
  readonly supportedFileTypes: readonly TFileType[];
  /** Pure, synchronous, no I/O, no clock, no randomness. Throws {@link ImportFileError} on a file-level failure only. */
  parse(input: ParseInput<TFileType>): ParseResult<TRow, TFileType>;
  /** Pure, synchronous. The per-row rules that need no database (IMP-4's per-row reporting starts here). */
  validate(parsed: ParseResult<TRow, TFileType>): ParseResult<TRow, TFileType>;
}
