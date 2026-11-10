import { randomUUID } from "node:crypto";
import { Decimal, ROUNDING_MODE, toDecimalString } from "@kerdial/core-decimal";
import { transferCarriedCost } from "@kerdial/core-domain";
import type { CurrencyCode, IsoDate } from "@kerdial/market-ports";
import {
  cashAccount,
  currency,
  holdingState,
  instrument,
  transaction,
  transactionPosting,
  transactionRevision,
  withFxCorrection,
  withTenant,
  type Db,
  type TenantId,
  type Tx,
} from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  BACKFILLABLE_KINDS,
  BACKFILL_FLOOR_YEARS,
  ensureInstrumentBackfillRequested,
  systemClock,
  type Clock,
  type IngestionScheduler,
} from "@kerdial/market-ingestion";
import postgres from "postgres";
import type { CryptoRateResolver } from "./crypto-rate-resolver.js";
import type { FxLeg, FxRateResolver, ResolvedRate } from "./fx-rate-resolver.js";
import { InstrumentNotFoundError } from "./instrument-service.js";
import { lockPortfolioRow, lockTenantWrites } from "./portfolio-lock.js";
import { loadPositionTimeline } from "./position-replay.js";
import { expandPostings } from "./posting-expander.js";
import { recomputeWithTransferPropagation } from "./transfer-link.js";

/**
 * `TransactionWriteService` — T-19 and T-20 (component C9). The write path for every transaction `kind`
 * the system has: `BUY`, `SELL`, `DEPOSIT`, `WITHDRAWAL` (T-19), plus
 * `DIVIDEND`, `DRIP`, `CURRENCY_EXCHANGE` and asset-settled trades
 * (`txn_settlement_instrument_id`, FR-66/AC52) added by T-20, plus
 * `SHARE_DISTRIBUTION` — the cashless 8th kind (migration
 * `0056`), and the only one here that names no cash account at all.
 *
 * Edit/delete and the `correctFxRate()` correction path are T-22; see {@link
 * TransactionWriteService.editTransaction}, {@link
 * TransactionWriteService.deleteTransaction} and {@link
 * TransactionWriteService.correctFxRate}. The last is the **only** code path
 * in the entire repository that sets `app.fx_correction` — via
 * `withFxCorrection` (platform/db), never a hand-written `SET LOCAL` — so it
 * is the single sanctioned bypass of `trg_transaction_fx_immutable`
 * (FR-57/FR-64/AC47).
 *
 * ## Every write expands its postings, in the same DB transaction
 *
 * All eight kinds' write paths end by regenerating `transaction_posting` for
 * the row they just inserted, inside the same `withTenant` transaction — a
 * **write-time projection, never a cache**. It is regenerated
 * wholesale (delete + insert) rather than patched, so a re-expansion cannot
 * half-apply, and it commits or rolls back with its parent, so a transaction
 * with no postings is not a reachable state. The expansion itself is the
 * pure {@link expandPostings}; see {@link
 * TransactionWriteService.regeneratePostings} for the edit path (step 1 of
 * the invalidation chain, which T-22/T-30 complete).
 *
 * ## Every write recomputes derived state, in the same DB transaction (T-30)
 *
 * Immediately after regenerating postings (or, for a delete, immediately
 * after the row is gone), every write method calls {@link
 * TransactionWriteService.#invalidate} — steps 2-4: increment
 * `portfolio.calc_epoch`, fully recompute `holding_state`/`cash_balance`/
 * `realized_gain` for the whole portfolio
 * (`ledger/materialization.ts`'s `recomputeAndInvalidate`), and delete every
 * `portfolio_daily_valuation` row on or after the earliest affected trade
 * date. Inside the same `withTenant` transaction as the write itself, so a
 * committed write is never observed with stale derived state (AC8/AC9/AC23)
 * and a rolled-back write leaves no partial recompute behind.
 *
 * ## Every write resolves its FX legs exactly once, at write time
 *
 * Each transaction carries up to three *independent* FX legs: the
 * principal, the fee, and the dividend withholding tax. This service
 * resolves every one of them through {@link FxRateResolver} — the one
 * place in the system where a rate is decided — **once**, before
 * the row is inserted, and stores the resolved rate plus its full provenance
 * on the row. `fx_rate` is therefore never NULL and never "absent, assume 1";
 * an EUR trade under an EUR base stores the literal `1` with
 * source `IMPLIED_BASE`.
 *
 * Nothing here ever recomputes a rate at read time, and nothing here ever
 * *updates* a stored rate: the FX columns are written exactly once, by the
 * `INSERT` below. `trg_transaction_fx_immutable` (migration `0004`)
 * blocks any later mutation of them without the
 * `app.fx_correction` session flag, which only T-22's `correctFxRate()` will
 * ever set. This service contains no `UPDATE` at all, so it cannot be the
 * source of an AC47 violation.
 *
 * ## Arbitrary trade currencies (FR-55, AC44)
 *
 * A trade may be denominated in *any* ISO currency — including one that is
 * neither the tenant's base reporting currency nor the instrument's listing
 * currency (a USD-settled trade in a EUR-listed share, say). This service
 * therefore never reads `instrument.listing_currency`, never compares it with
 * `txn_currency`, and has no coercion or warning path to take: the absence of
 * that comparison *is* the implementation of AC44, which is why the
 * acceptance test asserts the row round-trips with its currency untouched.
 *
 * ## Trade-date floor (T-35 security review Finding 3 companion, T-37)
 *
 * Every `tradeDate` this service accepts (write or, for `editTransaction`, a
 * `tradeDate` change) must be no older than {@link BACKFILL_FLOOR_YEARS}
 * (`@kerdial/market-ingestion`'s own hard floor on how far back a
 * backfill can ever be requested — `backfill-window.ts`'s doc comment).
 * `market/ingestion`'s `computeBackfillRequestedFrom` already clamps its
 * *own* result to that floor, so a transaction dated earlier than it would
 * reference an instrument for which the backfill mechanism can never be
 * asked to cover that date's price/FX history — silently mispriced rather
 * than rejected, which is exactly the gap T-35's security review flagged and
 * deferred. Rejected here, at the write boundary, with
 * {@link TradeDateTooOldError} — never a validation error decades later at
 * valuation time. This is a generous, simple constant (5 years beyond
 * `BACKFILL_YEARS`'s own baseline), so an ordinary historical import is never
 * affected — only a transaction dated at or before this floor is. **This
 * floor is imported, not redeclared, so it moved with FR-23's 15 -> 25**:
 * the accepted
 * trade-date range widened by ten years as a direct consequence, which is
 * intended — a transaction this service now accepts is one the backfill
 * mechanism can now actually cover.
 *
 * ## Instrument backfill trigger (T-35's deferred half, T-37)
 *
 * `market/ingestion`'s `ensureInstrumentBackfillRequested` (T-35) implements
 * both AC11 trigger sites — "on instrument
 * creation (or first transaction referencing it)" — but T-35 itself wired
 * neither, leaving both as this idempotent/race-safe building block for a
 * later caller. T-37 wires the second one here: every write that references
 * an instrument (`recordBuy`/`recordSell`, `recordDividend`, `recordDrip`,
 * and — for *both* legs — `recordSettledBuy`) calls it once the write has
 * committed, when {@link TransactionWriteServiceDeps.instrumentBackfillScheduler}
 * was supplied. Optional, and skipped entirely when omitted (most of this
 * package's own tests have no need to also stand up `pg-boss`) — a caller
 * that never supplies it (this package's own unit/integration test suites,
 * and any composition that does not yet own an `IngestionScheduler`) simply
 * gets no automatic trigger from this service.
 *
 * `ensureInstrumentBackfillRequested` is idempotent by construction
 * (`instrument_backfill_state.instrument_id`'s own `PRIMARY KEY` plus
 * `ON CONFLICT DO NOTHING` — T-35's own doc comment), so this service calls
 * it unconditionally on every instrument-bearing write rather than trying to
 * determine "is this genuinely the first reference" for itself; the
 * underlying row-level uniqueness is what actually enforces "first", not this
 * call site. Called *after* the write's own DB transaction commits, never
 * inside it — `ensureInstrumentBackfillRequested`'s own doc comment explains
 * why it cannot be enlisted in an arbitrary caller's transaction (the
 * `pg-boss` `send()` half is a separate connection/schema entirely), so nested
 * atomicity is not available regardless of where this call happens; running it
 * after commit at least means a failure here can never roll back an otherwise
 * successful financial write. Silently skipped (not attempted, never throws)
 * for a non-backfillable `kind` (FUND/INDEX) — this service does not treat
 * that as an error, exactly as `ensureInstrumentBackfillRequested` would if
 * called for one.
 *
 * **This method's `tradeDate`-edit trigger is reachable over HTTP.**
 * F8 above wired `editTransaction`'s own trigger for a `tradeDate` change (see
 * `editTransaction`'s own F8 doc comment). NEW-1 (T-38) once guarded
 * `tradeDate` out of `PATCH /transactions/:id`; the transaction-edit-fields
 * work lifted that guard, so the HTTP route now accepts `tradeDate`
 * and this trigger fires for it. A date change keeps the stored FX rate,
 * source and observation date verbatim and calls no resolver; a wrong rate is
 * corrected through `PATCH /transactions/:id/fx-rate`.
 *
 * ## NFR-12
 *
 * Every amount, price, quantity and rate crossing this module's boundary is a
 * `Decimal`; a `number` is rejected, never coerced. `quantity` and
 * `unit_price` are `NUMERIC(38,18)` — the ≥18 dp crypto quantities need — and
 * the money columns are `NUMERIC(38,12)`; `decimalCol` (platform/db) is the
 * only thing that ever turns those into strings for the wire.
 */

/** Mirrors `transaction`'s row shape exactly — see `platform/db/src/schema/transaction.ts`. */
export type TransactionRecord = typeof transaction.$inferSelect;

/** Mirrors `transaction_posting`'s row shape exactly — see `platform/db/src/schema/transaction-posting.ts`. */
export type TransactionPostingRecord = typeof transactionPosting.$inferSelect;

const CURRENCY_SHAPE = /^[A-Z]{3}$/;
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The rule — "quantity going negative (over-sell) is
 * a hard validation error at write time, not a silent negative-position
 * state". Raised by {@link
 * TransactionWriteService.recordSell} before the row is inserted, so a
 * negative position is never representable, not merely never displayed.
 */
export class InsufficientQuantityError extends Error {
  readonly portfolioId: string;
  readonly instrumentId: string;
  readonly requestedQuantity: Decimal;
  readonly heldQuantity: Decimal;

  constructor(
    portfolioId: string,
    instrumentId: string,
    requestedQuantity: Decimal,
    heldQuantity: Decimal,
  ) {
    super(
      `Cannot sell ${requestedQuantity.toString()} units of instrument ${instrumentId} from portfolio ${portfolioId}: only ${heldQuantity.toString()} are held. ` +
        `Over-selling is rejected at write time — a position is never allowed to go negative.`,
    );
    this.name = "InsufficientQuantityError";
    this.portfolioId = portfolioId;
    this.instrumentId = instrumentId;
    this.requestedQuantity = requestedQuantity;
    this.heldQuantity = heldQuantity;
  }
}

/**
 * AC6/FR-10: a `DRIP`'s `source_dividend_id` is mandatory and must point at a
 * real `DIVIDEND` **of the same instrument**, in the same tenant. Raised
 * before the row is inserted, so a DRIP is never stored dangling, pointing at
 * a non-dividend, or reinvesting one instrument's dividend into another.
 *
 * The `reason` discriminates the three ways the reference can be wrong, so an
 * assertion on this error proves *which* rule rejected the write rather than
 * merely that something threw.
 */
export type InvalidDripSourceReason =
  | "NOT_FOUND"
  | "NOT_A_DIVIDEND"
  | "DIFFERENT_INSTRUMENT"
  /**
   * The race backstop. `#assertDripSource` read the dividend and it was
   * there; a concurrent `deleteTransaction` then committed before this row's
   * `INSERT` reached `transaction_source_dividend_id_transaction_id_fk`. The
   * pre-check cannot close this window — it holds no lock on the referenced
   * row, and `#beginTransactionCreate`'s locks are taken *after* it — so the
   * database is the only place the fact is knowable, exactly as it is for the
   * portfolio FK and the four cash-account FKs.
   *
   * Distinguished from `NOT_FOUND` on purpose: same client-visible answer,
   * different provenance. `NOT_FOUND` means the caller named a row that was
   * never there; this means the caller named a row that stopped existing
   * underneath a valid request. An assertion on the reason proves which,
   * which is what makes the race testable at all.
   */
  | "DELETED_CONCURRENTLY";

export class InvalidDripSourceError extends Error {
  readonly sourceDividendId: string;
  readonly instrumentId: string;
  readonly reason: InvalidDripSourceReason;

  constructor(
    sourceDividendId: string,
    instrumentId: string,
    reason: InvalidDripSourceReason,
    detail: string,
  ) {
    super(
      `source_dividend_id ${sourceDividendId} is not a valid originating dividend for a DRIP of instrument ${instrumentId}: ${detail}. ` +
        `A DRIP is a distinct kind linked to the dividend it reinvests (FR-10, AC6) — it is never recorded as, or coerced into, a plain BUY.`,
    );
    this.name = "InvalidDripSourceError";
    this.sourceDividendId = sourceDividendId;
    this.instrumentId = instrumentId;
    this.reason = reason;
  }
}

/**
 * FR-66/AC52: the asset a trade is settled in (the BTC of "buy 2 ETH paying
 * 0.1 BTC") must exist in the instrument catalogue and must be usable as the
 * source of its own rate-to-base leg.
 *
 * **Routing on `instrument.kind`.** A
 * `CRYPTO`-kind settlement asset's leg is resolved through
 * {@link CryptoRateResolver} (a market quote, keyed by the provider's own
 * symbol via `instrument_provider_map` — never a three-letter code), so
 * `UNUSABLE_SYMBOL` **cannot fire for it**: this is exactly the fix for the
 * T-20 blocker (USDT/DOGE/AVAX/SHIB/MATIC were previously rejected outright
 * by a three-letter-symbol check that had no economically meaningful
 * connection to whether the asset could be priced). `UNUSABLE_SYMBOL`
 * survives only on the defensive non-crypto fall-through: an instrument that
 * is neither `CRYPTO`-kind nor carries a usable ISO-4217 `symbol` for
 * {@link FxRateResolver} is not a supported settlement asset in
 * phase 1 (FR-66's XOR constraint) and stays fail-closed.
 */
export class InvalidSettlementAssetError extends Error {
  readonly settlementInstrumentId: string;
  readonly reason: "NOT_FOUND" | "UNUSABLE_SYMBOL";

  constructor(
    settlementInstrumentId: string,
    reason: "NOT_FOUND" | "UNUSABLE_SYMBOL",
    detail: string,
  ) {
    super(
      `Instrument ${settlementInstrumentId} cannot settle a trade: ${detail}. ` +
        `A CRYPTO-kind settlement asset's rate to base is resolved through CryptoRateResolver (a market quote); any other kind falls through to FxRateResolver, which needs a three-letter symbol.`,
    );
    this.name = "InvalidSettlementAssetError";
    this.settlementInstrumentId = settlementInstrumentId;
    this.reason = reason;
  }
}

/**
 * T-35 security review Finding 3 companion (T-37, see this
 * class's own "Trade-date floor" doc-comment section): a `tradeDate` at or
 * before `now - BACKFILL_FLOOR_YEARS` years is rejected at the write
 * boundary rather than silently accepted and left un-backfillable.
 */
export class TradeDateTooOldError extends Error {
  readonly tradeDate: IsoDate;
  readonly floor: IsoDate;

  constructor(tradeDate: IsoDate, floor: IsoDate) {
    super(
      `tradeDate ${tradeDate} is older than the ${BACKFILL_FLOOR_YEARS}-year backfill floor (${floor}): ` +
        `market/ingestion's backfill-window computation can never request price/FX ` +
        `history before that date, so a transaction dated earlier than it would be silently mispriced rather ` +
        `than backed by a completed backfill.`,
    );
    this.name = "TradeDateTooOldError";
    this.tradeDate = tradeDate;
    this.floor = floor;
  }
}

/**
 * F9 (security review, T-37): `#assertTradeDate` had a floor
 * (above) but no ceiling — a future-dated `tradeDate` was accepted without
 * limit, which is nonsensical for a trade that (by definition) already
 * happened, and would corrupt every downstream figure that assumes trade
 * dates are in the past (PMP replay order, TWR sub-periods, XIRR). Rejected
 * at the same write boundary as the floor, with a small grace window for
 * timezone edges (a client in a timezone ahead of the server's UTC clock
 * legitimately sees "today" as one calendar day later).
 */
export class TradeDateInFutureError extends Error {
  readonly tradeDate: IsoDate;
  readonly ceiling: IsoDate;

  constructor(tradeDate: IsoDate, ceiling: IsoDate) {
    super(
      `tradeDate ${tradeDate} is after the allowed ceiling (${ceiling}, today + ${TRADE_DATE_CEILING_GRACE_DAYS} day(s) grace for timezone edges): a transaction cannot be dated in the future.`,
    );
    this.name = "TradeDateInFutureError";
    this.tradeDate = tradeDate;
    this.ceiling = ceiling;
  }
}

/**
 * Raised by {@link TransactionWriteService.regeneratePostings} when the
 * transaction it is asked to re-expand is not visible to this tenant — it
 * does not exist, or it belongs to someone else and RLS hides it. Regenerating
 * postings for a transaction that is not there would otherwise be a silent
 * no-op that leaves stale postings behind.
 */
export class TransactionNotFoundError extends Error {
  readonly transactionId: string;

  constructor(transactionId: string) {
    super(
      `Transaction ${transactionId} is not visible to this tenant, so its postings cannot be regenerated.`,
    );
    this.name = "TransactionNotFoundError";
    this.transactionId = transactionId;
  }
}

/**
 * portfolio-crud-ui D5: `portfolio-service.ts`'s `deletePortfolio` can
 * now make a portfolio disappear mid-race with any write here that
 * references it — `TransactionsController.create`'s own `getPortfolio`
 * pre-check (`transactions.controller.ts`) runs *outside* this service's
 * write transaction, so a delete that commits in the gap between that check
 * and this service's own `INSERT` would otherwise surface as a raw,
 * unmapped `23503` on `transaction_portfolio_id_portfolio_id_fk` — a 500 this
 * feature would introduce into an existing endpoint. Every `record*` method
 * below translates that one FK violation into this domain error instead
 * (same shape as {@link isUniqueViolation}'s translation); the controller
 * maps it to the **existing** 404 `PORTFOLIO_NOT_FOUND` — the identical
 * status/code its own pre-check already returns, so no new client-visible
 * contract appears (D5).
 */
export class TransactionPortfolioNotFoundError extends Error {
  readonly portfolioId: string;

  constructor(portfolioId: string) {
    super(
      `Portfolio ${portfolioId} does not exist for this tenant — it may have just been deleted.`,
    );
    this.name = "TransactionPortfolioNotFoundError";
    this.portfolioId = portfolioId;
  }
}

/**
 * A rejected **argument** at this service's own boundary — a value the DTO
 * layer would have refused, reaching a `record*`/`edit*` method directly.
 *
 * Every one of this module's freestanding assertions used to throw a bare
 * `TypeError`, from nine sites. That had two costs, and neither was about the
 * assertion being wrong:
 *
 *  1. **A 500 for a bad argument.** `mapTransactionWriteError` has no branch
 *     for `TypeError` and cannot get one, so a direct caller handing this
 *     service a malformed value got "internal server error" for a rejection
 *     the service had diagnosed precisely.
 *  2. **A suppressed message in the importer.** An earlier change replaced the importer's
 *     `rows[].message` echo with an `instanceof` allowlist, and `TypeError`
 *     is **deliberately** absent from it — it is not a class this codebase
 *     owns (V8 throws it for a property read on `undefined`, a dependency
 *     throws it for its own checks), so allow-listing it would allow-list any
 *     message from anyone under a specific-looking name. That decision stands.
 *     What was missing was a class this codebase *does* own for these nine
 *     rejections, which the allowlist can then name safely.
 *
 * So: one named class the importer and the mapper can both recognise, with
 * {@link TransactionAmountNotPositiveError} as its one specialisation (kept
 * distinct because it carries a `field` and its own problem `code`, both
 * already relied on). Messages are unchanged from the `TypeError` era — they
 * were written by this codebase, name a field and a value, and carry no SQL
 * and no bound parameters.
 *
 * **Not for programming mistakes.** A genuine `TypeError` from a property read
 * on `undefined` is still a `TypeError` and still a 500; this class is only
 * ever raised by an explicit assertion about a caller-supplied value.
 */
export class TransactionArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionArgumentError";
  }
}

/**
 * INFO-1 (final narrow remediation review, T-38):
 * `editTransaction`'s own layer of F1's three-layer positivity check (see
 * {@link TransactionWriteService.#assertPositiveIfPresent}) used to fall
 * through to the freestanding `assertPositiveDecimal`'s bare `TypeError` for a
 * non-positive amount reaching this service directly — unreachable via HTTP
 * today (`editTransactionBodySchema`'s own `positiveDecimal(...)` rejects
 * first, F1's first enforcement layer), but a latent, unmapped 500 for any
 * future internal caller that skips the DTO and calls `editTransaction`
 * itself with a bad value. A named, machine-readable domain error, mapped to
 * 400 by `transactions.controller.ts`'s `#mapWriteError` like every other
 * write-path rejection this class throws — never a raw `TypeError` a caller
 * has no stable way to distinguish from a programming mistake.
 */
export class TransactionAmountNotPositiveError extends TransactionArgumentError {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`${field} must be a positive, finite amount, got: ${detail}`);
    this.name = "TransactionAmountNotPositiveError";
    this.field = field;
  }
}

/**
 * NEW-3 (final narrow remediation review, T-38): a `BUY`/
 * `SELL`/`DRIP` row's `gross_amount` is never an independently client-settable
 * figure — every *creation* path derives it as `quantity × unit_price` (or,
 * for an asset-settled `BUY`, the settlement leg's own amount, from which
 * `unit_price` is in turn derived — see `recordSettledBuy`), and the create
 * DTO forbids a caller from supplying it directly for exactly these three
 * kinds (`createTransactionBodySchema`'s own `forbid(data.amount, ...)`). The
 * generic edit path issued a plain column-by-column `UPDATE` with no such
 * coupling: `PATCH {"grossAmount": ...}` alone (or alongside a `quantity`/
 * `unitPrice` change to a *different* figure) left the cash leg
 * (`posting-expander.ts` reads `gross_amount` verbatim) diverge from the
 * `quantity`/`unit_price` `computePmp` replays cost basis from: a `BUY`
 * 10 @ 50 (gross 500) `PATCH`ed to
 * `grossAmount: "0.000000000001"` moved the cash leg to that figure while
 * cost basis stayed 500.
 *
 * Thrown by {@link TransactionWriteService.editTransaction} when a
 * caller-supplied `grossAmount` reaches a row whose current-or-edited
 * `quantity`/`unit_price` are both non-`NULL` (exactly the `BUY`/`SELL`/
 * `DRIP` shape, migration `0003`'s per-kind `CHECK`s) — `grossAmount` is
 * recomputed there instead, server-side, as `quantity × unit_price` whenever
 * either changes, exactly as `#recordTrade`/`recordDrip`/`recordSettledBuy`
 * compute it at creation. Every other kind (`DEPOSIT`/`WITHDRAWAL`/
 * `DIVIDEND`/`CURRENCY_EXCHANGE`, none of which carry both a `quantity` and a
 * `unit_price`) never reaches this error: `grossAmount` is that row's *only*
 * representation of the amount moved there, exactly like `feeAmount`/
 * `withholdingAmount`/`targetAmount`, and stays a plain, independently
 * editable column.
 *
 * **A (final narrow fix round, feature/api-transactions): this error is
 * never thrown for a settlement-priced `BUY`** (`txn_settlement_instrument_id`
 * non-`NULL`, FR-66/AC52) — that row shape inverts which of
 * `grossAmount`/`unitPrice` is authoritative (see {@link
 * TransactionUnitPriceNotEditableError}'s doc comment for the full
 * invariant), so `grossAmount` stays editable there and `unitPrice` is the
 * one this error's mirror-image rejects instead.
 */
export class TransactionGrossAmountNotEditableError extends Error {
  readonly transactionId: string;

  constructor(transactionId: string) {
    super(
      `Transaction ${transactionId} is a quantity-priced trade (BUY/SELL/DRIP): grossAmount is derived ` +
        `from quantity x unitPrice and cannot be set directly via PATCH /transactions/:id — edit ` +
        `quantity/unitPrice instead (grossAmount is recomputed automatically), or delete and recreate ` +
        `the transaction if the trade itself was recorded wrong.`,
    );
    this.name = "TransactionGrossAmountNotEditableError";
    this.transactionId = transactionId;
  }
}

/**
 * A (a regression introduced by the T-38 remediation round): a
 * settlement-priced `BUY` row (`txn_settlement_instrument_id` non-`NULL`,
 * FR-66/AC52 — "buy 2 ETH paying 0.1 BTC") stores `gross_amount` as the
 * **authoritative** settlement-asset amount actually disposed (the 0.1 BTC —
 * `posting-expander.ts` emits it verbatim as the disposal leg's
 * `quantity_delta`, and PMP replay reads it the same way) and
 * `unit_price` as the **derived** figure (`amount / quantity`,
 * `recordSettledBuy`'s own doc comment) — the exact opposite of a
 * fiat-priced `BUY`/`SELL`/`DRIP` row, where `unit_price` is authoritative
 * and `grossAmount` is derived (see {@link
 * TransactionGrossAmountNotEditableError} for that row shape).
 *
 * `#reconcileGrossAmount` previously applied the fiat rule unconditionally to
 * every row with non-`NULL` `quantity`/`unit_price` — including a
 * settlement-priced `BUY` (which also carries both) — so a bare `quantity`
 * edit silently rewrote `gross_amount` to `quantity x unit_price` (a `BUY` 2
 * ETH paying 0.1 BTC, `PATCH`ed to `quantity: "2.5"`, moved `gross_amount` to
 * `0.125` — 25% more BTC disposed than actually happened), and the
 * legitimate correction, `PATCH {"grossAmount": ...}`, was rejected outright
 * with {@link TransactionGrossAmountNotEditableError}.
 *
 * Thrown instead, by the same method, when a caller supplies `unitPrice` for
 * a settlement-priced row: `unitPrice` is derived there (`grossAmount /
 * quantity`, recomputed whenever either changes — mirroring
 * `recordSettledBuy`'s own derivation exactly), so a client-supplied value
 * for it is exactly as meaningless as a client-supplied `grossAmount` is for
 * a fiat-priced row.
 */
export class TransactionUnitPriceNotEditableError extends Error {
  readonly transactionId: string;

  constructor(transactionId: string) {
    super(
      `Transaction ${transactionId} is a settlement-priced BUY (FR-66/AC52): unitPrice is derived from ` +
        `grossAmount / quantity (grossAmount is the authoritative settlement-asset amount actually ` +
        `disposed) and cannot be set directly via PATCH /transactions/:id — edit grossAmount/quantity ` +
        `instead (unitPrice is recomputed automatically), or delete and recreate the transaction if the ` +
        `trade itself was recorded wrong.`,
    );
    this.name = "TransactionUnitPriceNotEditableError";
    this.transactionId = transactionId;
  }
}

/**
 * C (final narrow fix round, feature/api-transactions): `recordSettledBuy`
 * rejects a settlement asset that equals the acquired instrument (a trade
 * cannot pay for itself with itself — see its own `settlement.instrumentId
 * must differ from instrumentId` `TypeError`), but `editTransaction`'s
 * generic `UPDATE` had no equivalent check, and no `CHECK` constraint backs
 * it either: `PATCH {"instrumentId": <the row's own settlement instrument
 * id>}` reached the database unrejected, leaving `instrument_id ===
 * txn_settlement_instrument_id` — a row representing net free units acquired
 * at zero cost basis (the acquisition and its own disposal cancel out in
 * quantity for that one instrument, while `unit_price`/`gross_amount` still
 * claim a real cost). Thrown by {@link TransactionWriteService.editTransaction}
 * before the `UPDATE` runs, mirroring `recordSettledBuy`'s own check against
 * the row's *merged* (current-or-edited) `instrumentId`/
 * `txnSettlementInstrumentId` pair — `txnSettlementInstrumentId` itself is
 * not reachable over HTTP (`GUARDED_FX_EDIT_FIELDS`), but a caller
 * constructing a `TransactionEdit` directly could still change it, so both
 * sides of the pair are considered, not only `instrumentId`.
 */
export class TransactionSelfSettledError extends Error {
  readonly transactionId: string;
  readonly instrumentId: string;

  constructor(transactionId: string, instrumentId: string) {
    super(
      `Transaction ${transactionId} cannot be edited to settle in the instrument it acquires ` +
        `(instrumentId and txnSettlementInstrumentId would both be ${instrumentId}): recordSettledBuy ` +
        `already rejects this exact shape at creation (a trade cannot pay for itself), and an edit that ` +
        `reaches it is rejected for the same reason — otherwise the row would represent net free units ` +
        `acquired at zero cost basis.`,
    );
    this.name = "TransactionSelfSettledError";
    this.transactionId = transactionId;
    this.instrumentId = instrumentId;
  }
}

/**
 * CA-9: a cash-emitting leg
 * named a `cash_account` that is not usable for it — it does not exist, it is
 * not visible to this tenant, or it belongs to another portfolio. RLS and the
 * composite FK make those three indistinguishable on purpose (AC33's recorded
 * class: a cross-tenant probe must not be able to tell "not yours" from "not
 * there"), so they are one error with one 404 mapping.
 *
 * Raised by {@link TransactionWriteService.#assertCashAccountsUsable} on the
 * primary path, and by the widened {@link
 * TransactionWriteService.#guardPortfolioFk} as the backstop when the row is
 * deleted between that pre-check and the `INSERT`/`UPDATE` —
 * exactly the division of labour {@link TransactionPortfolioNotFoundError}
 * already has for the portfolio FK.
 */
export class CashAccountNotFoundError extends Error {
  readonly cashAccountId: string;
  readonly field: string;

  constructor(cashAccountId: string, field: string) {
    super(
      `Cash account ${cashAccountId} (named by ${field}) is not usable for this transaction: it does not exist, ` +
        `it is not visible to this tenant, or it belongs to a different portfolio (FR-155). ` +
        `The composite FK on (tenant_id, portfolio_id, cash_account_id, <leg currency>) refuses all three at the database.`,
    );
    this.name = "CashAccountNotFoundError";
    this.cashAccountId = cashAccountId;
    this.field = field;
  }
}

/**
 * CA-9: the named account's currency is not the currency of the leg it was
 * named for. A `cash_account` holds exactly one currency (OD-2), and the
 * composite FK carries the leg's own currency column, so this is a database
 * fact — raised here first only so the caller gets a named 400 rather than a
 * raw `23503`.
 */
export class CashAccountCurrencyMismatchError extends Error {
  readonly cashAccountId: string;
  readonly field: string;
  readonly legCurrency: string;
  readonly accountCurrency: string;

  constructor(cashAccountId: string, field: string, legCurrency: string, accountCurrency: string) {
    super(
      `Cash account ${cashAccountId} is denominated in ${accountCurrency}, but ${field} attributes a ${legCurrency} leg to it. ` +
        `A cash account holds exactly one currency (OD-2) — name an account in ${legCurrency} instead.`,
    );
    this.name = "CashAccountCurrencyMismatchError";
    this.cashAccountId = cashAccountId;
    this.field = field;
    this.legCurrency = legCurrency;
    this.accountCurrency = accountCurrency;
  }
}

/**
 * CA-9/CA-10: a **newly named** archived account. Re-submitting the account a
 * row already carries is deliberately *not* this error — see {@link
 * TransactionWriteService.#reconcileCashAccounts}, which merges then compares:
 * otherwise a user who archived an old account could never again edit the note
 * on a transaction attributed to it (the "Not archived" row).
 */
export class CashAccountArchivedError extends Error {
  readonly cashAccountId: string;
  readonly field: string;

  constructor(cashAccountId: string, field: string) {
    super(
      `Cash account ${cashAccountId} (named by ${field}) is archived and cannot be newly attributed to a transaction. ` +
        `Un-archive it, or name a different account. (An edit that re-submits the account the row already carries is a no-op success, not this error.)`,
    );
    this.name = "CashAccountArchivedError";
    this.cashAccountId = cashAccountId;
    this.field = field;
  }
}

/**
 * CA-9: a leg that moves cash named no account. FR-158/AC-178's totality is a
 * database CHECK (`transaction_fiat_principal_has_cash_account` and its three
 * siblings, migration `0039`); this error exists so the rejection is a named
 * 400 raised **before** the round trip rather than a bare `23514` the
 * controller can only describe as "invalid shape".
 */
export class CashAccountRequiredError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(
      `${field} is required: ${detail}. Every leg that moves cash names the account it moved it in ` +
        `(FR-158/AC-178) — migration \`0039\`'s totality CHECKs make that total at the database.`,
    );
    this.name = "CashAccountRequiredError";
    this.field = field;
  }
}

/**
 * CA-9/CA-10: an account was named for a leg that moves no cash at all.
 *
 * - `ASSET_SETTLED_PRINCIPAL` is FR-157/AC-177: a BUY paid for in BTC has no
 *   fiat principal leg, so its principal names no account —
 *   `transaction_settled_principal_has_no_cash_account` (migration `0038`) is
 *   the database backstop, and `recordSettledBuy` has no parameter for one.
 * - `LEG_ABSENT` is the edit path's equivalent: naming, say, a
 *   `feeCashAccountId` on a row that carries no fee leg would violate
 *   `transaction_fee_cash_account_pairing`.
 */
export class CashAccountNotAllowedError extends Error {
  readonly field: string;
  readonly reason: "ASSET_SETTLED_PRINCIPAL" | "LEG_ABSENT";

  constructor(field: string, reason: "ASSET_SETTLED_PRINCIPAL" | "LEG_ABSENT", detail: string) {
    super(`${field} is not allowed here: ${detail}`);
    this.name = "CashAccountNotAllowedError";
    this.field = field;
    this.reason = reason;
  }
}

/**
 * Why {@link CashAmountNotAcceptedError} was raised — the same
 * reason-code idiom {@link CashAccountNotAllowedError} already uses, so a
 * client can tell the five refusals apart without parsing prose.
 *
 *   - `DERIVED_IN_BASE_CURRENCY` is **D4**, the case L11 exists for:
 *     when the settling
 *     account is denominated in this tenant's **base** currency the settled
 *     amount *is* `gross_amount x fx_rate`, and the row already carries both
 *     factors — a second, independently supplied figure could only contradict
 *     them. L11 derives rather than storing-and-checking because the check
 *     could not be a `CHECK`: `tenant.base_currency` lives on another table
 *     (P22), and a Postgres CHECK is single-row, single-table.
 *   - `DEGENERATE_EQUALS_GROSS` is the same sentence for D1/D2:
 *     `transaction_cash_degenerate_equals_gross` (`0045`) already pins
 *     `cash_amount = gross_amount` whenever the two currencies agree, so a
 *     contradicting figure is refused here **by name** instead of reaching the
 *     database as a bare `23514` the controller can only call "invalid shape".
 *   - `UNPAIRED_WITHOUT_CURRENCY` mirrors
 *     `transaction_cash_amount_currency_pairing`: the two settlement columns
 *     are supplied together or not at all.
 *   - `CURRENCY_EXCHANGE_PINNED` (FR-235) and `ASSET_SETTLED_PRINCIPAL`
 *     (FR-236) are the two write paths that accept **neither** field.
 *     {@link RecordCurrencyExchangeParams} and {@link RecordSettledBuyParams}
 *     declare neither, and a caller reaching past the types (a JSON payload,
 *     an internal call site) is rejected here — before the DB round trip —
 *     exactly as `recordCurrencyExchange` already rejects a stray
 *     `instrumentId`. `transaction_currency_exchange_cash_leg_pinned` and
 *     `transaction_settled_principal_has_no_cash_leg` are the backstop, not
 *     the primary.
 */
export type CashAmountNotAcceptedReason =
  | "DERIVED_IN_BASE_CURRENCY"
  | "DEGENERATE_EQUALS_GROSS"
  | "UNPAIRED_WITHOUT_CURRENCY"
  | "CURRENCY_EXCHANGE_PINNED"
  | "ASSET_SETTLED_PRINCIPAL";

