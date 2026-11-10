import { z } from "zod";
import type {
  TransactionCalendar,
  TransactionCalendarBucket,
  TransactionEdit,
  TransactionReadRecord,
} from "@kerdial/ledger";
// Imported for the same declaration-emission reason `instruments.schema.ts`
// documents on its own identical import: keeps `tsc`'s `.d.ts` output for any
// exported type below that structurally contains a `Decimal` field resolved
// against `@kerdial/core-decimal` (a real `api` dependency), not a bare
// `decimal.js` specifier `dependency-cruiser`'s `no-unresolvable` rule would
// then flag.
import type { Decimal } from "@kerdial/core-decimal";
import { serializeDecimal, zDecimal } from "../common/decimal.schema.js";
import {
  TRANSACTION_KIND_VALUES,
  createTransactionBodySchema,
  currencyCodeSchema,
  isoDateSchema,
  isoInstantAsDate,
  positiveDecimal,
  transactionReferenceEditSchema,
  type CreateTransactionBody,
  type TransactionKind,
} from "@kerdial/api-contracts";

/**
 * Zod DTOs for `/transactions/*` (T-38). Request schemas validate `unknown` input (`zod-validate.ts`'s
 * `parseOrThrow`); responses are typed by plain interfaces (their Zod
 * schemas went with the OpenAPI descriptors) — the controller builds response bodies
 * directly from `ledger` records via {@link toTransactionResponse}, never by
 * running them back through a Zod `.parse()`, exactly like
 * `instruments.schema.ts`/`portfolios.schema.ts`.
 *
 * **T-44 extraction note:** `TRANSACTION_KIND_VALUES`/`TransactionKind` and
 * the entire `POST /transactions` create-request schema
 * (`createTransactionBodySchema`/`CreateTransactionBody`, plus the
 * `isoDateSchema`/`positiveDecimal` helpers this file still uses below for
 * the edit/correct/list schemas) now live in `@kerdial/api-contracts` — a
 * pure move, re-exported/re-imported here so every existing import site
 * (this file's own `editTransactionBodySchema`/`correctFxRateBodySchema`/
 * `listTransactionsQuerySchema` below, `transactions.controller.ts`,
 * `transactions.openapi.ts`) needs no change. `web`'s transaction form
 * (T-44) imports the identical `createTransactionBodySchema`
 * from that same shared package, so client and server validate the create
 * request against the exact same schema object, not a structurally-identical
 * copy.
 */
export { TRANSACTION_KIND_VALUES, createTransactionBodySchema };
export type { CreateTransactionBody, TransactionKind };