/**
 * FT-12 (L11): a
 * settlement figure was supplied where this write path does not take one. See
 * {@link CashAmountNotAcceptedReason} for the five cases.
 *
 * Deliberately **not** the same error as {@link CashAmountRequiredError} (the
 * opposite complaint) or {@link CashAmountStaleError} (the edit path's): all
 * three are "your input is fine but this endpoint derives that figure", which
 * is a different sentence from "the information you entered is inconsistent",
 * and mapping them onto one code would put the user back in the position an earlier finding
 * records for `TransactionCashLegNotAddableError`.
 */
export class CashAmountNotAcceptedError extends Error {
  readonly field: string;
  readonly reason: CashAmountNotAcceptedReason;

  constructor(field: string, reason: CashAmountNotAcceptedReason, detail: string) {
    super(`${field} is not accepted here (${reason}): ${detail}`);
    this.name = "CashAmountNotAcceptedError";
    this.field = field;
    this.reason = reason;
  }
}

/**
 * FT-12, the D3/D5 row of the resolution table: the caller named a
 * settlement currency that is neither the transaction's own nor this tenant's
 * base, so **nothing on the row can derive the settled amount** — the trade's
 * rate converts `txn_currency` to base, and the account's currency is a third
 * one. The broker's figure is an independent fact and must be supplied.
 *
 * Raised before any DB round trip, so the caller gets a named 400 rather than
 * `transaction_cash_amount_currency_pairing`'s bare `23514`.
 */
export class CashAmountRequiredError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(
      `${field} is required: ${detail}. When the settling account is denominated in neither the ` +
        `transaction's currency nor the base currency, how much actually moved is a fact only the ` +
        `contract note carries (cases D3/D5) — it cannot be derived from the row.`,
    );
    this.name = "CashAmountRequiredError";
    this.field = field;
  }
}

/**
 * FT-13 / **L16** (locked 2026-08-27): an edit moved `gross_amount` on a
 * D3/D5 row — one whose settled amount is an independent broker figure — and
 * did not carry the new settled amount in the same request.
 *
 * `editTransaction` recomputes `gross_amount` from the merged quantity and
 * unit price (P19), so editing a *quantity alone* moves it silently. Left
 * alone, the row would claim a cash movement computed against a superseded
 * gross, in a currency no constraint can tie back to it — FR-254's "wrong cash
 * balance with no failing constraint", exactly. D1/D2 are pinned by
 * `transaction_cash_degenerate_equals_gross` and D4 is derived, so this error
 * is reachable only for D3/D5.
 *
 * L16 rejects the *incomplete* edit, not the edit: the same request carrying
 * the new `cashAmount` succeeds. Rejecting the correction outright (OD-D2(b))
 * was weighed and refused — it forbids a legitimate change the user can make
 * correctly.
 */
export class CashAmountStaleError extends Error {
  readonly transactionId: string;
  readonly field: string;
  /**
   * **Which of FR-254's triggers fired**.
   *
   * `GROSS_MOVED` was the only one implemented: the merged-shape
   * table keyed both its D3 and D5 rows on `gross_amount` alone, and so dropped
   * the `cash_account_id` trigger FR-254 states. `SETTLEMENT_CURRENCY_CHANGED`
   * is that missing one — and it is the worse of the two, because a gross that
   * moved leaves an amount that is merely out of date, while a settlement
   * currency that moved leaves the *same digits* silently reinterpreted in
   * another currency.
   *
   * Carried as a field rather than baked into the message so the API boundary
   * can title the two cases differently without parsing prose.
   */
  readonly reason: "GROSS_MOVED" | "SETTLEMENT_CURRENCY_CHANGED";

  constructor(
    transactionId: string,
    field: string,
    cashCurrency: string,
    reason: "GROSS_MOVED" | "SETTLEMENT_CURRENCY_CHANGED",
    detail: string,
  ) {
    super(
      `Transaction ${transactionId} is settled in ${cashCurrency}, which is neither its own currency nor ` +
        `the base currency, so its settled amount is an independent figure this edit cannot recompute: ` +
        `${detail}. Supply ${field} in the same request (L16).`,
    );
    this.name = "CashAmountStaleError";
    this.transactionId = transactionId;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * FR-213/FR-214 (`fee-tax-breakdown` phase 2): a cost itemisation that does not
 * add up, or that names a component on a kind that takes none.
 *
 * Raised **before** the `INSERT`, so the caller gets a named 400 rather than
 * `transaction_cost_components_sum_to_fee_amount`'s bare `23514` — the same
 * discipline the four settlement errors already follow, and the reason FT-36
 * states it as an acceptance criterion rather than leaving the constraint to
 * report it.
 */
export class CostComponentsInvalidError extends Error {
  readonly field: string;
  readonly reason: "SUM_MISMATCH" | "NO_SETTLING_ACCOUNT";

  constructor(field: string, reason: "SUM_MISMATCH" | "NO_SETTLING_ACCOUNT", detail: string) {
    super(`${field} is invalid (${reason}): ${detail}`);
    this.name = "CostComponentsInvalidError";
    this.field = field;
    this.reason = reason;
  }
}

/**
 * Resolves a cost leg's stored shape: the total, and the four component
 * columns.
 *
 * Three rules, in the order a caller trips them:
 *
 *  1. **Components alone imply the total.** The caller need not do arithmetic
 *     the database is about to check, and cannot get it wrong by doing it.
 *  2. **Both supplied must agree exactly** — no tolerance, at `numeric(38,12)`,
 *     mirroring `transaction_cost_components_sum_to_fee_amount`.
 *
 * **FR-212's per-kind restriction is not enforced here, and deliberately.**
 * `RecordDividendParams` carries no `fee` at all, so a DIVIDEND cannot reach
 * this function with components — the type is the enforcement, exactly as it
 * already is for that kind's `fee_amount`. On the wire it is the schema's
 * `forbid(...)` calls, where `fee_amount`'s own restriction lives; adding a
 * CHECK for components while `fee_amount` has none would be an asymmetry no
 * requirement asks for.
 *
 * **An asset-settled BUY is refused, and that is a gap that was not
 * anticipated**. FT-36 names five `record*` paths, but an
 * asset-settled BUY's principal leg moves no cash (FR-236) and so names no
 * account — and after L5 a cost is denominated *by the settling account*.
 * There is therefore no currency for its components to be in, which
 * `expandPostings` also refuses (it would emit a posting with no currency).
 * Refused here by name, before the `INSERT`, rather than as a
 * `PostingExpansionError` three layers down.
 */
function resolveCostLeg(
  kind: string,
  fee: FeeInput | undefined,
  settlingAccountCurrency: string | null,
): {
  feeAmount: Decimal | null;
  brokerFeeAmount: Decimal | null;
  fxFeeAmount: Decimal | null;
  taxAmount: Decimal | null;
  otherCostAmount: Decimal | null;
} {
  const empty = {
    feeAmount: fee?.amount ?? null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
  };
  const components = fee?.components;
  const present =
    components === undefined
      ? []
      : COST_COMPONENT_KEYS.filter((key) => components[key] !== undefined);

  // **A cost of any shape needs a settling account to be denominated by**, and
  // A later change made that bite for the unitemised total too.
  //
  // Until this release a cost carried its own `fee_currency`, so an
  // asset-settled row's total had a denomination even though the row moved no
  // cash. That column is no longer written. `expandPostings` then reaches its
  // L5 branch, needs `cash_currency`, and there is none — so the row is
  // *storable and unexpandable*, which is the worst of the three outcomes: a
  // `PostingExpansionError` on every subsequent write to that portfolio.
  //
  // Refused here instead, by name, before the `INSERT`. **This removes a
  // capability** — an asset-settled BUY can no longer carry a cost — and that
  // was an open product question, answered by force rather than by
  // preference: there is no currency such a cost could be in. A cost paid in
  // cash alongside an asset-settled trade is a cash transaction of its own:
  // the `FEE` kind (`portfolio-cash`).
  if ((fee?.amount !== undefined || present.length > 0) && settlingAccountCurrency === null) {
    throw new CostComponentsInvalidError(
      present.length > 0 ? "fee.components" : "fee.amount",
      "NO_SETTLING_ACCOUNT",
      `this ${kind} settles in an asset, not cash (FR-236), so it names no cash account — and after L5 a cost is denominated in the settling account's currency. There is no currency for this cost to be in`,
    );
  }
  if (components === undefined || present.length === 0) return empty;
  for (const key of present) {
    assertPositiveDecimal(components[key]!, `fee.components.${key}`);
  }
  const sum = present.reduce((total, key) => total.plus(components[key]!), new Decimal(0));
  if (fee?.amount !== undefined && !fee.amount.equals(sum)) {
    throw new CostComponentsInvalidError(
      "fee.components",
      "SUM_MISMATCH",
      `this ${kind}'s components sum to ${toDecimalString(sum)} but the supplied total is ${toDecimalString(fee.amount)} — the two must be equal, exactly. Supply the components alone and the total is their sum.`,
    );
  }
  return {
    feeAmount: sum,
    brokerFeeAmount: components.brokerFee ?? null,
    fxFeeAmount: components.fxFee ?? null,
    taxAmount: components.tax ?? null,
    otherCostAmount: components.other ?? null,
  };
}

/**
 * The settled amount is so small
 * relative to the trade's base value that the CASH posting's **implied** rate
 * — `amount_base / amount_native`, the figure `emitPrincipalCash` derives for
 * a D3/D5 leg — does not fit `transaction_posting.fx_rate_applied`,
 * `numeric(28,12)`. Sixteen integer digits; `1e18` needs nineteen.
 *
 * **The row is storable and its expansion is not.** Nothing relates
 * `cash_amount` to `gross_amount × fx_rate` once the currencies differ —
 * deliberately: FR-250 scopes the equality to the degenerate case and locks
 * L11/L14 put the settled amount under the writer's control, so the only floor
 * is `transaction_cash_amount_positive`. Left unguarded, `regeneratePostings`
 * raises a bare `22003` with no mapper entry, which surfaces as a 500 for what
 * is a user input problem.
 *
 * **Why here and not a `CHECK`** (the issue's own conclusion): the bound
 * relates `cash_amount` to `gross_amount × fx_rate`, and *which* rate applies
 * depends on the base currency, which lives on `tenant` — a Postgres CHECK is
 * single-row and single-table. The same reason L11 and L14 both rejected a
 * CHECK-based consistency rule.
 *
 * Mapped to **422**, not 400: the request is well formed and internally
 * coherent — the pair is paired, both figures are positive, the database would
 * take the row — and what cannot be done is *derive a representable posting*
 * from it. That is "understood but unprocessable", the same sentence
 * `TRANSACTION_EDIT_NOT_EXPRESSIBLE` already carries.
 */
export class ImpliedSettlementRateOutOfRangeError extends Error {
  readonly field: string;
  /** The offending rate, at the column's own scale — what would have been stored. */
  readonly impliedRate: string;
  /** The first magnitude the column cannot hold, as a decimal string. */
  readonly maximumExclusive: string;

  constructor(args: {
    readonly field: string;
    readonly impliedRate: Decimal;
    readonly maximumExclusive: Decimal;
    readonly detail: string;
  }) {
    super(
      `${args.field} makes this transaction's implied settlement rate ` +
        `${toDecimalString(args.impliedRate)}, which is beyond the largest rate a posting can ` +
        `record — it must stay below ${toDecimalString(args.maximumExclusive)}. ${args.detail}`,
    );
    this.name = "ImpliedSettlementRateOutOfRangeError";
    this.field = args.field;
    this.impliedRate = toDecimalString(args.impliedRate);
    this.maximumExclusive = toDecimalString(args.maximumExclusive);
  }
}

/** `transaction_posting.fx_rate_applied` is `numeric(28,12)`: twelve fractional digits… */
const FX_RATE_APPLIED_SCALE = 12;
/** …leaving sixteen integer ones, so this is the first magnitude it cannot hold. */
const FX_RATE_APPLIED_MAX_EXCLUSIVE = new Decimal("10000000000000000");

/**
 * Refuses a settlement pair whose CASH posting could not be
 * expanded, **before** any posting is written — so the caller gets a named 422
 * rather than a `22003` from three layers down.
 *
 * Reproduces the expander's own expression rather than approximating it:
 * `emitPrincipalCash` divides `amount_base` by `amount_native`, both signed the
 * same way, so the magnitude of the implied rate is
 * `(gross_amount × fx_rate) / cash_amount`. **Rounded to the column's scale
 * first**, because that is what the write does: a rate of
 * `9999999999999999.9999999999996` is under the bound at full precision and
 * `10000000000000000.000000000000` once stored, which is the overflow.
 *
 * Only the D3/D5 shape can reach it. A degenerate leg never divides, and D4's
 * settled amount *is* `gross × rate`, so its implied rate is exactly 1.
 */
function assertImpliedSettlementRateRepresentable(args: {
  readonly field: string;
  readonly grossAmount: Decimal;
  readonly fxRate: Decimal;
  readonly cashAmount: Decimal;
  readonly cashCurrency: string;
}): void {
  // `transaction_cash_amount_positive` and `assertPositiveDecimal` both own
  // zero; this guard has nothing to say about it and must not divide by it.
  if (args.cashAmount.isZero()) return;
  const impliedRate = args.grossAmount
    .times(args.fxRate)
    .dividedBy(args.cashAmount)
    .abs()
    .toDecimalPlaces(FX_RATE_APPLIED_SCALE, ROUNDING_MODE);
  if (impliedRate.lessThan(FX_RATE_APPLIED_MAX_EXCLUSIVE)) return;
  throw new ImpliedSettlementRateOutOfRangeError({
    field: args.field,
    impliedRate,
    maximumExclusive: FX_RATE_APPLIED_MAX_EXCLUSIVE,
    detail:
      `The settled amount ${toDecimalString(args.cashAmount)} ${args.cashCurrency} is too small ` +
      `beside this transaction's base value ${toDecimalString(args.grossAmount.times(args.fxRate))} ` +
      `— check the settled amount against the contract note.`,
  });
}

/**
 * Closes the portfolio-move gap left by the `cash-accounts` cycle (CA-10).
 *
 * `TransactionEdit` is `Partial<Omit<typeof transaction.$inferInsert, "id" |
 * "tenantId" | "seq">>`, which **includes `portfolioId`**, and
 * {@link TransactionWriteService.editTransaction} invalidates only the
 * *post*-`UPDATE` portfolio. A portfolio move would therefore leave the
 * **source** portfolio's `cash_balance`, `holding_state`, `realized_gain` and
 * `calc_epoch` stale with no signal — AC23's "no stale figures" silently
 * false.
 *
 * Not reachable over HTTP (`editTransactionBodySchema` omits `portfolioId`
 * and Zod strips unknown keys), but "an invariant that lives only in a DTO
 * omission is exactly what fails" is this repo's own recorded rule, so it is
 * closed at the service layer too — following F6's precedent for
 * `sourceDividendId`.
 *
 * This cycle makes closing it load-bearing rather than merely tidy: the four
 * composite cash-account FKs carry `portfolio_id`, so a move now fails with a
 * `23503` on `transaction_cash_account_fk`, and the widened
 * {@link TransactionWriteService.#guardPortfolioFk} would map that to a
 * *misleading* {@link CashAccountNotFoundError} ("your cash account is gone")
 * for what is actually an attempted portfolio move. Rejecting the move before
 * the `UPDATE` is what keeps the guard honest.
 *
 * Re-submitting the row's **own** `portfolioId` is a no-op success, not this
 * error (merge-then-compare, the same discipline
 * {@link TransactionWriteService.#assertNotSelfSettled} uses).
 */
export class TransactionPortfolioNotEditableError extends Error {
  readonly transactionId: string;
  readonly currentPortfolioId: string;
  readonly requestedPortfolioId: string;

  constructor(transactionId: string, currentPortfolioId: string, requestedPortfolioId: string) {
    super(
      `Transaction ${transactionId} cannot be moved from portfolio ${currentPortfolioId} to ${requestedPortfolioId}: ` +
        `a portfolio move would leave the source portfolio's cash_balance/holding_state/realized_gain and calc_epoch ` +
        `stale (only the destination is recomputed, AC23). Delete the transaction and recreate ` +
        `it in the other portfolio instead.`,
    );
    this.name = "TransactionPortfolioNotEditableError";
    this.transactionId = transactionId;
    this.currentPortfolioId = currentPortfolioId;
    this.requestedPortfolioId = requestedPortfolioId;
  }
}

/**
 * CA-10, and the repair of the error contract A1 changed as a side effect.
 * Adding a cost leg to a transaction whose shape carries none is **not
 * expressible** through `PATCH /transactions/:id`.
 *
 * **Only the cost leg since `0079`**. The withholding was refused here
 * because its currency could not be supplied and its rate could only be
 * resolved at write time; `0079` dropped both, so a withholding is a bare
 * amount and an edit may add one (on a DIVIDEND or an INTEREST —
 * `TransactionWriteService.#assertWithholdingBelowPrincipal`).
 *
 * **This is a narrow refusal.** A cost is a bare amount in the
 * settling account's currency (`0049`), so a generic edit may add one to a
 * BUY, SELL, DRIP or CURRENCY_EXCHANGE that settles in cash. What still refuses
 * is every row whose shape admits no cost leg: a DIVIDEND, INTEREST, FEE,
 * transfer or SHARE_DISTRIBUTION (their `CHECK`s force `fee_amount` to
 * `NULL`), a row that settles in an asset (`0050`), and a row with no cash
 * currency to denominate the cost in. There "delete and recreate" is not
 * advice either: the row simply cannot carry a cost.
 *
 * Before migration `0038` this surfaced as a `PostingExpansionError` → 422
 * `TRANSACTION_EDIT_NOT_EXPRESSIBLE`, whose French message tells the user to
 * delete and recreate the transaction — accurate and actionable. `0038`'s
 * `transaction_fee_amount_currency_pairing` CHECK then began refusing the same
 * `UPDATE` first, as a bare `23514` the controller could only map to
 * `400 TRANSACTION_INVALID_SHAPE` ("les informations saisies sont
 * incohérentes"), which is **wrong**: the user's input is fine, the endpoint
 * simply cannot express it.
 *
 * Raised here, in the service, before the `UPDATE` reaches the database, and
 * mapped back onto the original 422 `TRANSACTION_EDIT_NOT_EXPRESSIBLE` — the
 * pre-`0038` contract, restored deliberately rather than by accident.
 */
export class TransactionCashLegNotAddableError extends Error {
  readonly transactionId: string;
  readonly leg: "fee";

  constructor(transactionId: string, leg: "fee") {
    super(
      `Transaction ${transactionId} carries no ${leg} leg, and its shape cannot take one: ` +
        // A BUY/SELL/DRIP/CURRENCY_EXCHANGE settling in cash can gain a
        // cost through an edit, so what reaches here is a kind with no cost leg
        // (DIVIDEND, INTEREST, FEE, transfer, share distribution), an
        // asset-settled row, or a row with no cash currency.
        `only a BUY, SELL, DRIP or CURRENCY_EXCHANGE settled in cash carries a cost, so a ${leg} ` +
        `cannot be added to this transaction.`,
    );
    this.name = "TransactionCashLegNotAddableError";
    this.transactionId = transactionId;
    this.leg = leg;
  }
}

/** The kinds whose shape admits a cost leg (`resolveCostLeg`'s callers). */
const FEE_LEG_KINDS: ReadonlySet<string> = new Set(["BUY", "SELL", "DRIP", "CURRENCY_EXCHANGE"]);

/**
 * **The edit path's half of the 8th kind's shape.**
 *
 * `createTransactionBodySchema` refuses a malformed `SHARE_DISTRIBUTION` at
 * the wire, field by field, with a message per field. `editTransaction`
 * had no equivalent, and could not have one at the schema layer: `PATCH
 * /transactions/:id` carries no `kind`, and the row's kind is not known until
 * it is loaded — the same reason `write-error.mapper.ts` gives for why
 * `editTransactionBodySchema` cannot statically rule out a per-kind shape
 * mismatch. So a `PATCH {"cashAccountId": …}` or `{"unitPrice": …}` against a
 * cashless distribution travelled the whole edit path and met
 * `transaction_share_distribution_shape` as a bare `23514` at the very end.
 *
 * Raised here instead, **before materialisation** — the layering the instrument-cap
 * refusal established: the refusal precedes the write rather than being
 * recovered from it. `reason` distinguishes the two halves of the kind's
 * shape, which are genuinely different sentences:
 *
 *  - `FORBIDDEN` — the edit would give the row something a cashless
 *    distribution does not have (a price per unit, a settling account, a
 *    settlement currency or amount, a cost leg, a withholding leg, a
 *    currency-exchange target). Its whole definition is those absences;
 *  - `REQUIRED` — the edit would take away something it is made of (the
 *    instrument, or the distributed count).
 *
 * Named after the constraint it front-runs, so a reader who greps the
 * constraint name from a production log finds this class.
 */
export class TransactionShareDistributionShapeError extends Error {
  readonly transactionId: string;
  readonly field: string;
  readonly reason: "FORBIDDEN" | "REQUIRED";

  constructor(transactionId: string, field: string, reason: "FORBIDDEN" | "REQUIRED") {
    super(
      reason === "FORBIDDEN"
        ? `Transaction ${transactionId} is a SHARE_DISTRIBUTION — a cashless share distribution — and ${field} is ` +
            `not one of its fields: the kind is defined by moving units and no money at all (no price per unit, no ` +
            `settling account, no cost), which is what transaction_share_distribution_shape holds at the database. ` +
            `Delete this transaction and recreate it as the kind that does carry ${field} if that is what the event ` +
            `really was.`
        : `Transaction ${transactionId} is a SHARE_DISTRIBUTION and ${field} is what it is made of: clearing it ` +
            `would leave a row that records no distribution at all. Delete the transaction instead of emptying it.`,
    );
    this.name = "TransactionShareDistributionShapeError";
    this.transactionId = transactionId;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * FR-577 (`security-transfer`): a security transfer's destination
 * is the portfolio it was sent from. Raised by
 * {@link TransactionWriteService.recordTransferOut} before any FX resolution
 * or DB round trip — a transfer moves units **between two** portfolios, and a
 * "move" into the same one would write a pair of rows that nets to nothing.
 */
export class TransferDestinationIsSourceError extends Error {
  readonly portfolioId: string;

  constructor(portfolioId: string) {
    super(
      `A security transfer's destination portfolio must differ from its source portfolio ` +
        `(${portfolioId} was named as both).`,
    );
    this.name = "TransferDestinationIsSourceError";
    this.portfolioId = portfolioId;
  }
}

/**
 * A security transfer named a destination portfolio this tenant cannot see
 * (`security-transfer`, AC-471). Raised when rung 2's
 * `lockPortfolioRow` finds no row for the destination — which is the same
 * answer for a portfolio that does not exist and for another tenant's real
 * portfolio, because RLS makes the latter "not there" too. The message names
 * only the id the caller supplied, so the two cases cannot be told apart.
 */
export class TransferDestinationNotFoundError extends Error {
  readonly destinationPortfolioId: string;

  constructor(destinationPortfolioId: string) {
    super(`Destination portfolio ${destinationPortfolioId} does not exist for this tenant.`);
    this.name = "TransferDestinationNotFoundError";
    this.destinationPortfolioId = destinationPortfolioId;
  }
}

/**
 * **The edit path's half of the two transfer kinds' shape** (`security-transfer`, F-8) — the {@link TransactionShareDistributionShapeError}
 * precedent, for the same reason: `PATCH /transactions/:id` carries no `kind`,
 * so a field the row's kind cannot carry is refused here, before
 * materialisation, instead of meeting a shape CHECK as a bare `23514`.
 *
 * Raised for:
 *
 *  - a `TRANSFER_OUT` edit, or a **severed** `TRANSFER_IN` edit (ND-3 (a)),
 *    naming anything but `quantity`, `grossAmount` (the market value), `note`,
 *    `reference` or `tradeTs` — `instrumentId` included (ST-8), `tradeDate`
 *    included (ND-4 (a)), and every `transfer_*` column (the carried cost stays
 *    read-only once severed);
 *  - any row's edit naming one of the four `transfer_*` columns, which only
 *    {@link TransactionWriteService.recordTransferOut} writes. They are not part
 *    of {@link TransactionEdit} at all; this is the defensive runtime half for a
 *    caller that reaches past the type.
 *
 * `REQUIRED` is the other half of the shape: clearing the moved quantity would
 * leave a row that records no transfer.
 */
export class TransactionTransferShapeError extends Error {
  readonly transactionId: string;
  readonly field: string;
  readonly reason: "FORBIDDEN" | "REQUIRED";

  constructor(transactionId: string, field: string, reason: "FORBIDDEN" | "REQUIRED") {
    super(
      reason === "FORBIDDEN"
        ? `Transaction ${transactionId}: ${field} cannot be edited here — a security transfer's editable ` +
            `fields are its quantity, market value (grossAmount), note, reference and time of day, and ` +
            `its transfer columns are written only by the transfer itself. Delete and recreate the ` +
            `transaction if the event really was something else.`
        : `Transaction ${transactionId} is a security transfer and ${field} is what it is made of: ` +
            `clearing it would leave a row that records no transfer. Delete the transaction instead.`,
    );
    this.name = "TransactionTransferShapeError";
    this.transactionId = transactionId;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * A **linked** `TRANSFER_IN` is read-only but for its own `note` and
 * `reference` (FR-578 as amended, ND-5 (b); `security-transfer`):
 * its quantity, market value, date and carried cost are its source leg's, and
 * change only through that row. Raised before any write, naming the source
 * leg's portfolio so the caller knows where the edit belongs.
 */
export class TransferTargetReadOnlyError extends Error {
  readonly transactionId: string;
  readonly field: string;
  readonly sourcePortfolioId: string;

  constructor(transactionId: string, field: string, sourcePortfolioId: string) {
    super(
      `Transaction ${transactionId} is the receiving leg of a security transfer and ${field} cannot be ` +
        `edited on it: only its note and reference are its own. Edit the transfer's source leg in ` +
        `portfolio ${sourcePortfolioId} instead.`,
    );
    this.name = "TransferTargetReadOnlyError";
    this.transactionId = transactionId;
    this.field = field;
    this.sourcePortfolioId = sourcePortfolioId;
  }
}

/** A fee leg (FR-60): its own amount, its own currency, and its own independently resolved FX rate — a EUR fee on a USD trade is the case this exists for (AC49). */
/**
 * **FR-213 (`fee-tax-breakdown` phase 2): the four cost components**, beside
 * the total they sum to.
 *
 * Absent is `undefined`, **never zero** — a cost that was not charged has no
 * component, and `transaction_<x>_amount_positive` refuses a zero so the two
 * cannot be confused. Supplying any component makes the row *itemised*, which
 * is what routes it through `expandPostings`' component loop.
 *
 * The vocabulary is closed by this type and by the column set, not by a
 * Postgres enum (A9) — a fifth kind of cost is a migration, deliberately.
 */
/** @public (AR-3): the nameable form of an exported signature's type — consumers receive it structurally; exported so call sites can name it. Unmasked by the same vi.mock removal the gate's other @public tags record. */
export interface CostComponentsInput {
  // `| undefined` on each, not merely optional: this package compiles under
  // `exactOptionalPropertyTypes`, and the shape a Zod `.optional()` infers is
  // `T | undefined`. Without it the API's own parsed body does not satisfy this
  // type, which is a compile error at the one boundary that matters.
  readonly brokerFee?: Decimal | undefined;
  readonly fxFee?: Decimal | undefined;
  readonly tax?: Decimal | undefined;
  readonly other?: Decimal | undefined;
}

/** The four component keys, in the enum order `expandPostings` emits them in — one list, so a fifth cannot be added to the type without appearing here. */
const COST_COMPONENT_KEYS = ["brokerFee", "fxFee", "tax", "other"] as const;

/**
 * A cost leg, after **L5/L6**: a figure, or a breakdown, and
 * nothing else.
 *
 * `currency`, `cashAccountId` and `fxRateUserInput` were fields of this type
 * until this release. A cost is now denominated **by the settling account** and
 * shares the principal leg's rate, so there is no second currency to name, no
 * second account to name, and no second rate to pin. The removal is what makes
 * `FxLeg`'s third member unreachable and what
 * `feeBodySchema`'s `z.strictObject` makes visible to a caller still sending
 * them, rather than stripping them in silence.
 */
export interface FeeInput {
  /**
   * **Optional since phase 2** (FR-213): when `components` are supplied the
   * total *is* their exact sum, so a caller need not restate it — and cannot
   * restate it wrongly. Required whenever no components are given, which is
   * the unitemised shape L8 keeps valid permanently.
   */
  readonly amount?: Decimal;
  /**
   * **FR-213/FR-208: the itemisation.** Optional beside `amount`, and when
   * both are supplied `amount` must equal their exact sum — checked here,
   * before the `INSERT`, so the caller gets a named error rather than
   * `transaction_cost_components_sum_to_fee_amount`'s bare `23514`.
   *
   * Supplying components alone is enough: the total is then their sum, so a
   * caller cannot produce a row the CHECK refuses by arithmetic it did not do.
   */
  readonly components?: CostComponentsInput;
}

/** Fields common to every kind this service writes. */
interface CommonInput {
  /** Optional: defaults to a freshly minted UUID (all IDs are UUIDv7). */
  readonly id?: string;
  readonly portfolioId: string;
  /** FR-26's exact date, `YYYY-MM-DD`. */
  readonly tradeDate: IsoDate;
  /** Optional intraday timestamp; ordering still uses `(trade_date, seq)`. */
  readonly tradeTs?: Date;
  readonly note?: string;
  /**
   * The user's own reference for this transaction (migration
   * `0057`) — a broker's order number, a statement line. Optional for every
   * kind, unique for none, generated by nothing: absent means the column
   * stays NULL, which is what every row written before `0057` carries.
   *
   * Common to all eight kinds, hence its place here beside `note`: it
   * describes where the row *came from* for the person reconciling it, and
   * that question has the same answer whatever the kind.
   */
  readonly reference?: string;
  readonly updatedBySessionId?: string;
}

/**
 * A `BUY` or `SELL` (FR-6, FR-7). `txnCurrency` is free — see the class
 * comment on FR-55/AC44.
 */
export interface RecordTradeParams extends CommonInput {
  readonly instrumentId: string;
  /** Always positive; the sign is implied by the kind, never by the caller. */
  readonly quantity: Decimal;
  /** Per unit, in `txnCurrency`. */
  readonly unitPrice: Decimal;
  readonly txnCurrency: CurrencyCode;
  /** The `cash_account` the principal leg's money moved through (CA-9, FR-156) — must be a `txnCurrency` account of `portfolioId`. */
  readonly cashAccountId: string;
  /**
   * The **settling account's own denomination**, and how much of it actually
   * moved (FR-230/FR-255, migrations `0045`/`0046`). Both optional, and
   * **omitting both is the degenerate case** — settlement currency =
   * `txnCurrency`, settled amount = the gross — which is what keeps every
   * pre-cycle caller (the importer, every e2e fixture, `load/`'s HTTP paths)
   * byte-compatible (AC-278).
   *
   * The resolution table, in
   * one place ({@link TransactionWriteService.#resolveCashLeg}), applied once
   * per create path:
   *
   * | supplied | stored `cash_currency` | stored `cash_amount` |
   * |---|---|---|
   * | neither | `txnCurrency` | the gross |
   * | `cashCurrency = txnCurrency` (D1/D2) | `txnCurrency` | the gross; a contradicting `cashAmount` is refused |
   * | `cashCurrency = base`, ≠ `txnCurrency` (**D4**, L11) | as given | **derived** `gross x fx_rate`; a supplied `cashAmount` is refused |
   * | otherwise (D3/D5) | as given | **required** |
   * | `cashAmount` alone | — | refused, mirroring `transaction_cash_amount_currency_pairing` |
   *
   * The named account must be denominated in the **resolved** settlement
   * currency, not in `txnCurrency` — that is the whole capability (FR-253):
   * a USD trade settled from the portfolio's only account, a EUR one.
   */
  readonly cashCurrency?: CurrencyCode;
  readonly cashAmount?: Decimal;
  /** The user-pinned principal rate (FR-56). When present it wins outright over any provider rate (FR-57, AC45). */
  readonly fxRateUserInput?: Decimal | null;
  readonly fee?: FeeInput;
  /**
   * The CSV importer's per-row idempotency key
   * (ID7), written verbatim
   * into `transaction.import_fingerprint`. Absent — hence `NULL` — for every
   * hand-entered row, which is what makes a manually created transaction
   * invisible to a later import and vice versa.
   *
   * **Why this is a parameter of the write and not a follow-up `UPDATE`.**
   * Makes the partial unique index
   * (`transaction_import_fingerprint_key`) the backstop that closes `plan`'s
   * TOCTOU read: two concurrent imports of the same file race, and the loser
   * takes a `23505` which `applyImport` maps to `SKIP / ALREADY_IMPORTED`.
   * That mapping is only honest if the losing row was **never written** — so
   * the fingerprint has to be part of the same `INSERT` the index guards. A
   * post-insert `UPDATE` would leave the loser's duplicate `transaction` row
   * committed and report it as a skip.
   *
   * Declared per param type rather than on `CommonInput`, and **now present on
   * all seven `record*` param types, not four** — the three that used to be
   * absent gained it with the `portfolio-export-import` cycle. The rule that keeps the per-type declaration honest is unchanged
   * and is the reason this is not simply moved onto `CommonInput`: a field is
   * declared on a param type **iff** that method's own `INSERT` writes it, so
   * a value a caller supplies can never be silently dropped. Today the
   * declarations are {@link RecordTradeParams},
   * {@link RecordCashMovementParams}, {@link RecordDividendParams},
   * {@link RecordShareDistributionParams}, {@link RecordDripParams},
   * {@link RecordCurrencyExchangeParams} and {@link RecordSettledBuyParams},
   * and there are exactly seven `INSERT`s carrying `importFingerprint`.
   * **Eight since `security-transfer` Batch D**: {@link RecordTransferOutParams}
   * declares it too, and its *source* `INSERT` writes it (the target's writes
   * only a *carried* value, `targetImportFingerprint`, never a computed one).
   * **Nine since Batch E**:
   * {@link RecordStandaloneTransferInParams} declares it, and its one `INSERT`
   * writes it. **Ten since `cash-interest`**: {@link RecordInterestParams}
   * declares it, and its one `INSERT` writes it. **Still ten since
   * `portfolio-cash`**: {@link RecordFeeParams} extends
   * {@link RecordCashMovementParams} and inherits the declaration, and a FEE
   * is written by the same `#recordCashMovement` `INSERT`.
   *
   * **Why the three were added.** A Kerdial transactions file can contain a
   * `DRIP`, a `CURRENCY_EXCHANGE` and an asset-settled `BUY`; writing those
   * rows with `import_fingerprint = NULL` would break FR-537's resumability (a
   * re-run duplicates them), FR-541's cross-format dedupe and AC-437's "every
   * row from the first, partial run is reported skipped". The change is
   * additive and behaviour-preserving for every existing caller: the field is
   * optional, and an absent value stores the same `NULL` those rows store
   * today.
   */
  readonly importFingerprint?: string;
}

/**
 * A `DEPOSIT` or `WITHDRAWAL` (FR-8, AC5): amount, currency, date — and, by
 * construction, nothing else. There is deliberately no `instrumentId`,
 * `quantity` or `unitPrice` field on this type, so AC5's "no instrument leg"
 * is unrepresentable at the type level as well as rejected by
 * `transaction_deposit_withdrawal_shape` at the database level.
 */
export interface RecordCashMovementParams extends CommonInput {
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  /** The `cash_account` the money moved into (DEPOSIT) or out of (WITHDRAWAL) — CA-9, FR-156. */
  readonly cashAccountId: string;
  /** The settling account's own denomination and the amount that moved — see {@link RecordTradeParams.cashCurrency}. Omitting both is the degenerate case. */
  readonly cashCurrency?: CurrencyCode;
  readonly cashAmount?: Decimal;
  readonly fxRateUserInput?: Decimal | null;
  /** The CSV importer's per-row idempotency key — see {@link RecordTradeParams.importFingerprint}. */
  readonly importFingerprint?: string;
}

/**
 * A `FEE` (`portfolio-cash`, FR-671, FR-672, PC-L14): a standalone portfolio
 * fee — {@link RecordCashMovementParams}'s shape (amount, currency, the
 * account it was debited from, an optional cross-currency settlement) plus an
 * optional `instrumentId` that is a **reference only**: it emits no POSITION
 * posting and requests no price backfill. A separate type, so a DEPOSIT or a
 * WITHDRAWAL still cannot carry an instrument.
 */
export interface RecordFeeParams extends RecordCashMovementParams {
  /** The holding the fee relates to, if any (a UC management fee, a custody fee on one line). Must name an existing instrument. */
  readonly instrumentId?: string;
}

/**
 * A withholding tax deducted at source on a DIVIDEND or an INTEREST: **one amount**, denominated by the settling cash
 * account's currency — the same denomination rule a trade's tax follows (L5).
 * It has no currency, FX rate or cash account of its own: it converts at the
 * principal's implied rate and leaves the principal's account. Strictly below
 * the principal cash amount. `gross_amount` stays the gross; the net is
 * derived downstream as principal cash − withholding.
 */
export interface WithholdingInput {
  readonly amount: Decimal;
}

/**
 * A `DIVIDEND` (FR-9): a cash receipt attached to an instrument, with no
 * instrument *quantity* leg — `quantity` and `unit_price` are forbidden by
 * `transaction_dividend_shape`, and this type has no field for either.
 */
export interface RecordDividendParams extends CommonInput {
  readonly instrumentId: string;
  /** The **gross** amount received, before any withholding, in `currency`. */
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  /** The `cash_account` the dividend was paid into (CA-9, FR-156). */
  readonly cashAccountId: string;
  /** The settling account's own denomination and the amount that moved — see {@link RecordTradeParams.cashCurrency}. Omitting both is the degenerate case. */
  readonly cashCurrency?: CurrencyCode;
  readonly cashAmount?: Decimal;
  readonly fxRateUserInput?: Decimal | null;
  readonly withholding?: WithholdingInput;
  /** The CSV importer's per-row idempotency key — see {@link RecordTradeParams.importFingerprint}. */
  readonly importFingerprint?: string;
}

/**
 * An `INTEREST` (`cash-interest`, FR-624, FR-625): interest earned on cash —
 * {@link RecordCashMovementParams}'s shape (amount, currency, the account it
 * was paid into, an optional cross-currency settlement) plus DIVIDEND's
 * optional {@link WithholdingInput}. A separate type, so a DEPOSIT still
 * cannot carry a withholding; there is no `instrumentId`, `quantity`,
 * `unitPrice` or fee field, so the `transaction_interest_shape` refusals are
 * unrepresentable here as well as refused by the database.
 */
export interface RecordInterestParams extends CommonInput {
  /** The **gross** interest received, before any withholding, in `currency`. */
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  /** The `cash_account` the interest was paid into (CA-9, FR-156). */
  readonly cashAccountId: string;
  /** The settling account's own denomination and the amount that moved — see {@link RecordTradeParams.cashCurrency}. Omitting both is the degenerate case. */
  readonly cashCurrency?: CurrencyCode;
  readonly cashAmount?: Decimal;
  readonly fxRateUserInput?: Decimal | null;
  /** Strictly below the principal cash amount, both in the settling account's currency. */
  readonly withholding?: WithholdingInput;
  /** The CSV importer's per-row idempotency key — see {@link RecordTradeParams.importFingerprint}. */
  readonly importFingerprint?: string;
}

/**
 * A `DRIP` (FR-10, AC6): structurally a buy — quantity, unit price, a money
 * leg — but a distinct `kind` with a mandatory link to the dividend it
 * reinvests. {@link TransactionWriteService.recordDrip} is the only way to
 * write one, and it writes `kind = 'DRIP'`; there is no parameter anywhere on
 * this service that turns a DRIP into a `BUY`.
 */
export interface RecordDripParams extends CommonInput {
  readonly instrumentId: string;
  /** Mandatory (AC6). Must be an existing `DIVIDEND` for `instrumentId` in this tenant, or the write is rejected with {@link InvalidDripSourceError}. */
  readonly sourceDividendId: string;
  readonly quantity: Decimal;
  readonly unitPrice: Decimal;
  readonly txnCurrency: CurrencyCode;
  /** The `cash_account` the reinvested cash left (CA-9, FR-156). */
  readonly cashAccountId: string;
  /** The settling account's own denomination and the amount that moved — see {@link RecordTradeParams.cashCurrency}. Omitting both is the degenerate case. */
  readonly cashCurrency?: CurrencyCode;
  readonly cashAmount?: Decimal;
  readonly fxRateUserInput?: Decimal | null;
  readonly fee?: FeeInput;
  /** The importer's per-row idempotency key — see {@link RecordTradeParams.importFingerprint}. */
  readonly importFingerprint?: string;
}

/**
 * A `SHARE_DISTRIBUTION` (migration `0056`): a cashless share
 * distribution — the French *attribution d'actions gratuites*. Units arrive,
 * **no money moves**, and the holding's total cost basis is unchanged.
 *
 * The absences are the type, and each one is also a database `CHECK`
 * (`transaction_share_distribution_shape`):
 *
 *  - **no `unitPrice`** — a free share has no price per unit;
 *  - **no `cashAccountId`, `cashCurrency` or `cashAmount`** — there is no
 *    settling account, because nothing settled. This is the only kind this
 *    service writes that names no account at all, and it is the reason `0056`
 *    had to exempt it from `transaction_fiat_principal_has_cash_account`;
 *  - **no `fee`** — a cost is denominated by the settling account (L5), and
 *    there is none.
 *
 * What it *does* carry is {@link marketValue}: what the distributed shares
 * were worth on the day, which is what the source data supplies and what
 * keeps `gross_amount`'s `NOT NULL AND > 0` (F1/T-38) satisfied honestly
 * rather than relaxed. It is stored and reported; it is deliberately **not**
 * capitalised — `expandPostings` emits the position leg at exactly zero, so
 * the cost basis does not move.
 */
export interface RecordShareDistributionParams extends CommonInput {
  readonly instrumentId: string;
  /** The distributed count; always positive, and the whole effect of the event. */
  readonly quantity: Decimal;
  /**
   * The distribution's market value on `tradeDate`, in `currency`. Stored as
   * `gross_amount`; contributes **nothing** to the cost basis.
   */
  readonly marketValue: Decimal;
  /** What {@link marketValue} is denominated in. Non-null, which is also what satisfies `transaction_currency_xor_settlement_instrument`. */
  readonly currency: CurrencyCode;
  /** The user-pinned rate for the row's own FX leg (FR-56/FR-57), resolved and stored exactly as every other kind's is. */
  readonly fxRateUserInput?: Decimal | null;
  /** The CSV importer's per-row idempotency key — see {@link RecordTradeParams.importFingerprint}. */
  readonly importFingerprint?: string;
}

/**
 * A security transfer's **source leg** (`TRANSFER_OUT`, `security-transfer`):
 * units leave `portfolioId` at their PMP cost and, when
 * `destinationPortfolioId` is named, arrive in that portfolio as a linked
 * `TRANSFER_IN` carrying exactly the cost that left (FR-563). No money moves:
 * the row names no cash account, no price per unit and no fee — the
 * `SHARE_DISTRIBUTION` shape (`transaction_transfer_out_shape`).
 */
export interface RecordTransferOutParams extends CommonInput {
  readonly instrumentId: string;
  /** The moved count; always positive. */
  readonly quantity: Decimal;
  /**
   * What the moved units were worth on `tradeDate`, in `currency` — stored as
   * `gross_amount` on both legs and valued as the flow each portfolio's
   * performance sees (FR-567). **Not** a cost: the cost that moves is the
   * source's PMP share, computed by the replay.
   */
  readonly marketValue: Decimal;
  /** What {@link marketValue} is denominated in. */
  readonly currency: CurrencyCode;
  /** The user-pinned rate for the row's own FX leg (FR-56/FR-57), shared verbatim by the target leg (ST-6). */
  readonly fxRateUserInput?: Decimal | null;
  /**
   * The receiving portfolio. Absent: a transfer out of Kerdial altogether
   * (FR-566) — the source leg is written alone.
   */
  readonly destinationPortfolioId?: string;
  /**
   * The importer's per-row idempotency key — see
   * {@link RecordTradeParams.importFingerprint}. Written on the **source** leg
   * only (`security-transfer`): the target is not a source row of
   * any file, and its `NULL` is "never blocked by an import nor able to block
   * one". A retried or continued import therefore skips the source
   * `ALREADY_IMPORTED` and never reaches the target at all.
   */
  readonly importFingerprint?: string;
  /*
   * The target leg's own row fields (`security-transfer`) —
   * for the Kerdial CSV importer, which reads a linked pair as **two** rows of
   * one file and so has a target row whose id, labels and carried fingerprint
   * are its own. Each is written by the target's `INSERT` only, and naming any
   * of them without `destinationPortfolioId` is refused: there would be no
   * target to write it on. The HTTP controller passes none of them.
   */
  /** The target row's pre-allocated id (the importer's, as {@link CommonInput.id} is the source's). */
  readonly targetId?: string;
  readonly targetNote?: string;
  readonly targetReference?: string;
  /**
   * The target row's **carried** fingerprint (L17), verbatim — never one this
   * service computes: an absent value stores `NULL`, the PP path's target.
   */
  readonly targetImportFingerprint?: string;
}

/**
 * A lone `TRANSFER_IN` — a **severed** target leg, whose source was in a
 * portfolio since deleted (OD-7 (c)) — as the Kerdial CSV carries it back in
 * (`security-transfer` ND-2 (a)). **Import-only**: no HTTP route
 * reaches {@link TransactionWriteService.recordStandaloneTransferIn}, and the
 * create schema has no field for a carried cost.
 *
 * The carried cost is the file's own stored figure (`transfer_cost_*`), not
 * one this service derives: there is no source portfolio to replay. It is
 * written once and, like any severed target's, never propagated.
 */
export interface RecordStandaloneTransferInParams extends CommonInput {
  readonly instrumentId: string;
  /** The received count; always positive. */
  readonly quantity: Decimal;
  /** What the received units were worth on `tradeDate`, in `currency` — `gross_amount`, the flow (FR-567). */
  readonly marketValue: Decimal;
  readonly currency: CurrencyCode;
  readonly fxRateUserInput?: Decimal | null;
  /**
   * The cost the units arrived with: `transfer_cost_base`/`_native`, both
   * `>= 0` (`transaction_transfer_cost_non_negative` — a units-only holding
   * carries exactly zero), and `transfer_cost_currency`.
   */
  readonly carriedCost: {
    readonly base: Decimal;
    readonly native: Decimal;
    readonly currency: CurrencyCode;
  };
  /** The importer's per-row idempotency key — see {@link RecordTradeParams.importFingerprint}. */
  readonly importFingerprint?: string;
}

/**
 * A `CURRENCY_EXCHANGE` (FR-59, AC48): cash out of one currency and into
 * another **at a user-specified rate**, with optional fees and — like a
 * DEPOSIT/WITHDRAWAL — no instrument leg at all. As with
 * {@link RecordCashMovementParams}, the absence of an `instrumentId` field
 * makes AC48's "shall not alter any instrument's quantity or cost basis"
 * unrepresentable at the type level; a caller that reaches past the types is
 * rejected at runtime, and `transaction_currency_exchange_shape` rejects it
 * at the database.
 *
 * `exchangeRate` is the source→target rate the user states (FR-59), *not* an
 * FX rate to the base currency: `target_amount = amount × exchangeRate`, so
 * the two stored amounts cannot disagree with the rate the user gave. The
 * conversion to base is the separate `fx_rate` leg on the source currency
 * (`fxRateUserInput`), resolved like every other leg; the exchange itself is
 * value-neutral in base, so the target leg carries no second stored rate
 * (there is no such column).
 */
export interface RecordCurrencyExchangeParams extends CommonInput {
  /** The amount leaving `currency`. */
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  readonly targetCurrency: CurrencyCode;
  /** Units of `targetCurrency` per one unit of `currency`, as stated by the user (FR-59). */
  readonly exchangeRate: Decimal;
  /** The `cash_account` the source currency left (CA-9, FR-156, AC-176) — a `currency` account. */
  readonly cashAccountId: string;
  /**
   * The `cash_account` the target currency arrived in — a `targetCurrency`
   * account, and **independent** of {@link cashAccountId} (AC-176). Two
   * columns and not one is CD1's whole point: one row moves cash in two
   * currencies, and an account holds one.
   */
  readonly targetCashAccountId: string;
  /** Pins the *source* currency's rate to base (FR-56/FR-57). */
  readonly fxRateUserInput?: Decimal | null;
  readonly fee?: FeeInput;
  /** The importer's per-row idempotency key — see {@link RecordTradeParams.importFingerprint}. */
  readonly importFingerprint?: string;
}

/**
 * FR-66/AC52's settlement leg: the asset paid with, and how much of it.
 * `amount` is the transaction's `gross_amount`, denominated in that asset —
 * the 0.1 BTC of "buy 2 ETH paying 0.1 BTC".
 */
/** @public (AR-3): the nameable form of an exported signature's type — consumers receive it structurally; exported so call sites can name it. Unmasked by the same vi.mock removal the gate's other @public tags record. */
export interface SettlementInput {
  /** The instrument paid with (BTC). Stored as `txn_settlement_instrument_id`; `txn_currency` is NULL, per the XOR constraint. */
  readonly instrumentId: string;
  /** Total paid in the settlement asset — stored verbatim as `gross_amount`. */
  readonly amount: Decimal;
  /** Pins the settlement asset's own rate to base (BTC→EUR), FR-56/FR-57. */
  readonly fxRateUserInput?: Decimal | null;
}

/**
 * An asset-settled `BUY` (FR-66, AC52): "buy 2 ETH paying 0.1 BTC" as **one**
 * row — `instrument_id` = ETH, `quantity` = 2,
 * `txn_settlement_instrument_id` = BTC, `gross_amount` = 0.1 — with no
 * synthetic sell for the caller to construct. The disposal of the BTC is the
 * posting expander's job (T-21) and the realized gain on it T-25's; neither
 * changes this row's shape.
 *
 * **No principal `cashAccountId` (FR-157/AC-177).** The principal leg is
 * settled in an asset, so it moves no cash and names no account — there is
 * deliberately no field for one here, and
 * `transaction_settled_principal_has_no_cash_account` (migration `0038`) is
 * the database backstop. The `fee`, when present, still carries one: that leg
 * genuinely moved cash.
 */
export interface RecordSettledBuyParams extends CommonInput {
  /** The acquired asset (ETH). */
  readonly instrumentId: string;
  /** How much of it was acquired. Always positive; ≥ 18 dp is representable (`NUMERIC(38,18)`). */
  readonly quantity: Decimal;
  readonly settlement: SettlementInput;
  readonly fee?: FeeInput;
  /** The importer's per-row idempotency key — see {@link RecordTradeParams.importFingerprint}. */
  readonly importFingerprint?: string;
}

/**
 * The columns the generic {@link TransactionWriteService.editTransaction} may
 * mutate — every `transaction` column except the identity/ordering columns
 * (`id`, `tenant_id`, `seq`) that define the row and its replay position.
 *
 * The FX-leg columns are deliberately **included** here rather than filtered
 * out. The generic edit path issues a plain `UPDATE` with no correction flag,
 * so an attempt to change `fx_rate` (or any other guarded FX column) is
 * refused by `trg_transaction_fx_immutable` at the database — not by a special
 * case in this service. That refusal *is* FR-57/AC47 enforcement mechanism 2
 * at the application boundary. Only {@link
 * TransactionWriteService.correctFxRate} sets the flag that lets an FX change
 * through.
 *
 * **The four `transfer_*` columns are excluded too** (`security-transfer`, F-8): a target leg's link and carried cost are written only by
 * {@link TransactionWriteService.recordTransferOut}, and the generic
 * `.set({ ...changes })` below must not be able to carry them. A caller that
 * reaches past this type is refused at runtime as well —
 * {@link TransactionTransferShapeError}.
 *
 * **`kind` is excluded as well** (`cash-interest`, F-A1, I-11): a
 * row's kind is what every shape CHECK, flow class and posting is keyed on,
 * so it is not editable at any layer — delete and recreate the row. The HTTP
 * half is `TRANSACTION_KIND_NOT_EDITABLE` in `transactions.controller.ts`.
 */
export type TransactionEdit = Partial<
  Omit<typeof transaction.$inferInsert, "id" | "tenantId" | "seq" | "kind" | TransferColumn>
>;

/** The four columns only the transfer path writes — see {@link TransactionEdit}. */
type TransferColumn =
  "transferSourceId" | "transferCostBase" | "transferCostNative" | "transferCostCurrency";

/** {@link TransferColumn} as data, for the runtime refusal in `#assertTransferShape`. */
const TRANSFER_COLUMNS = [
  "transferSourceId",
  "transferCostBase",
  "transferCostNative",
  "transferCostCurrency",
] as const satisfies readonly TransferColumn[];

/**
 * What a transfer row's edit may name (`security-transfer`): the
 * moved quantity, the market value, and the row's own labels and time of day.
 * A **linked** `TRANSFER_IN` narrows this to {@link LINKED_TARGET_EDITABLE}
 * (ND-5 (b)); a `TRANSFER_OUT` and a severed `TRANSFER_IN` take the whole set
 * (ND-3 (a)). `tradeDate` is absent on purpose (ND-4 (a)).
 */
const TRANSFER_EDITABLE: ReadonlySet<string> = new Set([
  "quantity",
  "grossAmount",
  "note",
  "reference",
  "tradeTs",
] satisfies (keyof TransactionEdit)[]);

/** A linked target's own fields — FR-578 as amended (ND-5 (b)). */
const LINKED_TARGET_EDITABLE: ReadonlySet<string> = new Set([
  "note",
  "reference",
] satisfies (keyof TransactionEdit)[]);

/** The fields a linked source leg's edit carries across to its target. */
const TRANSFER_MIRRORED = [
  "quantity",
  "grossAmount",
  "tradeTs",
] as const satisfies readonly (keyof TransactionEdit)[];

function isTransferKind(kind: unknown): kind is "TRANSFER_OUT" | "TRANSFER_IN" {
  return kind === "TRANSFER_OUT" || kind === "TRANSFER_IN";
}

/**
 * Which edited fields make `#assertShareDistributionShape` read the row —
 * stated as **data**, and compared against the live
 * `transaction_share_distribution_shape` CHECK in
 * `transaction-write-service.fk-coverage.integration.test.ts`.
 *
 * **Why it is data and not two array literals inside the method.** The
 * literals carried `as const satisfies readonly (keyof TransactionEdit)[]`,
 * which checks that every entry **is** an editable field — not that every
 * conjunct of the CHECK **has** an entry. Those are different claims, and only
 * the second one is the invariant: *a SHARE_DISTRIBUTION edit that could
 * violate the CHECK must be refused by this method with a named error, never
 * reach the database and come back as a generic `23514`.* Two conjuncts had no
 * entry — `target_currency` and `source_dividend_id` — and the compiler was
 * satisfied, because it was answering the other question.
 *
 * Neither was reachable when the schema was first written: `targetCurrency` is rejected by
 * `GUARDED_FX_EDIT_FIELDS` before this schema runs, and `sourceDividendId` was
 * dropped from `editTransactionBodySchema` (F6). Both are listed anyway —
 * un-guarding either one elsewhere would otherwise silently reintroduce the
 * 23514-as-generic-400 that an earlier fix closed, which is exactly the hazard class
 * `GUARDED_FX_EDIT_FIELDS`' own F7 note records.
 *
 * Extra entries are deliberate and fine: the cost-component columns are forced
 * to NULL by *other* constraints, and naming them here costs one `SELECT` on
 * an edit that touches them and buys a named error instead of a raw one. The
 * drift test asserts coverage in one direction only — every conjunct has an
 * entry — never that every entry has a conjunct.
 */
const SHARE_DISTRIBUTION_SHAPE_EDIT_COVERAGE = {
  /** Every column `transaction_share_distribution_shape` forces to NULL, paired with the sentence it belongs to. */
  forbidden: [
    "unitPrice",
    "cashAccountId",
    "cashCurrency",
    "cashAmount",
    "feeAmount",
    "withholdingAmount",
    "targetAmount",
    // The two conjuncts the `satisfies` clause could not have caught.
    "targetCurrency",
    "sourceDividendId",
    "brokerFeeAmount",
    "fxFeeAmount",
    "taxAmount",
    "otherCostAmount",
  ],
  /** …and the ones it forces to NOT NULL — the instrument, the count, and the denomination are the event. */
  required: ["instrumentId", "quantity", "txnCurrency"],
} as const satisfies {
  readonly forbidden: readonly (keyof TransactionEdit)[];
  readonly required: readonly (keyof TransactionEdit)[];
};

/**
 * A generic in-place edit (FR-13): the transaction to change, the field
 * changes to apply, and the `app_user` responsible (recorded on the
 * `transaction_revision` audit row).
 */
export interface EditTransactionParams {
  readonly id: string;
  readonly changes: TransactionEdit;
  /** The `app_user.id` making the change — stored as `transaction_revision.changed_by` (FR-13's audit trail). */
  readonly changedBy: string;
}

/** A hard delete (AC9, FR-13): the transaction to remove and the `app_user` responsible. */
export interface DeleteTransactionParams {
  readonly id: string;
  readonly changedBy: string;
}

/**
 * FR-64's explicit FX-rate correction: the transaction to correct, the rate
 * the user pins, and the `app_user` responsible. Stored as both `fx_rate` and
 * `fx_rate_user_input` with `fx_rate_source = USER_PINNED` (the AC50
 * walkthrough).
 */
export interface CorrectFxRateParams {
  readonly id: string;
  /** The corrected principal rate the user pins (`amount_base = amount_native × fx_rate`). */
  readonly fxRate: Decimal;
  readonly changedBy: string;
}

export interface TransactionWriteServiceDeps {
  readonly db: Db;
  /**
   * Constructed for this request's tenant (T-18): it already carries the
   * `tenantId` and `baseCurrency` this service scopes its writes to, so
   * there is no second tenant parameter here that could disagree with it.
   */
  readonly fxRateResolver: FxRateResolver;
  /**
   * Resolves a `CRYPTO`-kind settlement asset's rate to base via the crypto
   * `QuoteProvider` (T-32) — constructed for the
   * same tenant/request as `fxRateResolver`, which it wraps for fiat
   * cross-rate composition.
   */
  readonly cryptoRateResolver: CryptoRateResolver;
  /**
   * T-35's deferred "first transaction referencing an instrument" backfill
   * trigger (see this class's own "Instrument backfill trigger" doc-comment
   * section) — optional; omitted by most of this package's own tests, which
   * have no need to also stand up `pg-boss`.
   */
  readonly instrumentBackfillScheduler?: IngestionScheduler;
  /**
   * Injectable clock (`@kerdial/market-ingestion`'s `Clock`, reused rather
   * than a second, competing clock abstraction) — used for the trade-date
   * floor check (see this class's own doc-comment section) and, when
   * `instrumentBackfillScheduler` is supplied, passed straight through to
   * `ensureInstrumentBackfillRequested`'s own `now()` reference. Defaults to
   * the real clock.
   */
  readonly clock?: Clock;
}

function assertPositiveDecimal(value: unknown, label: string): asserts value is Decimal {
  if (!(value instanceof Decimal)) {
    throw new TransactionArgumentError(
      `${label} must be a Decimal (NFR-12 — never a number or string), got: ${typeof value}`,
    );
  }
  // `greaterThan(0)`, not `isPositive()`: decimal.js's `isPositive()` is true
  // for zero (see the identical note in `fx-rate-resolver.ts`).
  if (!value.isFinite() || !value.greaterThan(0)) {
    // The one specialisation: same message this line always produced, now
    // carrying the `field` and the `TRANSACTION_AMOUNT_NOT_POSITIVE` code that
    // `editTransaction`'s own layer has had since INFO-1.
    throw new TransactionAmountNotPositiveError(label, value.toString());
  }
}

/** {@link assertPositiveDecimal}'s `>= 0` sibling — the one figure a real zero is legal for is a carried transfer cost. */
function assertNonNegativeDecimal(value: unknown, label: string): asserts value is Decimal {
  if (!(value instanceof Decimal)) {
    throw new TransactionArgumentError(
      `${label} must be a Decimal (NFR-12 — never a number or string), got: ${typeof value}`,
    );
  }
  if (!value.isFinite() || value.lessThan(0)) {
    throw new TransactionArgumentError(`${label} must be zero or greater`);
  }
}

function assertCurrency(value: string, label: string): void {
  if (!CURRENCY_SHAPE.test(value)) {
    throw new TransactionArgumentError(
      `${label} must be an ISO 4217 alphabetic code, got: ${JSON.stringify(value)}`,
    );
  }
}

function assertTradeDateShape(value: string): void {
  if (!ISO_DATE_SHAPE.test(value)) {
    throw new TransactionArgumentError(
      `tradeDate must be an ISO YYYY-MM-DD calendar date, got: ${JSON.stringify(value)}`,
    );
  }
}

/** `now` minus `BACKFILL_FLOOR_YEARS` calendar years, `YYYY-MM-DD` — mirrors `market/ingestion`'s `backfill-window.ts` identical (unexported) helper. Integer calendar-field arithmetic only, no floats (NFR-12). */
function computeTradeDateFloor(now: Date): IsoDate {
  const shifted = new Date(now.getTime());
  shifted.setUTCFullYear(shifted.getUTCFullYear() - BACKFILL_FLOOR_YEARS);
  return shifted.toISOString().slice(0, 10);
}

/** F9's grace window on the trade-date ceiling — a client in a timezone ahead of the server's UTC clock legitimately sees "today" as one calendar day later. */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (web/api mirrors and their tests, which knip does not analyse) — until AR-13a removed a namespace-wide `typeof import("@kerdial/ledger")` vi.mock, that accident masked this. */
export const TRADE_DATE_CEILING_GRACE_DAYS = 1;

/** `now` plus {@link TRADE_DATE_CEILING_GRACE_DAYS} calendar days, `YYYY-MM-DD` (F9). Integer calendar-field arithmetic only, no floats (NFR-12). */
function computeTradeDateCeiling(now: Date): IsoDate {
  const shifted = new Date(now.getTime());
  shifted.setUTCDate(shifted.getUTCDate() + TRADE_DATE_CEILING_GRACE_DAYS);
  return shifted.toISOString().slice(0, 10);
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TransactionArgumentError(`${label} is required`);
  }
}

/** Migration `0003_ledger-schema.sql`'s FK on `transaction.portfolio_id` — the one {@link TransactionPortfolioNotFoundError} translates (D5). */
const TRANSACTION_PORTFOLIO_FK = "transaction_portfolio_id_portfolio_id_fk";

/**
 * Migration `0038`'s four composite cash-account FKs, by their exact database
 * names — the ones {@link TransactionWriteService.#guardPortfolioFk} was
 * widened to translate. Each is
 * `(tenant_id, portfolio_id, <leg's account column>, <leg's currency column>)`
 * against `cash_account (tenant_id, portfolio_id, id, currency)`.
 */
/**
 * Migration `0003`'s self-referential FK on `transaction.source_dividend_id`.
 * Mapped by {@link TransactionWriteService.#guardPortfolioFk} for the
 * same reason as the portfolio and cash-account FKs: the pre-check that
 * normally rejects a bad reference runs before any lock is held, so a
 * concurrent delete of the referenced dividend can still reach the `INSERT`.
 *
 * Written by `recordDrip` and nothing else — `editTransaction` deliberately
 * does not express a `sourceDividendId` change (F6), so there is exactly one
 * call site to guard.
 */
const TRANSACTION_SOURCE_DIVIDEND_FK = "transaction_source_dividend_id_transaction_id_fk";

const TRANSACTION_CASH_ACCOUNT_FK = "transaction_cash_account_fk";
const TRANSACTION_TARGET_CASH_ACCOUNT_FK = "transaction_target_cash_account_fk";

/**
 * One leg's cash-account attribution, as this service checks it: which
 * parameter named it, which composite FK the database enforces it with, the
 * account id itself, and the currency of the leg it was named for.
 *
 * The `constraint` is what lets the widened {@link
 * TransactionWriteService.#guardPortfolioFk} map a `23503` back to the
 * *specific* account the caller named, rather than reporting whichever id it
 * happens to have in scope.
 */
interface CashAccountRef {
  readonly field: string;
  readonly constraint: string;
  readonly id: string;
  readonly currency: string;
}

/**
 * The originating dividend a DRIP names, carried into
 * {@link TransactionWriteService.#guardPortfolioFk} so a `23503` on
 * {@link TRANSACTION_SOURCE_DIVIDEND_FK} can be reported against the id the
 * caller actually named.
 */
interface DripSourceRef {
  readonly sourceDividendId: string;
  readonly instrumentId: string;
}

/**
 * See `portfolio-service.ts`'s identical helper's doc comment: drizzle-orm's
 * postgres-js driver wraps the underlying `PostgresError` in a
 * `DrizzleQueryError`, so this unwraps one level to be robust to either
 * shape.
 */
function isForeignKeyViolation(err: unknown, constraintName: string): boolean {
  const candidate =
    err instanceof postgres.PostgresError
      ? err
      : err instanceof Error && err.cause instanceof postgres.PostgresError
        ? err.cause
        : undefined;
  return candidate?.code === "23503" && candidate.constraint_name === constraintName;
}

/** The FX columns of one leg, written verbatim from what {@link FxRateResolver} resolved. */
function principalFxColumns(resolved: ResolvedRate) {
  return {
    fxRate: resolved.rate,
    fxRateSource: resolved.source,
    fxRateProviderKey: resolved.providerKey,
    fxRateObservedOn: resolved.observedOn,
    fxRateUserInput: resolved.userInput,
  };
}

/**
 * A DIVIDEND/INTEREST withholding is strictly below the principal cash
 * amount — both in the settling account's currency, so this is a plain
 * comparison of two amounts (INTEREST's `transaction_interest_shape` backstops
 * it in the database). A withholding that ate the whole credit would leave a
 * zero or negative net, which no source document describes.
 *
 * @throws {TransactionArgumentError} naming `field`.
 */
function assertWithholdingBelowPrincipal(
  withholding: Decimal,
  principalCashAmount: Decimal,
  field: string,
): void {
  if (!withholding.lessThan(principalCashAmount)) {
    throw new TransactionArgumentError(`${field} must be less than the principal cash amount`);
  }
}

/**
 * The principal cash leg's own denomination (migrations `0045`/`0046`), in the
 * **degenerate case** — the only case any writer can express today.
 *
 * `0046`'s backfill wrote `cash_currency := txn_currency` and
 * `cash_amount := gross_amount` for every fiat row that existed when it ran
 * (statement (1) there, FR-249); this is the same rule applied to the rows
 * written after it. Every constraint the two migrations added is satisfied by
 * construction: `transaction_cash_amount_currency_pairing` (both non-NULL),
 * `transaction_cash_degenerate_equals_gross` (the two amounts agree),
 * `transaction_cash_account_currency_pairing` and
 * `transaction_fiat_principal_has_cash_currency` (a fiat principal leg has a
 * currency), and `transaction_currency_exchange_cash_leg_pinned` (the cash
 * currency *is* `txn_currency`, on every kind including CURRENCY_EXCHANGE).
 * The re-pointed `transaction_cash_account_fk` now scopes by `cash_currency`,
 * which equals `txn_currency` here — so it accepts and refuses exactly the
 * accounts it did before the re-point.
 *
 * **Still the degenerate case only, and now one branch of three.** FT-12
 * (Batch B) made the general rule reachable: {@link
 * TransactionWriteService.#resolveCashLeg} is the resolution table, and it
 * calls this helper for the two rows that resolve to the degenerate pair —
 * both fields omitted, and `cashCurrency = txnCurrency`. The D4 derivation and
 * the D3/D5 required-figure rows do not come through here. It is still the
 * only expression of "the degenerate pair" on the write path, which is why it
 * stays a named function rather than an inline object literal:
 * `recordCurrencyExchange` calls it directly (FR-235 pins that kind to this
 * case forever), and `#resolveCashLeg` calls it for the other two.
 *
 * An **asset-settled** principal leg (`txn_settlement_instrument_id` non-NULL,
 * `txn_currency` NULL) moves no cash and so has no denomination: it leaves both
 * columns NULL and does not call this helper at all (FR-236,
 * `transaction_settled_principal_has_no_cash_leg`).
 */
function degenerateCashLeg(txnCurrency: string, grossAmount: Decimal) {
  return { cashCurrency: txnCurrency, cashAmount: grossAmount };
}

/**
 * The handle {@link TransactionWriteService.inWriteBatch} hands its callback.
 *
 * `row` is the only way to issue a write inside the batch, and it exists for
 * one reason: **a row that the ledger refuses must fail alone.** Without it
 * the batch's single transaction would be aborted whole by the first
 * `CashAccountArchivedError` or CHECK violation, and a 300-row import with one
 * bad row would write nothing — strictly worse than the row-at-a-time path it
 * replaces. `row` wraps each write in a `SAVEPOINT` (postgres.js's nested
 * `tx.transaction()`), so a rejection rolls that row back and leaves every
 * earlier row of the batch intact and the transaction usable.
 */
export interface WriteBatch {
  /**
   * Runs one `record*` call inside its own `SAVEPOINT`. Rethrows whatever the
   * write threw, after the savepoint has been rolled back — the caller
   * records the failure and calls `row` again for the next row.
   */
  row<T>(write: () => Promise<T>): Promise<T>;
}

/** {@link TransactionWriteService}'s private view of an open {@link WriteBatch}. */
interface WriteBatchState {
  /**
   * The handle every `record*` call inside the batch runs on — the batch's
   * own transaction, or the `SAVEPOINT` handle of the row currently being
   * written. Swapped by {@link WriteBatch.row} for the duration of that row.
   */
  tx: Tx;
  /** The batch's outer transaction. Never a savepoint handle; the flush at the end runs on this. */
  readonly outerTx: Tx;
  /**
   * `portfolioId` → the earliest `trade_date` written to it so far in this
   * batch: exactly the `minTradeDate` a single `recomputeAndInvalidate` needs
   * to subsume every per-row call it replaced (step 4 deletes every
   * `portfolio_daily_valuation` on or after it, and steps 2–3 are a full
   * recompute that does not depend on the date at all).
   */
  readonly deferredRecompute: Map<string, IsoDate>;
  /**
   * Instrument backfill triggers collected during the batch, drained **after**
   * it commits. See {@link TransactionWriteService.#triggerInstrumentBackfill}
   * on why this one cannot run inside the transaction.
   */
  readonly deferredBackfills: { readonly instrumentId: string; readonly tradeDate: IsoDate }[];
}

export class TransactionWriteService {
  readonly #db: Db;
  readonly #fx: FxRateResolver;
  readonly #crypto: CryptoRateResolver;
  readonly #tenantId: TenantId;
  readonly #instrumentBackfillScheduler: IngestionScheduler | undefined;
  readonly #clock: Clock;
  /** Non-null exactly while {@link TransactionWriteService.inWriteBatch}'s callback is running. See {@link WriteBatchState}. */
  #batch: WriteBatchState | null = null;

  constructor(deps: TransactionWriteServiceDeps) {
    this.#db = deps.db;
    this.#fx = deps.fxRateResolver;
    this.#crypto = deps.cryptoRateResolver;
    this.#tenantId = deps.fxRateResolver.tenantId;
    this.#instrumentBackfillScheduler = deps.instrumentBackfillScheduler;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Runs every `record*` call `run` issues inside **one** tenant transaction,
   * with the per-write portfolio recompute deferred to a single
   * `recomputeAndInvalidate` at the end of it.
   *
   * ## What this exists for
   *
   * Every create path ends with {@link TransactionWriteService.#invalidate},
   * whose `recomputeAndInvalidate` (`materialization.ts` steps 2–4) is a
   * **full** recompute of the portfolio: it loads the whole position timeline
   * and replays it. That is the deliberate, correct choice for one write, and
   * Argues it at length. It is quadratic for a bulk import, which issues
   * N of them over a timeline the import itself is growing — measured on the
   * NAS deployment as the reason a 25 s apply deadline (`importer/limits.ts`)
   * started rejecting rows with `APPLY_NOT_ATTEMPTED`. One recompute per batch
   * subsumes N of them exactly: steps 2–3 do not depend on the date, and step
   * 4's delete over `>= min(trade_date)` covers every individual delete it
   * replaces.
   *
   * ## Why the invariants still hold
   *
   * The guarantee is that a write and its recompute **commit or roll back
   * together**, so no committed state is ever stale. That is preserved
   * verbatim, because the deferred recompute runs inside this same
   * transaction, before it commits — it is moved, not dropped. A caller that
   * wants the guarantee *per row* keeps it by not using a batch; a caller that
   * uses one gets it per batch. Nothing commits in between.
   *
   * The lock order (F1) is unchanged: each `record*` inside the batch
   * still takes rung 1 then rung 2 through `#beginTransactionCreate`, both
   * re-entrant within one transaction, and rung 2 is now held for the whole
   * batch rather than re-taken per row — a strengthening, not a weakening.
   * Deferring the `calc_epoch` bump therefore does not defer any exclusion:
   * `materialization.ts`'s step-2 argument already rests on the caller holding
   * that row `FOR UPDATE` from before its first read.
   *
   * The one read of materialised state inside a write,
   * {@link TransactionWriteService.assertSufficientQuantity}, flushes the
   * deferred recompute first — see its own comment. Without that, a BUY and a
   * later SELL of the same instrument in one batch would read a
   * `holding_state` the BUY had not yet reached and reject a valid sell.
   *
   * ## Not re-entrant, on purpose
   *
   * The ambient handle is instance state, and a `TransactionWriteService` is
   * built per request (`api`'s `transaction-write-service.factory.ts`), so it
   * is never shared across concurrent callers. Nesting one batch inside
   * another, or issuing two concurrently on one instance, would silently make
   * one of them write on the other's transaction; both throw instead.
   *
   * `editTransaction` / `deleteTransaction` / `correctFxRate` deliberately do
   * **not** join a batch — they open their own transaction as before. The
   * deferral in `#invalidate` is keyed on the transaction handle's identity,
   * not merely on a batch being open, so a write on any other transaction
   * recomputes immediately exactly as it always did.
   */
  async inWriteBatch<T>(run: (batch: WriteBatch) => Promise<T>): Promise<T> {
    if (this.#batch !== null) {
      throw new Error(
        "TransactionWriteService.inWriteBatch: a write batch is already open on this instance. " +
          "Batches are not re-entrant and one instance serves one request; open the inner writes " +
          "through the batch you already have.",
      );
    }

    const deferredBackfills: { readonly instrumentId: string; readonly tradeDate: IsoDate }[] = [];
    const result = await withTenant(this.#db, this.#tenantId, async (outerTx) => {
      const state: WriteBatchState = {
        tx: outerTx,
        outerTx,
        deferredRecompute: new Map<string, IsoDate>(),
        deferredBackfills,
      };
      this.#batch = state;
      try {
        const value = await run({
          row: async <R>(write: () => Promise<R>): Promise<R> => {
            if (this.#batch !== state) {
              throw new Error(
                "TransactionWriteService.inWriteBatch: this batch handle is no longer the open one; " +
                  "a `row` call escaped its batch's lifetime.",
              );
            }
            // Snapshotted so a rolled-back savepoint cannot leave the
            // deferral map describing writes that no longer exist — the flush
            // `assertSufficientQuantity` may have performed inside this row is
            // rolled back with it, and the entries it cleared must come back.
            const deferredBefore = new Map(state.deferredRecompute);
            const backfillsBefore = state.deferredBackfills.length;
            try {
              // postgres.js issues a `SAVEPOINT` for a nested transaction, so
              // this row — and only this row — is undone if `write` throws.
              return await state.outerTx.transaction(async (rowTx) => {
                state.tx = rowTx;
                try {
                  return await write();
                } finally {
                  state.tx = state.outerTx;
                }
              });
            } catch (error) {
              state.deferredRecompute.clear();
              for (const [portfolioId, date] of deferredBefore) {
                state.deferredRecompute.set(portfolioId, date);
              }
              state.deferredBackfills.length = backfillsBefore;
              throw error;
            }
          },
        });
        await this.#flushDeferredRecompute(outerTx);
        return value;
      } finally {
        this.#batch = null;
      }
    });

    // Same rule as every other call site: after commit, never inside it (F4).
    for (const pending of deferredBackfills) {
      await this.#triggerInstrumentBackfill(pending.instrumentId, pending.tradeDate);
    }
    return result;
  }

  /**
   * The transaction every **create** path runs on: the open batch's, when
   * there is one, and a fresh `withTenant` transaction otherwise — which is
   * byte-for-byte the previous behaviour for every caller that never opens a
   * batch.
   */
  async #inTenantTx<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    const batch = this.#batch;
    if (batch !== null) return run(batch.tx);
    return withTenant(this.#db, this.#tenantId, run);
  }

  /**
   * Runs the recompute a batch has been accumulating, once per portfolio it
   * touched, and empties the accumulator. Called at the end of the batch, and
   * by {@link TransactionWriteService.assertSufficientQuantity} before it
   * reads `holding_state`.
   *
   * `tx` is the handle to run on — the batch's outer transaction at the end,
   * the current row's savepoint when a quantity check forces an early flush.
   * The map is cleared **before** the awaits rather than after, so a flush
   * that throws cannot be retried into a double recompute; the transaction is
   * being rolled back in that case anyway.
   */
  async #flushDeferredRecompute(tx: Tx, onlyPortfolioId?: string): Promise<void> {
    const batch = this.#batch;
    if (batch === null || batch.deferredRecompute.size === 0) return;
    let pending: Map<string, IsoDate>;
    if (onlyPortfolioId === undefined) {
      pending = new Map(batch.deferredRecompute);
      batch.deferredRecompute.clear();
    } else {
      const minTradeDate = batch.deferredRecompute.get(onlyPortfolioId);
      if (minTradeDate === undefined) return;
      pending = new Map([[onlyPortfolioId, minTradeDate]]);
      batch.deferredRecompute.delete(onlyPortfolioId);
    }
    // `security-transfer`: every deferred portfolio is round 0 of
    // one propagation, so a batch re-costs the linked targets its rows moved.
    await recomputeWithTransferPropagation(tx, this.#tenantId, pending);
  }

  /**
   * The trade-date floor check (see this class's own "Trade-date floor"
   * doc-comment section) plus the pre-existing shape check, plus F9's
   * ceiling check (see {@link TradeDateInFutureError}'s doc comment). Every
   * public write method calls this instance method — never the freestanding
   * `assertTradeDateShape` alone — so both bounds are enforced everywhere a
   * shape check already was.
   */
  #assertTradeDate(value: string): void {
    assertTradeDateShape(value);
    const floor = computeTradeDateFloor(this.#clock.now());
    if (value < floor) {
      throw new TradeDateTooOldError(value, floor);
    }
    const ceiling = computeTradeDateCeiling(this.#clock.now());
    if (value > ceiling) {
      throw new TradeDateInFutureError(value, ceiling);
    }
  }

  /**
   * portfolio-crud-ui, D5: wraps every `record*` method's own
   * `withTenant` write transaction — a portfolio that existed at
   * `TransactionsController.create`'s own pre-check (`getPortfolio`, run
   * *outside* this service) can still be deleted before this method's
   * `INSERT` runs (`deletePortfolio`'s advisory lock and `FOR UPDATE` on the
   * `portfolio` row make that race safe at the database — but the
   * resulting `23503` on {@link TRANSACTION_PORTFOLIO_FK} would otherwise
   * escape as a raw, unmapped 500). Translated here, once, for every
   * transaction-creating write method, rather than duplicated seven times.
   *
   * **Widened for the four composite cash-account FKs (CA-9).** Before this cycle it matched exactly one constraint name, so a
   * violation of `transaction_cash_account_fk` (or its target
   * variants) fell straight through as a raw, unmapped `23503` — a verbatim
   * reproduction of the F2 finding this same file already records. The
   * pre-check ({@link TransactionWriteService.#assertCashAccountsUsable}) is
   * still the primary path; this is the backstop for the window between that
   * read and the write, exactly as it already is for the portfolio FK.
   *
   * `refs` is matched **by constraint name**, never "any cash-account FK maps
   * to the account I happen to be holding": a `23503` on
   * `transaction_cash_account_fk` raised by an *attempted portfolio move*
   * would otherwise be reported as a missing cash account,
   * which is exactly backwards. That move is rejected outright by
   * {@link TransactionPortfolioNotEditableError} before the `UPDATE` runs, so
   * it never reaches here — and a constraint this call has no `ref` for is
   * re-thrown unchanged rather than guessed at.
   */
  async #guardPortfolioFk<T>(
    portfolioId: string,
    refs: readonly CashAccountRef[],
    run: () => Promise<T>,
    dripSource?: DripSourceRef,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isForeignKeyViolation(err, TRANSACTION_PORTFOLIO_FK)) {
        throw new TransactionPortfolioNotFoundError(portfolioId);
      }
      for (const ref of refs) {
        if (isForeignKeyViolation(err, ref.constraint)) {
          throw new CashAccountNotFoundError(ref.id, ref.field);
        }
      }
      // Only `recordDrip` passes a `dripSource`, and it is the only
      // writer of this FK. A caller that did not name a source dividend
      // cannot violate the constraint, so an absent `dripSource` is not a
      // missing case — it is a path where the constraint is unreachable.
      if (dripSource !== undefined && isForeignKeyViolation(err, TRANSACTION_SOURCE_DIVIDEND_FK)) {
        throw new InvalidDripSourceError(
          dripSource.sourceDividendId,
          dripSource.instrumentId,
          "DELETED_CONCURRENTLY",
          "it was visible when this write began and was deleted before the row was inserted",
        );
      }
      throw err;
    }
  }

  /**
   * Rung 2 of `portfolio-lock.ts`'s global lock order (F1), taken by
   * **every** write path in this class before it touches a `transaction` row or
   * a `cash_account` row.
   *
   * Returns `false` when this tenant has no such portfolio — which, for every
   * caller below, means a concurrent `deletePortfolio` cascade has committed:
   * that cascade destroys this portfolio's `transaction` rows in the same DB
   * transaction as the `portfolio` row, so "the portfolio is gone" and "the
   * transaction is gone" are the same fact and callers raise
   * {@link TransactionNotFoundError} for it (MEDIUM-1's standing rule). The
   * create paths raise {@link TransactionPortfolioNotFoundError} instead — they
   * have no transaction id yet, and this is exactly the 404
   * {@link TransactionWriteService.#guardPortfolioFk} would have produced from
   * the `INSERT`'s own FK violation a moment later.
   *
   * **Not free of consequence, and the consequence is smaller than it looks.**
   * `FOR UPDATE` here serialises concurrent writes within one portfolio. They
   * were already serialised: `recomputeAndInvalidate` ends every one of these
   * paths with `UPDATE portfolio SET calc_epoch = calc_epoch + 1`, whose
   * row-exclusive lock is the same contention point (`materialization.ts`'s own
   * step-2 argument depends on it). This moves the wait to the front of the
   * transaction instead of the end; it does not add one.
   */
  async #lockPortfolio(tx: Tx, portfolioId: string): Promise<boolean> {
    return lockPortfolioRow(tx, this.#tenantId, portfolioId);
  }

  /**
   * The first three statements of every `record*` path, in the one order
   * `portfolio-lock.ts` sanctions — extracted so the seven creation methods
   * cannot drift from each other, and so the order is stated once where it can
   * be read, rather than seven times where it can be copied wrong.
   *
   *   1. `#nextSeq`'s **tenant advisory lock** (rung 1). It must precede the
   *      portfolio row, not follow it: `deletePortfolio` takes the advisory
   *      lock and *then* the portfolio row, so a create holding the portfolio
   *      row while waiting for the advisory lock is a two-edge cycle with it.
   *   2. The **`portfolio` row** (rung 2). Before this fix no create took it
   *      explicitly — the `INSERT`'s own RI triggers did, and they happened to
   *      fire the portfolio FK before the four cash-account FKs only because
   *      that constraint has a lower OID. See `portfolio-lock.ts` for why
   *      resting on that was a latent `40P01`.
   *   3. `#assertCashAccountsUsable`'s read. It is a plain `SELECT` and takes
   *      no lock at all, so its position matters for a different reason:
   *      running it *after* the portfolio row is held closes the archive TOCTOU
   * for free — a concurrent `PATCH …/cash-accounts/:id {"archived":
   *      true}` takes that same row `FOR UPDATE`, so it cannot commit between
   *      this read and the `INSERT` below. Either it commits first and this
   *      read sees `archived_at` set, or it waits behind this whole write.
   *
   * Returns the allocated `seq`, which the caller's `INSERT` supplies verbatim.
   */
  async #beginTransactionCreate(
    tx: Tx,
    portfolioId: string,
    refs: readonly CashAccountRef[],
  ): Promise<bigint> {
    const seq = await this.#nextSeq(tx);
    if (!(await this.#lockPortfolio(tx, portfolioId))) {
      throw new TransactionPortfolioNotFoundError(portfolioId);
    }
    await this.#assertCashAccountsUsable(tx, portfolioId, refs);
    return seq;
  }

  /**
   * CA-9: the one in-transaction read that decides
   * whether the accounts a write names are usable for the legs it named them
   * for. Called immediately before the `INSERT`/`UPDATE` — the position
   * {@link TransactionWriteService.#assertInstrumentExists} already occupies,
   * and for the same recorded reason: *after* FX resolution, so a valid write
   * still resolves its rates exactly once before any DB round trip.
   *
   * One statement for all four legs, under the caller's `tx` so RLS scopes it
   * (`tenant_id` is also stated explicitly — belt and braces, matching every
   * other read in this file). Four rejections, each named:
   *
   *   - not visible to this tenant, or in another portfolio -> {@link CashAccountNotFoundError}
   *   - the account's currency is not the leg's -> {@link CashAccountCurrencyMismatchError}
   *   - archived -> {@link CashAccountArchivedError}
   *
   * The composite FK enforces the first two at the database regardless (it
   * carries `tenant_id`, `portfolio_id` and the leg's currency column); this
   * check exists so the caller gets a named 4xx instead of a raw `23503`,
   * not because the database would otherwise let the write through.
   * "Archived" is the one rule that is **only** here — CD11's unique key is
   * unconditional precisely so an archived account keeps its name and its
   * rows, so no constraint refuses a reference to one.
   *
   * **That makes this read's *position* load-bearing, not just its content**.
   * It takes no lock, so on its own it is a time-of-check/time-of-use
   * read: a concurrent archive committing between it and the write would leave
   * a row attributed to an archived account with nothing to detect it. Every
   * caller now runs it while already holding the `portfolio` row `FOR UPDATE`
   * (`#beginTransactionCreate` for the create paths, `editTransaction`'s own
   * lock for the edit path), and `setCashAccountArchived` takes that same row
   * — so the archive either commits before this read, and is seen, or waits
   * behind the whole write. Asserted behaviourally in
   * `cash-account-service.integration.test.ts`, both interleavings; it is not
   * a property this method can hold by itself.
   */
  async #assertCashAccountsUsable(
    tx: Tx,
    portfolioId: string,
    refs: readonly CashAccountRef[],
  ): Promise<void> {
    if (refs.length === 0) return;
    const ids = [...new Set(refs.map((ref) => ref.id))];
    const rows = await tx
      .select({
        id: cashAccount.id,
        portfolioId: cashAccount.portfolioId,
        currency: cashAccount.currency,
        archivedAt: cashAccount.archivedAt,
      })
      .from(cashAccount)
      .where(and(eq(cashAccount.tenantId, this.#tenantId), inArray(cashAccount.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const ref of refs) {
      const row = byId.get(ref.id);
      // AC33: "not yours" and "not there" are deliberately the same answer.
      if (!row || row.portfolioId !== portfolioId) {
        throw new CashAccountNotFoundError(ref.id, ref.field);
      }
      // `char(3)`, so the value is exactly three characters — trimmed anyway,
      // for the same reason `materialization.ts` trims it.
      const accountCurrency = row.currency.trim();
      if (accountCurrency !== ref.currency) {
        throw new CashAccountCurrencyMismatchError(
          ref.id,
          ref.field,
          ref.currency,
          accountCurrency,
        );
      }
      if (row.archivedAt !== null) {
        throw new CashAccountArchivedError(ref.id, ref.field);
      }
    }
  }

  /**
   * CA-9's "before any FX resolution or DB round trip" rejection for a
   * missing/empty account id. A named {@link CashAccountRequiredError} rather
   * than the freestanding `assertNonEmpty`'s bare `TypeError`, for the reason
   * INFO-1 already records for {@link TransactionAmountNotPositiveError}: an
   * unmapped `TypeError` out of this service is a 500 the caller has no stable
   * way to distinguish from a programming mistake.
   */
  #assertCashAccountNamed(value: string, field: string, detail: string): void {
    if (typeof value !== "string" || value.trim() === "") {
      throw new CashAccountRequiredError(field, detail);
    }
  }

  /**
   * FT-12 — the resolution
   * table, in one place, applied once per create path immediately after FX
   * resolution and before the `refs` array is built (see
   * {@link RecordTradeParams.cashCurrency} for the table itself).
   *
   * **This is the only place in the system that branches on the base
   * currency**, and it exists because L11's D4 rule *cannot* be a `CHECK`:
   * `tenant.base_currency` is on another table (P22,
   * `platform/db/src/schema/tenant.ts`) and a Postgres CHECK is single-row,
   * single-table. Under L11 there is nothing left to enforce afterwards —
   * `cash_amount = amount_base` at the stored scale **by construction**.
   *
   * Pure: no DB round trip, no lock, no FX resolution of its own. `FxRateResolver.resolve`
   * gains **no** call site here (FR-243/AC-269) — `principalRate` is the rate
   * the caller already resolved for the principal leg, passed in rather than
   * re-derived, so three legs remain three legs.
   *
   * Currencies are compared **trimmed on both sides**, for the reason
   * `posting-expander.ts` gives for the identical comparison: `char(3)` on one
   * side and a caller-supplied string on the other, and a mis-compare here
   * would route a degenerate write down the D3/D5 path and demand a figure it
   * should have derived.
   *
   * Every rejection is a named error raised before any DB round trip, so the
   * caller gets a 400 with a code rather than a `23514`/`23503` the controller
   * can only describe as "invalid shape" (the FR-253 discipline the three
   * cash-account errors already follow).
   */
  #resolveCashLeg(args: {
    readonly txnCurrency: string;
    readonly grossAmount: Decimal;
    readonly cashCurrency: string | undefined;
    readonly cashAmount: Decimal | undefined;
    readonly principalRate: Decimal;
  }): { cashCurrency: string; cashAmount: Decimal } {
    const { txnCurrency, grossAmount, cashCurrency, cashAmount, principalRate } = args;

    // Row 1/5: both omitted is the degenerate case; an amount alone is the
    // pairing violation `transaction_cash_amount_currency_pairing` refuses.
    if (cashCurrency === undefined) {
      if (cashAmount !== undefined) {
        throw new CashAmountNotAcceptedError(
          "cashAmount",
          "UNPAIRED_WITHOUT_CURRENCY",
          "the settlement currency and the settled amount are supplied together or not at all — name the account's currency in cashCurrency, or omit cashAmount for the degenerate case",
        );
      }
      return degenerateCashLeg(txnCurrency, grossAmount);
    }

    // Row 2 (D1/D2): the account is denominated in the transaction's own
    // currency, so there is one figure and `transaction_cash_degenerate_equals_gross`
    // pins it. A supplied amount is accepted only if it agrees.
    if (cashCurrency.trim() === txnCurrency.trim()) {
      if (cashAmount !== undefined && !cashAmount.equals(grossAmount)) {
        throw new CashAmountNotAcceptedError(
          "cashAmount",
          "DEGENERATE_EQUALS_GROSS",
          `the settling account is denominated in ${txnCurrency}, the transaction's own currency, so the settled amount is the gross (${grossAmount.toString()}) — the two are necessarily equal; ${cashAmount.toString()} contradicts it`,
        );
      }
      return degenerateCashLeg(txnCurrency, grossAmount);
    }

    // Row 3 (D4, L11): the account is denominated in the base currency, so the
    // settled amount *is* the row's own base value — `gross_amount x fx_rate`,
    // the one expression FR-234 permits for it.
    if (cashCurrency.trim() === this.#fx.baseCurrency.trim()) {
      if (cashAmount !== undefined) {
        throw new CashAmountNotAcceptedError(
          "cashAmount",
          "DERIVED_IN_BASE_CURRENCY",
          `the settling account is denominated in ${cashCurrency}, this tenant's base currency, so the settled amount is derived as gross_amount x fx_rate (${grossAmount.toString()} x ${principalRate.toString()}) — omit cashAmount`,
        );
      }
      return { cashCurrency, cashAmount: grossAmount.times(principalRate) };
    }

    // Row 4 (D3/D5): a third currency. Nothing on the row can produce the
    // figure, so it is required.
    if (cashAmount === undefined) {
      throw new CashAmountRequiredError(
        "cashAmount",
        `the settling account is denominated in ${cashCurrency}, which is neither the transaction's ${txnCurrency} nor the base ${this.#fx.baseCurrency}`,
      );
    }
    // The one shape whose implied rate is unbounded — and the
    // last point before the row is written, so the refusal is a named 422
    // instead of the expander's `22003`.
    assertImpliedSettlementRateRepresentable({
      field: "cashAmount",
      grossAmount,
      fxRate: principalRate,
      cashAmount,
      cashCurrency,
    });
    return { cashCurrency, cashAmount };
  }

  /**
   * **FR-214 / AC-248** (`fee-tax-breakdown` phase 2): an edit that touches the
   * cost breakdown must leave the components summing to the total.
   *
   * Shaped like `#reconcileCashLeg` deliberately — the same `.for("update")`
   * read of the merged values, the same "reject before the `UPDATE`, by name"
   * discipline — so a reviewer compares two adjacent methods rather than two
   * conventions. Early return with no query unless the edit touches
   * `fee_amount` or one of the four components.
   *
   * Two merged shapes, and only one of them needs a decision:
   *
   *  - **no component survives the merge** — the row is unitemised, which stays
   *    valid permanently (L8), and `fee_amount` stands alone. Nothing to do.
   *  - **at least one does** — the total must equal their sum. The caller may
   *    supply the new total, or omit it and have it derived; what is refused is
   *    a merged pair that disagrees, because that is a row
   *    `transaction_cost_components_sum_to_fee_amount` would refuse with a bare
   *    `23514` the controller could only call "invalid shape".
   *
   * Deriving rather than refusing when the total is absent is the same choice
   * the create path makes: a caller editing one component should not have to
   * restate arithmetic the row already determines.
   */
  async #reconcileCostComponents(
    tx: Tx,
    id: string,
    changes: TransactionEdit,
  ): Promise<TransactionEdit> {
    const touchesCosts =
      changes.feeAmount !== undefined ||
      changes.brokerFeeAmount !== undefined ||
      changes.fxFeeAmount !== undefined ||
      changes.taxAmount !== undefined ||
      changes.otherCostAmount !== undefined;
    if (!touchesCosts) return changes;

    const [row] = await tx
      .select({
        kind: transaction.kind,
        feeAmount: transaction.feeAmount,
        brokerFeeAmount: transaction.brokerFeeAmount,
        fxFeeAmount: transaction.fxFeeAmount,
        taxAmount: transaction.taxAmount,
        otherCostAmount: transaction.otherCostAmount,
      })
      .from(transaction)
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, id)))
      .for("update");
    // MEDIUM-1's standing rule: a concurrent `deletePortfolio` cascade may have
    // removed the row between `editTransaction`'s snapshot and this read.
    if (!row) throw new TransactionNotFoundError(id);