/**
 * `PATCH /transactions/:id` body — FR-13's generic in-place edit, over
 * `TransactionWriteService.editTransaction`'s `TransactionEdit` (any
 * `transaction` column except `id`/`tenant_id`/`seq`). Deliberately narrower
 * than that full column set: **no FX-leg field appears anywhere in this
 * schema** — `fxRate`, `fxRateSource`, `fxRateProviderKey`,
 * `fxRateObservedOn`, `fxRateUserInput`, and the `fee_fx_*`
 * equivalents are not fields a client can even attempt to set here (FR-57,
 * AC47). `transactions.controller.ts`'s `patch` handler additionally rejects
 * (400, not silently strips) a raw body naming any of them, so the "which"
 * `PATCH /transactions/:id/fx-rate` is the only fx_correction path AC requires
 * is answered explicitly: **rejected**, with a `problem+json` pointing at the
 * dedicated endpoint — never silently ignored, and never forwarded to
 * `editTransaction` as if the plain edit path could apply it.
 *
 * F4 (security review, T-38): for the identical reason, **no
 * currency-leg field appears here either** — `txnCurrency`, `targetCurrency`,
 * are absent (`feeCurrency` was a fourth
 * until `0049` retired the fee FX leg). `fxRate` is
 * resolved once, at write time, *for the currency
 * the row was created with*; changing only the currency string
 * while that resolved rate stays frozen leaves every base-currency figure on
 * the row wrong by whatever the two currencies' rates actually differ by (a
 * USD trade re-labelled JPY keeps its USD rate, off by roughly two orders of
 * magnitude) — with the row's `fxRateSource`/provenance still claiming to be
 * correct for a currency it no longer is. A currency mistake is a structural
 * error, not a correction any rate-preserving edit can express: it is
 * remediated by deleting the transaction and recreating it with the right
 * currency (so write-time FX resolution runs again, for real), exactly like
 * F6's `sourceDividendId` posture below.
 *
 * **`tradeDate` is editable** (transaction-edit-fields D1). It
 * was guarded here by NEW-1/NEW-2 (T-38) on the argument that a frozen FX rate
 * would be "pinned for" the old date. That risk is accepted: a date change
 * keeps the stored `fxRate`, `fxRateSource` and `fxRateObservedOn` verbatim
 * and calls no resolver, so a rate may end up observed on a day other than the
 * new `tradeDate`; the ledger still applies the five-year floor / ceiling,
 * re-checks the oversell invariant, and invalidates from min(old, new). A wrong
 * rate is corrected by `PATCH /transactions/:id/fx-rate`.
 *
 * **`txnSettlementInstrumentId` stays absent**: migration `0003`'s
 * `transaction_currency_xor_settlement_instrument` CHECK treats `txnCurrency`
 * and `txnSettlementInstrumentId` as the same XOR slot (the trade's principal
 * leg is settled in *either* a fiat currency *or* an asset, never both), so an
 * asset-settled `BUY`'s settlement asset is exactly as FX-leg-sensitive as a
 * fiat trade's currency: swapping BTC settlement for DOGE leaves the row's
 * `fxRate` (BTC's rate to base) stamped on a DOGE trade. It is guarded in
 * {@link GUARDED_FX_EDIT_FIELDS} below, with the same 400
 * `TRANSACTION_FX_EDIT_FORBIDDEN` response `transactions.controller.ts`'s
 * `patch` handler already gives the currency fields.
 */