    // **A lone total on an itemised row.** The edit form has one fee
    // field, so it sends `feeAmount` and no component. Merging that against the
    // stored components could never agree (every fee-bearing row the owner has
    // was itemised, and 299 of 299 were refused with `SUM_MISMATCH`). The
    // ruling: the change in the total, `delta = new - old`, lands on the
    // broker component (null counts as 0) and the fx, tax and other components
    // are left alone, so the sum invariant holds and a tax posting survives.
    // Only when that would take the broker component below zero does the old
    // collapse apply (all of the new fee to broker, the other three cleared).
    // A caller that names any component keeps the strict path below; `null`
    // keeps its own branch; an unitemised row stays unitemised (L8).
    const namesComponent =
      changes.brokerFeeAmount !== undefined ||
      changes.fxFeeAmount !== undefined ||
      changes.taxAmount !== undefined ||
      changes.otherCostAmount !== undefined;
    if (
      changes.feeAmount !== undefined &&
      changes.feeAmount !== null &&
      !namesComponent &&
      (row.brokerFeeAmount !== null ||
        row.fxFeeAmount !== null ||
        row.taxAmount !== null ||
        row.otherCostAmount !== null)
    ) {
      const delta = changes.feeAmount.minus(row.feeAmount ?? new Decimal(0));
      if (delta.isZero()) return changes;
      const broker = (row.brokerFeeAmount ?? new Decimal(0)).plus(delta);
      if (!broker.isNegative()) return { ...changes, brokerFeeAmount: broker };
      return {
        ...changes,
        brokerFeeAmount: changes.feeAmount,
        fxFeeAmount: null,
        taxAmount: null,
        otherCostAmount: null,
      };
    }

    const merged = (
      column: "brokerFeeAmount" | "fxFeeAmount" | "taxAmount" | "otherCostAmount",
    ): Decimal | null => (changes[column] !== undefined ? changes[column] : row[column]);
    const components = [
      merged("brokerFeeAmount"),
      merged("fxFeeAmount"),
      merged("taxAmount"),
      merged("otherCostAmount"),
    ];
    if (components.every((amount) => amount === null)) return changes;

    const sum = components.reduce(
      (total: Decimal, amount) => (amount === null ? total : total.plus(amount)),
      new Decimal(0),
    );
    // **`null` is an instruction, `undefined` is an absence**.
    //
    // These used to collapse into one branch, so `PATCH {"feeAmount": null}` on
    // an itemised row returned 200 with the fee *unchanged*: the explicit
    // "clear this cost leg" was overridden by the derived sum and the caller
    // was never told. A silently discarded destructive request is worse than a
    // refused one.
    //
    // `null` clears the components with it, rather than being refused, because
    // the database admits no other reading:
    // `transaction_cost_components_sum_to_fee_amount` (`0047`) is
    // `(all four components NULL) OR (fee_amount IS NOT NULL AND fee_amount =
    // their sum)` — a NULL total beside a surviving component is not a
    // representable row. So "clear the total" and "clear the leg" are the same
    // instruction, and this is RC3's "the whole leg goes, in this one UPDATE"
    // extended to the four columns phase 2 added.
    //
    // The rejected alternative was `CostComponentsInvalidError`, making the
    // caller null all five fields explicitly. It was dropped because it would
    // put the arithmetic of an unrepresentable state into the caller's hands
    // for no gain: there is no *other* row they could have meant.
    if (changes.feeAmount === null) {
      // …but a request that clears the total *and* supplies a component in the
      // same breath contradicts itself, and here there genuinely are two
      // readings. Refused by name rather than resolved: this is the case the
      // sibling branch below already states as the rule — "the service will not
      // decide on the user's behalf which of the two figures they meant".
      const supplied = (
        [
          ["brokerFeeAmount", changes.brokerFeeAmount],
          ["fxFeeAmount", changes.fxFeeAmount],
          ["taxAmount", changes.taxAmount],
          ["otherCostAmount", changes.otherCostAmount],
        ] as const
      ).filter(([, amount]) => amount !== undefined && amount !== null);
      if (supplied.length > 0) {
        throw new CostComponentsInvalidError(
          "fee.components",
          "SUM_MISMATCH",
          `this edit clears transaction ${id}'s cost total and supplies ${supplied
            .map(([field]) => field)
            .join(
              ", ",
            )} in the same request — clear the total to remove the whole cost leg, or supply a total that agrees with the components`,
        );
      }
      return {
        ...changes,
        brokerFeeAmount: null,
        fxFeeAmount: null,
        taxAmount: null,
        otherCostAmount: null,
      };
    }
    const mergedTotal = changes.feeAmount !== undefined ? changes.feeAmount : row.feeAmount;
    if (mergedTotal === null || mergedTotal === undefined) {
      return { ...changes, feeAmount: sum };
    }
    if (!mergedTotal.equals(sum)) {
      throw new CostComponentsInvalidError(
        "fee.components",
        "SUM_MISMATCH",
        `after this edit transaction ${id}'s components would sum to ${toDecimalString(sum)} against a total of ${toDecimalString(mergedTotal)} — omit the total and it is derived, or supply one that agrees`,
      );
    }
    return changes;
  }

  /**
   * F1 (security review, T-38): `editTransaction`'s own
   * layer of the three-layer positivity check. `undefined` (field not
   * present in this edit) and `null` (an explicit "clear this field", valid
   * for the columns the per-kind field table allows to be absent) both
   * pass through untouched; only a present, non-null value is required to be
   * a positive `Decimal` — the same rule {@link assertPositiveDecimal} every
   * `record*` method already uses, but raised as {@link
   * TransactionAmountNotPositiveError} (INFO-1, final narrow remediation
   * review, T-38) rather than delegating to that function's
   * own bare `TypeError`, so a rejection here is machine-readable and mapped
   * to a 400 by `transactions.controller.ts`'s `#mapWriteError`, exactly like
   * every other write-path rejection this class throws.
   */
  #assertPositiveIfPresent(value: unknown, label: string): void {
    if (value === undefined || value === null) return;
    if (!(value instanceof Decimal) || !value.isFinite() || !value.greaterThan(0)) {
      throw new TransactionAmountNotPositiveError(
        label,
        value instanceof Decimal ? value.toString() : `not a Decimal (${typeof value})`,
      );
    }
  }

  /**
   * See this class's own "Instrument backfill trigger" doc-comment section.
   * No-op when `instrumentBackfillScheduler` was not supplied, or when
   * `instrumentId` does not resolve to a `BACKFILLABLE_KINDS` member
   * (FUND, the only excluded kind) — never throws for either case.
   *
   * F4 (security review, T-37): also never throws for a
   * failure of the trigger itself. Every call site invokes this *after* the
   * financial write has already committed (`withTenant`'s transaction has
   * closed by the time this method runs), so letting a rejection here
   * propagate would turn a successful write into a 5xx at the HTTP boundary
   * — and a client that retries a 5xx would record the same transaction
   * twice. This trigger is documented best-effort (see the class-level doc
   * comment); `market/ingestion`'s `reconcilePendingInstrumentBackfills` is
   * the recovery path for exactly this failure, so logging and swallowing
   * here is correct, not merely convenient.
   */
  async #triggerInstrumentBackfill(instrumentId: string, tradeDate: IsoDate): Promise<void> {
    const scheduler = this.#instrumentBackfillScheduler;
    if (!scheduler) return;

    // Inside a write batch the caller's transaction has **not** closed
    // yet — the whole point of the batch is that it commits once, at the end
    // — so the "after the financial write has already committed" precondition
    // this method's doc comment rests on is not met here. Queue it and let
    // `inWriteBatch` drain the queue after its commit, which restores the
    // precondition exactly. (It also uses `this.#db`, a *different*
    // connection from the batch's: running it now would read rows the open
    // transaction has not committed and cannot see.)
    const batch = this.#batch;
    if (batch !== null) {
      batch.deferredBackfills.push({ instrumentId, tradeDate });
      return;
    }

    try {
      const [row] = await this.#db
        .select({ kind: instrument.kind })
        .from(instrument)
        .where(eq(instrument.id, instrumentId));
      if (!row || !BACKFILLABLE_KINDS.includes(row.kind)) return;

      await ensureInstrumentBackfillRequested(this.#db, scheduler, this.#clock, {
        instrumentId,
        kind: row.kind,
        firstTransactionDate: tradeDate,
      });
    } catch (err) {
      rootLogger().error(
        "TransactionWriteService#triggerInstrumentBackfill: best-effort backfill trigger failed (F4) — swallowed; reconcilePendingInstrumentBackfills is the recovery path.",
        {
          component: "ledger",
          instrument_id: instrumentId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  /** The tenant every write of this instance is scoped to — taken from the resolver, never supplied separately. */
  get tenantId(): TenantId {
    return this.#tenantId;
  }

  /**
   * Records a `BUY` (FR-6, AC4's write half). `gross_amount` is derived as
   * `quantity × unit_price` rather than taken from the caller, so the money
   * leg cannot disagree with the instrument leg — the PMP replay reads
   * both.
   *
   * The principal FX leg, and the fee's own leg when a fee is present, are
   * each resolved exactly once here and stored on the row.
   */
  async recordBuy(params: RecordTradeParams): Promise<TransactionRecord> {
    return this.#recordTrade("BUY", params);
  }

  /**
   * Records a `SELL` (FR-7). Rejects an over-sell with
   * {@link InsufficientQuantityError} — see {@link
   * TransactionWriteService.assertSufficientQuantity} for what "held" means
   * today and what completes it.
   */
  async recordSell(params: RecordTradeParams): Promise<TransactionRecord> {
    return this.#recordTrade("SELL", params);
  }

  /** Records a `DEPOSIT` (FR-8, AC5): cash in, no instrument leg. */
  async recordDeposit(params: RecordCashMovementParams): Promise<TransactionRecord> {
    return this.#recordCashMovement("DEPOSIT", params);
  }

  /** Records a `WITHDRAWAL` (FR-8, AC5): cash out, no instrument leg. */
  async recordWithdrawal(params: RecordCashMovementParams): Promise<TransactionRecord> {
    return this.#recordCashMovement("WITHDRAWAL", params);
  }

  /**
   * Records a `FEE` (`portfolio-cash`, FR-671..673): a standalone portfolio
   * fee, cash out of a named account, classified `FEE`. An `instrumentId`, when
   * given, is a reference only — checked to exist, stored, and never read by
   * the posting expander; no instrument backfill is requested (PC-D3).
   */
  async recordFee(params: RecordFeeParams): Promise<TransactionRecord> {
    return this.#recordCashMovement("FEE", params);
  }

  /**
   * Records a `DIVIDEND` (FR-9): a cash receipt tied to an instrument, with
   * an optional withholding tax.
   *
   * The withholding is **one amount**, denominated by the settling cash
   * account (`cash_currency`) like a trade's tax (L5): it has no currency, FX
   * rate or account of its own, so there is one {@link FxRateResolver} call,
   * the principal's. The expander posts it as one `TAX` cash posting at the
   * principal's implied rate on the principal's account. It must be strictly
   * below the principal cash amount. `gross_amount` stays the **gross**
   * dividend; the net is `cash_amount − withholding_amount`, derived on read.
   */
  async recordDividend(params: RecordDividendParams): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    assertNonEmpty(params.instrumentId, "instrumentId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.amount, "amount");
    assertCurrency(params.currency, "currency");
    this.#assertCashAccountNamed(
      params.cashAccountId,
      "cashAccountId",
      "a DIVIDEND is paid into a cash account",
    );
    // FT-12: shape-checked here, with every other argument, before any FX
    // resolution or DB round trip. `#resolveCashLeg` below decides whether the
    // pair is *acceptable*; this decides whether it is well-formed.
    if (params.cashCurrency !== undefined) assertCurrency(params.cashCurrency, "cashCurrency");
    this.#assertPositiveIfPresent(params.cashAmount, "cashAmount");
    if (params.withholding) {
      assertPositiveDecimal(params.withholding.amount, "withholding.amount");
    }
    // F2 (security review, T-38): see `#recordTrade`'s
    // identical BUY-only comment — a DIVIDEND has no other check that would
    // catch a nonexistent instrumentId before the FK at INSERT time.
    await this.#assertInstrumentExists(this.#db, params.instrumentId);

    const principal = await this.#fx.resolve(
      "PRINCIPAL",
      params.currency,
      params.tradeDate,
      params.fxRateUserInput,
    );

    // FT-12: once, after FX resolution, before `refs` is built — the
    // ref below is checked against the **settlement** currency this returns,
    // never against `params.currency` (FR-253).
    const cashLeg = this.#resolveCashLeg({
      txnCurrency: params.currency,
      grossAmount: params.amount,
      cashCurrency: params.cashCurrency,
      cashAmount: params.cashAmount,
      principalRate: principal.rate,
    });
    // The withholding is denominated by the settling account, so it is
    // compared with the principal cash amount it reduces, in that currency.
    if (params.withholding) {
      assertWithholdingBelowPrincipal(
        params.withholding.amount,
        cashLeg.cashAmount,
        "withholding.amount",
      );
    }

    const refs: CashAccountRef[] = [
      {
        field: "cashAccountId",
        constraint: TRANSACTION_CASH_ACCOUNT_FK,
        id: params.cashAccountId,
        currency: cashLeg.cashCurrency,
      },
    ];

    const id = params.id ?? randomUUID();
    const written = await this.#guardPortfolioFk(params.portfolioId, refs, () =>
      this.#inTenantTx(async (tx) => {
        // F1: rung 1 (the tenant advisory lock, which allocates `seq`),
        // then rung 2 (this portfolio's row), then the account check — see
        // `#beginTransactionCreate`.
        const seq = await this.#beginTransactionCreate(tx, params.portfolioId, refs);

        const [row] = await tx
          .insert(transaction)
          .values({
            id,
            tenantId: this.#tenantId,
            // AR-5 (ADR-0002): the fact states its own base. The 0055 fill
            // trigger would stamp the identical value; writing it here keeps
            // the service honest and the trigger a verifier.
            baseCurrency: this.#fx.baseCurrency,
            portfolioId: params.portfolioId,
            kind: "DIVIDEND",
            tradeDate: params.tradeDate,
            tradeTs: params.tradeTs ?? null,
            seq,
            instrumentId: params.instrumentId,
            // `transaction_dividend_shape`: a dividend has an instrument
            // reference but no quantity leg — a cash receipt, not a trade.
            quantity: null,
            unitPrice: null,
            grossAmount: params.amount,
            txnCurrency: params.currency,
            cashAccountId: params.cashAccountId,
            ...cashLeg,
            withholdingAmount: params.withholding?.amount ?? null,
            note: params.note ?? null,
            reference: params.reference ?? null,
            updatedBySessionId: params.updatedBySessionId ?? null,
            importFingerprint: params.importFingerprint ?? null,
            ...principalFxColumns(principal),
          })
          .returning();
        // The derived ledger, written inside this same DB transaction.
        await this.#writePostings(tx, row!);
        // Steps 2-4 (T-30): same DB transaction as the write above.
        await this.#invalidate(tx, row!.portfolioId, row!.tradeDate);
        return row!;
      }),
    );
    // T-35's deferred trigger (see this class's "Instrument backfill
    // trigger" doc-comment section) — after commit, never inside it.
    await this.#triggerInstrumentBackfill(params.instrumentId, params.tradeDate);
    return written;
  }

  /**
   * Records an `INTEREST` (`cash-interest`, FR-624, FR-625):
   * interest earned on cash, paid into a named cash account, with an optional
   * withholding tax (one amount in the settling account's currency) —
   * the principal leg is INCOME and the withholding leg TAX.
   *
   * `recordDividend`'s structure minus the instrument (no
   * `instrumentId`, no instrument existence check, no backfill trigger), copied
   * rather than shared on purpose (CI-D4): a shared helper would edit the
   * DIVIDEND write path, whose behaviour must stay byte-identical (N10).
   *
   * C-5, shared with DIVIDEND: the withholding is **strictly
   * below the principal cash amount**, compared as two amounts in the settling
   * account's currency (`transaction_interest_shape` backstops it).
   */
  async recordInterest(params: RecordInterestParams): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.amount, "amount");
    assertCurrency(params.currency, "currency");
    this.#assertCashAccountNamed(
      params.cashAccountId,
      "cashAccountId",
      "an INTEREST is paid into a cash account",
    );
    // FT-12: shape-checked here, with every other argument, before any FX
    // resolution or DB round trip — as in `recordDividend`.
    if (params.cashCurrency !== undefined) assertCurrency(params.cashCurrency, "cashCurrency");
    this.#assertPositiveIfPresent(params.cashAmount, "cashAmount");
    if (params.withholding) {
      assertPositiveDecimal(params.withholding.amount, "withholding.amount");
    }

    const principal = await this.#fx.resolve(
      "PRINCIPAL",
      params.currency,
      params.tradeDate,
      params.fxRateUserInput,
    );

    // FT-12: once, after FX resolution, before `refs` is built — the
    // ref below is checked against the **settlement** currency this returns,
    // never against `params.currency` (FR-253).
    const cashLeg = this.#resolveCashLeg({
      txnCurrency: params.currency,
      grossAmount: params.amount,
      cashCurrency: params.cashCurrency,
      cashAmount: params.cashAmount,
      principalRate: principal.rate,
    });
    // The withholding is denominated by the settling account, so it is
    // compared with the principal cash amount it reduces, in that currency.
    if (params.withholding) {
      assertWithholdingBelowPrincipal(
        params.withholding.amount,
        cashLeg.cashAmount,
        "withholding.amount",
      );
    }

    const refs: CashAccountRef[] = [
      {
        field: "cashAccountId",
        constraint: TRANSACTION_CASH_ACCOUNT_FK,
        id: params.cashAccountId,
        currency: cashLeg.cashCurrency,
      },
    ];

    const id = params.id ?? randomUUID();
    return this.#guardPortfolioFk(params.portfolioId, refs, () =>
      this.#inTenantTx(async (tx) => {
        // F1: rung 1 (the tenant advisory lock, which allocates `seq`),
        // then rung 2 (this portfolio's row), then the account check — see
        // `#beginTransactionCreate`.
        const seq = await this.#beginTransactionCreate(tx, params.portfolioId, refs);

        const [row] = await tx
          .insert(transaction)
          .values({
            id,
            tenantId: this.#tenantId,
            // AR-5 (ADR-0002): the fact states its own base, as on every kind.
            baseCurrency: this.#fx.baseCurrency,
            portfolioId: params.portfolioId,
            kind: "INTEREST",
            tradeDate: params.tradeDate,
            tradeTs: params.tradeTs ?? null,
            seq,
            // `transaction_interest_shape`: no instrument leg of any kind.
            instrumentId: null,
            quantity: null,
            unitPrice: null,
            grossAmount: params.amount,
            txnCurrency: params.currency,
            cashAccountId: params.cashAccountId,
            ...cashLeg,
            withholdingAmount: params.withholding?.amount ?? null,
            note: params.note ?? null,
            reference: params.reference ?? null,
            updatedBySessionId: params.updatedBySessionId ?? null,
            importFingerprint: params.importFingerprint ?? null,
            ...principalFxColumns(principal),
          })
          .returning();
        // The derived ledger, written inside this same DB transaction.
        await this.#writePostings(tx, row!);
        // Steps 2-4 (T-30): same DB transaction as the write above.
        await this.#invalidate(tx, row!.portfolioId, row!.tradeDate);
        return row!;
      }),
    );
  }

  /**
   * Records a `DRIP` (FR-10, AC6) — its own `kind`, never a `BUY`.
   *
   * `source_dividend_id` is mandatory and is validated **inside the write
   * transaction**, against the real `transaction` table under RLS: it must
   * name an existing row, of kind `DIVIDEND`, for the same `instrument_id`.
   * Anything else raises {@link InvalidDripSourceError} and no row is
   * written. (The column's FK alone would only prove the target exists — not
   * that it is a dividend, and not that it is *this instrument's* dividend.)
   *
   * The tenant scoping of that check is RLS's, not a `WHERE` clause's: a
   * DRIP cannot be attached to another tenant's dividend because the read
   * cannot see it, and it fails as `NOT_FOUND`.
   */
  async recordDrip(params: RecordDripParams): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    assertNonEmpty(params.instrumentId, "instrumentId");
    assertNonEmpty(params.sourceDividendId, "sourceDividendId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.quantity, "quantity");
    assertPositiveDecimal(params.unitPrice, "unitPrice");
    assertCurrency(params.txnCurrency, "txnCurrency");
    this.#assertCashAccountNamed(
      params.cashAccountId,
      "cashAccountId",
      "a DRIP's reinvested cash leaves a cash account",
    );
    // FT-12: shape-checked here, with every other argument, before any FX
    // resolution or DB round trip. `#resolveCashLeg` below decides whether the
    // pair is *acceptable*; this decides whether it is well-formed.
    if (params.cashCurrency !== undefined) assertCurrency(params.cashCurrency, "cashCurrency");
    this.#assertPositiveIfPresent(params.cashAmount, "cashAmount");
    if (params.fee) {
      // FR-213: the total may be **omitted** when components carry it —
      // `resolveCostLeg` then derives it as their exact sum, which is the one
      // shape in which a caller cannot get the arithmetic wrong. Present, it is
      // still required to be a positive `Decimal`.
      this.#assertPositiveIfPresent(params.fee.amount, "fee.amount");
    }

    const principal = await this.#fx.resolve(
      "PRINCIPAL",
      params.txnCurrency,
      params.tradeDate,
      params.fxRateUserInput,
    );

    // FT-12 — see `recordDividend`'s identical call.
    const cashLeg = this.#resolveCashLeg({
      txnCurrency: params.txnCurrency,
      grossAmount: params.quantity.times(params.unitPrice),
      cashCurrency: params.cashCurrency,
      cashAmount: params.cashAmount,
      principalRate: principal.rate,
    });

    const refs: CashAccountRef[] = [
      {
        field: "cashAccountId",
        constraint: TRANSACTION_CASH_ACCOUNT_FK,
        id: params.cashAccountId,
        currency: cashLeg.cashCurrency,
      },
    ];

    const id = params.id ?? randomUUID();
    const written = await this.#guardPortfolioFk(
      params.portfolioId,
      refs,
      () =>
        this.#inTenantTx(async (tx) => {
          await this.#assertDripSource(tx, params.sourceDividendId, params.instrumentId);
          // F1: rung 1 (the tenant advisory lock, which allocates `seq`),
          // then rung 2 (this portfolio's row), then the account check — see
          // `#beginTransactionCreate`.
          const seq = await this.#beginTransactionCreate(tx, params.portfolioId, refs);

          const [row] = await tx
            .insert(transaction)
            .values({
              id,
              tenantId: this.#tenantId,
              // AR-5 (ADR-0002): the fact states its own base — see the
              // sibling insert sites.
              baseCurrency: this.#fx.baseCurrency,
              portfolioId: params.portfolioId,
              // FR-10, AC6: the kind is a literal here, and this method is the
              // only writer of it. There is no branch anywhere in this service
              // along which a DRIP becomes a BUY.
              kind: "DRIP",
              tradeDate: params.tradeDate,
              tradeTs: params.tradeTs ?? null,
              seq,
              instrumentId: params.instrumentId,
              quantity: params.quantity,
              unitPrice: params.unitPrice,
              grossAmount: params.quantity.times(params.unitPrice),
              txnCurrency: params.txnCurrency,
              cashAccountId: params.cashAccountId,
              ...cashLeg,
              sourceDividendId: params.sourceDividendId,
              ...resolveCostLeg("DRIP", params.fee, cashLeg.cashCurrency),
              note: params.note ?? null,
              reference: params.reference ?? null,
              updatedBySessionId: params.updatedBySessionId ?? null,
              importFingerprint: params.importFingerprint ?? null,
              ...principalFxColumns(principal),
            })
            .returning();
          // The derived ledger, written inside this same DB transaction.
          await this.#writePostings(tx, row!);
          // Steps 2-4 (T-30): same DB transaction as the write above.
          await this.#invalidate(tx, row!.portfolioId, row!.tradeDate);
          return row!;
        }),
      // The backstop for the window between `#assertDripSource`'s read
      // above and this `INSERT`. Passing the two ids is what lets the mapped
      // error name the dividend the caller actually asked for.
      { sourceDividendId: params.sourceDividendId, instrumentId: params.instrumentId },
    );
    // T-35's deferred trigger (see this class's "Instrument backfill
    // trigger" doc-comment section) — after commit, never inside it.
    await this.#triggerInstrumentBackfill(params.instrumentId, params.tradeDate);
    return written;
  }

  /**
   * Records a `SHARE_DISTRIBUTION` — the 8th kind, and the only
   * one this service writes that touches no cash account.
   *
   * The write is deliberately the same shape as its siblings minus the cash
   * leg: the same `#assertTradeDate`, the same `#assertInstrumentExists`, one
   * `#fx.resolve` for the row's own rate (FR-57 — the rate is resolved once
   * and stored, never re-derived), the same `#beginTransactionCreate` lock
   * order, the same in-transaction `#writePostings` and `#invalidate`, and the
   * same post-commit backfill trigger. There is no `#resolveCashLeg` call,
   * because there is no cash leg to resolve, and `refs` is empty for the same
   * reason — the one and only structural difference.
   *
   * `marketValue` is stored as `gross_amount` and is **not** a cost:
   * `expandPostings` emits a single POSITION leg worth exactly zero, so the
   * holding's quantity rises by `quantity` and its cost basis does not move.
   */
  async recordShareDistribution(params: RecordShareDistributionParams): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    assertNonEmpty(params.instrumentId, "instrumentId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.quantity, "quantity");
    // F1/T-38's positivity, applied to the one figure this kind stores: the
    // market value is `gross_amount`, whose `> 0` CHECK this kind satisfies
    // rather than relaxes. A distribution "worth nothing" is not a cashless
    // event, it is a missing figure.
    assertPositiveDecimal(params.marketValue, "marketValue");
    assertCurrency(params.currency, "currency");
    // F2 (security review, T-38): the FK is the only other
    // thing that would catch a nonexistent instrument, and it would arrive as
    // a raw `23503`.
    await this.#assertInstrumentExists(this.#db, params.instrumentId);

    const principal = await this.#fx.resolve(
      "PRINCIPAL",
      params.currency,
      params.tradeDate,
      params.fxRateUserInput,
    );

    const id = params.id ?? randomUUID();
    const written = await this.#guardPortfolioFk(params.portfolioId, [], () =>
      this.#inTenantTx(async (tx) => {
        // F1: rung 1 then rung 2, exactly as every sibling — the empty
        // `refs` skips only the account read, never a lock.
        const seq = await this.#beginTransactionCreate(tx, params.portfolioId, []);

        const [row] = await tx
          .insert(transaction)
          .values({
            id,
            tenantId: this.#tenantId,
            // AR-5 (ADR-0002): the fact states its own base — see the sibling
            // insert sites.
            baseCurrency: this.#fx.baseCurrency,
            portfolioId: params.portfolioId,
            // The kind is a literal here and this method is its only writer;
            // there is no branch anywhere in this service along which a
            // distribution becomes a BUY (the coercion OD-3 refused).
            kind: "SHARE_DISTRIBUTION",
            tradeDate: params.tradeDate,
            tradeTs: params.tradeTs ?? null,
            seq,
            instrumentId: params.instrumentId,
            quantity: params.quantity,
            // `transaction_share_distribution_shape`, stated as values rather
            // than left to the column defaults: no price, and no cash leg of
            // any kind.
            unitPrice: null,
            grossAmount: params.marketValue,
            txnCurrency: params.currency,
            cashAccountId: null,
            cashCurrency: null,
            cashAmount: null,
            note: params.note ?? null,
            reference: params.reference ?? null,
            updatedBySessionId: params.updatedBySessionId ?? null,
            importFingerprint: params.importFingerprint ?? null,
            ...principalFxColumns(principal),
          })
          .returning();
        // The derived ledger, written inside this same DB transaction.
        await this.#writePostings(tx, row!);
        // Steps 2-4 (T-30): same DB transaction as the write above.
        await this.#invalidate(tx, row!.portfolioId, row!.tradeDate);
        return row!;
      }),
    );
    // T-35's deferred trigger (see this class's "Instrument backfill
    // trigger" doc-comment section) — after commit, never inside it.
    await this.#triggerInstrumentBackfill(params.instrumentId, params.tradeDate);
    return written;
  }

  /**
   * Records a security transfer (`security-transfer`): a
   * `TRANSFER_OUT` in `portfolioId` and, when `destinationPortfolioId` is
   * named, its linked `TRANSFER_IN` there — **one** DB transaction, so the pair
   * commits or rolls back whole. Returns the source row.
   *
   * The source leg removes the moved units' cost at PMP (FR-562, by
   * construction in `applyDisposal`) and realises nothing. The target leg
   * carries **exactly** that removed cost (FR-563): it is read off the source
   * portfolio's own replay by `transferCarriedCost` — `before − after` of the
   * transfer event, in the currency OD-9 (a)/ND-1 (a) pick — and stored on the
   * row, because the target portfolio is always replayed alone.
   * The market value, currency and whole principal FX group are copied from
   * the source row verbatim (ST-6), so the two legs' flows net to exactly zero
   * in base.
   *
   * The order, and why each step is where it is:
   *
   *  1. Pre-DB validation as `recordShareDistribution`, plus FR-577's
   *     same-portfolio refusal — before any FX resolution or DB round trip.
   *  2. One `#fx.resolve` for the principal leg; the target shares it.
   *  3. **Rung 1** (`#nextSeq`'s tenant advisory lock). The source takes `seq`
   *     and the target `seq + 1` — the target strictly after its source, which
   *     the cross-portfolio cost propagation relies on for termination.
   *     No other create can take a seq in between: rung 1 is held to commit.
   *  4. **Rung 2 for both portfolios, ascending id**. A destination this tenant
   *     cannot see — missing, or another tenant's under RLS — raises
   *     {@link TransferDestinationNotFoundError}, the same answer either way
   *     (AC-471).
   *  5. The SELL guard ({@link TransactionWriteService.assertSufficientQuantity}):
   *     an oversized transfer is refused before any row is written (FR-564,
   *     AC-452).
   *  6. Insert the source, its postings; then, for a named destination, replay
   *     the source portfolio (`loadPositionTimeline` reads rows, so it sees the
   *     insert above) and insert the target with its carried cost. A back-dated
   *     transfer that makes a later `SELL` oversell throws `OverSellError` from
   *     that replay (or, with no destination, from the recompute) and the whole
   *     write rolls back.
   *  7. Invalidate the source portfolio, then the destination; one post-commit
   *     backfill trigger — the instrument is the same for both legs.
   */
  async recordTransferOut(params: RecordTransferOutParams): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    assertNonEmpty(params.instrumentId, "instrumentId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.quantity, "quantity");
    // `gross_amount`'s `> 0` CHECK, satisfied rather than relaxed — as for a
    // share distribution, a transfer "worth nothing" is a missing figure.
    assertPositiveDecimal(params.marketValue, "marketValue");
    assertCurrency(params.currency, "currency");
    const destinationPortfolioId = params.destinationPortfolioId;
    if (destinationPortfolioId !== undefined) {
      assertNonEmpty(destinationPortfolioId, "destinationPortfolioId");
      // FR-577, server half: refused before any write, and before the FX
      // resolution a doomed request would otherwise spend. Compared lowercased
      // because a uuid is case-insensitive to Postgres, so an uppercase spelling
      // of the source id names the same portfolio.
      if (destinationPortfolioId.toLowerCase() === params.portfolioId.toLowerCase()) {
        throw new TransferDestinationIsSourceError(params.portfolioId);
      }
    } else {
      for (const field of [
        "targetId",
        "targetNote",
        "targetReference",
        "targetImportFingerprint",
      ] as const) {
        if (params[field] !== undefined) {
          throw new TransactionArgumentError(
            `${field} describes the target leg, and a transfer with no destinationPortfolioId writes none`,
          );
        }
      }
    }
    await this.#assertInstrumentExists(this.#db, params.instrumentId);

    const principal = await this.#fx.resolve(
      "PRINCIPAL",
      params.currency,
      params.tradeDate,
      params.fxRateUserInput,
    );

    const id = params.id ?? randomUUID();
    const written = await this.#guardPortfolioFk(params.portfolioId, [], () =>
      this.#inTenantTx(async (tx) => {
        // Rung 1 first — see step 3 of this method's doc comment.
        const seq = await this.#nextSeq(tx);
        // Rung 2, both portfolios in ascending id order (step 4).
        const toLock =
          destinationPortfolioId === undefined
            ? [params.portfolioId]
            : [params.portfolioId, destinationPortfolioId].sort();
        for (const portfolioId of toLock) {
          if (!(await this.#lockPortfolio(tx, portfolioId))) {
            throw portfolioId === params.portfolioId
              ? new TransactionPortfolioNotFoundError(portfolioId)
              : new TransferDestinationNotFoundError(portfolioId);
          }
        }
        await this.assertSufficientQuantity(
          tx,
          params.portfolioId,
          params.instrumentId,
          params.quantity,
        );

        const [source] = await tx
          .insert(transaction)
          .values({
            id,
            tenantId: this.#tenantId,
            baseCurrency: this.#fx.baseCurrency,
            portfolioId: params.portfolioId,
            kind: "TRANSFER_OUT",
            tradeDate: params.tradeDate,
            tradeTs: params.tradeTs ?? null,
            seq,
            instrumentId: params.instrumentId,
            quantity: params.quantity,
            // `transaction_transfer_out_shape`, stated as values: no price, no
            // cash leg of any kind.
            unitPrice: null,
            grossAmount: params.marketValue,
            txnCurrency: params.currency,
            cashAccountId: null,
            cashCurrency: null,
            cashAmount: null,
            note: params.note ?? null,
            reference: params.reference ?? null,
            updatedBySessionId: params.updatedBySessionId ?? null,
            importFingerprint: params.importFingerprint ?? null,
            ...principalFxColumns(principal),
          })
          .returning();
        await this.#writePostings(tx, source!);

        if (destinationPortfolioId !== undefined) {
          const { timeline } = await loadPositionTimeline(tx, this.#tenantId, params.portfolioId);
          const carried = transferCarriedCost(timeline, seq, {
            baseCurrency: this.#fx.baseCurrency,
            fallbackCurrency: params.currency,
          });
          const [target] = await tx
            .insert(transaction)
            .values({
              id: params.targetId ?? randomUUID(),
              tenantId: this.#tenantId,
              baseCurrency: source!.baseCurrency,
              portfolioId: destinationPortfolioId,
              kind: "TRANSFER_IN",
              tradeDate: source!.tradeDate,
              tradeTs: source!.tradeTs,
              seq: seq + 1n,
              instrumentId: source!.instrumentId,
              quantity: source!.quantity,
              unitPrice: null,
              // The market value, its currency and the principal FX group are
              // the source row's own, copied verbatim (ST-6).
              grossAmount: source!.grossAmount,
              txnCurrency: source!.txnCurrency,
              cashAccountId: null,
              cashCurrency: null,
              cashAmount: null,
              note: params.targetNote ?? null,
              reference: params.targetReference ?? null,
              updatedBySessionId: params.updatedBySessionId ?? null,
              // A carried value only (see the param's own doc comment); the
              // target is not a source row, so nothing is computed for it.
              importFingerprint: params.targetImportFingerprint ?? null,
              fxRate: source!.fxRate,
              fxRateSource: source!.fxRateSource,
              fxRateProviderKey: source!.fxRateProviderKey,
              fxRateObservedOn: source!.fxRateObservedOn,
              fxRateUserInput: source!.fxRateUserInput,
              transferSourceId: source!.id,
              transferCostBase: carried.base,
              transferCostNative: carried.native,
              transferCostCurrency: carried.currency,
            })
            .returning();
          await this.#writePostings(tx, target!);
        }

        await this.#invalidate(tx, source!.portfolioId, source!.tradeDate);
        if (destinationPortfolioId !== undefined) {
          await this.#invalidate(tx, destinationPortfolioId, source!.tradeDate);
        }
        return source!;
      }),
    );
    await this.#triggerInstrumentBackfill(params.instrumentId, params.tradeDate);
    return written;
  }

  /**
   * Records a **lone** `TRANSFER_IN` (`security-transfer` ND-2 (a)): a severed target leg, carried back in by the
   * Kerdial CSV importer with the cost it arrived with. **Its only caller is
   * that importer**; `POST /transactions` has no route to it.
   *
   * The `recordShareDistribution` shape — no price, no cash leg, no fee, the
   * market value in `gross_amount`, one `#fx.resolve` for the row's own rate,
   * the same `#beginTransactionCreate` lock order — plus the three carried-cost
   * columns, stated by the caller, and `transfer_source_id` NULL. The ledger
   * cannot re-derive that cost: the portfolio it was replayed in no longer
   * exists, which is exactly why a severed target stores it (FR-563, OD-7 (c)).
   *
   * An acquisition, so there is no quantity guard. It classifies `EXTERNAL`
   * like every transfer leg (FR-567): the value arrived from outside this
   * portfolio — never `INTERNAL`, which is what exporting it as a `BUY`
   * (ND-2's rejected (c)) would have made it.
   */
  async recordStandaloneTransferIn(
    params: RecordStandaloneTransferInParams,
  ): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    assertNonEmpty(params.instrumentId, "instrumentId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.quantity, "quantity");
    assertPositiveDecimal(params.marketValue, "marketValue");
    assertCurrency(params.currency, "currency");
    // `transaction_transfer_cost_non_negative`, applied before the write so a
    // caller that reaches past the importer's own checks gets a named
    // refusal, not a `23514`.
    assertNonNegativeDecimal(params.carriedCost.base, "carriedCost.base");
    assertNonNegativeDecimal(params.carriedCost.native, "carriedCost.native");
    assertCurrency(params.carriedCost.currency, "carriedCost.currency");
    await this.#assertInstrumentExists(this.#db, params.instrumentId);
    await this.#assertCurrencyKnown(params.carriedCost.currency, "carriedCost.currency");

    const principal = await this.#fx.resolve(
      "PRINCIPAL",
      params.currency,
      params.tradeDate,
      params.fxRateUserInput,
    );

    const id = params.id ?? randomUUID();
    const written = await this.#guardPortfolioFk(params.portfolioId, [], () =>
      this.#inTenantTx(async (tx) => {
        const seq = await this.#beginTransactionCreate(tx, params.portfolioId, []);
        const [row] = await tx
          .insert(transaction)
          .values({
            id,
            tenantId: this.#tenantId,
            baseCurrency: this.#fx.baseCurrency,
            portfolioId: params.portfolioId,
            kind: "TRANSFER_IN",
            tradeDate: params.tradeDate,
            tradeTs: params.tradeTs ?? null,
            seq,
            instrumentId: params.instrumentId,
            quantity: params.quantity,
            // `transaction_transfer_in_shape`, stated as values.
            unitPrice: null,
            grossAmount: params.marketValue,
            txnCurrency: params.currency,
            cashAccountId: null,
            cashCurrency: null,
            cashAmount: null,
            note: params.note ?? null,
            reference: params.reference ?? null,
            updatedBySessionId: params.updatedBySessionId ?? null,
            importFingerprint: params.importFingerprint ?? null,
            ...principalFxColumns(principal),
            // Severed: no source, and the cost the file states.
            transferSourceId: null,
            transferCostBase: params.carriedCost.base,
            transferCostNative: params.carriedCost.native,
            transferCostCurrency: params.carriedCost.currency,
          })
          .returning();
        await this.#writePostings(tx, row!);
        await this.#invalidate(tx, row!.portfolioId, row!.tradeDate);
        return row!;
      }),
    );
    await this.#triggerInstrumentBackfill(params.instrumentId, params.tradeDate);
    return written;
  }

  /**
   * Records a `CURRENCY_EXCHANGE` (FR-59, AC48): cash out of one currency,
   * into another, at the rate the user states — with no instrument leg.
   *
   * `target_amount` is derived as `amount × exchangeRate` rather than taken
   * as a second free-standing figure, so the stored pair can never contradict
   * the rate the user gave (the same reason a BUY derives `gross_amount` from
   * `quantity × unit_price`). Multiplication is exact at `Decimal`'s
   * precision, so nothing is rounded here.
   *
   * `instrumentId` is not a field of {@link RecordCurrencyExchangeParams};
   * the runtime check below exists for callers that reach past the types (a
   * JSON payload, T-38's API layer), so AC48's rejection is a real rejection
   * and not merely a silently ignored property.
   */
  async recordCurrencyExchange(params: RecordCurrencyExchangeParams): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.amount, "amount");
    assertPositiveDecimal(params.exchangeRate, "exchangeRate");
    assertCurrency(params.currency, "currency");
    assertCurrency(params.targetCurrency, "targetCurrency");
    if (params.targetCurrency === params.currency) {
      throw new TransactionArgumentError(
        `A CURRENCY_EXCHANGE must convert between two different currencies, got ${params.currency} -> ${params.targetCurrency}`,
      );
    }
    if ((params as { instrumentId?: unknown }).instrumentId !== undefined) {
      throw new TransactionArgumentError(
        "A CURRENCY_EXCHANGE has no instrument leg (FR-59, AC48): it moves cash between two currencies and alters no instrument's quantity or cost basis. Remove instrumentId.",
      );
    }
    // FR-235 / FT-12: this kind's settlement pair is **pinned degenerate**
    // forever — `transaction_currency_exchange_cash_leg_pinned` (`0046`) makes
    // that a database fact, and L3's "CURRENCY_EXCHANGE is unchanged" rests on
    // it. `RecordCurrencyExchangeParams` therefore declares neither field;
    // this rejects a caller that reached past the types, before the DB round
    // trip, so the CHECK is the backstop and not the primary (the same shape
    // as the stray-`instrumentId` rejection immediately above, and named
    // rather than a bare `TypeError` so it maps to a 400).
    for (const field of ["cashCurrency", "cashAmount"] as const) {
      if ((params as { cashCurrency?: unknown; cashAmount?: unknown })[field] !== undefined) {
        throw new CashAmountNotAcceptedError(
          field,
          "CURRENCY_EXCHANGE_PINNED",
          `a CURRENCY_EXCHANGE's source leg settles in its own currency by construction (FR-235) — it settles in ${params.currency} for the gross amount, and no other settlement is accepted`,
        );
      }
    }
    this.#assertCashAccountNamed(
      params.cashAccountId,
      "cashAccountId",
      "the source currency leaves a cash account",
    );
    this.#assertCashAccountNamed(
      params.targetCashAccountId,
      "targetCashAccountId",
      "the target currency arrives in a cash account (AC-176: independent of the source's)",
    );
    if (params.fee) {
      // FR-213: the total may be **omitted** when components carry it —
      // `resolveCostLeg` then derives it as their exact sum, which is the one
      // shape in which a caller cannot get the arithmetic wrong. Present, it is
      // still required to be a positive `Decimal`.
      this.#assertPositiveIfPresent(params.fee.amount, "fee.amount");
    }

    const principal = await this.#fx.resolve(
      "PRINCIPAL",
      params.currency,
      params.tradeDate,
      params.fxRateUserInput,
    );

    const refs: CashAccountRef[] = [
      {
        field: "cashAccountId",
        constraint: TRANSACTION_CASH_ACCOUNT_FK,
        id: params.cashAccountId,
        currency: params.currency,
      },
      {
        field: "targetCashAccountId",
        constraint: TRANSACTION_TARGET_CASH_ACCOUNT_FK,
        id: params.targetCashAccountId,
        currency: params.targetCurrency,
      },
    ];

    const id = params.id ?? randomUUID();
    return this.#guardPortfolioFk(params.portfolioId, refs, () =>
      this.#inTenantTx(async (tx) => {
        // F1: rung 1 (the tenant advisory lock, which allocates `seq`),
        // then rung 2 (this portfolio's row), then the account check — see
        // `#beginTransactionCreate`.
        const seq = await this.#beginTransactionCreate(tx, params.portfolioId, refs);

        const [row] = await tx
          .insert(transaction)
          .values({
            id,
            tenantId: this.#tenantId,
            // AR-5 (ADR-0002): the fact states its own base. The 0055 fill
            // trigger would stamp the identical value; writing it here keeps
            // the service honest and the trigger a verifier.
            baseCurrency: this.#fx.baseCurrency,
            portfolioId: params.portfolioId,
            kind: "CURRENCY_EXCHANGE",
            tradeDate: params.tradeDate,
            tradeTs: params.tradeTs ?? null,
            seq,
            // AC48: spelled out, as for DEPOSIT/WITHDRAWAL, next to the
            // `transaction_currency_exchange_shape` CHECK that enforces it.
            instrumentId: null,
            quantity: null,
            unitPrice: null,
            grossAmount: params.amount,
            txnCurrency: params.currency,
            cashAccountId: params.cashAccountId,
            // L3/FR-235: a CURRENCY_EXCHANGE's source leg stays pinned to
            // `txn_currency` forever — `transaction_currency_exchange_cash_leg_pinned`
            // makes that a database fact, and Batch B does not relax it.
            ...degenerateCashLeg(params.currency, params.amount),
            targetCurrency: params.targetCurrency,
            targetAmount: params.amount.times(params.exchangeRate),
            targetCashAccountId: params.targetCashAccountId,
            ...resolveCostLeg("CURRENCY_EXCHANGE", params.fee, params.currency),
            note: params.note ?? null,
            reference: params.reference ?? null,
            updatedBySessionId: params.updatedBySessionId ?? null,
            importFingerprint: params.importFingerprint ?? null,
            ...principalFxColumns(principal),
          })
          .returning();
        // The derived ledger, written inside this same DB transaction.
        await this.#writePostings(tx, row!);
        // Steps 2-4 (T-30): same DB transaction as the write above.
        await this.#invalidate(tx, row!.portfolioId, row!.tradeDate);
        return row!;
      }),
    );
  }

  /**
   * Records an asset-settled `BUY` — FR-66/AC52's "buy 2 ETH paying 0.1 BTC"
   * — as **one** row: `instrument_id` = ETH, `quantity` = 2,
   * `txn_settlement_instrument_id` = BTC, `gross_amount` = 0.1 (denominated
   * in BTC), `txn_currency` NULL (the
   * `txn_currency XOR txn_settlement_instrument_id`), and `fx_rate` = the
   * settlement asset's own rate to base. The caller constructs no synthetic
   * sell-to-fiat-then-buy pair; the disposal of the BTC is emitted by the
   * posting expander (T-21) and priced against BTC's PMP by T-25.
   *
   * **Which figures are authoritative.** `quantity` and the settlement
   * `amount` are stored verbatim — they are what the user actually
   * exchanged, and what the replay reads. `unit_price` is *derived*
   * (`amount / quantity`) and is the only value here that can round, at the
   * column's 18 dp; deriving it the other way round would instead round
   * `gross_amount`, at the money columns' 12 dp, which is the figure cost
   * basis is computed from.
   *
   * A "sell 2 ETH receiving 0.1 BTC" is the same event viewed from the other
   * side and is recorded as the settled buy of the BTC — there is
   * deliberately no second method, because a single transaction has a single
   * row.
   */
  async recordSettledBuy(params: RecordSettledBuyParams): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    assertNonEmpty(params.instrumentId, "instrumentId");
    assertNonEmpty(params.settlement.instrumentId, "settlement.instrumentId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.quantity, "quantity");
    assertPositiveDecimal(params.settlement.amount, "settlement.amount");
    if (params.settlement.instrumentId === params.instrumentId) {
      throw new TransactionArgumentError(
        "A trade cannot be settled in the instrument it acquires (settlement.instrumentId must differ from instrumentId).",
      );
    }
    // FR-157/AC-177: the principal leg settles in an asset, so it moves no
    // cash and names no account. `RecordSettledBuyParams` has no field for
    // one, and `transaction_settled_principal_has_no_cash_account` (migration
    // `0038`) is the database backstop — but a caller reaching past the types
    // (a JSON payload, an internal call site) is rejected here, before the DB
    // round trip, exactly as `recordCurrencyExchange` rejects a stray
    // `instrumentId`. Named, not a bare `TypeError`, so it maps to a 400.
    if ((params as { cashAccountId?: unknown }).cashAccountId !== undefined) {
      throw new CashAccountNotAllowedError(
        "cashAccountId",
        "ASSET_SETTLED_PRINCIPAL",
        "an asset-settled BUY's principal leg moves no cash (FR-157/AC-177) — attach the account to the fee leg if a fee was paid in cash, and remove cashAccountId",
      );
    }
    // FR-236 / FT-12: for the same reason, and one step further — a leg that
    // moves no cash has no denomination either.
    // `transaction_settled_principal_has_no_cash_leg` (`0045`) requires both
    // columns NULL beside a `txn_settlement_instrument_id`;
    // `RecordSettledBuyParams` declares neither field, and this rejects a
    // caller reaching past the types before the DB round trip.
    for (const field of ["cashCurrency", "cashAmount"] as const) {
      if ((params as { cashCurrency?: unknown; cashAmount?: unknown })[field] !== undefined) {
        throw new CashAmountNotAcceptedError(
          field,
          "ASSET_SETTLED_PRINCIPAL",
          "an asset-settled BUY's principal leg moves no cash (FR-236), so it carries no settlement currency and no settled amount — remove both",
        );
      }
    }
    if (params.fee) {
      // FR-213: the total may be **omitted** when components carry it —
      // `resolveCostLeg` then derives it as their exact sum, which is the one
      // shape in which a caller cannot get the arithmetic wrong. Present, it is
      // still required to be a positive `Decimal`.
      this.#assertPositiveIfPresent(params.fee.amount, "fee.amount");
      // **This path cannot carry a cost at all** (forced by dropping the
      // fee-currency column). `resolveCostLeg` refuses it too, but that runs at the
      // `INSERT` — after the instrument lookup below — and CA-9's rule for
      // every argument-level refusal is *before any FX resolution or DB round
      // trip*. Refused here so it is, and so a caller is not charged a query
      // for a body that was never writable.
      throw new CostComponentsInvalidError(
        params.fee.components === undefined ? "fee.amount" : "fee.components",
        "NO_SETTLING_ACCOUNT",
        "this BUY settles in an asset, not cash (FR-236), so it names no cash account — and after L5 a cost is denominated in the settling account's currency. There is no currency for this cost to be in",
      );
    }
    // F2 (security review, T-38): the *acquired* instrument
    // (ETH in this class's own "buy 2 ETH paying 0.1 BTC" example) has no
    // check of its own — only `settlement.instrumentId` is validated, by
    // `#resolveSettlementPrincipal` below, via `InvalidSettlementAssetError`.
    await this.#assertInstrumentExists(this.#db, params.instrumentId);

    // The settlement asset's rate to base is an FX leg like any other: one
    // resolution, at write time, stored verbatim. Routed on
    // `instrument.kind`: a CRYPTO-kind asset's
    // rate is a market *quote*, resolved through `CryptoRateResolver`; any
    // other kind falls through to the plain `FxRateResolver` lane, unchanged.
    // Either way, the rate the user pins (FR-56) still wins outright, and
    // failing both a pin and an automatic rate rejects the write rather than
    // guessing at one.
    const principal = await this.#resolveSettlementPrincipal(
      params.settlement.instrumentId,
      params.tradeDate,
      params.settlement.fxRateUserInput,
    );

    // L5: a cost names no account of its own any more, and an
    // asset-settled principal leg names none either (FR-236) — so this write
    // has no cash-account reference to guard at all.
    const refs: CashAccountRef[] = [];

    const id = params.id ?? randomUUID();
    const written = await this.#guardPortfolioFk(params.portfolioId, refs, () =>
      this.#inTenantTx(async (tx) => {
        // The settlement leg genuinely disposes of the paid-with asset
        // (AC52: "decreases the BTC holding"), so the hard error on a
        // position going negative applies to it exactly as it applies to a
        // SELL — same check, same materialised `holding_state`, same caveats.
        await this.assertSufficientQuantity(
          tx,
          params.portfolioId,
          params.settlement.instrumentId,
          params.settlement.amount,
        );
        // F1: rung 1 (the tenant advisory lock, which allocates `seq`),
        // then rung 2 (this portfolio's row), then the account check — see
        // `#beginTransactionCreate`.
        const seq = await this.#beginTransactionCreate(tx, params.portfolioId, refs);

        const [row] = await tx
          .insert(transaction)
          .values({
            id,
            tenantId: this.#tenantId,
            // AR-5 (ADR-0002): the fact states its own base. The 0055 fill
            // trigger would stamp the identical value; writing it here keeps
            // the service honest and the trigger a verifier.
            baseCurrency: this.#fx.baseCurrency,
            portfolioId: params.portfolioId,
            kind: "BUY",
            tradeDate: params.tradeDate,
            tradeTs: params.tradeTs ?? null,
            seq,
            instrumentId: params.instrumentId,
            quantity: params.quantity,
            unitPrice: params.settlement.amount.dividedBy(params.quantity),
            grossAmount: params.settlement.amount,
            // The XOR rule: settled in an asset, so no ISO currency.
            txnCurrency: null,
            // FR-157: no fiat principal leg, so no principal cash account.
            cashAccountId: null,
            // FR-236: and no cash denomination either — this is the one
            // creation path that must *not* call `degenerateCashLeg`.
            // `transaction_settled_principal_has_no_cash_leg` (`0045`) refuses
            // the row outright if either column is non-NULL beside
            // `txn_settlement_instrument_id`. Spelled out rather than omitted,
            // like `cashAccountId` above, so the intent is legible next to the
            // CHECK that enforces it.
            cashCurrency: null,
            cashAmount: null,
            txnSettlementInstrumentId: params.settlement.instrumentId,
            ...resolveCostLeg("BUY", params.fee, null),
            note: params.note ?? null,
            reference: params.reference ?? null,
            updatedBySessionId: params.updatedBySessionId ?? null,
            importFingerprint: params.importFingerprint ?? null,
            ...principalFxColumns(principal),
          })
          .returning();
        // The derived ledger, written inside this same DB transaction.
        await this.#writePostings(tx, row!);
        // Steps 2-4 (T-30): same DB transaction as the write above.
        await this.#invalidate(tx, row!.portfolioId, row!.tradeDate);
        return row!;
      }),
    );
    // T-35's deferred trigger (see this class's "Instrument backfill
    // trigger" doc-comment section) — both legs reference an instrument
    // (the acquired asset and the settlement asset), so both are checked.
    await this.#triggerInstrumentBackfill(params.instrumentId, params.tradeDate);
    await this.#triggerInstrumentBackfill(params.settlement.instrumentId, params.tradeDate);
    return written;
  }

  /**
   * AC6's validation: the row `source_dividend_id` names must exist, be a
   * `DIVIDEND`, and be for the same instrument the DRIP acquires. Read
   * inside the caller's write transaction so the check and the insert commit
   * or roll back together.
   */
  async #assertDripSource(tx: Tx, sourceDividendId: string, instrumentId: string): Promise<void> {
    const [source] = await tx
      .select({ kind: transaction.kind, instrumentId: transaction.instrumentId })
      .from(transaction)
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, sourceDividendId)));

    if (!source) {
      throw new InvalidDripSourceError(
        sourceDividendId,
        instrumentId,
        "NOT_FOUND",
        "no such transaction is visible to this tenant",
      );
    }
    if (source.kind !== "DIVIDEND") {
      throw new InvalidDripSourceError(
        sourceDividendId,
        instrumentId,
        "NOT_A_DIVIDEND",
        `it is a ${source.kind}, not a DIVIDEND`,
      );
    }
    if (source.instrumentId !== instrumentId) {
      throw new InvalidDripSourceError(
        sourceDividendId,
        instrumentId,
        "DIFFERENT_INSTRUMENT",
        `it is a dividend of instrument ${source.instrumentId}`,
      );
    }
  }

  /**
   * F2 (security review, T-38): a `BUY`/`DIVIDEND`/
   * asset-settled-`BUY` naming a nonexistent `instrumentId` (or an
   * `editTransaction` changing one to a nonexistent id) previously reached
   * `transaction_instrument_id_instrument_id_fk` at `INSERT`/`UPDATE` time
   * with no check of its own — a raw `23503` the controller had no mapping
   * for, so it surfaced as a 500. `SELL` (via {@link
   * TransactionWriteService.assertSufficientQuantity}, which always rejects
   * a nonexistent instrument as "0 held") and `DRIP` (via {@link
   * TransactionWriteService.#assertDripSource}'s dividend-instrument match)
   * already got a clean rejection for free; this method gives every other
   * instrument-bearing write path the same clean 404 instead, without
   * relying on a lucky side effect of an unrelated check.
   *
   * `instrument` is shared catalogue data with no `tenant_id`, so —
   * like {@link TransactionWriteService.#resolveSettlementPrincipal}'s
   * identical read — this is deliberately not tenant-scoped.
   *
   * `db` is an explicit parameter — `this.#db` (the pooled connection) when
   * called before a `withTenant` transaction has opened, or the caller's own
   * `tx` when called from inside one — never assumed. This is not merely
   * stylistic: a call site added inside `#recordTrade`'s `withTenant`
   * callback that (mistakenly) queried `this.#db` instead of `tx` deadlocked
   * every integration suite using a `max: 1` connection pool (this package's
   * own convention) — the outer transaction holds the pool's only connection
   * open while awaiting this method, which would then wait forever for a
   * second connection the pool can never hand out until the first commits.
   */
  /**
   * `transfer_cost_currency` has no foreign key: the one
   * currency on a transaction row that no FK and no FX resolution looks up.
   * The importer refuses an unknown one at plan time as `CURRENCY_UNKNOWN`;
   * this is the backstop for a caller that reaches past it.
   */
  async #assertCurrencyKnown(code: string, label: string): Promise<void> {
    const [row] = await this.#db
      .select({ code: currency.code })
      .from(currency)
      .where(eq(currency.code, code));
    if (!row) {
      throw new TransactionArgumentError(
        `${label} must be a currency this installation knows, got: ${JSON.stringify(code)}`,
      );
    }
  }

  async #assertInstrumentExists(db: Db | Tx, instrumentId: string): Promise<void> {
    const [row] = await db
      .select({ id: instrument.id })
      .from(instrument)
      .where(eq(instrument.id, instrumentId));
    if (!row) throw new InstrumentNotFoundError(instrumentId);
  }

  /**
   * Resolves a settlement asset's principal FX leg, routed on
   * `instrument.kind` — the lookup this method
   * performs is the same query T-20 always ran, widened by one column
   * (`kind` alongside `symbol`), so this costs no extra round-trip.
   * `instrument` is shared catalogue data with no `tenant_id`, so the
   * read is deliberately not tenant-scoped.
   *
   * - `kind === 'CRYPTO'` -> {@link CryptoRateResolver}, keyed by the
   *   provider's own symbol via `instrument_provider_map` — never a
   *   three-letter code; `UNUSABLE_SYMBOL` cannot fire here.
   * - any other kind -> the existing {@link FxRateResolver} lane, unchanged
   *   — a defensive fall-through per the XOR constraint (in phase 1,
   *   FR-66 settlement is always CRYPTO, so this branch is not an expected
   *   path), still requiring a three-letter ISO `symbol`.
   */
  async #resolveSettlementPrincipal(
    settlementInstrumentId: string,
    tradeDate: IsoDate,
    fxRateUserInput: Decimal | null | undefined,
  ): Promise<ResolvedRate> {
    const leg: FxLeg = "PRINCIPAL";
    const [asset] = await this.#db
      .select({ kind: instrument.kind, symbol: instrument.symbol })
      .from(instrument)
      .where(eq(instrument.id, settlementInstrumentId));

    if (!asset) {
      throw new InvalidSettlementAssetError(
        settlementInstrumentId,
        "NOT_FOUND",
        "no such instrument exists",
      );
    }

    if (asset.kind === "CRYPTO") {
      return this.#crypto.resolve(leg, settlementInstrumentId, tradeDate, fxRateUserInput);
    }

    if (asset.symbol === null || !CURRENCY_SHAPE.test(asset.symbol)) {
      throw new InvalidSettlementAssetError(
        settlementInstrumentId,
        "UNUSABLE_SYMBOL",
        `its symbol ${JSON.stringify(asset.symbol)} is not a three-letter code`,
      );
    }
    return this.#fx.resolve(leg, asset.symbol, tradeDate, fxRateUserInput);
  }

  async #recordTrade(kind: "BUY" | "SELL", params: RecordTradeParams): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    assertNonEmpty(params.instrumentId, "instrumentId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.quantity, "quantity");
    assertPositiveDecimal(params.unitPrice, "unitPrice");
    assertCurrency(params.txnCurrency, "txnCurrency");
    this.#assertCashAccountNamed(
      params.cashAccountId,
      "cashAccountId",
      `a fiat-settled ${kind}'s principal leg moves cash through a cash account`,
    );
    // FT-12: shape-checked here, with every other argument, before any FX
    // resolution or DB round trip. `#resolveCashLeg` below decides whether the
    // pair is *acceptable*; this decides whether it is well-formed.
    if (params.cashCurrency !== undefined) assertCurrency(params.cashCurrency, "cashCurrency");
    this.#assertPositiveIfPresent(params.cashAmount, "cashAmount");
    if (params.fee) {
      // FR-213: the total may be **omitted** when components carry it —
      // `resolveCostLeg` then derives it as their exact sum, which is the one
      // shape in which a caller cannot get the arithmetic wrong. Present, it is
      // still required to be a positive `Decimal`.
      this.#assertPositiveIfPresent(params.fee.amount, "fee.amount");
    }
    // One resolution per leg, at write time, before anything is
    // persisted. The fee's currency is resolved independently of the
    // principal's — a EUR fee on a USD trade gets IMPLIED_BASE while the
    // principal gets a real rate (FR-60, AC49).
    const principal = await this.#fx.resolve(
      "PRINCIPAL",
      params.txnCurrency,
      params.tradeDate,
      params.fxRateUserInput,
    );

    // FT-12 — see `recordDividend`'s identical call. This is AC-257's
    // own path: a USD BUY settled from the portfolio's only account, a EUR one.
    const cashLeg = this.#resolveCashLeg({
      txnCurrency: params.txnCurrency,
      grossAmount: params.quantity.times(params.unitPrice),
      cashCurrency: params.cashCurrency,
      cashAmount: params.cashAmount,
      principalRate: principal.rate,
    });

    const refs: CashAccountRef[] = [
      {
        field: "cashAccountId",
        constraint: TRANSACTION_CASH_ACCOUNT_FK,
        id: params.cashAccountId,
        currency: cashLeg.cashCurrency,
      },
    ];

    const id = params.id ?? randomUUID();
    const written = await this.#guardPortfolioFk(params.portfolioId, refs, () =>
      this.#inTenantTx(async (tx) => {
        if (kind === "SELL") {
          await this.assertSufficientQuantity(
            tx,
            params.portfolioId,
            params.instrumentId,
            params.quantity,
          );
        } else {
          // F2 (security review, T-38): a SELL of a
          // nonexistent instrumentId is already rejected cleanly by
          // `assertSufficientQuantity` above (a nonexistent instrument can
          // never have a `holding_state` row, so it always reads as "0
          // held"); a BUY has no equivalent check on this path, so it needs
          // this one explicitly. Checked here (inside the write transaction,
          // immediately before the `INSERT`) rather than earlier alongside
          // this method's other argument validation — deliberately *after*
          // FX resolution, so a valid BUY's FX leg is still resolved exactly
          // once before any DB round trip, matching every other
          // `record*`/`#recordTrade` validation's own "no DB touched until
          // here" shape (`transaction-write-service.test.ts`'s pure/no-DB
          // suite asserts exactly that boundary for the trade-date floor/
          // ceiling and instrument-backfill-omitted cases).
          await this.#assertInstrumentExists(tx, params.instrumentId);
        }
        // F1: rung 1 (the tenant advisory lock, which allocates `seq`),
        // then rung 2 (this portfolio's row), then the account check — see
        // `#beginTransactionCreate`.
        const seq = await this.#beginTransactionCreate(tx, params.portfolioId, refs);

        const [row] = await tx
          .insert(transaction)
          .values({
            id,
            tenantId: this.#tenantId,
            // AR-5 (ADR-0002): the fact states its own base. The 0055 fill
            // trigger would stamp the identical value; writing it here keeps
            // the service honest and the trigger a verifier.
            baseCurrency: this.#fx.baseCurrency,
            portfolioId: params.portfolioId,
            kind,
            tradeDate: params.tradeDate,
            tradeTs: params.tradeTs ?? null,
            seq,
            instrumentId: params.instrumentId,
            quantity: params.quantity,
            unitPrice: params.unitPrice,
            grossAmount: params.quantity.times(params.unitPrice),
            txnCurrency: params.txnCurrency,
            cashAccountId: params.cashAccountId,
            ...cashLeg,
            ...resolveCostLeg(kind, params.fee, cashLeg.cashCurrency),
            note: params.note ?? null,
            reference: params.reference ?? null,
            updatedBySessionId: params.updatedBySessionId ?? null,
            importFingerprint: params.importFingerprint ?? null,
            ...principalFxColumns(principal),
          })
          .returning();
        // The derived ledger, written inside this same DB transaction.
        await this.#writePostings(tx, row!);
        // Steps 2-4 (T-30): same DB transaction as the write above.
        await this.#invalidate(tx, row!.portfolioId, row!.tradeDate);
        return row!;
      }),
    );
    // T-35's deferred trigger (see this class's "Instrument backfill
    // trigger" doc-comment section) — after commit, never inside it.
    await this.#triggerInstrumentBackfill(params.instrumentId, params.tradeDate);
    return written;
  }

  async #recordCashMovement(
    kind: "DEPOSIT" | "WITHDRAWAL" | "FEE",
    params: RecordFeeParams,
  ): Promise<TransactionRecord> {
    assertNonEmpty(params.portfolioId, "portfolioId");
    this.#assertTradeDate(params.tradeDate);
    assertPositiveDecimal(params.amount, "amount");
    assertCurrency(params.currency, "currency");
    this.#assertCashAccountNamed(
      params.cashAccountId,
      "cashAccountId",
      `a ${kind} moves cash into or out of a named cash account`,
    );
    // FT-12: shape-checked here, with every other argument, before any FX
    // resolution or DB round trip. `#resolveCashLeg` below decides whether the
    // pair is *acceptable*; this decides whether it is well-formed.
    if (params.cashCurrency !== undefined) assertCurrency(params.cashCurrency, "cashCurrency");
    this.#assertPositiveIfPresent(params.cashAmount, "cashAmount");
    // `portfolio-cash` PC-L14: only a FEE may name an instrument, as a
    // reference. Read for no other kind, so a DEPOSIT/WITHDRAWAL reaching past
    // the types still writes NULL; checked like `recordDividend`'s (F2), and
    // never followed by a backfill trigger (PC-D3).
    const instrumentId = kind === "FEE" ? (params.instrumentId ?? null) : null;
    if (instrumentId !== null) await this.#assertInstrumentExists(this.#db, instrumentId);

    const principal = await this.#fx.resolve(
      "PRINCIPAL",
      params.currency,
      params.tradeDate,
      params.fxRateUserInput,
    );

    // FT-12 — see `recordDividend`'s identical call.
    const cashLeg = this.#resolveCashLeg({
      txnCurrency: params.currency,
      grossAmount: params.amount,
      cashCurrency: params.cashCurrency,
      cashAmount: params.cashAmount,
      principalRate: principal.rate,
    });

    const refs: CashAccountRef[] = [
      {
        field: "cashAccountId",
        constraint: TRANSACTION_CASH_ACCOUNT_FK,
        id: params.cashAccountId,
        currency: cashLeg.cashCurrency,
      },
    ];

    const id = params.id ?? randomUUID();
    return this.#guardPortfolioFk(params.portfolioId, refs, () =>
      this.#inTenantTx(async (tx) => {
        // F1: rung 1 (the tenant advisory lock, which allocates `seq`),
        // then rung 2 (this portfolio's row), then the account check — see
        // `#beginTransactionCreate`.
        const seq = await this.#beginTransactionCreate(tx, params.portfolioId, refs);

        const [row] = await tx
          .insert(transaction)
          .values({
            id,
            tenantId: this.#tenantId,
            // AR-5 (ADR-0002): the fact states its own base. The 0055 fill
            // trigger would stamp the identical value; writing it here keeps
            // the service honest and the trigger a verifier.
            baseCurrency: this.#fx.baseCurrency,
            portfolioId: params.portfolioId,
            kind,
            tradeDate: params.tradeDate,
            tradeTs: params.tradeTs ?? null,
            seq,
            // AC5, FR-8: no instrument leg. Spelled out rather than omitted so
            // the intent is legible next to the `transaction_deposit_
            // withdrawal_shape` CHECK that also enforces it. A FEE's optional
            // reference is the one exception (`transaction_fee_shape`).
            instrumentId,
            quantity: null,
            unitPrice: null,
            grossAmount: params.amount,
            txnCurrency: params.currency,
            cashAccountId: params.cashAccountId,
            ...cashLeg,
            note: params.note ?? null,
            reference: params.reference ?? null,
            updatedBySessionId: params.updatedBySessionId ?? null,
            importFingerprint: params.importFingerprint ?? null,
            ...principalFxColumns(principal),
          })
          .returning();
        // The derived ledger, written inside this same DB transaction.
        await this.#writePostings(tx, row!);
        // Steps 2-4 (T-30): same DB transaction as the write above.
        await this.#invalidate(tx, row!.portfolioId, row!.tradeDate);
        return row!;
      }),
    );
  }

  /**
   * An over-sell is a hard
   * validation error at write time, never a negative position.
   *
   * "Held" is read from the materialised `holding_state` row for
   * `(tenant, portfolio, instrument)` — the real table, not a stand-in
   * — with **no row meaning zero held**, so a sell of an instrument that was
   * never bought is rejected rather than waved through. The read happens
   * inside the caller's write transaction, so the check and the insert commit
   * or roll back together.
   *
   * **What completes this (T-24, T-30).** `holding_state` is materialised by
   * the PMP replay (T-24) and its invalidation/materialisation loop (T-30),
   * neither of which exists yet — until they land, the table is only ever
   * populated out of band, so this check is exact for a materialised position
   * and conservative (rejects) for one that has not been materialised yet. No
   * substitute for `holding_state` is computed here: doing so would create a
   * second, divergent definition of "quantity held" that T-24 would then have
   * to reconcile with its own. When T-24/T-30 land, this method becomes
   * end-to-end complete without changing shape — which is why it is a named,
   * separately callable member rather than an inline `if` inside the insert.
   */
  async assertSufficientQuantity(
    tx: Tx,
    portfolioId: string,
    instrumentId: string,
    quantity: Decimal,
  ): Promise<void> {
    // `holding_state` is the one materialised table a write reads, and
    // inside a write batch it is exactly as stale as the recomputes that
    // batch has deferred. Flush first, or a BUY and a later SELL of the
    // same instrument in one batch would read a position the BUY had not
    // reached and reject a valid sell as an over-sell. A file of BUYs,
    // deposits and dividends never reaches this line and pays nothing for it.
    //
    // Only **this** portfolio's deferred recompute. Its quantities come
    // from its own rows alone — a TRANSFER_IN stores its quantity; only the
    // carried *cost* depends on the source, and nothing here reads cost — so
    // another portfolio's pending recompute cannot move the figure checked
    // below. Flushing them all made every sell in a file interleaving two
    // portfolios replay both timelines (and propagate) for nothing. What stays
    // deferred is flushed at the end of the batch as before, and that flush's
    // propagation still re-costs any target this portfolio's recompute here
    // leaves stale.
    await this.#flushDeferredRecompute(tx, portfolioId);

    const [held] = await tx
      .select()
      .from(holdingState)
      .where(
        and(
          eq(holdingState.tenantId, this.#tenantId),
          eq(holdingState.portfolioId, portfolioId),
          eq(holdingState.instrumentId, instrumentId),
        ),
      );

    const heldQuantity = held?.quantity ?? new Decimal(0);
    if (quantity.greaterThan(heldQuantity)) {
      throw new InsufficientQuantityError(portfolioId, instrumentId, quantity, heldQuantity);
    }
  }

  /**
   * Regenerates `transaction_posting` for one transaction (Step 1) **inside the caller's DB transaction** — the `tx`
   * parameter is not a convenience, it is the point: the postings commit or
   * roll back with whatever write prompted them, so they cannot drift from
   * their parent.
   *
   * Wholesale delete + insert, never a patch: the old rows are removed and a
   * fresh expansion inserted, so an edit that changes the *number* of legs (a
   * fee added, a withholding removed) is handled by exactly the same code path
   * as one that changes an amount. New `id`s are minted for the new rows,
   * which is how a caller can tell a regeneration happened.
   *
   * This is the mechanism T-22's edit/delete service and T-30's invalidation
   * loop call after mutating a row; this is the mechanism, not that public
   * edit API. Deletion needs no call at all —
   * `transaction_posting.transaction_id` is `ON DELETE CASCADE`.
   *
   * **Lock order is the caller's here, uniquely in this class** (F1).
   * This method takes `tx` rather than opening one, and its `INSERT` reaches
   * rung 4 (`transaction_posting`'s `cash_account` reference) and rung 2 (the
   * portfolio FK) through RI checks alone, so a caller that already holds
   * `transaction` rows must have taken the `portfolio` row first — see
   * `portfolio-lock.ts`. Every in-repo caller is a test that holds nothing;
   * the internal `#writePostings` call sites are all inside methods that have
   * already taken rung 2 through `#beginTransactionCreate`/`#lockPortfolio`.
   */
  async regeneratePostings(tx: Tx, transactionId: string): Promise<TransactionPostingRecord[]> {
    const [row] = await tx
      .select()
      .from(transaction)
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, transactionId)));
    if (!row) throw new TransactionNotFoundError(transactionId);
    return this.#writePostings(tx, row);
  }

  /**
   * NEW-3 (final narrow remediation review, T-38): the
   * `quantity`/`unitPrice`/`grossAmount` consistency layer for
   * {@link TransactionWriteService.editTransaction} — see {@link
   * TransactionGrossAmountNotEditableError}'s doc comment for the
   * fiat-priced invariant and {@link TransactionUnitPriceNotEditableError}'s
   * for the settlement-priced one this method also enforces (A, final
   * narrow fix round, feature/api-transactions). A no-op (returns `changes`
   * unchanged) unless the edit touches at least one of the three columns, so
   * an edit of, say, `note` alone costs no extra query.
   *
   * Reads the row's *current* `quantity`/`unitPrice`/`grossAmount`/
   * `txnSettlementInstrumentId` inside the caller's own `tx` (the same
   * transaction the edit itself runs in, after its own
   * `TransactionNotFoundError` check has already proven the row exists) —
   * never the JSONB `to_jsonb` snapshot `editTransaction` also takes for the
   * audit trail, which round-trips a `numeric` column through a bare JSON
   * number and cannot be trusted for a value this method recomputes from
   * (NFR-12).
   *
   * **B (final narrow fix round, feature/api-transactions): `.for("update")`
   * locks the row for the remainder of this DB transaction** — the same
   * `FOR UPDATE` pattern `valuation/src/materialize.ts`'s own race-free
   * re-check uses. Without it, two concurrent `PATCH`es against the same row
   * both read the same pre-edit `quantity`/`unitPrice`/`grossAmount` under
   * READ COMMITTED and could each compute a merge consistent with a
   * `gross_amount`/`unit_price` pair that never actually existed together
   * (e.g. one edit's `quantity` change and the other's `unitPrice` change,
   * each recomputing the derived column from the *other* edit's stale
   * pre-image), landing `gross_amount != quantity x unit_price` (or the
   * settlement-priced mirror image) on commit. Serialising the second
   * `PATCH` behind the first's commit here is a short wait, not a spurious
   * error — the second edit's merge then sees the first edit's already
   * up-to-date row.
   *
   * **MEDIUM-1 (security review): `row` is no
   * longer guaranteed to exist.** Before `deletePortfolio`
   * (`portfolio-service.ts`) existed, `editTransaction`'s own preceding
   * `TransactionNotFoundError` check (on the same id/tenant, inside this same
   * transaction) really was a guarantee — nothing else could remove a
   * `transaction` row out from under an in-flight edit. A concurrent
   * `deletePortfolio` cascade now can: it takes no lock this method's own
   * `.for("update")` read would already be holding, so it can win the row
   * lock, delete the row (and its portfolio), and commit in the gap between
   * `editTransaction`'s plain (non-locking) `#snapshot` and this method's own
   * `.for("update")` read. `row!.quantity` on an empty result was a bare,
   * unmapped `TypeError` (a 500) — checked explicitly below instead, so this
   * degrades to the same clean `TransactionNotFoundError` `editTransaction`'s
   * own pre-check would have thrown had the race landed microseconds
   * earlier.
   *
   * **F1 has since made that window unreachable, and the check stays.**
   * `editTransaction` now takes the `portfolio` row `FOR UPDATE` before calling
   * this method, and `deletePortfolio` takes that same row before it deletes
   * any `transaction` row, so the cascade can no longer commit between
   * `#snapshot` and this read — it is either already committed (and
   * `editTransaction`'s own rung-2 check raises `TransactionNotFoundError`
   * before this method is reached) or blocked behind this whole transaction.
   * The guard below is kept as defence in depth for the same reason
   * `PortfolioVanishedDuringRecomputeError` is kept: a future caller that
   * forgets rung 2 must get a named error here, not a `TypeError`. The same
   * note applies verbatim to {@link
   * TransactionWriteService.#assertNotSelfSettled}, {@link
   * TransactionWriteService.#reconcileCashAccounts}, and the zero-row checks on
   * `editTransaction`/`deleteTransaction`/`correctFxRate`'s own final
   * statements.
   */
  async #reconcileGrossAmount(
    tx: Tx,
    id: string,
    changes: TransactionEdit,
  ): Promise<TransactionEdit> {
    if (
      changes.quantity === undefined &&
      changes.unitPrice === undefined &&
      changes.grossAmount === undefined
    ) {
      return changes;
    }
    const [row] = await tx
      .select({
        quantity: transaction.quantity,
        unitPrice: transaction.unitPrice,
        grossAmount: transaction.grossAmount,
        txnSettlementInstrumentId: transaction.txnSettlementInstrumentId,
      })
      .from(transaction)
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, id)))
      .for("update");
    // MEDIUM-1: a concurrent `deletePortfolio` cascade may have removed this
    // row between `editTransaction`'s own snapshot and this `.for("update")`
    // read — see this method's own doc comment above. Never dereference
    // `row!` for that case.
    if (!row) throw new TransactionNotFoundError(id);
    const mergedQuantity = changes.quantity !== undefined ? changes.quantity : row.quantity;
    const mergedUnitPrice = changes.unitPrice !== undefined ? changes.unitPrice : row.unitPrice;
    if (mergedQuantity === null || mergedUnitPrice === null) {
      // Not a quantity-priced kind (DEPOSIT/WITHDRAWAL/DIVIDEND/
      // CURRENCY_EXCHANGE never carry both) — `grossAmount` stays a plain,
      // independently editable column.
      return changes;
    }

    // A (final narrow fix round, feature/api-transactions): a
    // settlement-priced BUY (FR-66/AC52) inverts which of
    // `grossAmount`/`unitPrice` is authoritative — routed on
    // `txnSettlementInstrumentId` (non-NULL identifies the shape), not on
    // `kind` alone, since a settlement-priced trade is still `kind = 'BUY'`.
    // `txnSettlementInstrumentId` itself is not reachable over HTTP
    // (`GUARDED_FX_EDIT_FIELDS`), but a caller constructing a
    // `TransactionEdit` directly could still change it, so the *merged*
    // value is used here too, exactly like `mergedQuantity`/`mergedUnitPrice`
    // above.
    const mergedSettlementInstrumentId =
      changes.txnSettlementInstrumentId !== undefined
        ? changes.txnSettlementInstrumentId
        : row.txnSettlementInstrumentId;
    if (mergedSettlementInstrumentId !== null) {
      if (changes.unitPrice !== undefined) {
        throw new TransactionUnitPriceNotEditableError(id);
      }
      // `grossAmount` is the authoritative settlement-asset amount actually
      // disposed here (never derived), so a caller-supplied value for it is
      // accepted verbatim, exactly as it always was before NEW-3 introduced
      // this method. `unitPrice` is derived from it, mirroring
      // `recordSettledBuy`'s own `amount / quantity` division exactly (same
      // operands, same rounding at `unit_price`'s 18 dp column).
      const mergedGrossAmount =
        changes.grossAmount !== undefined ? changes.grossAmount : row.grossAmount;
      return { ...changes, unitPrice: mergedGrossAmount.dividedBy(mergedQuantity) };
    }

    if (changes.grossAmount !== undefined) {
      throw new TransactionGrossAmountNotEditableError(id);
    }
    return { ...changes, grossAmount: mergedQuantity.times(mergedUnitPrice) };
  }

  /**
   * **FT-13 / FR-254 / L16** — the edit path's half of
   * {@link TransactionWriteService.#resolveCashLeg}, on **merged** values
   * (the four-shape table). Replaces
   * Batch A's `#mirrorDegenerateCashLeg`, whose degenerate mirror is this
   * method's first row.
   *
   * **The hazard this exists for (P19).** `editTransaction` recomputes
   * `gross_amount` from the merged `quantity × unit_price`
   * ({@link TransactionWriteService.#reconcileGrossAmount}), so editing a
   * *quantity alone* moves it. Left alone the row would keep a settled amount
   * computed against a superseded gross. In D1/D2 that is a `23514` from
   * `transaction_cash_degenerate_equals_gross`; in D3/D4/D5 **no constraint
   * fires at all** and the row silently claims a cash movement that
   * corresponds to nothing — FR-254's "a wrong cash balance with no failing
   * constraint". That asymmetry is why this method exists.
   *
   * {@link TransactionWriteService.#reconcileGrossAmount}'s shape,
   * deliberately, so a reviewer compares two adjacent methods: the same
   * `.for("update")` read, the same merged-value discipline, the same
   * `if (!row) throw new TransactionNotFoundError(id)` (MEDIUM-1's standing
   * rule; never `row!`), and the same early return with **no query** when the
   * edit touches nothing this method reconciles.
   *
   * The four merged shapes, in order:
   *
   * | merged shape | action |
   * |---|---|
   * | `cash_currency` = `txn_currency` (D1/D2) | **recompute** `cash_amount := merged gross_amount`, never trusting a supplied one — which makes `transaction_cash_degenerate_equals_gross` true by construction |
   * | `cash_currency` = `fx.baseCurrency` (D4) | **recompute** `cash_amount := merged gross_amount × stored fx_rate`, the same rule as create. The rate is immutable on this path (`trg_transaction_fx_immutable`), so the stored one is the right one to read |
   * | otherwise (D3/D5) **and** `gross_amount` moved | the settled amount is an independent broker fact with no formula to recompute it from, so it must be supplied in the same request — else {@link CashAmountStaleError} (**L16(a)**, locked 2026-08-27) |
   * | otherwise (D3/D5), nothing that moves money changed | no-op: every settlement figure and every posting stays byte-identical |
   *
   * **The trigger set is `txnCurrency`-inclusive, and that is one field wider
   * than the shape list.** That list enumerates `quantity`, `unitPrice`,
   * `grossAmount`, `cashAccountId`, `cashCurrency` and `cashAmount`; FR-254
   * names `txn_currency` explicitly ("an edit that moves `gross_amount`,
   * `txn_currency`, or the cash account"), and Batch A's
   * `#mirrorDegenerateCashLeg` keyed off it. Dropping it would silently
   * regress a direct-service `txnCurrency` edit from "re-mirrored" to
   * "left stale", so the wider set is kept. `txnCurrency` is unreachable over
   * HTTP (`GUARDED_FX_EDIT_FIELDS`); the note-only early return, which is what
   * the zero-additional-statements criterion measures, is unaffected.
   */
  async #reconcileCashLeg(tx: Tx, id: string, changes: TransactionEdit): Promise<TransactionEdit> {
    if (
      changes.quantity === undefined &&
      changes.unitPrice === undefined &&
      changes.grossAmount === undefined &&
      changes.txnCurrency === undefined &&
      changes.cashAccountId === undefined &&
      changes.cashCurrency === undefined &&
      changes.cashAmount === undefined
    ) {
      return changes;
    }
    const [row] = await tx
      .select({
        txnCurrency: transaction.txnCurrency,
        grossAmount: transaction.grossAmount,
        cashCurrency: transaction.cashCurrency,
        // The stored settled amount, needed to bound the implied
        // rate on the fall-through below — where the gross did not move and no
        // new figure was supplied, so the *stored* one is what will be expanded.
        cashAmount: transaction.cashAmount,
        fxRate: transaction.fxRate,
        txnSettlementInstrumentId: transaction.txnSettlementInstrumentId,
      })
      .from(transaction)
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, id)))
      .for("update");
    // MEDIUM-1: a concurrent `deletePortfolio` cascade may have removed this
    // row between `editTransaction`'s own snapshot and this `.for("update")`
    // read — never dereference `row!`.
    if (!row) throw new TransactionNotFoundError(id);

    const mergedSettlementInstrumentId =
      changes.txnSettlementInstrumentId !== undefined
        ? changes.txnSettlementInstrumentId
        : row.txnSettlementInstrumentId;
    const mergedTxnCurrency =
      changes.txnCurrency !== undefined ? changes.txnCurrency : row.txnCurrency;
    // FR-236 / the XOR rule: an asset-settled principal leg moves no cash and so
    // carries no denomination — `transaction_settled_principal_has_no_cash_leg`
    // requires both columns to stay NULL, exactly as `recordSettledBuy` writes
    // them. Routed on the merged settlement instrument, not on `kind`, for the
    // reason `#reconcileGrossAmount` gives above.
    if (mergedSettlementInstrumentId !== null || mergedTxnCurrency === null) {
      return changes;
    }
    const mergedCashCurrency =
      changes.cashCurrency !== undefined ? changes.cashCurrency : row.cashCurrency;
    // Only reachable by a caller clearing `cash_currency` on a fiat row —
    // `transaction_fiat_principal_has_cash_currency` (`0046`) refuses exactly
    // that, and `editTransactionBodySchema` cannot express it. Left to the
    // CHECK rather than given a fourth error of its own: there is no shape
    // here to reconcile.
    if (mergedCashCurrency === null) return changes;

    const mergedGrossAmount =
      changes.grossAmount !== undefined ? changes.grossAmount : row.grossAmount;

    // Trimmed on both sides, as `posting-expander.ts` and
    // `#assertCashAccountsUsable` already trim: `char(3)` on one side, a
    // caller-supplied string on the other, and a mis-compare here would route
    // a degenerate row down the D3/D5 path and reject an edit it should have
    // recomputed.
    if (mergedCashCurrency.trim() === mergedTxnCurrency.trim()) {
      // D1/D2 — recomputed, never taken from `changes`.
      return { ...changes, cashCurrency: mergedCashCurrency, cashAmount: mergedGrossAmount };
    }
    if (mergedCashCurrency.trim() === this.#fx.baseCurrency.trim()) {
      // D4 (L11) — the settled amount *is* the row's base value, and both
      // factors are on the row.
      return {
        ...changes,
        cashCurrency: mergedCashCurrency,
        cashAmount: mergedGrossAmount.times(row.fxRate),
      };
    }
    // D3/D5. A settled amount supplied in this same request is authoritative
    // and is passed through untouched.
    if (changes.cashAmount !== undefined && changes.cashAmount !== null) {
      // On the merged pair: the supplied figure against the
      // merged gross and the row's own rate, which `trg_transaction_fx_immutable`
      // pins for the life of this path.
      assertImpliedSettlementRateRepresentable({
        field: "cashAmount",
        grossAmount: mergedGrossAmount,
        fxRate: row.fxRate,
        cashAmount: changes.cashAmount,
        cashCurrency: mergedCashCurrency,
      });
      return changes;
    }
    // **L16(c) — the fifth merged shape: the settlement currency moved**
    // (FR-254's third trigger).
    //
    // Checked *before* the gross, because it is the worse case and the more
    // specific one: when the gross moves, the stored amount is out of date and
    // reads as such; when the settlement currency moves, the stored digits are
    // silently reinterpreted in the new currency and every constraint still
    // passes. `transaction_cash_amount_positive` sees a positive number,
    // `transaction_cash_degenerate_equals_gross` no longer applies, and the
    // composite FK is satisfied by the new account — so nothing downstream
    // catches it, and the re-expanded posting debits the right digits in the
    // wrong unit.
    //
    // `row.cashCurrency` can be NULL only for an asset-settled principal,
    // which returned above, so a NULL here is not a currency *change* — it is
    // a leg being added, which `#reconcileCashAccounts` owns.
    if (row.cashCurrency !== null && mergedCashCurrency.trim() !== row.cashCurrency.trim()) {
      throw new CashAmountStaleError(
        id,
        "cashAmount",
        mergedCashCurrency.trim(),
        "SETTLEMENT_CURRENCY_CHANGED",
        `this edit moves the settling currency from ${row.cashCurrency.trim()} to ${mergedCashCurrency.trim()}, so the stored settled amount is a ${row.cashCurrency.trim()} figure that would otherwise be committed as though it were ${mergedCashCurrency.trim()}`,
      );
    }
    // L16(a): the gross moved and the request carried no new figure. Rejected
    // *before* the `UPDATE`, naming the field — never guessed, never committed
    // stale. An edit that moved nothing (a note, a date) falls through and is
    // a no-op, which is the fourth shape.
    if (!mergedGrossAmount.equals(row.grossAmount)) {
      throw new CashAmountStaleError(
        id,
        "cashAmount",
        mergedCashCurrency.trim(),
        "GROSS_MOVED",
        `this edit moves gross_amount from ${row.grossAmount.toString()} to ${mergedGrossAmount.toString()}, so the stored settled amount now describes a gross that no longer exists`,
      );
    }
    // Defence in depth. Reaching here means the gross did not
    // move, so the stored pair is the one that will be re-expanded — and it was
    // already bounded when it was written. It is re-checked all the same: an
    // out-of-band writer can put a row past this bound (the database accepts
    // it; that is the whole finding), and an edit is the next thing that would
    // re-expand it into a `22003` nobody could read.
    if (row.cashAmount !== null) {
      assertImpliedSettlementRateRepresentable({
        field: "cashAmount",
        grossAmount: mergedGrossAmount,
        fxRate: row.fxRate,
        cashAmount: row.cashAmount,
        cashCurrency: mergedCashCurrency,
      });
    }
    return changes;
  }

  /**
   * C (final narrow fix round, feature/api-transactions): the
   * `instrumentId`/`txnSettlementInstrumentId` self-settlement guard for
   * {@link TransactionWriteService.editTransaction} — see {@link
   * TransactionSelfSettledError}'s doc comment for the full invariant. A
   * no-op unless the edit touches at least one of the two columns, so an
   * edit of, say, `quantity` alone costs no extra query.
   *
   * `.for("update")` for the same reason {@link
   * TransactionWriteService.#reconcileGrossAmount} locks its own read (B,
   * final narrow fix round) — a concurrent edit racing to change the *other*
   * half of this pair must not slip past this check under READ COMMITTED.
   *
   * **MEDIUM-1 (security review):** `row` is no
   * longer guaranteed to exist — see {@link
   * TransactionWriteService.#reconcileGrossAmount}'s identical doc-comment
   * note. A concurrent `deletePortfolio` cascade can remove this row (and its
   * portfolio) between `editTransaction`'s own snapshot and this method's own
   * `.for("update")` read, since neither takes a lock on it beforehand.
   */
  async #assertNotSelfSettled(tx: Tx, id: string, changes: TransactionEdit): Promise<void> {
    if (changes.instrumentId === undefined && changes.txnSettlementInstrumentId === undefined) {
      return;
    }
    const [row] = await tx
      .select({
        instrumentId: transaction.instrumentId,
        txnSettlementInstrumentId: transaction.txnSettlementInstrumentId,
      })
      .from(transaction)
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, id)))
      .for("update");
    // MEDIUM-1: never dereference `row!` — see this method's own doc comment.
    if (!row) throw new TransactionNotFoundError(id);
    const mergedInstrumentId =
      changes.instrumentId !== undefined ? changes.instrumentId : row.instrumentId;
    const mergedSettlementInstrumentId =
      changes.txnSettlementInstrumentId !== undefined
        ? changes.txnSettlementInstrumentId
        : row.txnSettlementInstrumentId;
    if (
      mergedInstrumentId !== null &&
      mergedSettlementInstrumentId !== null &&
      mergedInstrumentId === mergedSettlementInstrumentId
    ) {
      throw new TransactionSelfSettledError(id, mergedInstrumentId);
    }
  }

  /**
   * The edit path's half of the withholding rules (`cash-interest` C-5,
   * extended to DIVIDEND). Runs after {@link
   * TransactionWriteService.#reconcileCashAccounts}, so `changes` already
   * carries the `cashAmount` `#reconcileCashLeg` may have mirrored from an
   * edited `grossAmount`.
   *
   * 1. A withholding is carried only by a DIVIDEND or an INTEREST. Since
   *    `0079` it is a bare amount, so it *can* be added through an edit — on
   *    those two kinds only (nothing in the database keeps it off the others).
   * 2. On those kinds, the **merged** withholding stays strictly below the
   *    **merged** principal cash amount — both in the settling account's
   *    currency, so a plain comparison (`transaction_interest_shape`
   *    backstops it for INTEREST).
   *
   * @throws {TransactionArgumentError} naming `withholdingAmount` (→ 400
   * `TRANSACTION_ARGUMENT_INVALID`).
   */
  async #assertWithholdingBelowPrincipal(
    tx: Tx,
    id: string,
    changes: TransactionEdit,
  ): Promise<void> {
    if (
      changes.withholdingAmount === undefined &&
      changes.cashAmount === undefined &&
      changes.grossAmount === undefined
    ) {
      return;
    }

    const [row] = await tx
      .select({
        kind: transaction.kind,
        cashAmount: transaction.cashAmount,
        withholdingAmount: transaction.withholdingAmount,
      })
      .from(transaction)
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, id)))
      .for("update");
    // MEDIUM-1: never dereference `row!` — see `#reconcileGrossAmount`.
    if (!row) throw new TransactionNotFoundError(id);

    const withholding =
      changes.withholdingAmount !== undefined ? changes.withholdingAmount : row.withholdingAmount;
    // No withholding left (`withholdingAmount: null` removes it).
    if (withholding === null) return;
    if (row.kind !== "DIVIDEND" && row.kind !== "INTEREST") {
      throw new TransactionArgumentError(
        `withholdingAmount is carried only by a DIVIDEND or an INTEREST, and transaction ${id} is a ${row.kind}`,
      );
    }
    const cashAmount = changes.cashAmount !== undefined ? changes.cashAmount : row.cashAmount;
    // Unreachable for these two kinds (their principal always moves cash), and
    // left to the shape CHECKs rather than guessed at here.
    if (cashAmount === null) return;
    assertWithholdingBelowPrincipal(withholding, cashAmount, "withholdingAmount");
  }

  /**
   * **The 8th kind's shape, enforced on the edit path** — see
   * {@link TransactionShareDistributionShapeError} for what was reaching the
   * database before this existed and why the check cannot live in
   * `editTransactionBodySchema`.
   *
   * The rules are `createTransactionBodySchema`'s own `SHARE_DISTRIBUTION`
   * block and `transaction_share_distribution_shape`, mirrored rather than
   * re-invented: the forbidden set below is exactly the CHECK's `IS NULL`
   * conjuncts and the required set exactly its `IS NOT NULL` ones — plus the
   * five cost components, which the CHECK does not name because
   * `transaction_cost_components_sum_to_fee_amount` already forbids them
   * transitively (a component requires a total, and a total is forbidden
   * here). Naming them explicitly turns that two-constraint deduction into one
   * message that says which field was the problem.
   *
   * **Runs before {@link TransactionWriteService.#reconcileGrossAmount}**, and
   * that order is load-bearing twice over. A `unitPrice` on a distribution
   * would otherwise be *merged into a recomputed `grossAmount`* first, so the
   * refusal would arrive with a second, silently rewritten column attached to
   * it; and a `cashAccountId` would reach `#reconcileCashAccounts`, whose
   * merged-currency logic answers `CashAccountNotAllowedError` (400,
   * "carries no cashCurrency leg for that account to belong to") — true, but a
   * description of a symptom rather than of the kind.
   *
   * A no-op with **no query at all** unless the edit touches a column the
   * kind's shape constrains: an edit of `note`, `reference` or `tradeTs` alone
   * costs nothing, which is the property `transaction-cash-leg-statement-count`
   * measures for the sibling reconcilers. The `kind` cannot be known without a
   * read, so the cheap test has to be on the *edited fields* rather than on the
   * row — every other kind then pays one extra `SELECT` for an edit that names
   * one of these columns, which is the same price `#reconcileGrossAmount`
   * already charges for touching `quantity`.
   *
   * `.for("update")` and the `if (!row)` guard for the reasons {@link
   * TransactionWriteService.#reconcileGrossAmount}'s doc comment gives (B and
   * MEDIUM-1) — never `row!`.
   */
  async #assertShareDistributionShape(tx: Tx, id: string, changes: TransactionEdit): Promise<void> {
    const { forbidden, required } = SHARE_DISTRIBUTION_SHAPE_EDIT_COVERAGE;

    const touchesShape =
      forbidden.some((field) => changes[field] !== undefined) ||
      required.some((field) => changes[field] !== undefined);
    if (!touchesShape) return;

    const [row] = await tx
      .select({
        kind: transaction.kind,
        instrumentId: transaction.instrumentId,
        quantity: transaction.quantity,
        // Read because `txn_currency` is one of the CHECK's NOT NULL
        // conjuncts and is therefore in `required`; the merged-value check
        // below needs the stored value when the edit does not name it.
        txnCurrency: transaction.txnCurrency,
      })
      .from(transaction)
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, id)))
      .for("update");
    // MEDIUM-1: never dereference `row!` — see `#reconcileGrossAmount`.
    if (!row) throw new TransactionNotFoundError(id);
    // Every other kind leaves this method here: their own shape CHECKs, the
    // reconcilers below and `editTransactionBodySchema` are unchanged here.
    if (row.kind !== "SHARE_DISTRIBUTION") return;

    for (const field of forbidden) {
      // `null` is the value the row already holds and the only one the CHECK
      // allows, so clearing an absent leg is a no-op success rather than a
      // rejection — the same tolerance every `forbid(...)` on the create side
      // has for an omitted key.
      if (changes[field] !== undefined && changes[field] !== null) {
        throw new TransactionShareDistributionShapeError(id, field, "FORBIDDEN");
      }
    }
    for (const field of required) {
      const merged = changes[field] !== undefined ? changes[field] : row[field];
      if (merged === null) {
        throw new TransactionShareDistributionShapeError(id, field, "REQUIRED");
      }
    }
  }

  /**
   * **The two transfer kinds' edit rules** (`security-transfer`;
   * OD-6 (a), ND-3 (a), ND-4 (a), ND-5 (b), F-8), run before the reconcilers
   * for the reason {@link TransactionWriteService.#assertShareDistributionShape}
   * gives.
   *
   * | row | accepted | otherwise |
   * |---|---|---|
   * | `TRANSFER_OUT`, linked or not | `quantity`, `grossAmount`, `note`, `reference`, `tradeTs` | {@link TransactionTransferShapeError} |
   * | `TRANSFER_IN`, linked | `note`, `reference` | {@link TransferTargetReadOnlyError}, naming the source's portfolio |
   * | `TRANSFER_IN`, severed | the `TRANSFER_OUT` set — never the carried cost | {@link TransactionTransferShapeError} |
   * | any other kind | everything it accepted before | a `transfer_*` column → {@link TransactionTransferShapeError} |
   *
   * Decided from `before`, the row's snapshot. For a transfer row that
   * snapshot was taken under rung 1 (`editTransaction`), so "linked" cannot
   * change underneath it. **No query** unless a linked target's edit is being
   * refused — the one case that must name another row's portfolio — so an
   * edit of `note` alone costs every kind exactly what it did before.
   *
   * `portfolioId` is skipped: a differing one was already refused as a move
   * (`TransactionPortfolioNotEditableError`), and re-submitting the stored one
   * is the no-op it is for every kind.
   */
  async #assertTransferShape(
    tx: Tx,
    id: string,
    before: Record<string, unknown>,
    changes: TransactionEdit,
  ): Promise<void> {
    // `Object.entries` over the runtime object, not the type: this method is
    // the refusal for a caller that reaches past `TransactionEdit`.
    const named = Object.entries(changes)
      .filter(([field, value]) => value !== undefined && field !== "portfolioId")
      .map(([field]) => field);
    const kind = before["kind"];

    if (!isTransferKind(kind)) {
      const transferColumn = named.find((field) =>
        (TRANSFER_COLUMNS as readonly string[]).includes(field),
      );
      if (transferColumn !== undefined) {
        throw new TransactionTransferShapeError(id, transferColumn, "FORBIDDEN");
      }
      return;
    }

    const sourceId = before["transfer_source_id"];
    if (kind === "TRANSFER_IN" && typeof sourceId === "string") {
      const refused = named.find((field) => !LINKED_TARGET_EDITABLE.has(field));
      if (refused === undefined) return;
      const [source] = await tx
        .select({ portfolioId: transaction.portfolioId })
        .from(transaction)
        .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, sourceId)));
      // The link is a `NO ACTION` FK, so the source exists while it is set.
      if (!source) throw new TransactionNotFoundError(sourceId);
      throw new TransferTargetReadOnlyError(id, refused, source.portfolioId);
    }

    const refused = named.find((field) => !TRANSFER_EDITABLE.has(field));
    if (refused !== undefined) {
      throw new TransactionTransferShapeError(id, refused, "FORBIDDEN");
    }
    if (changes.quantity === null) {
      throw new TransactionTransferShapeError(id, "quantity", "REQUIRED");
    }
  }

  /**
   * A linked source leg's edit, carried across to its target in the same DB
   * transaction (`security-transfer`, FR-578): the target takes the
   * source's merged `quantity`, `gross_amount` and `trade_ts`, its postings are
   * regenerated, its portfolio invalidated, and a revision is appended with the
   * same `changedBy`. A no-op, with no query, unless the edit named one of the
   * mirrored fields; a no-op after one read for a source with no target
   * (FR-566, or severed).
   *
   * **The carried cost is not written here.** A quantity change moves the
   * amount the source leg removes, and so the target's `transfer_cost_*`; that
   * value has exactly one writer, the cross-portfolio propagation that
   * recomputes it from the source replay (TR-10).
   *
   * The caller holds rung 1 and the source's portfolio row; the target's
   * portfolio row is taken here, second — safe because every writer that can
   * hold two portfolio rows holds rung 1 first.
   */
  async #mirrorOntoLinkedTarget(
    tx: Tx,
    source: TransactionRecord,
    changes: TransactionEdit,
    changedBy: string,
  ): Promise<void> {
    if (!TRANSFER_MIRRORED.some((field) => changes[field] !== undefined)) return;
    const [target] = await tx
      .select({ id: transaction.id, portfolioId: transaction.portfolioId })
      .from(transaction)
      .where(
        and(eq(transaction.tenantId, this.#tenantId), eq(transaction.transferSourceId, source.id)),
      );
    if (!target) return;
    if (!(await this.#lockPortfolio(tx, target.portfolioId))) {
      throw new TransactionNotFoundError(target.id);
    }
    const targetBefore = await this.#snapshot(tx, target.id);
    const [mirrored] = await tx
      .update(transaction)
      .set({
        quantity: source.quantity,
        grossAmount: source.grossAmount,
        tradeTs: source.tradeTs,
        updatedAt: sql`now()`,
      })
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, target.id)))
      .returning();
    if (!mirrored) throw new TransactionNotFoundError(target.id);
    await this.#writePostings(tx, mirrored);
    const targetAfter = await this.#snapshot(tx, target.id);
    await this.#appendRevision(
      tx,
      target.id,
      "UPDATE",
      targetBefore ?? null,
      targetAfter ?? null,
      changedBy,
    );
    await this.#invalidate(tx, mirrored.portfolioId, mirrored.tradeDate);
  }

  /**
   * CA-10: the cash-account
   * layer of {@link TransactionWriteService.editTransaction}, mirroring
   * {@link TransactionWriteService.#reconcileGrossAmount}'s exact shape — the
   * same `.for("update")` read, the same merged-value discipline, the same
   * `if (!row) throw new TransactionNotFoundError(id)` (MEDIUM-1's standing
   * rule). A no-op (returns `changes` unchanged, no query) unless the edit
   * touches an account column or one of the two clearable leg amounts.
   *
   * Four things happen here, in order, and each one exists because the
   * database would otherwise refuse the `UPDATE` with a bare `23514`/`23503`:
   *
   * 1. **FR-157 on edit.** Naming a principal account on a row whose *merged*
   *    `txnSettlementInstrumentId` is non-`NULL` is rejected
   *    ({@link CashAccountNotAllowedError}, reason `ASSET_SETTLED_PRINCIPAL`)
   *    — `transaction_settled_principal_has_no_cash_account`'s application
   *    twin. (An alternative would hang this off `#assertNotSelfSettled`'s
   *    existing locked read "rather than adding a second one"; it lives here
   *    instead because this method must read the row anyway for the merged
   *    currencies, so doing it here costs **zero** extra reads while widening
   *    `#assertNotSelfSettled`'s early-return would cost one. Same rule, same
   *    lock, strictly fewer statements.)
   *
   * 2. **RC3, the single most likely bug in this cycle.** Clearing `feeAmount`
   *    to `null` clears the *whole* leg — `feeCurrency` **and**
   *    `feeCashAccountId` — in the same `UPDATE`. Not just the account:
   *    `0038`'s `transaction_fee_amount_currency_pairing` is
   *    `(fee_amount IS NULL) = (fee_currency IS NULL)`, so clearing the amount
   *    alone is itself a `23514`. (only the account half was specified;
   *    the currency half is required by the constraint A1 actually shipped.)
   *    (A withholding has no currency or account of its own since 0079.)
   *
   * 3. **A leg is added only where the shape carries one.** A
   *    `feeAmount` on a fee-less BUY/SELL/DRIP/CURRENCY_EXCHANGE that settles in
   *    cash adds the cost leg. On any other row (a kind with no cost leg, an
   *    asset-settled row, no cash currency) it is refused with
   *    {@link TransactionCashLegNotAddableError} — see that class's doc
   *    comment for the list and the error-contract history.
   *
   * 4. **Merged totality and pairing**, per leg: a leg whose currency is
   *    present must name an account ({@link CashAccountRequiredError} —
   *    `0039`'s totality CHECKs); a leg whose currency is absent must not
   *    ({@link CashAccountNotAllowedError}, reason `LEG_ABSENT` — `0038`'s
   *    pairing CHECKs). The currency is always read **from the stored row**,
   *    never assumed to be carried by the change: no currency column is
   *    editable at all (`GUARDED_FX_EDIT_FIELDS`), which is exactly why the
   *    merged value is the stored one.
   *
   * Only accounts whose value actually **changes** are handed to
   * {@link TransactionWriteService.#assertCashAccountsUsable} — merge, then
   * compare. Re-submitting the account a row already carries is a no-op
   * success even when that account is archived, or a user who archived an old
   * account could never again edit the note on a transaction attributed to it
   * (the "Not archived" row).
   *
   * Returns the changes to apply **and** the refs the caller must hand to
   * {@link TransactionWriteService.#guardPortfolioFk}, so the edit's `UPDATE`
   * gets the same FK backstop a create's `INSERT` has.
   */
  async #reconcileCashAccounts(
    tx: Tx,
    id: string,
    changes: TransactionEdit,
  ): Promise<{ changes: TransactionEdit; refs: readonly CashAccountRef[] }> {
    // `cashCurrency`/`cashAmount` are in this set because `cash_currency` is
    // half of `transaction_cash_account_fk`. Editing it alone
    // used to skip this method entirely, so the pairing was never checked and
    // the `UPDATE` handed the database a `cash_currency` its unchanged
    // `cash_account_id` could not satisfy — a `23503` that no branch of
    // `#guardPortfolioFk` matched (it was given `refs: []`), that
    // `mapTransactionWriteError` has no case for, and that
    // `CLIENT_CAUSED_FK_CONSTRAINTS` does not list: a raw 500 for what is
    // plainly a rejected input.
    if (
      changes.cashAccountId === undefined &&
      changes.targetCashAccountId === undefined &&
      changes.cashCurrency === undefined &&
      changes.cashAmount === undefined &&
      changes.feeAmount === undefined
    ) {
      return { changes, refs: [] };
    }

    const [row] = await tx
      .select({
        kind: transaction.kind,
        portfolioId: transaction.portfolioId,
        cashCurrency: transaction.cashCurrency,
        targetCurrency: transaction.targetCurrency,
        // The cost leg's presence test reads the **amount** —
        // there is no `fee_currency` left to read (`0049`).
        feeAmount: transaction.feeAmount,
        cashAccountId: transaction.cashAccountId,
        targetCashAccountId: transaction.targetCashAccountId,
        txnSettlementInstrumentId: transaction.txnSettlementInstrumentId,
      })
      .from(transaction)
      .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, id)))
      .for("update");
    // MEDIUM-1: a concurrent `deletePortfolio` cascade may have removed this
    // row between `editTransaction`'s own snapshot and this `.for("update")`
    // read — never dereference `row!`.
    if (!row) throw new TransactionNotFoundError(id);

    const next: TransactionEdit = { ...changes };

    // (1) FR-157 on edit.
    const mergedSettlementInstrumentId =
      changes.txnSettlementInstrumentId !== undefined
        ? changes.txnSettlementInstrumentId
        : row.txnSettlementInstrumentId;
    if (
      mergedSettlementInstrumentId !== null &&
      changes.cashAccountId !== undefined &&
      changes.cashAccountId !== null
    ) {
      throw new CashAccountNotAllowedError(
        "cashAccountId",
        "ASSET_SETTLED_PRINCIPAL",
        `transaction ${id} settles in an asset, so its principal leg moves no cash (FR-157/AC-177)`,
      );
    }

    // **(2) the cost leg — an amount and nothing else** (L5).
    //
    // It was one arm of a two-leg loop until `0049`. A cost has no currency and
    // no account of its own to clear or to pair any more, so clearing it is a
    // single assignment and its presence test is `fee_amount IS NOT NULL` —
    // which is what FT-37 / L17 had already narrowed it to, for the shape Batch
    // F introduced.
    if (changes.feeAmount !== undefined) {
      if (changes.feeAmount === null) {
        // RC3: the whole leg goes, in this one `UPDATE`. There is nothing
        // beside the amount to null out with it.
      } else if (row.feeAmount === null) {
        // The refusal's last reason ("the edit form is deferred", L17)
        // lapsed with the transaction-edit-fields cycle. A cost is a bare
        // amount in the settling account's currency, so a leg can be added
        // wherever the kind carries one and the row settles in cash. Every
        // other row keeps the named refusal (the database would refuse it
        // anyway: `transaction_dividend_shape`, `0050`, `0056`, `0070`).
        const mergedCashCurrency =
          changes.cashCurrency !== undefined ? changes.cashCurrency : row.cashCurrency;
        if (
          !FEE_LEG_KINDS.has(row.kind) ||
          row.txnSettlementInstrumentId !== null ||
          mergedCashCurrency === null
        ) {
          throw new TransactionCashLegNotAddableError(id, "fee");
        }
      }
    }

    // (3) the withholding — since `0079` an amount and nothing else,
    // like the cost leg: no currency, rate or account to clear or pair, so
    // there is nothing to reconcile here. Its kind and its bound are checked
    // by `#assertWithholdingBelowPrincipal`.

    // (4) merged totality and pairing, per leg — plus the refs for the ones
    // that actually changed.
    const refs: CashAccountRef[] = [];
    const legs = [
      {
        // FT-14 **F2**: `cash_currency`, not `txn_currency`. The
        // composite FK `transaction_cash_account_fk` was re-pointed by `0046`
        // to `(tenant_id, portfolio_id, cash_account_id, cash_currency)`, so
        // this is now the column the database itself pairs the account with —
        // reading `txn_currency` here would check a cross-currency settlement
        // against the wrong currency and reject the one edit FR-156 exists to
        // allow. The other three rows are unchanged (FR-237).
        accountField: "cashAccountId",
        currencyField: "cashCurrency",
        constraint: TRANSACTION_CASH_ACCOUNT_FK,
      },
      {
        accountField: "targetCashAccountId",
        currencyField: "targetCurrency",
        constraint: TRANSACTION_TARGET_CASH_ACCOUNT_FK,
      },
    ] as const;

    for (const leg of legs) {
      // `null` is a meaningful value here ("clear this leg's account"), so the
      // merge tests against `undefined` only — never a truthiness check, and
      // never a `!` that would claim non-null when `null` is exactly the case
      // `CashAccountRequiredError` below exists to catch.
      const changedAccountId = next[leg.accountField];
      const mergedAccountId =
        changedAccountId !== undefined ? changedAccountId : row[leg.accountField];
      // **Which currencies are editable, and which are not — F2, FD8.**
      // The other currency columns are guarded: `txn_currency` and
      // `target_currency` are in `GUARDED_FX_EDIT_FIELDS`
      // (`transactions.schema.ts`), because each one **pins a resolved rate**
      // — `fx_rate`, the target leg's value-neutrality — and a currency that
      // moves under a pinned rate leaves the rate stale (F4's note).
      // (`fee_currency` and `withholding_currency` were dropped by `0049` and
      // `0079`.)
      //
      // `cash_currency` is the **one that is not**, and deliberately so: it
      // carries no rate. The principal cash posting's rate is *derived*
      // (`amount_base / amount_native`, `posting-expander.ts`), never
      // resolved, so nothing goes stale when it moves — and guarding it would
      // forbid the one correction FR-156 exists for, re-pointing a leg to an
      // account which, after phase 1, may be denominated differently.
      //
      // So the merged currency is read from `changes`/`next` first and the
      // stored row second, exactly like the account id: for the guarded
      // leg `changes` never carries one and the stored value always wins; for
      // the principal leg it may, either from the caller or from
      // `#reconcileCashLeg`, which runs first. Step (2) above is the other
      // writer of `next[currencyField]` (it clears a whole leg).
      const changedCurrency = next[leg.currencyField];
      const mergedCurrency =
        changedCurrency !== undefined ? changedCurrency : row[leg.currencyField];

      if (mergedCurrency === null) {
        if (mergedAccountId !== null) {
          throw new CashAccountNotAllowedError(
            leg.accountField,
            "LEG_ABSENT",
            `transaction ${id} carries no ${leg.currencyField} leg for that account to belong to`,
          );
        }
        continue;
      }
      if (mergedAccountId === null) {
        throw new CashAccountRequiredError(
          leg.accountField,
          `transaction ${id}'s ${leg.currencyField} leg moves cash, so it must name the account it moved it in`,
        );
      }
      // A ref is produced when **either** half of the composite FK moved.
      // Keying it on the account id alone left the other half
      // unchecked: `transaction_cash_account_fk` pairs the account with the
      // *currency*, so re-denominating a leg while leaving its account in place
      // is just as capable of violating it — and reached the database instead
      // of `#assertCashAccountsUsable`, which answers it as a named
      // `CashAccountCurrencyMismatchError` (400).
      //
      // Trimmed on the stored side for the reason `#reconcileCashLeg` gives:
      // `char(3)` on one side, a caller-supplied string on the other, and a
      // mis-compare here would push a spurious ref on every no-op edit.
      const storedCurrency = row[leg.currencyField];
      const currencyMoved =
        storedCurrency === null || mergedCurrency.trim() !== storedCurrency.trim();
      if (mergedAccountId !== row[leg.accountField] || currencyMoved) {
        refs.push({
          field: leg.accountField,
          constraint: leg.constraint,
          id: mergedAccountId,
          currency: mergedCurrency,
        });
      }
    }

    await this.#assertCashAccountsUsable(tx, row.portfolioId, refs);
    return { changes: next, refs };
  }

  /**
   * Edits any field of a transaction in place (FR-13, "Editing"), and appends a `transaction_revision` row with a full
   * before/after JSONB snapshot — both in the **same DB transaction**, so the
   * edit and its audit record commit or roll back together and a mutation
   * without an audit trail is not a reachable state.
   *
   * The postings are regenerated after the edit, inside the same
   * transaction, exactly as every write path does — an edit that changes an
   * amount or the *number* of legs is followed by a wholesale re-expansion, so
   * the derived ledger cannot drift from the row it edited.
   *
   * **This path cannot change an FX leg.** It issues a plain `UPDATE` and
   * never sets `app.fx_correction`, so `trg_transaction_fx_immutable`
   * (migration `0004`, last redefined by `0079`) refuses any change to
   * `fx_rate` (and its source/provider/observed/user-input columns) with
   * SQLSTATE `23514`, rolling back the whole operation — no row edited, no
   * revision written. That refusal is FR-57/AC47 enforcement mechanism 2 at
   * the application boundary; {@link TransactionWriteService.correctFxRate} is
   * the one method that can change an FX rate, and it does so through the
   * single sanctioned flag.
   *
   * **`grossAmount` is not freely editable either** on a `BUY`/`SELL`/`DRIP`
   * row (NEW-3, final narrow remediation review, T-38) — see
   * {@link TransactionGrossAmountNotEditableError}'s doc comment. The mirror
   * image applies to a settlement-priced `BUY`'s `unitPrice` (A, final
   * narrow fix round, feature/api-transactions) — see {@link
   * TransactionUnitPriceNotEditableError}'s doc comment.
   *
   * **Cannot be edited into settling in the instrument it acquires either**
   * (C, final narrow fix round, feature/api-transactions) — see {@link
   * TransactionSelfSettledError}'s doc comment.
   *
   * @throws {TransactionNotFoundError} if the transaction is not visible to
   * this tenant (it does not exist, or RLS hides another tenant's row) —
   * including a race where a concurrent `deletePortfolio` cascade removed it
   * partway through this method (MEDIUM-1, security review:
   * see `#reconcileGrossAmount`/`#assertNotSelfSettled`/this
   * method's own `UPDATE`, each of which now checks for this rather than
   * assuming the row it already proved existed still does).
   * @throws {TransactionGrossAmountNotEditableError} if `grossAmount` is
   * supplied for a fiat-priced row whose current-or-edited `quantity`/
   * `unitPrice` are both non-`NULL` (NEW-3).
   * @throws {TransactionUnitPriceNotEditableError} if `unitPrice` is supplied
   * for a settlement-priced row (A).
   * @throws {TransactionSelfSettledError} if the merged `instrumentId`/
   * `txnSettlementInstrumentId` would be equal (C).
   * @throws {TransactionShareDistributionShapeError} if the row is a
   * `SHARE_DISTRIBUTION` and the edit would give it a field the cashless kind
   * does not have, or take away one it is made of.
   * @throws {TransactionPortfolioNotEditableError} if `portfolioId` is present
   * and differs from the stored value (CA-10).
   * @throws {CashAccountNotFoundError} / {@link CashAccountCurrencyMismatchError}
   * / {@link CashAccountArchivedError} / {@link CashAccountRequiredError} /
   * {@link CashAccountNotAllowedError} / {@link TransactionCashLegNotAddableError}
   * from `#reconcileCashAccounts` (CA-10) — the edit path's half of the
   * create-versus-edit table.
   */
  async editTransaction(params: EditTransactionParams): Promise<TransactionRecord> {
    assertNonEmpty(params.id, "id");
    assertNonEmpty(params.changedBy, "changedBy");
    if (Object.keys(params.changes).length === 0) {
      throw new TransactionArgumentError("editTransaction requires at least one field to change");
    }
    // The trade-date floor (this class's own doc-comment section) applies at
    // every write boundary, not only creation — an edit that retroactively
    // moves a transaction's date past the floor has the identical mispricing
    // risk a too-old creation does.
    if (params.changes.tradeDate !== undefined) {
      this.#assertTradeDate(params.changes.tradeDate);
    }
    // F1 (security review, T-38): the third of this
    // finding's three enforcement layers (see `transactions.schema.ts`'s
    // `editTransactionBodySchema` and migration `0025`'s `CHECK`s for the
    // other two) — this generic edit path is the one place in this service
    // that accepts an arbitrary caller-supplied `TransactionEdit`, so it gets
    // the same `assertPositiveDecimal` every `record*` method already runs
    // on these twelve columns. `null` is a legitimate "clear this field" value
    // for the kinds that carry it as optional
    // and is left alone here — only a present, non-null value is checked.
    this.#assertPositiveIfPresent(params.changes.quantity, "quantity");
    this.#assertPositiveIfPresent(params.changes.unitPrice, "unitPrice");
    this.#assertPositiveIfPresent(params.changes.grossAmount, "grossAmount");
    this.#assertPositiveIfPresent(params.changes.targetAmount, "targetAmount");
    this.#assertPositiveIfPresent(params.changes.feeAmount, "feeAmount");
    this.#assertPositiveIfPresent(params.changes.withholdingAmount, "withholdingAmount");
    // …and the five columns phase 1 and phase 2 added. They were
    // left out when the rung was written for five, which reduced F1's stated
    // three-rung design to two for exactly the new money fields: the DTO
    // (`positiveDecimal`) and the DB CHECKs (`0045`, `0047`). Not reachable
    // over HTTP — `editTransactionBodySchema` catches them all — but an
    // internal caller bypassing the DTO got a `23514` mapped to a generic 400
    // rather than the named error every other amount raises, which is the
    // whole reason the rung exists.
    this.#assertPositiveIfPresent(params.changes.cashAmount, "cashAmount");
    this.#assertPositiveIfPresent(params.changes.brokerFeeAmount, "brokerFeeAmount");
    this.#assertPositiveIfPresent(params.changes.fxFeeAmount, "fxFeeAmount");
    this.#assertPositiveIfPresent(params.changes.taxAmount, "taxAmount");
    this.#assertPositiveIfPresent(params.changes.otherCostAmount, "otherCostAmount");
    // F2 (security review, T-38): a PATCH changing
    // `instrumentId`/`txnSettlementInstrumentId` to a nonexistent id hit the
    // same unmapped FK violation `#recordTrade`'s BUY branch did — checked
    // here for the same reason. `null` (clearing the field, valid for the
    // kinds that allow it) is left alone; only a present, non-null change is
    // checked.
    if (params.changes.instrumentId !== undefined && params.changes.instrumentId !== null) {
      await this.#assertInstrumentExists(this.#db, params.changes.instrumentId);
    }
    if (
      params.changes.txnSettlementInstrumentId !== undefined &&
      params.changes.txnSettlementInstrumentId !== null
    ) {
      await this.#assertInstrumentExists(this.#db, params.changes.txnSettlementInstrumentId);
    }

    // Rung 1 first (`#inLedgerWriteTx`, `security-transfer`): any
    // edit may reach a second portfolio — a linked source mirrors onto its
    // target, and a change to a transfer's source history re-costs it.
    const written = await this.#inLedgerWriteTx(async (tx) => {
      const before = await this.#snapshot(tx, params.id);
      if (before === undefined) throw new TransactionNotFoundError(params.id);
      const storedPortfolioId = before["portfolio_id"] as string;

      // F1, rung 2, and the fix for the deadlock this path was one
      // half of. `#snapshot` above takes no lock, so this is still the first
      // lock this transaction acquires — and it is now acquired *before*
      // `#reconcileGrossAmount`/`#assertNotSelfSettled`/`#reconcileCashAccounts`
      // take the `transaction` row `FOR UPDATE` (rung 3) and before the
      // `UPDATE` below re-checks `transaction_cash_account_fk` and takes the
      // named `cash_account` row `FOR KEY SHARE` (rung 4). Previously this
      // path reached rung 4 while holding rung 3 and asked for rung 2 last (at
      // `#writePostings`' posting `INSERT`), which is exactly the inverted
      // edge `renameCashAccount` deadlocked against.
      //
      // A missing row here means a concurrent `deletePortfolio` cascade
      // committed, and that cascade deleted this transaction with it —
      // MEDIUM-1's standing `TransactionNotFoundError`, raised before anything
      // is written rather than after the `UPDATE` affects zero rows.
      if (!(await this.#lockPortfolio(tx, storedPortfolioId))) {
        throw new TransactionNotFoundError(params.id);
      }

      // CA-10: a portfolio move would recompute only the
      // destination (`#invalidate` below is called with the *post*-`UPDATE`
      // portfolio), leaving the source's derived figures stale — AC23
      // silently false. Rejected outright rather than "fixed" by invalidating
      // both, following F6's `sourceDividendId` precedent: this endpoint does
      // not express a move. Merge-then-compare, so re-submitting the row's own
      // portfolio is a no-op success. Rejected *here*, before anything else,
      // so the widened `#guardPortfolioFk` below can never be handed a
      // `23503` on `transaction_cash_account_fk` that is really an attempted
      // move and report it as a missing cash account — see
      // `TransactionPortfolioNotEditableError`'s own doc comment.
      if (
        params.changes.portfolioId !== undefined &&
        params.changes.portfolioId !== storedPortfolioId
      ) {
        throw new TransactionPortfolioNotEditableError(
          params.id,
          storedPortfolioId,
          params.changes.portfolioId,
        );
      }

      // C (final narrow fix round, feature/api-transactions): rejects an
      // edit that would leave the row settling in the instrument it
      // acquires — see `#assertNotSelfSettled`'s own doc comment.
      await this.#assertNotSelfSettled(tx, params.id, params.changes);

      // The 8th kind's own shape, refused **before** the three
      // reconcilers below touch anything — see `#assertShareDistributionShape`
      // for why this order is load-bearing and not merely tidy.
      await this.#assertShareDistributionShape(tx, params.id, params.changes);
      // `security-transfer`: the two transfer kinds' shape, and
      // the linked target's read-only rule, before any reconciler — same
      // reason as the line above.
      await this.#assertTransferShape(tx, params.id, before, params.changes);

      // NEW-3 (final narrow remediation review, T-38): may
      // reject a caller-supplied `grossAmount` (`TransactionGrossAmountNotEditableError`)
      // or recompute it from `quantity x unitPrice` — or, for a
      // settlement-priced row (A, final narrow fix round,
      // feature/api-transactions), the mirror image on `unitPrice` — see
      // `#reconcileGrossAmount`'s own doc comment.
      const grossReconciled = await this.#reconcileGrossAmount(tx, params.id, params.changes);
      // FT-13/FR-254/L16: the settlement figures follow the `gross_amount` the
      // step above may have just recomputed — recomputed in D1/D2 and D4,
      // required in the same request in D3/D5 — see `#reconcileCashLeg`'s own
      // doc comment for the four merged shapes.
      const cashMirrored = await this.#reconcileCashLeg(tx, params.id, grossReconciled);
      // FR-214/AC-248: an edit that touches one component, or the total, must
      // leave the two agreeing — see `#reconcileCostComponents`.
      const costsReconciled = await this.#reconcileCostComponents(tx, params.id, cashMirrored);
      // CA-10: the edit path's half of the create-versus-edit
      // table — see `#reconcileCashAccounts`'s own doc comment.
      const { changes, refs } = await this.#reconcileCashAccounts(tx, params.id, costsReconciled);
      // `cash-interest` C-5, DIVIDEND too: the merged
      // withholding stays strictly below the merged principal cash amount —
      // see the method's own comment.
      await this.#assertWithholdingBelowPrincipal(tx, params.id, changes);

      // A plain UPDATE with no correction flag: the FX-immutability trigger
      // fires (SQLSTATE 23514) and rolls the whole transaction back if
      // `changes` touches a guarded FX column (FR-57/AC47).
      //
      // CA-9: wrapped in `#guardPortfolioFk`, which this
      // `UPDATE` was not — for *any* constraint, not only the new ones — so a
      // portfolio or cash-account FK violation reaching it was a raw 500.
      const [row] = await this.#guardPortfolioFk(storedPortfolioId, refs, () =>
        tx
          .update(transaction)
          .set({ ...changes, updatedAt: sql`now()` })
          .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, params.id)))
          .returning(),
      );
      // MEDIUM-1 (security review): `before`
      // proved this row existed at the time of `#snapshot` above, but that
      // read takes no lock — a concurrent `deletePortfolio` cascade
      // (`portfolio-service.ts`) can win the row lock this `UPDATE` itself
      // requests, delete the row (and its portfolio), and commit in the gap
      // between the two reads, leaving this `UPDATE ... RETURNING` to affect
      // zero rows. `row!.portfolioId` on an empty result was a bare, unmapped
      // `TypeError` (a 500); this degrades to the same clean
      // `TransactionNotFoundError` a request landing microseconds earlier
      // would have gotten from the pre-check above.
      if (!row) throw new TransactionNotFoundError(params.id);

      // Regenerate the derived ledger inside the same DB transaction.
      await this.#writePostings(tx, row);
      // `security-transfer`: a linked source's quantity, market
      // value and time of day reach its target **before** this portfolio is
      // recomputed, so the propagation that recomputation runs re-costs
      // a target that already carries the edited quantity — and the target's
      // own revision records the mirror, not a propagated cost.
      if (row.kind === "TRANSFER_OUT") {
        await this.#mirrorOntoLinkedTarget(tx, row, params.changes, params.changedBy);
      }
      // Steps 2-4 (T-30): min(old.trade_date, new.trade_date) — a
      // retroactive date change invalidates every valuation from the
      // *earlier* of the two dates, not just the new one.
      await this.#invalidate(
        tx,
        row.portfolioId,
        this.#minDate(before["trade_date"] as IsoDate, row.tradeDate),
      );
      const after = await this.#snapshot(tx, params.id);
      await this.#appendRevision(tx, params.id, "UPDATE", before, after ?? null, params.changedBy);
      return row;
    });

    // F8 (security review, T-37): every *creation* path
    // triggers a backfill check for the instrument(s) it references
    // (this class's "Instrument backfill trigger" doc-comment section), but
    // `editTransaction` never did — so a transaction whose `tradeDate` is
    // retroactively moved earlier (a correction, exactly the scenario
    // `ensureInstrumentBackfillRequested`'s own F8 widening fix now handles)
    // had no path back into the trigger at all. After commit, never inside
    // it, mirroring every other call site.
    //
    // `portfolio-cash` (G-2): a FEE's `instrument_id` is a reference
    // with no position — its creation requests no backfill (PC-D3), so an edit
    // of its date must not either.
    if (params.changes.tradeDate !== undefined && written.kind !== "FEE") {
      if (written.instrumentId) {
        await this.#triggerInstrumentBackfill(written.instrumentId, written.tradeDate);
      }
      if (written.txnSettlementInstrumentId) {
        await this.#triggerInstrumentBackfill(written.txnSettlementInstrumentId, written.tradeDate);
      }
    }
    return written;
  }

  /**
   * Hard-deletes a transaction ("Deletion", AC9/FR-13)
   * and appends a `DELETE`-kind `transaction_revision` row capturing the row's
   * final JSONB state as `before` (with `after` NULL), both in the same DB
   * transaction.
   *
   * The `transaction_posting` rows are removed by the FK's `ON DELETE CASCADE`,
   * so this path does no posting cleanup of its own. The revision's
   * `transaction_id` intentionally points at the now-deleted row — the audit
   * table carries no FK to `transaction` precisely so a `DELETE` revision
   * remains a valid reference.
   *
   * @throws {TransactionNotFoundError} if the transaction is not visible to
   * this tenant — including a race where a concurrent `deletePortfolio`
   * cascade (`portfolio-service.ts`) removed it between this method's own
   * `#snapshot` and its `DELETE` below (MEDIUM-1, security review,
   * portfolio-crud-ui fix round 1: see the `DELETE`'s own comment).
   */
  async deleteTransaction(params: DeleteTransactionParams): Promise<void> {
    assertNonEmpty(params.id, "id");
    assertNonEmpty(params.changedBy, "changedBy");

    // Rung 1 first (`#inLedgerWriteTx`, `security-transfer`): a
    // pair delete holds two portfolios, and a delete in a transfer's source
    // history re-costs its target in another.
    await this.#inLedgerWriteTx(async (tx) => {
      const before = await this.#snapshot(tx, params.id);
      if (before === undefined) throw new TransactionNotFoundError(params.id);

      // FR-579: either leg of a transfer deletes the pair — see
      // `#deleteTransferLeg`. The snapshot above was read under rung 1.
      if (isTransferKind(before["kind"])) {
        await this.#deleteTransferLeg(tx, before, params.changedBy);
        return;
      }

      // F1, rung 2: the `portfolio` row before the `transaction` row
      // this `DELETE` locks (rung 3) and before the postings' `ON DELETE
      // CASCADE` releases their `cash_account` references (rung 4). Required
      // for the same reason `deletePortfolio` now takes rung 2 before rung 3 —
      // the two would otherwise be a cycle. A missing row is the concurrent
      // cascade, which took this transaction with it.
      if (!(await this.#lockPortfolio(tx, before["portfolio_id"] as string))) {
        throw new TransactionNotFoundError(params.id);
      }

      // MEDIUM-1: `before`'s plain (non-locking) read proved this row existed
      // a moment ago, but a concurrent `deletePortfolio` cascade takes no
      // lock this `DELETE` would already be holding, so it can win the row
      // lock, delete this same row (and its portfolio), and commit in the gap
      // between the two statements — this `DELETE ... RETURNING` would then
      // affect zero rows. Previously unchecked, this fell through to
      // `#invalidate` with a portfolio id that no longer exists either,
      // surfacing as a bare, unmapped `TypeError` (a 500) from
      // `recomputeAndInvalidate`'s own `portfolioRow!` dereference. Checked
      // here instead, before `#invalidate` is ever called, so this degrades to
      // the same clean `TransactionNotFoundError` a request landing
      // microseconds earlier would have gotten from the pre-check above.
      const deleted = await tx
        .delete(transaction)
        .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, params.id)))
        .returning({ id: transaction.id });
      if (deleted.length === 0) throw new TransactionNotFoundError(params.id);

      // Steps 2-4 (T-30): the deleted row's own portfolio/trade_date —
      // `transaction_posting`'s cleanup is `ON DELETE CASCADE` (step 1), so
      // there is no posting regeneration to await here.
      await this.#invalidate(tx, before["portfolio_id"] as string, before["trade_date"] as IsoDate);

      await this.#appendRevision(tx, params.id, "DELETE", before, null, params.changedBy);
    });
  }

  /**
   * Deletes a transfer leg and, when it is linked, its partner — one operation
   * (`security-transfer`, FR-579).
   *
   *  1. **Rung 1, then the partner.** `own` and the partner are both read
   *     after the tenant advisory lock is held — `deleteTransaction` takes it
   *     as its first statement (F-6). `deletePortfolio` holds that same lock
   *     for its whole cascade, so a partner seen here cannot be deleted, or
   *     unlinked by portfolio deletion's sever, before this transaction's own
   *     `DELETE` reaches it; a partner discovered *before* the lock could be,
   *     and the `DELETE` would then find nothing.
   *  2. **Both portfolio rows**, ascending id (rung 2).
   *  3. **Target first, then source**, each checked for a zero-row result
   *     (MEDIUM-1's rule): the link is a `NO ACTION` FK, so the referencing row
   *     has to go first.
   *  4. A `DELETE` revision per row, and both portfolios invalidated. Removing
   *     the received units can make a later `SELL` in the target oversell; its
   *     recompute throws `OverSellError` and the whole delete rolls back (I-4).
   *
   * A standalone leg — a source with no target (FR-566), a severed target —
   * deletes alone through the same steps.
   */
  async #deleteTransferLeg(tx: Tx, own: Record<string, unknown>, changedBy: string): Promise<void> {
    const id = own["id"] as string;

    let partnerId: string | undefined;
    if (own["kind"] === "TRANSFER_OUT") {
      const [target] = await tx
        .select({ id: transaction.id })
        .from(transaction)
        .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.transferSourceId, id)));
      partnerId = target?.id;
    } else if (typeof own["transfer_source_id"] === "string") {
      partnerId = own["transfer_source_id"];
    }
    const partner = partnerId === undefined ? undefined : await this.#snapshot(tx, partnerId);
    if (partnerId !== undefined && partner === undefined) {
      // Unreachable under rung 1 and the `NO ACTION` FK; named rather than
      // silently deleting one leg of what was a pair.
      throw new TransactionNotFoundError(partnerId);
    }

    const legs = partner === undefined ? [own] : [own, partner];
    const portfolioIds = [...new Set(legs.map((leg) => leg["portfolio_id"] as string))].sort();
    for (const portfolioId of portfolioIds) {
      if (!(await this.#lockPortfolio(tx, portfolioId))) {
        throw new TransactionNotFoundError(id);
      }
    }

    // The referencing row — the `TRANSFER_IN` — goes first.
    const ordered = [...legs].sort((a, b) =>
      a["kind"] === b["kind"] ? 0 : a["kind"] === "TRANSFER_IN" ? -1 : 1,
    );
    for (const leg of ordered) {
      const legId = leg["id"] as string;
      const deleted = await tx
        .delete(transaction)
        .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, legId)))
        .returning({ id: transaction.id });
      if (deleted.length === 0) throw new TransactionNotFoundError(legId);
    }
    for (const leg of ordered) {
      await this.#invalidate(tx, leg["portfolio_id"] as string, leg["trade_date"] as IsoDate);
    }
    for (const leg of ordered) {
      await this.#appendRevision(tx, leg["id"] as string, "DELETE", leg, null, changedBy);
    }
  }

  /**
   * FR-64's explicit FX-rate correction path (the AC50
   * walkthrough) — and the **only** method in the entire repository that sets
   * `app.fx_correction`, the flag `trg_transaction_fx_immutable` requires
   * before it will allow an FX-leg change.
   *
   * It sets the flag through `withFxCorrection` (platform/db) rather than a
   * hand-written `SET LOCAL`, updates `fx_rate` and `fx_rate_user_input` to the
   * corrected rate with `fx_rate_source = USER_PINNED`, regenerates the
   * postings with the new `amount_base`, and appends a `transaction_revision`
   * row — all in one DB transaction.
   *
   * Because `withFxCorrection` uses `set_config(..., true)`, the flag is
   * transaction-local: it is gone the instant this transaction commits or
   * rolls back, so the correction window cannot leak into a later ordinary
   * edit on the same pooled connection (the integration test proves a
   * subsequent plain update is again blocked).
   *
   * @throws {TransactionNotFoundError} if the transaction is not visible to
   * this tenant — including a race where a concurrent `deletePortfolio`
   * cascade removed it between this method's own `#snapshot` and its `UPDATE`
   * below (MEDIUM-1, security review: see the
   * `UPDATE`'s own comment).
   */
  async correctFxRate(params: CorrectFxRateParams): Promise<TransactionRecord> {
    assertNonEmpty(params.id, "id");
    assertNonEmpty(params.changedBy, "changedBy");
    assertPositiveDecimal(params.fxRate, "fxRate");

    // Rung 1 first (`#inLedgerWriteTx`, `security-transfer`): a
    // correction on a linked source leg writes its target in another
    // portfolio, and one on an earlier acquisition re-costs a transfer's
    // target through the propagation.
    const written = await this.#inLedgerWriteTx(async (tx) => {
      const before = await this.#snapshot(tx, params.id);
      if (before === undefined) throw new TransactionNotFoundError(params.id);

      // `security-transfer`: a linked target's rate is its
      // source's (ST-6) and moves only with it — refused before any lock or
      // write, naming where the correction belongs. A severed target is a
      // standalone row and corrects like any other.
      if (before["kind"] === "TRANSFER_IN" && typeof before["transfer_source_id"] === "string") {
        const [source] = await tx
          .select({ portfolioId: transaction.portfolioId })
          .from(transaction)
          .where(
            and(
              eq(transaction.tenantId, this.#tenantId),
              eq(transaction.id, before["transfer_source_id"]),
            ),
          );
        // The link is a `NO ACTION` FK, so the source exists while it is set.
        if (!source) throw new TransactionNotFoundError(before["transfer_source_id"]);
        throw new TransferTargetReadOnlyError(params.id, "fxRate", source.portfolioId);
      }

      // F1, rung 2. A rate correction re-expands the postings, so it
      // reaches rung 4 (`transaction_posting`'s `cash_account` reference) and
      // rung 2 (`#invalidate`) exactly as an edit does, and takes the same
      // order for the same reason.
      if (!(await this.#lockPortfolio(tx, before["portfolio_id"] as string))) {
        throw new TransactionNotFoundError(params.id);
      }

      // **The third writer of the implied settlement rate, and
      // the one the create-path guard did not cover.**
      //
      // On a D3/D5 row the correction moves `amount_base = gross_amount ×
      // fx_rate` while `amount_native = cash_amount` stays put (correctly — the
      // broker's settled figure is an independent fact there, not a function of
      // the base rate, per FT-15/L15). So the implied rate
      // `amount_base / amount_native` moves with the correction, and a large
      // enough corrected rate pushes it past `transaction_posting.fx_rate_applied`'s
      // `numeric(28,12)`: the same `22003` the create-path guard exists to prevent, reached from
      // the one endpoint it does not cover.
      //
      // **Why a second statement rather than SQL on the `UPDATE` below.** That
      // `UPDATE` is deliberately one expression so its condition and both
      // factors are evaluated against the row it locks — and a guard computed
      // off `before` would reintroduce exactly the race that shape avoids,
      // because `#lockPortfolio` runs *after* the snapshot read. This read is
      // taken **after** the portfolio lock and takes the row's own lock, so it
      // cannot race a concurrent write of `gross_amount` either; and it keeps
      // the rule in one language, TypeScript, matching the create and edit
      // paths' own shape. One extra statement on a rare, explicitly-audited
      // endpoint (the cheapest of three options).
      const [locked] = await tx
        .select({
          grossAmount: transaction.grossAmount,
          txnCurrency: transaction.txnCurrency,
          cashCurrency: transaction.cashCurrency,
          cashAmount: transaction.cashAmount,
          withholdingAmount: transaction.withholdingAmount,
        })
        .from(transaction)
        .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, params.id)))
        .for("update");
      // The same MEDIUM-1 degradation the `UPDATE` below documents: a
      // concurrent `deletePortfolio` cascade can win this row's lock.
      if (!locked) throw new TransactionNotFoundError(params.id);
      if (locked.cashCurrency !== null && locked.cashAmount !== null) {
        const cashCurrency = locked.cashCurrency.trim();
        // **D4 is exempt, and this is the reason the guard is one branch
        // rather than all of them**: the `UPDATE` below recomputes D4's
        // `cash_amount` to `gross × new rate`, so its implied rate is exactly
        // 1 whatever the correction. The predicate is the *same* pair of
        // conjuncts that `CASE` uses — anything else would guard a shape the
        // statement treats differently.
        const recomputedByThisUpdate =
          cashCurrency === this.#fx.baseCurrency &&
          cashCurrency !== (locked.txnCurrency?.trim() ?? null);
        // On D4 the `UPDATE` below moves `cash_amount` to `gross × new
        // rate`, and a withholding is bounded by that very figure (it is
        // denominated in the settling account's currency). Without this a
        // correction could leave TAX ≥ INCOME — a zero or negative net —
        // silently on a DIVIDEND (no CHECK) and as an unnamed shape error on
        // an INTEREST (`transaction_interest_shape`). Same rule and error as
        // the create and edit paths, named by the field that moved.
        if (recomputedByThisUpdate && locked.withholdingAmount !== null) {
          assertWithholdingBelowPrincipal(
            locked.withholdingAmount,
            locked.grossAmount.times(params.fxRate),
            "fxRate",
          );
        }
        if (!recomputedByThisUpdate) {
          assertImpliedSettlementRateRepresentable({
            field: "fxRate",
            grossAmount: locked.grossAmount,
            fxRate: params.fxRate,
            cashAmount: locked.cashAmount,
            cashCurrency,
          });
        }
      }

      // The one sanctioned bypass of trg_transaction_fx_immutable. The flag is
      // set only for the duration of this UPDATE (and, for a linked source
      // leg, its target's — `#correctLinkedTargetFxRate`), and only here.
      const [row] = await withFxCorrection(tx, async (correcting) =>
        correcting
          .update(transaction)
          .set({
            fxRate: params.fxRate,
            fxRateSource: "USER_PINNED",
            fxRateUserInput: params.fxRate,
            // A pinned rate has no provider provenance (FR-58). Clearing these
            // matters when correcting a row that was PROVIDER-sourced: leaving
            // them would produce a USER_PINNED row still claiming it came from
            // ecb on some observation date — a self-contradictory audit record.
            // trg_transaction_fx_immutable guards both columns too, so this is
            // only writable inside this same correction window.
            fxRateProviderKey: null,
            fxRateObservedOn: null,
            // **FT-15 F3 / L15** (locked 2026-08-27). In case D4 —
            // the settling account denominated in this tenant's base currency
            // — `cash_amount = gross_amount × fx_rate` holds **by
            // construction at write time** (L11) and is *not* enforceable as a
            // `CHECK`, because the base currency lives on `tenant` and a
            // Postgres CHECK is single-row, single-table (P22). Correcting
            // `fx_rate` without this line therefore silently breaks it: the
            // EUR account stays booked as having moved the pre-correction
            // figure while the trade's base value is the new one, with **no
            // constraint and no signal** — sum-to-zero still holds and
            // `fx_rate_applied` simply moves. That is exactly why F3 needed a
            // decision rather than a test.
            //
            // The same rule the create path (`#resolveCashLeg`) and the edit
            // path (`#reconcileCashLeg`) already apply, so L11's "nothing left
            // to enforce" stays true across **every** write path rather than
            // two of three.
            //
            // Written as one SQL expression on the `UPDATE` this method
            // already issues — not a read-then-compute — so the condition and
            // both factors are evaluated against the row this statement is
            // actually locking, not against `before`'s unlocked snapshot.
            //
            //   - the condition reads the row's stored **`cash_currency`**,
            //     never `txn_currency`: in D4 those differ (that is what D4
            //     *is*), and reading the wrong one would recompute nothing;
            //   - D1/D2 are untouched — `transaction_cash_degenerate_equals_gross`
            //     already pins `cash_amount = gross_amount` there, and a
            //     recompute would break that CHECK outright. **The condition
            //     has to say so explicitly**: a degenerate row
            //     whose `txn_currency` *is* the base currency satisfies
            //     `cash_currency = base` too, so the base test alone caught it
            //     and any rate ≠ 1 set `cash_amount = gross × rate ≠
            //     gross_amount` — refused by that very CHECK as a `23514`, i.e.
            //     "untouched" only in the sense of rolled back. The second
            //     conjunct is what makes the claim above true;
            //   - D3/D5 are untouched — the settled amount is an independent
            //     broker fact there, not a function of the base rate, and a
            //     blanket recompute would corrupt it.
            //
            // `trim()` on both sides for the reason `posting-expander.ts` and
            // `#assertCashAccountsUsable` already trim: `char(3)` against a
            // parameter. `cash_amount` is not in
            // `trg_transaction_fx_immutable`'s guarded set (it is a money
            // figure, not a rate — FR-243), so this `.set()` neither needs the
            // correction flag nor widens what the flag permits.
            cashAmount: sql`case
                     when trim(${transaction.cashCurrency}) = ${this.#fx.baseCurrency}
                      and trim(${transaction.cashCurrency}) <> trim(${transaction.txnCurrency})
                     then ${transaction.grossAmount} * ${params.fxRate.toFixed()}::numeric
                     else ${transaction.cashAmount}
                   end`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, params.id)))
          .returning(),
      );
      // MEDIUM-1 (security review): `before`'s
      // plain (non-locking) read proved this row existed a moment ago, but a
      // concurrent `deletePortfolio` cascade can win the row lock this
      // `UPDATE` requests, delete the row (and its portfolio), and commit in
      // the gap — leaving this `UPDATE ... RETURNING` to affect zero rows.
      // `row!.portfolioId` on an empty result was a bare, unmapped
      // `TypeError` (a 500); this degrades to the same clean
      // `TransactionNotFoundError` a request landing microseconds earlier
      // would have gotten from the pre-check above.
      if (!row) throw new TransactionNotFoundError(params.id);

      // The corrected rate flows into the derived ledger's amount_base.
      await this.#writePostings(tx, row);
      // `security-transfer`: a linked source leg's target takes the
      // same corrected rate in this same correction window, or the two legs'
      // flows would stop netting to zero (FR-569, ST-6).
      if (row.kind === "TRANSFER_OUT") {
        await this.#correctLinkedTargetFxRate(tx, row, params.fxRate, params.changedBy);
      }
      // Steps 2-4 / AC50 (T-30): a rate correction never changes
      // trade_date, but computing min(before, after) is still the literal
      // Rule rather than assuming the two agree.
      await this.#invalidate(
        tx,
        row.portfolioId,
        this.#minDate(before["trade_date"] as IsoDate, row.tradeDate),
      );
      const after = await this.#snapshot(tx, params.id);
      await this.#appendRevision(tx, params.id, "UPDATE", before, after ?? null, params.changedBy);
      return row;
    });
    return written;
  }

  /**
   * A linked source leg's FX correction, carried to its target
   * (`security-transfer`): the same corrected columns, written
   * inside the correction window `correctFxRate` already opened (the flag is
   * transaction-local), the target's postings regenerated, a revision appended
   * with the same `changedBy` (as the edit mirror does — a changed rate is an
   * audited fact, not a propagated projection), and its portfolio invalidated.
   * A no-op after one read for a source with no target (FR-566, or severed).
   *
   * The caller holds rung 1 and the source's portfolio row; the target's is
   * taken here, second (`portfolio-lock.ts`'s multi-portfolio rule).
   */
  async #correctLinkedTargetFxRate(
    tx: Tx,
    source: TransactionRecord,
    fxRate: Decimal,
    changedBy: string,
  ): Promise<void> {
    const [target] = await tx
      .select({ id: transaction.id, portfolioId: transaction.portfolioId })
      .from(transaction)
      .where(
        and(eq(transaction.tenantId, this.#tenantId), eq(transaction.transferSourceId, source.id)),
      );
    if (!target) return;
    if (!(await this.#lockPortfolio(tx, target.portfolioId))) {
      throw new TransactionNotFoundError(target.id);
    }
    const targetBefore = await this.#snapshot(tx, target.id);
    const [mirrored] = await withFxCorrection(tx, async (correcting) =>
      correcting
        .update(transaction)
        // `correctFxRate`'s own columns, minus the D4 `cash_amount` recompute:
        // a transfer row has no cash leg (`transaction_transfer_in_shape`).
        .set({
          fxRate,
          fxRateSource: "USER_PINNED",
          fxRateUserInput: fxRate,
          fxRateProviderKey: null,
          fxRateObservedOn: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(transaction.tenantId, this.#tenantId), eq(transaction.id, target.id)))
        .returning(),
    );
    if (!mirrored) throw new TransactionNotFoundError(target.id);
    await this.#writePostings(tx, mirrored);
    const targetAfter = await this.#snapshot(tx, target.id);
    await this.#appendRevision(
      tx,
      target.id,
      "UPDATE",
      targetBefore ?? null,
      targetAfter ?? null,
      changedBy,
    );
    await this.#invalidate(tx, mirrored.portfolioId, mirrored.tradeDate);
  }

  /**
   * The full JSONB row snapshot `to_jsonb` produces at the database — the
   * canonical stored representation, not a re-serialisation of the drizzle
   * record, so the audit trail records exactly what Postgres held. Returns
   * `undefined` when no such row is visible to this tenant (used to raise
   * {@link TransactionNotFoundError} before any write happens). Read inside the
   * caller's DB transaction under RLS.
   */
  async #snapshot(tx: Tx, transactionId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await tx.execute<{ snapshot: Record<string, unknown> }>(
      sql`select to_jsonb(t) as snapshot
          from "transaction" as t
          where t.tenant_id = ${this.#tenantId} and t.id = ${transactionId}`,
    );
    return rows[0]?.snapshot;
  }

  /**
   * Appends one `transaction_revision` row (the audit
   * trail): the before/after JSONB snapshots, the `revision_kind`, this
   * tenant, and the `app_user` responsible. `changed_at` defaults to `now()`
   * at the database. Always called inside the caller's DB transaction so the
   * audit row commits or rolls back with the write it records.
   */
  async #appendRevision(
    tx: Tx,
    transactionId: string,
    revisionKind: "CREATE" | "UPDATE" | "DELETE",
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    changedBy: string,
  ): Promise<void> {
    await tx.insert(transactionRevision).values({
      id: randomUUID(),
      tenantId: this.#tenantId,
      transactionId,
      revisionKind,
      before,
      after,
      changedBy,
    });
  }

  /**
   * Reads back the postings of one transaction in `seq` order. Provided
   * because the postings are a *derived* projection that no caller should
   * reconstruct for itself — the whole point is that there is one
   * expansion, at write time.
   */
  async listPostings(tx: Tx, transactionId: string): Promise<TransactionPostingRecord[]> {
    return tx
      .select()
      .from(transactionPosting)
      .where(
        and(
          eq(transactionPosting.tenantId, this.#tenantId),
          eq(transactionPosting.transactionId, transactionId),
        ),
      )
      .orderBy(asc(transactionPosting.seq));
  }

  /** The delete + insert half of {@link TransactionWriteService.regeneratePostings}, for a row already in hand. */
  async #writePostings(tx: Tx, row: TransactionRecord): Promise<TransactionPostingRecord[]> {
    await tx
      .delete(transactionPosting)
      .where(
        and(
          eq(transactionPosting.tenantId, this.#tenantId),
          eq(transactionPosting.transactionId, row.id),
        ),
      );

    const drafts = expandPostings(row);
    if (drafts.length === 0) return [];
    return tx
      .insert(transactionPosting)
      .values(
        drafts.map((draft) => ({
          ...draft,
          id: randomUUID(),
          tenantId: this.#tenantId,
          transactionId: row.id,
          portfolioId: row.portfolioId,
          // AR-5: a posting's base is its transaction's — same tenant, same
          // fact, verified by the same 0055 trigger.
          baseCurrency: row.baseCurrency,
        })),
      )
      .returning();
  }

  /**
   * Steps 2-4 (T-30), inside the caller's DB
   * transaction: increment `portfolio.calc_epoch`, fully recompute
   * `holding_state`/`cash_balance`/`realized_gain` for the whole portfolio,
   * and delete every `portfolio_daily_valuation` row on or after
   * `minTradeDate`. See `ledger/materialization.ts`'s
   * `recomputeAndInvalidate` for the implementation; this is a thin
   * tenant-scoped wrapper so every call site below reads the same one line.
   */
  async #invalidate(tx: Tx, portfolioId: string, minTradeDate: IsoDate): Promise<void> {
    // Inside a write batch, accumulate instead of recomputing — one
    // call at the end of the batch subsumes every call deferred here (see
    // {@link TransactionWriteService.inWriteBatch}). Keyed on the handle's
    // identity, not merely on a batch being open: `editTransaction` and
    // friends open their own transaction and must still recompute inside it,
    // and a recompute deferred onto a transaction that is not the one this
    // write is committing with would be a lost invalidation.
    const batch = this.#batch;
    if (batch !== null && batch.tx === tx) {
      const seen = batch.deferredRecompute.get(portfolioId);
      batch.deferredRecompute.set(
        portfolioId,
        seen === undefined ? minTradeDate : this.#minDate(seen, minTradeDate),
      );
      return;
    }
    // `security-transfer`: the recompute, then the cross-portfolio
    // propagation — a write in a transfer's source portfolio re-costs its
    // linked targets and recomputes their portfolios too, in this transaction.
    // A portfolio with no transfer disposal pays nothing more.
    await recomputeWithTransferPropagation(
      tx,
      this.#tenantId,
      new Map([[portfolioId, minTradeDate]]),
    );
  }

  /** Lexicographic `min` of two `YYYY-MM-DD` dates — valid because ISO date-string order is chronological order. */
  #minDate(a: IsoDate, b: IsoDate): IsoDate {
    return a < b ? a : b;
  }

  /**
   * The next `transaction.seq` for this tenant — the "monotonic per
   * tenant" tiebreaker within a `trade_date`, which the replay orders
   * by.
   *
   * `pg_advisory_xact_lock` serialises this read-then-insert per tenant for
   * the duration of the enclosing DB transaction. Without it, two concurrent
   * writes for the same tenant would both read the same `max(seq)` under READ
   * COMMITTED and be assigned the same `seq`, and one of them would fail the
   * `UNIQUE (tenant_id, seq)` constraint (migration `0013`) rather than
   * proceed — the lock turns that collision into a short wait instead of a
   * spurious error, and the constraint keeps the invariant true for any
   * write path that forgets the lock. The lock is
   * per tenant (`hashtext(tenant_id)`), so it does not serialise unrelated
   * tenants' writes, and is released automatically at commit or rollback.
   */
  async #nextSeq(tx: Tx): Promise<bigint> {
    await this.#lockTenant(tx);
    const rows = await tx.execute<{ next_seq: string }>(
      sql`select coalesce(max(${transaction.seq}), 0) + 1 as next_seq
          from ${transaction}
          where ${eq(transaction.tenantId, this.#tenantId)}`,
    );
    return BigInt(rows[0]!.next_seq);
  }

  /**
   * Rung 1 of `portfolio-lock.ts`'s order ({@link lockTenantWrites}). Taken by
   * {@link TransactionWriteService.#nextSeq} for every create, and as the
   * **first statement** of `editTransaction`, `deleteTransaction` and
   * `correctFxRate` for every kind — each of them may hold a second portfolio
   * row (a pair's partner, or a target the propagation re-costs), and none can
   * know whether it will before it has read (`security-transfer`,
   * ST-7). {@link TransactionWriteService.#inLedgerWriteTx} is how those three
   * take it, so the order is structural rather than a comment.
   */
  async #lockTenant(tx: Tx): Promise<void> {
    await lockTenantWrites(tx, this.#tenantId);
  }

  /**
   * The transaction `editTransaction`, `deleteTransaction` and `correctFxRate`
   * run on: a fresh `withTenant` transaction whose **first statement is rung
   * 1** — before the row snapshot, and so before any `portfolio` row
   * (`portfolio-lock.ts`'s multi-portfolio rule). What `run` reads is read
   * under the lock, so a transfer link it acts on cannot move underneath it:
   * every writer of `transfer_source_id` holds rung 1 too.
   */
  async #inLedgerWriteTx<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.#db, this.#tenantId, async (tx) => {
      await this.#lockTenant(tx);
      return run(tx);
    });
  }
}