export const editTransactionBodySchema = z.object({
  /**
   * The day the trade happened (FR-26). The ledger's `editTransaction`
   * enforces the floor/ceiling and the oversell invariant, and keeps the stored
   * FX rate untouched (D1).
   */
  tradeDate: isoDateSchema.optional(),
  /**
   * `null` clears the intraday time. `trade_ts` stays inert: replay orders by
   * `(trade_date, seq)` only. If a consumer ever derives a calendar date from
   * it, that date becomes editable independently of `tradeDate`; revisit then.
   */
  tradeTs: isoInstantAsDate.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  /**
   * The user's own reference, editable exactly as `note` is —
   * it is a label the user wrote, so correcting a mistyped broker reference
   * must not require deleting the transaction.
   *
   * `nullable()` for the reason `note` carries it: on a PATCH, absent leaves
   * the stored value alone and `null` clears it, and a user emptying the
   * field means the latter. `transactionReferenceEditSchema` maps a blank
   * string (under the database's own blank floor, not JavaScript's) to that
   * `null`, so the form need not distinguish the two.
   *
   * **Not in {@link GUARDED_FX_EDIT_FIELDS}** and not a candidate for it: the
   * field pins no rate, denominates nothing, and appears in no per-kind
   * `CHECK` — the F4/NEW-1 reasoning that guards the currency and date fields
   * has no purchase on a free-text label.
   */
  reference: transactionReferenceEditSchema.nullable().optional(),
  instrumentId: z.uuid().nullable().optional(),
  // F1 (security review, T-38): every one of these six
  // columns is documented on `platform/db/src/schema/transaction.ts` as
  // "always positive" — a bare `zDecimal` here let a negative or zero value
  // (e.g. `PATCH {"quantity":"-1000000"}`) reach `editTransaction`'s plain
  // `UPDATE` verbatim, with no sign guard anywhere in PMP replay to
  // catch it downstream. `positiveDecimal(...)`, mirroring the create DTO
  // above, is the first of this finding's three enforcement layers (see
  // `editTransaction`'s own `#assertPositiveIfPresent` calls — raising
  // `TransactionAmountNotPositiveError` since INFO-1, final narrow
  // remediation review, T-38 — and migration `0025`'s
  // `CHECK`s for the other two).
  quantity: positiveDecimal("quantity").nullable().optional(),
  unitPrice: positiveDecimal("unitPrice").nullable().optional(),
  // NEW-3 (final narrow remediation review, T-38): still
  // present here (positivity is still checked at this layer) — but
  // `editTransaction`'s own `#reconcileGrossAmount` now rejects a value
  // supplied here outright for a BUY/SELL/DRIP row (`quantity`/`unitPrice`
  // both non-NULL), recomputing it there instead whenever `quantity`/
  // `unitPrice` changes. See `TransactionGrossAmountNotEditableError`'s doc
  // comment for the full invariant this schema alone cannot express (the
  // row's `kind` is not known until it is loaded).
  grossAmount: positiveDecimal("grossAmount").optional(),
  targetAmount: positiveDecimal("targetAmount").nullable().optional(),
  feeAmount: positiveDecimal("feeAmount").nullable().optional(),
  withholdingAmount: positiveDecimal("withholdingAmount").nullable().optional(),
  // CA-11: the four per-leg
  // cash-account columns are editable — re-attributing a leg to a different
  // account **of the same currency** is exactly the correction FR-156 exists
  // to make possible ("I recorded this against the wrong account").
  //
  // **Deliberately NOT added to {@link GUARDED_FX_EDIT_FIELDS}**, and this is
  // the plausible wrong call precisely because these fields sit next to the
  // currency fields F4 guards. The FR-57/AC47 reasoning that guards
  // `txnCurrency`/`targetCurrency`/… is that a resolved `fx_rate` is
  // pinned *for that currency* and goes stale the moment the currency moves
  // under it. A cash account is not a currency: the composite FK
  // (`transaction_cash_account_fk` and its two siblings) carries the leg's own
  // currency column, so the *only* accounts this edit can reach are ones in the
  // currency the rate was already resolved for. No rate changes, no
  // `amount_base` changes — nothing the FX guard protects is even reachable.
  //
  // (this named `feeCurrency` and "three siblings". `0049`
  // retired the fee FX leg — there is no `feeCurrency` to guard and no fee cash
  // FK to be a fourth sibling. `cashCurrency` is the one currency field that is
  // deliberately *not* guarded, for the reason stated at its own declaration.)
  //
  // `nullable()` is what lets `#reconcileCashAccounts` express "this leg is
  // going away" in the same `UPDATE` that clears its amount; a `null` that
  // would leave a live leg unattributed is refused there
  // (`CashAccountRequiredError`), not silently written.
  //
  // **FD8 / FT-14: the
  // settlement pair is not guarded either, and "it sits next to the currency
  // fields" is the plausible wrong call here too.** After phase 1 the account
  // this edit re-points to may be denominated differently from the trade
  // (migrations `0045`/`0046`), so the leg's own `cash_currency` has to be
  // editable alongside it or the correction FR-156 exists for is expressible
  // only for same-currency accounts. The FR-57/AC47 reasoning that guards
  // `txnCurrency`/`targetCurrency` does
  // **not** reach it: each of those three pins a resolved rate that goes stale
  // the moment the currency moves under it, whereas the principal cash
  // posting's rate is *derived* (`amount_base / amount_native`,
  // `posting-expander.ts`) and no rate is stored for `cash_currency` at
  // all. `cashAmount` is a money figure like `grossAmount`, not a rate, and
  // `editTransaction`'s `#reconcileCashLeg` is what keeps it consistent with
  // the merged gross (FR-254/L16) — the guard list is not.
  cashAccountId: z.uuid().nullable().optional(),
  targetCashAccountId: z.uuid().nullable().optional(),
  // `feeCashAccountId` used to be here. L5 denominates a cost by
  // the settling account, so a cost leg names no account of its own to
  // re-point — and the write path stops writing the column. Legacy rows that
  // carry one keep it (migration `0049` drops the column), and the edit service's
  // own `legs` table still validates their stored pair; what is gone is the
  // ability to *set* it over the wire.
  /**
   * FT-17 (FD8): the
   * principal cash leg's own denomination and the amount that moved in it.
   * Editable **because** `cashAccountId` above is: re-pointing a leg to an
   * account denominated differently from the trade is the correction phase 1
   * exists for, and the leg's currency column is half of the composite FK
   * `0046` re-points — changing one without the other could only ever be a
   * `23503`.
   *
   * `cashAmount` is `nullable()` for the reason the four account ids are: it
   * is how `#reconcileCashLeg` can be told a figure is going away in the same
   * `UPDATE` that clears the leg. `cashCurrency` is not — a live fiat
   * principal leg always has one (`transaction_fiat_principal_has_cash_currency`),
   * and clearing it is not an edit any client can express.
   *
   * Neither joins {@link GUARDED_FX_EDIT_FIELDS} — see this schema's own FD8
   * doc-comment section above for why "it sits next to the currency fields"
   * is the plausible wrong call here.
   */
  cashCurrency: currencyCodeSchema.optional(),
  cashAmount: positiveDecimal("cashAmount").nullable().optional(),
  /**
   * FR-213/AC-248: the four cost components are editable, and `nullable()` for
   * the reason every optional money column here is — `null` clears the
   * component, which is how a user un-itemises one line of a breakdown.
   *
   * The **sum** they must keep is not enforceable field-by-field, so it is not
   * attempted here: `transaction_cost_components_sum_to_fee_amount` is the
   * backstop, and `editTransaction` reconciles the merged values before the
   * `UPDATE` so the caller gets a named error rather than a `23514`.
   */
  brokerFeeAmount: positiveDecimal("brokerFeeAmount").nullable().optional(),
  fxFeeAmount: positiveDecimal("fxFeeAmount").nullable().optional(),
  taxAmount: positiveDecimal("taxAmount").nullable().optional(),
  otherCostAmount: positiveDecimal("otherCostAmount").nullable().optional(),
  // F6 (security review, T-38): dropped from this schema
  // entirely rather than merely re-checked — a DRIP's `sourceDividendId` had
  // no tenant/shape validation on this path at all (referential-integrity
  // checks are not RLS-aware, so a cross-tenant dividend id could otherwise
  // be named), and, like F4's currency fields above, re-pointing a DRIP at a
  // different dividend after the fact is a structural change this edit
  // endpoint does not support — delete and recreate instead.
});

export type EditTransactionBody = z.infer<typeof editTransactionBodySchema>;

/**
 * The guarded FX-leg column names (camelCase, matching `TransactionEdit`'s
 * own field names) — every one of them is rejected outright by
 * `transactions.controller.ts`'s `patch` handler if present on the raw
 * request body, *before* {@link editTransactionBodySchema} even runs (so a
 * client cannot rename its way around the schema's own omission of these
 * fields either).
 *
 * F4 (security review, T-38): the currency-leg columns
 * (`txnCurrency`, `targetCurrency`) are guarded here
 * too — four until `0049` retired `feeCurrency` with the fee FX leg
 * — for the same reason and with the same rejection: see
 * {@link editTransactionBodySchema}'s own F4 doc-comment section. A currency
 * change without a matching rate re-resolution is exactly as much an
 * FX-leg change as directly setting `fxRate` would be.
 *
 * NEW-2 (final narrow remediation review, T-38):
 * `txnSettlementInstrumentId` is guarded here too, for the identical reason —
 * see {@link editTransactionBodySchema}'s doc-comment section. `tradeDate` was
 * guarded too until D1 (a date change keeps the stored rate).
 */
export const GUARDED_FX_EDIT_FIELDS = [
  "fxRate",
  "fxRateSource",
  "fxRateProviderKey",
  "fxRateObservedOn",
  "fxRateUserInput",
  "txnCurrency",
  "targetCurrency",
  "txnSettlementInstrumentId",
  /**
   * **FT-30 / F7** (fee and tax breakdown, phase 2): this list is a
   * plain string array that *mirrors* columns by value, and phase 2 drops six
   * of the columns it names. Without the clause below, that deletion compiles:
   * six entries would go on reading as if the fee FX leg were protected while
   * guarding nothing at all — the "a budget that mirrors its inputs by value
   * can pass while the thing it describes has moved" hazard this repo has
   * recorded more than once.
   *
   * `TransactionEdit` is `Partial<Omit<typeof transaction.$inferInsert, …>>`,
   * so it tracks the Drizzle table exactly. Landed **before** the drop rather
   * than after, deliberately: as a tripwire it has to be in place when the
   * columns go, or it is a check written after the thing it was meant to
   * catch.
   */
] as const satisfies readonly (keyof TransactionEdit)[];

/**
 * `PATCH /transactions/:id/fx-rate` body — FR-64's explicit correction, the
 * **only** endpoint that maps onto `TransactionWriteService.correctFxRate()`
 * ("the only fx_correction path").
 */
export const correctFxRateBodySchema = z.object({
  fxRate: positiveDecimal("fxRate"),
});

export type CorrectFxRateBody = z.infer<typeof correctFxRateBodySchema>;

/**
 * `?kind=BUY&kind=SELL` **and** `?kind=BUY,SELL`.
 *
 * Both spellings, because a query string has no single convention for a
 * repeated value and both reach this handler as something real: Fastify's
 * default parser (Node's `querystring.parse`) hands a repeated key over as an
 * array and a single one as a string, while a CSV is what a hand-written URL
 * and every `URLSearchParams`-building client produce most naturally. Accepting
 * one and silently ignoring the other is the failure mode this cycle exists to
 * remove, so the two are normalised to the same list here.
 *
 * Validated against `TRANSACTION_KIND_VALUES` — the same eight the create
 * schema writes and the enum column stores, never a copy. An unknown kind is a
 * per-field 400, not a filter that silently matches nothing; an empty `?kind=`
 * is a 400 too, since "no kinds at all" is not a request this endpoint can
 * honour and would otherwise read as "every kind".
 *
 * Duplicates collapse: `?kind=BUY,BUY` is the same query as `?kind=BUY`.
 */
const listKindFilterSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => [
    ...new Set(
      (Array.isArray(value) ? value : [value]).flatMap((entry) =>
        entry.split(",").map((kind) => kind.trim()),
      ),
    ),
  ])
  .pipe(z.array(z.enum(TRANSACTION_KIND_VALUES)).min(1));

/**
 * A bound on `gross_amount` — a plain decimal string through the repo's own
 * codec (`zDecimal`), never `parseFloat`/`Number`. The
 * value reaches Drizzle as a `Decimal` and `decimalCol`'s `toDriver` renders it
 * for the `numeric` comparison, so no float ever exists on this path.
 *
 * Non-negative rather than strictly positive: `0` is a meaningful (if
 * redundant) lower bound, whereas a negative bound could only ever describe an
 * amount the `transaction_amounts_positive` CHECK makes unstorable.
 */
const grossAmountBoundSchema = (label: string) =>
  zDecimal.refine((value) => !value.isNegative(), `${label} must not be negative`);

/**
 * `GET /transactions`'s query — **strict**.
 *
 * It used to be a plain `z.object`, so Zod stripped every unrecognised key
 * and the endpoint answered `200` with an unfiltered page that looked filtered:
 * a typo (`?kinds=BUY`), a parameter from a newer client, or a filter this
 * endpoint has never had all read as success. `z.strictObject` turns each into
 * an `unrecognized_keys` issue, which `zod-validate.ts` expands into a
 * per-field `400` naming the key — the same posture `createTransactionBodySchema`
 * and `feeBodySchema` already take for request bodies (RF8).
 */
export const listTransactionsQuerySchema = z.strictObject({
  portfolio: z.uuid().optional(),
  instrument: z.uuid().optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
  // FR-264: "desc" = newest-first. Default stays ascending —
  // the ledger screen's forward reading order, an explicit decision rather
  // than an inherited one.
  order: z.enum(["asc", "desc"]).optional(),
  // The three filters the ledger screen's own controls needed and
  // the endpoint did not have. `type` was applied client-side over one loaded
  // page until this cycle; `kind` is the server capability that retires it.
  kind: listKindFilterSchema.optional(),
  /**
   * The trade's own denomination (`transaction.txn_currency`), not the
   * settling account's and not the ledger base.
   *
   * **Asset-settled rows never match.** A BUY settled in another instrument
   * has `txn_currency IS NULL` (migration `0003`'s currency-XOR-settlement
   * CHECK), and SQL equality against NULL is never true — so *any* value of
   * this parameter excludes every asset-settled row. Stated here and in the
   * OpenAPI description because it is a silent exclusion otherwise.
   */
  currency: currencyCodeSchema.optional(),
  /**
   * Inclusive bounds on `gross_amount`, **in `currency`** — which is why
   * `transactions.controller.ts` refuses either bound without one (422
   * `TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY`). The ledger stores this
   * figure in the trade's own denomination and this endpoint does not convert,
   * so an unscoped bound would rank 1 000 JPY against 1 000 EUR.
   */
  minAmount: grossAmountBoundSchema("minAmount").optional(),
  maxAmount: grossAmountBoundSchema("maxAmount").optional(),
});

export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

/**
 * The wire shape one transaction response body takes — every decimal a JSON
 * string (AC53), `seq` (a `bigint` column) as a decimal
 * string too (`JSON.stringify` cannot serialise a raw `bigint`), and
 * `tradeTs`/`createdAt`/`updatedAt` as ISO instant strings.
 */
export interface TransactionResponse {
  readonly id: string;
  readonly portfolioId: string;
  readonly kind: string;
  readonly tradeDate: string;
  readonly tradeTs: string | null;
  readonly seq: string;
  readonly instrumentId: string | null;
  readonly quantity: string | null;
  readonly unitPrice: string | null;
  readonly grossAmount: string;
  readonly txnCurrency: string | null;
  readonly txnSettlementInstrumentId: string | null;
  readonly targetCurrency: string | null;
  readonly targetAmount: string | null;
  readonly feeAmount: string | null;
  readonly withholdingAmount: string | null;
  readonly sourceDividendId: string | null;
  /**
   * CA-21 (CD12): the four
   * per-leg cash-account columns, on the **read** side.
   *
   * CA-11 made them writable (`editTransactionBodySchema` above) but left
   * them off this response, which makes CD12's third picker behaviour —
   * *"always includes the currently-attributed account, even when
   * archived"* — unimplementable at the **edit** entry point: a form that
   * cannot read the current attribution cannot preselect it, and cannot keep
   * an archived-but-attributed account offerable. That is precisely the
   * two-entry-point defect class RC6 names. Additive, `null` for a leg the
   * row does not have, mirrored by hand in
   * `web/src/lib/api/transactions.ts`'s `TransactionResponse`.
   *
   * Deliberately **not** a nested `{id, name, currency, archived}` object:
   * the picker resolves the label from `GET /portfolios/:id/cash` (which it
   * already reads, and which is the one place an account's archived state
   * lives), so embedding a second, independently-serialised rendering of the
   * same row here would be a shape two surfaces could disagree about — the
   * same argument `CashAccountResponse`'s own doc comment makes about
   * `archived` vs. `archivedAt`.
   */
  readonly cashAccountId: string | null;
  readonly targetCashAccountId: string | null;
  /**
   * FT-17 (FR-258): the settled amount and the currency it moved in. `null`
   * for a row that moved no cash at all (an asset-settled BUY), and equal to
   * `txnCurrency`/`grossAmount` for the degenerate case — which is why
   * `TransactionDetailPanel` must compare them rather than test for
   * presence: "the field exists" is not "the settlement differs".
   *
   * Also what lets the **edit** form round-trip a cross-currency row: without
   * them it could not preselect the settled amount it is about to re-submit,
   * which is the same two-entry-point defect CA-21 records for the four
   * cash-account ids just above.
   */
  readonly cashCurrency: string | null;
  readonly cashAmount: string | null;
  /**
   * FR-208/FR-213 (`fee-tax-breakdown` phase 2): the itemisation of
   * `feeAmount`, which keeps its meaning as the **total**. All four `null` is
   * the unitemised shape — every row written before `0047`, and every row a
   * user chooses not to itemise (L8), so a client must render the total when
   * they are absent rather than treat absence as "no cost".
   */
  readonly brokerFeeAmount: string | null;
  readonly fxFeeAmount: string | null;
  readonly taxAmount: string | null;
  readonly otherCostAmount: string | null;
  readonly fxRate: string;
  readonly fxRateSource: string;
  readonly fxRateProviderKey: string | null;
  readonly fxRateObservedOn: string | null;
  readonly fxRateUserInput: string | null;
  readonly note: string | null;
  /**
   * The user's own reference. `null` for every row written
   * before migration `0057` and for every row whose author never filled the
   * field — which is why `TransactionDetailPanel` **omits** its row rather
   * than rendering an em-dash: absent is absent, not a value.
   */
  readonly reference: string | null;
  /**
   * The other leg of a security transfer —
   * on a `TRANSFER_OUT` its receiving `TRANSFER_IN`, on a `TRANSFER_IN` its
   * source. `null` for every other kind, for a transfer out of Kerdial
   * (FR-566), and for a target whose source portfolio was deleted (FR-580).
   * Flat ids, following `sourceDividendId`'s precedent; the screen resolves
   * the portfolio's name from the portfolio list it already reads.
   */
  readonly transferLinkedTransactionId: string | null;
  readonly transferLinkedPortfolioId: string | null;
  /**
   * The cost a `TRANSFER_IN` carried in from its source (FR-563): in the ledger
   * base, and in the currency the source's cost was held in. On a
   * `TRANSFER_IN` only — `null` on every other kind, a `TRANSFER_OUT`
   * included, whose removed cost is a replay figure and not a stored one.
   */
  readonly transferCostBase: string | null;
  readonly transferCostNative: string | null;
  readonly transferCostCurrency: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function decimalOrNull(value: Decimal | null): string | null {
  return value === null ? null : serializeDecimal(value);
}

/**
 * `TransactionRecord` (a `ledger` row) -> the wire shape, for every read
 * path (`POST`, `PATCH`, `PATCH .../fx-rate`, `GET /transactions`,
 * `GET /transactions/:id`) — one mapper, so no response-building code
 * duplicates NFR-12/AC53's "every decimal a string" rule.
 */
export function toTransactionResponse(row: TransactionReadRecord): TransactionResponse {
  const carriesCost = row.kind === "TRANSFER_IN";
  return {
    id: row.id,
    portfolioId: row.portfolioId,
    kind: row.kind,
    tradeDate: row.tradeDate,
    tradeTs: row.tradeTs === null ? null : row.tradeTs.toISOString(),
    seq: row.seq.toString(),
    instrumentId: row.instrumentId,
    quantity: decimalOrNull(row.quantity),
    unitPrice: decimalOrNull(row.unitPrice),
    grossAmount: serializeDecimal(row.grossAmount),
    txnCurrency: row.txnCurrency,
    txnSettlementInstrumentId: row.txnSettlementInstrumentId,
    targetCurrency: row.targetCurrency,
    targetAmount: decimalOrNull(row.targetAmount),
    feeAmount: decimalOrNull(row.feeAmount),
    withholdingAmount: decimalOrNull(row.withholdingAmount),
    sourceDividendId: row.sourceDividendId,
    cashAccountId: row.cashAccountId,
    targetCashAccountId: row.targetCashAccountId,
    cashCurrency: row.cashCurrency,
    cashAmount: decimalOrNull(row.cashAmount),
    brokerFeeAmount: decimalOrNull(row.brokerFeeAmount),
    fxFeeAmount: decimalOrNull(row.fxFeeAmount),
    taxAmount: decimalOrNull(row.taxAmount),
    otherCostAmount: decimalOrNull(row.otherCostAmount),
    fxRate: serializeDecimal(row.fxRate),
    fxRateSource: row.fxRateSource,
    fxRateProviderKey: row.fxRateProviderKey,
    fxRateObservedOn: row.fxRateObservedOn,
    fxRateUserInput: decimalOrNull(row.fxRateUserInput),
    note: row.note,
    reference: row.reference,
    transferLinkedTransactionId: row.transferLinkedTransactionId,
    transferLinkedPortfolioId: row.transferLinkedPortfolioId,
    transferCostBase: carriesCost ? decimalOrNull(row.transferCostBase) : null,
    transferCostNative: carriesCost ? decimalOrNull(row.transferCostNative) : null,
    transferCostCurrency: carriesCost ? row.transferCostCurrency : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `GET /transactions/calendar`'s query — **the list's own
 * schema minus paging and ordering**, derived rather than re-listed so a
 * filter added to `GET /transactions` reaches the calendar for free and the
 * two can never accept different filter sets. Still strict: an unrecognised
 * key is a named 400, as it is on the list.
 */
export const transactionCalendarQuerySchema = listTransactionsQuerySchema.omit({
  cursor: true,
  limit: true,
  order: true,
});

export type TransactionCalendarQuery = z.infer<typeof transactionCalendarQuerySchema>;

/** One `YYYY` or `YYYY-MM` bucket. A period with no transaction is **absent**, never a zero-valued entry. */
export interface TransactionCalendarBucketResponse {
  readonly period: string;
  readonly count: number;
  /** Σ `gross_amount × fx_rate` in the ledger base — each row's principal leg; fees and withholding excluded. */
  readonly volumeBase: string;
}

export interface TransactionCalendarTotalsResponse {
  readonly count: number;
  readonly volumeBase: string;
}

/**
 * `GET /transactions/calendar` — the Activité screen's « Calendrier » tab.
 * `total` is the exact sum of `months[]`, which is the exact sum the service
 * folded `years[]` from; nothing is re-summed here.
 */
export interface TransactionCalendarResponse {
  /** AR-5 — the tenant's ledger base, the unit of every `volumeBase`. */
  readonly baseCurrency: string;
  readonly total: TransactionCalendarTotalsResponse;
  /** `period` ascending. */
  readonly years: readonly TransactionCalendarBucketResponse[];
  readonly months: readonly TransactionCalendarBucketResponse[];
}

function toCalendarBucketResponse(
  bucket: TransactionCalendarBucket,
): TransactionCalendarBucketResponse {
  return {
    period: bucket.period,
    count: bucket.count,
    volumeBase: serializeDecimal(bucket.volumeBase),
  };
}

/** `ledger`'s `Decimal`-bearing calendar on the wire — the one place its figures become strings. */
export function toTransactionCalendarResponse(
  calendar: TransactionCalendar,
): TransactionCalendarResponse {
  return {
    baseCurrency: calendar.baseCurrency,
    total: {
      count: calendar.total.count,
      volumeBase: serializeDecimal(calendar.total.volumeBase),
    },
    years: calendar.years.map(toCalendarBucketResponse),
    months: calendar.months.map(toCalendarBucketResponse),
  };
}
