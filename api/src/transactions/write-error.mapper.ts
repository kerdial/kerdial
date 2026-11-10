import { extractPostgresError } from "@kerdial/platform-db";
import {
  CashAccountArchivedError,
  CashAccountCurrencyMismatchError,
  CashAccountNotAllowedError,
  CashAccountNotFoundError,
  CashAccountRequiredError,
  CashAmountNotAcceptedError,
  CashAmountRequiredError,
  CashAmountStaleError,
  CostComponentsInvalidError,
  ImpliedSettlementRateOutOfRangeError,
  CryptoRateUnavailableError,
  FxRateUnavailableError,
  InsufficientQuantityError,
  InstrumentNotFoundError,
  InvalidDripSourceError,
  InvalidSettlementAssetError,
  OverSellError,
  PostingExpansionError,
  TradeDateInFutureError,
  TradeDateTooOldError,
  TransactionAmountNotPositiveError,
  TransactionArgumentError,
  TransactionCashLegNotAddableError,
  TransactionGrossAmountNotEditableError,
  TransactionNotFoundError,
  TransactionPortfolioNotEditableError,
  TransactionPortfolioNotFoundError,
  TransactionSelfSettledError,
  TransactionShareDistributionShapeError,
  TransactionTransferShapeError,
  TransactionUnitPriceNotEditableError,
  TransferDestinationIsSourceError,
  TransferDestinationNotFoundError,
  TransferPropagationDidNotSettleError,
  TransferTargetReadOnlyError,
} from "@kerdial/ledger";
import { loggableErrorDetail, rootLogger } from "@kerdial/platform-logging";
import { problemException } from "../common/problem.js";

/**
 * Translates `ledger`'s domain errors to `problem+json` — every one of them is
 * a rejected input (4xx), never a raw 500, bar one named internal failure
 * (`TransferPropagationDidNotSettleError`: a 500 with its own code).
 *
 * **One mapper, two callers, and the second one is why this is a module rather
 * than a private method.** It was `TransactionsController#mapWriteError` and is
 * still reached through that method, unchanged, for every `/transactions/*`
 * write. `csv-import` requires the import controller to reuse
 * it rather than write a second one: a cash account archived between an
 * import's dry run and its confirm reaches the write path as
 * `CashAccountArchivedError`, and it must answer `409 CASH_ACCOUNT_ARCHIVED`
 * there exactly as it does for a manual write. A second mapper would be a
 * second contract to keep in step, and the first thing to fall out of step is
 * always the error nobody tested — a `CashAccountArchivedError` reaching a
 * generic filter is a `500`, not a `409`.
 *
 * Returns the exception to throw. Anything it does not recognise is returned
 * **unchanged**, so `ProblemJsonExceptionFilter`'s own SQLSTATE mapping and its
 * logged-500 fallback still get their turn — this function narrows, it never
 * swallows.
 */
export function mapTransactionWriteError(err: unknown): unknown {
  if (err instanceof TransactionNotFoundError) {
    return problemException(404, {
      title: "Transaction not found",
      code: "TRANSACTION_NOT_FOUND",
    });
  }
  // D5: `TransactionsController#create`'s own
  // `getPortfolio` pre-check runs outside `TransactionWriteService`'s write
  // transaction, so a `deletePortfolio` that commits in the gap between
  // that check and the `INSERT` now reaches this service as a translated
  // `TransactionPortfolioNotFoundError` (never a raw `23503`). Mapped to
  // the **same** 404/`PORTFOLIO_NOT_FOUND` the pre-check already returns —
  // no new client-visible contract, per D5's explicit requirement.
  if (err instanceof TransactionPortfolioNotFoundError) {
    return problemException(404, { title: "Portfolio not found", code: "PORTFOLIO_NOT_FOUND" });
  }
  if (err instanceof InsufficientQuantityError) {
    return problemException(409, {
      title: "Insufficient quantity held",
      code: "TRANSACTION_INSUFFICIENT_QUANTITY",
      detail: err.message,
    });
  }
  // Added a fourth `reason`, `DELETED_CONCURRENTLY`: the source
  // dividend was there when `#assertDripSource` read it and gone by the time
  // the `INSERT` reached
  // `transaction_source_dividend_id_transaction_id_fk`, which used to escape
  // as an unmapped raw `23503`/500. It is deliberately mapped to the **same**
  // 400/`TRANSACTION_INVALID_DRIP_SOURCE` the pre-check already returns for
  // `NOT_FOUND` — no new client-visible contract, following D5's explicit
  // rule for the portfolio FK's own race (which reuses the pre-check's 404
  // rather than inventing a status). The original report suggested a 409; the sibling races
  // it cited actually answer 404 and 404, i.e. each reuses its own
  // pre-check's status, and that is the pattern followed here. The client
  // cannot act differently on the two — the dividend is not a valid source
  // either way — so the distinction lives in `reason` for tests and logs,
  // not in the status line.
  if (err instanceof InvalidDripSourceError) {
    return problemException(400, {
      title: "Invalid DRIP source dividend",
      code: "TRANSACTION_INVALID_DRIP_SOURCE",
      detail: err.message,
    });
  }
  if (err instanceof InvalidSettlementAssetError) {
    return problemException(400, {
      title: "Invalid settlement asset",
      code: "TRANSACTION_INVALID_SETTLEMENT_ASSET",
      detail: err.message,
    });
  }
  if (err instanceof TradeDateTooOldError) {
    return problemException(400, {
      title: "Trade date too old",
      code: "TRANSACTION_TRADE_DATE_TOO_OLD",
      detail: err.message,
    });
  }
  if (err instanceof TradeDateInFutureError) {
    return problemException(400, {
      title: "Trade date in the future",
      code: "TRANSACTION_TRADE_DATE_IN_FUTURE",
      detail: err.message,
    });
  }
  if (err instanceof FxRateUnavailableError) {
    return problemException(422, {
      title: "No FX rate available for this transaction",
      code: "TRANSACTION_FX_RATE_UNAVAILABLE",
      detail: err.message,
    });
  }
  if (err instanceof CryptoRateUnavailableError) {
    return problemException(422, {
      title: "No crypto rate available for this settlement asset",
      code: "TRANSACTION_CRYPTO_RATE_UNAVAILABLE",
      detail: err.message,
    });
  }
  // F2(c) (security review, T-38): a BUY/DIVIDEND/
  // asset-settled-BUY create, or an edit changing `instrumentId`/
  // `txnSettlementInstrumentId`, naming a nonexistent instrument is now
  // rejected by `TransactionWriteService` itself (see its own
  // `#assertInstrumentExists`) before the row is ever written, rather than
  // surfacing as a raw `23503` foreign-key-violation 500 — a clean 404,
  // the same code `POST /instruments/:id/prices` already uses for "this
  // instrument does not exist".
  if (err instanceof InstrumentNotFoundError) {
    return problemException(404, {
      title: "Instrument not found",
      code: "INSTRUMENT_NOT_FOUND",
      detail: err.message,
    });
  }
  // F2(b) (security review, T-38): an edit or delete can
  // leave a *later* SELL (or the paid-with side of a crypto-settled BUY)
  // over-selling a position that was only valid before the change —
  // `recomputeAndInvalidate`'s full replay catches this at
  // `computePmp` time, inside the same DB transaction, and rolls the whole
  // edit/delete back. This is the same class of rejection
  // `InsufficientQuantityError` above is for a direct SELL — reusing its
  // 409/`TRANSACTION_INSUFFICIENT_QUANTITY` semantics rather than minting a
  // second code for what a client cannot usefully distinguish from the
  // first (both mean "this would leave a position negative").
  if (err instanceof OverSellError) {
    return problemException(409, {
      title: "Insufficient quantity held",
      code: "TRANSACTION_INSUFFICIENT_QUANTITY",
      detail: err.message,
    });
  }
  // F2(a) (security review, T-38): an edit that adds a
  // fee/withholding leg to a transaction that did not carry one before
  // (or removes the leg's currency while keeping its amount, etc.) can
  // leave `expandPostings` unable to expand the row — it has an amount but
  // no rate for that leg, because `editTransaction` issues a plain
  // `UPDATE` and resolves no FX rate itself (a rate is resolved
  // exactly once, at write time). Mapped to 422 rather than left as a raw
  // 500 — this is a well-formed request that is simply not expressible
  // through this endpoint, not a malformed one.
  if (err instanceof PostingExpansionError) {
    return problemException(422, {
      title: "This edit cannot be expressed as postings",
      code: "TRANSACTION_EDIT_NOT_EXPRESSIBLE",
      detail:
        `${err.message} A generic PATCH cannot resolve a new FX rate for a leg the row ` +
        "never carried (rates are only ever resolved once, at write time). " +
        "A fee can be added on a cash-settled BUY/SELL/DRIP/CURRENCY_EXCHANGE; other kinds cannot gain one.",
    });
  }
  // NEW-3 (final narrow remediation review, T-38): a
  // `grossAmount` reaching a BUY/SELL/DRIP row (`quantity`/`unitPrice` both
  // present) is rejected by `editTransaction`'s own `#reconcileGrossAmount`
  // rather than silently desyncing the cash leg from cost basis — see
  // `TransactionGrossAmountNotEditableError`'s doc comment.
  if (err instanceof TransactionGrossAmountNotEditableError) {
    return problemException(400, {
      title: "grossAmount cannot be set directly on a quantity-priced transaction",
      code: "TRANSACTION_GROSS_AMOUNT_NOT_EDITABLE",
      detail: err.message,
    });
  }
  // A (final narrow fix round, feature/api-transactions): the mirror image
  // of `TransactionGrossAmountNotEditableError` for a settlement-priced BUY
  // (FR-66/AC52) — `unitPrice` is derived there (`grossAmount / quantity`),
  // so a client-supplied value for it is rejected the same way `gross
  // Amount` is rejected on a fiat-priced row. See
  // `TransactionUnitPriceNotEditableError`'s doc comment.
  if (err instanceof TransactionUnitPriceNotEditableError) {
    return problemException(400, {
      title: "unitPrice cannot be set directly on a settlement-priced transaction",
      code: "TRANSACTION_UNIT_PRICE_NOT_EDITABLE",
      detail: err.message,
    });
  }
  // C (final narrow fix round, feature/api-transactions): an edit that
  // would leave a row settling in the instrument it acquires is rejected
  // the same way `recordSettledBuy` rejects the identical shape at
  // creation — see `TransactionSelfSettledError`'s doc comment.
  if (err instanceof TransactionSelfSettledError) {
    return problemException(400, {
      title: "A transaction cannot be settled in the instrument it acquires",
      code: "TRANSACTION_SELF_SETTLED",
      detail: err.message,
    });
  }
  // INFO-1 (final narrow remediation review, T-38):
  // `editTransaction`'s own positivity layer (F1's third enforcement layer)
  // used to throw a bare `TypeError` for a non-positive amount — unreachable
  // via HTTP today (`editTransactionBodySchema` rejects first), but mapped
  // here all the same so a future internal caller bypassing the DTO gets a
  // clean 400, never a raw 500. See `TransactionAmountNotPositiveError`'s
  // own doc comment.
  if (err instanceof TransactionAmountNotPositiveError) {
    return problemException(400, {
      title: "Amount must be positive",
      code: "TRANSACTION_AMOUNT_NOT_POSITIVE",
      detail: err.message,
    });
  }
  // The other eight of `ledger`'s own argument assertions,
  // which threw a bare `TypeError` until that issue: a currency that is not
  // three letters, a `tradeDate` that is not an ISO date, a required id left
  // blank, a CURRENCY_EXCHANGE between one currency and itself or carrying an
  // instrument leg, a trade settled in the instrument it acquires, an
  // `editTransaction` with nothing to change. Each is a *rejected input* the
  // service diagnosed precisely, and each was answered with a 500.
  //
  // **After the specialisation above, never before it** —
  // `TransactionAmountNotPositiveError` extends this class, and it keeps its
  // own `field` and its own code, both of which callers already read.
  //
  // The message is this codebase's own, names the argument, and carries no SQL
  // and no bound parameters (that is the property that let it be echoed at
  // all — see `ROW_SAFE_LEDGER_ERRORS` in the importer for the same rule).
  if (err instanceof TransactionArgumentError) {
    return problemException(400, {
      title: "Invalid argument",
      code: "TRANSACTION_ARGUMENT_INVALID",
      detail: err.message,
    });
  }
  // ---------------------------------------------------------------------
  // CA-11 (error table):
  // the five cash-account rejections `TransactionWriteService` raises, plus
  // CA-10's two edit-path ones. Every one of them is a rejected input, and
  // every one of them would otherwise be a raw `23514`/`23503` 500.
  if (err instanceof CashAccountNotFoundError) {
    // 404, and deliberately the same answer for "not yours" as for "not
    // there" (AC33) — RLS and the composite FK make the two
    // indistinguishable on purpose.
    return problemException(404, {
      title: "Cash account not found",
      code: "CASH_ACCOUNT_NOT_FOUND",
      detail: err.message,
    });
  }
  if (err instanceof CashAccountCurrencyMismatchError) {
    return problemException(400, {
      title: "Cash account currency does not match this leg",
      code: "CASH_ACCOUNT_CURRENCY_MISMATCH",
      detail: err.message,
    });
  }
  if (err instanceof CashAccountArchivedError) {
    return problemException(409, {
      title: "Cash account is archived",
      code: "CASH_ACCOUNT_ARCHIVED",
      detail: err.message,
    });
  }
  if (err instanceof CashAccountRequiredError) {
    return problemException(400, {
      title: "This leg moves cash and must name a cash account",
      code: "CASH_ACCOUNT_REQUIRED",
      detail: err.message,
    });
  }
  if (err instanceof CashAccountNotAllowedError) {
    return problemException(400, {
      title: "This leg moves no cash and cannot name a cash account",
      code: "CASH_ACCOUNT_NOT_ALLOWED",
      detail: err.message,
    });
  }
  // ---------------------------------------------------------------------
  // FT-17: the three
  // settlement-figure rejections `TransactionWriteService` raises. Each gets
  // its **own** code, and none of them is the generic
  // `TRANSACTION_INVALID_SHAPE` the `23514` branch below produces: all three
  // say "your input is fine, but this endpoint derives that figure", which is
  // a different sentence from "the information you entered is incoherent".
  // Mapping them onto one code would put the user back in the position the CA-10 case
  // records for `TransactionCashLegNotAddableError` — a correct input
  // reported as a malformed one.
  //
  // 400 rather than 409 for all three: nothing about the row's *state*
  // refuses them (that is what makes `CashAccountArchivedError` a 409); the
  // request named a figure this write does not take, or omitted one it does.
  if (err instanceof CashAmountNotAcceptedError) {
    return problemException(400, {
      title: "This transaction's settled amount is derived, not supplied",
      code: "CASH_AMOUNT_NOT_ACCEPTED",
      detail: err.message,
    });
  }
  // Unreachable over HTTP while `createTransactionBodySchema`'s pairing rule
  // stands (a `cashCurrency` with no `cashAmount` is `parseOrThrow`'s 400
  // `VALIDATION_ERROR`, with a per-field issue, first) — mapped all the same,
  // for the reason
  // INFO-1 records just above for `TransactionAmountNotPositiveError`: an
  // internal caller bypassing the DTO must get a clean 400, never a raw 500.
  if (err instanceof CashAmountRequiredError) {
    return problemException(400, {
      title: "This settlement's amount cannot be derived and must be supplied",
      code: "CASH_AMOUNT_REQUIRED",
      detail: err.message,
    });
  }
  // L16(a)/L16(c): the *incomplete* edit is refused, not the edit — the same
  // request carrying the new `cashAmount` succeeds, which is why the detail
  // carries the service's own "supply cashAmount in the same request"
  // sentence.
  //
  // Two titles, one code. FR-254 names three triggers and only
  // the gross one was implemented, so the single title used to state the wrong
  // cause for the trigger that was missing — a caller re-pointing a leg to
  // another currency would have been told their edit "moves the gross amount".
  // The code stays `CASH_AMOUNT_STALE` for both: the remedy is identical, and
  // `reason` is on the error for anything that needs to tell them apart.
  if (err instanceof CashAmountStaleError) {
    return problemException(400, {
      title:
        err.reason === "SETTLEMENT_CURRENCY_CHANGED"
          ? "This edit changes the settling currency and must carry the new settled amount"
          : "This edit moves the gross amount and must carry the new settled amount",
      code: "CASH_AMOUNT_STALE",
      detail: err.message,
    });
  }
  // FR-213/FR-214 (phase 2): the itemisation is incoherent — the components do
  // not sum to the supplied total, or they were named on a row that settles in
  // an asset and so has no account to denominate them in. **400, with the
  // three `CASH_AMOUNT_*` refusals**, because it is the same sentence: the
  // information supplied contradicts itself. Not the generic
  // `TRANSACTION_INVALID_SHAPE`, and never left to
  // `transaction_cost_components_sum_to_fee_amount` to report as a bare 23514
  // the controller could only describe as "invalid shape".
  if (err instanceof CostComponentsInvalidError) {
    return problemException(400, {
      title: "This transaction's cost breakdown does not add up",
      code: "COST_COMPONENTS_INVALID",
      detail: err.message,
    });
  }
  // The implied-rate overflow. **422, not 400**, and deliberately not one of the three
  // above: the request is well formed and internally coherent — the pair is
  // paired, both figures are positive, the database would accept the row — and
  // what fails is deriving a *representable* posting from it. The three
  // `CASH_AMOUNT_*` codes say "this endpoint derives that figure"; this one
  // says "understood, and the figure it implies does not fit", which is the
  // same sentence `TRANSACTION_EDIT_NOT_EXPRESSIBLE` carries.
  //
  // Without this branch the input reaches `regeneratePostings` and raises a
  // bare `22003` with no entry anywhere in this mapper — a 500 for a user
  // input problem, which is what the issue was filed for.
  if (err instanceof ImpliedSettlementRateOutOfRangeError) {
    return problemException(422, {
      title: "This settled amount implies a settlement rate too large to record",
      code: "IMPLIED_SETTLEMENT_RATE_OUT_OF_RANGE",
      detail: err.message,
    });
  }
  // CA-10: a portfolio move is not expressible here.
  if (err instanceof TransactionPortfolioNotEditableError) {
    return problemException(400, {
      title: "A transaction cannot be moved to another portfolio",
      code: "TRANSACTION_PORTFOLIO_NOT_EDITABLE",
      detail: err.message,
    });
  }
  // (CA-10): adding a fee leg to a row that carries none
  // is not expressible through this endpoint — mapped back onto the exact
  // 422 `TRANSACTION_EDIT_NOT_EXPRESSIBLE` contract this input had before
  // migration `0038`'s pairing CHECK started refusing it first as a bare
  // `23514` (which F3's branch below could only call "invalid shape", a
  // misleading message for input that is not, in fact, incoherent). See
  // `TransactionCashLegNotAddableError`'s own doc comment.
  if (err instanceof TransactionCashLegNotAddableError) {
    return problemException(422, {
      title: "This edit cannot be expressed as postings",
      code: "TRANSACTION_EDIT_NOT_EXPRESSIBLE",
      detail: err.message,
    });
  }
  // A malformed cashless distribution edit. **422, and deliberately not the `23514` branch's 400
  // `TRANSACTION_INVALID_SHAPE` below**, which is exactly where this input used
  // to end up: the body is well formed and internally coherent — a real uuid, a
  // positive price — and what fails is that *this row's kind* has no such
  // field. That is `TRANSACTION_EDIT_NOT_EXPRESSIBLE`'s sentence ("understood,
  // and not expressible here"), not `TRANSACTION_INVALID_SHAPE`'s ("the
  // information you entered is incoherent"), and the CA-10 case records what happens when
  // the two are conflated: a correct input reported as a malformed one.
  //
  // Its own code rather than a second use of `TRANSACTION_EDIT_NOT_EXPRESSIBLE`
  // because the remedy differs. That one says "delete and recreate with the leg
  // present from the start"; this one says the field belongs to another kind
  // entirely, and the web copy has to be able to say so.
  if (err instanceof TransactionShareDistributionShapeError) {
    return problemException(422, {
      title: "A cashless share distribution has no such field",
      code: "TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE",
      detail: err.message,
    });
  }
  // ---------------------------------------------------------------------
  // The four refusals the transfer write
  // paths raise. Each would otherwise be a 500.
  //
  // FR-577's server half. `createTransactionBodySchema` and the controller's
  // raw-body check refuse the same body first, so over HTTP this is the
  // backstop for a caller that reaches the service another way — the same
  // code, so the client cannot tell which layer answered.
  if (err instanceof TransferDestinationIsSourceError) {
    return problemException(400, {
      title: "A transfer's destination must differ from its source portfolio",
      code: "TRANSFER_DESTINATION_IS_SOURCE",
      detail: err.message,
    });
  }
  // AC-471: another tenant's real portfolio is "not there" under RLS, so it
  // reaches this branch exactly as a nonexistent id does — same status, same
  // code, and a detail naming only the id the caller supplied.
  if (err instanceof TransferDestinationNotFoundError) {
    return problemException(404, {
      title: "Destination portfolio not found",
      code: "TRANSFER_DESTINATION_NOT_FOUND",
      detail: err.message,
    });
  }
  // 422 for both, on `TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE`'s reading:
  // a well-formed edit, of a field this row cannot take.
  if (err instanceof TransferTargetReadOnlyError) {
    return problemException(422, {
      title: "A linked transfer's receiving leg is read-only but for its note and reference",
      code: "TRANSACTION_TRANSFER_TARGET_READ_ONLY",
      detail: err.message,
    });
  }
  if (err instanceof TransactionTransferShapeError) {
    return problemException(422, {
      title: "A security transfer has no such field",
      code: "TRANSACTION_TRANSFER_INVALID_SHAPE",
      detail: err.message,
    });
  }
  // The one branch here that is **not** a rejected input. The transfer
  // propagation's round cap (`transfer-link.ts`) is unreachable
  // by its termination argument; reaching it means a linked pair breaks the
  // ordering the propagation relies on, and the write was rolled back.
  //
  // **500, not 409.** This mapper's one other internal-invariant signal,
  // `TRANSACTION_FX_LEG_IMMUTABLE` below, is a 409 because a request tried to
  // change state the database protects; here no request is at fault and none
  // can be amended to succeed. It is named only so the screen can say which
  // operation failed instead of a generic « erreur serveur ».
  //
  // Logged here, because the filter logs only what reaches it unmapped: an
  // `HttpException` of any status skips its "unhandled error mapped to 500"
  // line, which is the signal an operator needs for exactly this error. No
  // `detail`: the message names the tenant and the round cap, which are
  // internal.
  if (err instanceof TransferPropagationDidNotSettleError) {
    rootLogger().error("transfer propagation did not settle", {
      error: loggableErrorDetail(err),
    });
    return problemException(500, {
      title: "Re-costing linked security transfers did not settle",
      code: "TRANSFER_PROPAGATION_DID_NOT_SETTLE",
    });
  }
  // Defence in depth (FR-57/AC47's third, database-level enforcement
  // mechanism).
  //
  // F3 (security review, T-38): a `23514` (check_violation)
  // reaching this controller is no longer assumed to always be
  // `trg_transaction_fx_immutable` — the six per-kind shape `CHECK`s
  // (`0003_ledger-schema.sql`) and the six positivity `CHECK`s
  // (migration `0025`) are also reachable via the edit DTO (`kind` is only
  // known once the row is loaded, so `editTransactionBodySchema` cannot
  // statically rule out every per-kind shape mismatch — e.g.
  // `PATCH <a DEPOSIT> {"instrumentId":"<real uuid>"}` is well-typed Zod
  // input that only `transaction_deposit_withdrawal_shape` rejects).
  // `trg_transaction_fx_immutable` raises via a bare `RAISE EXCEPTION ...
  // USING ERRCODE = '23514'` (migration `0004`) — a trigger-raised error
  // carries no constraint name at all — while every `CHECK` violation
  // always does. Branching on `constraintName`'s presence tells the two
  // apart, so a fat-fingered shape edit is a 400 "invalid shape" and
  // cannot masquerade as (or bury) the FX-immutability canary this code
  // exists to signal.
  const pgError = extractPostgresError(err);
  if (pgError?.sqlstate === "23514") {
    if (pgError.constraintName === undefined) {
      return problemException(409, {
        title: "Transaction FX legs are immutable outside PATCH /transactions/:id/fx-rate",
        code: "TRANSACTION_FX_LEG_IMMUTABLE",
      });
    }
    return problemException(400, {
      title: "Transaction is not shaped correctly for its kind",
      code: "TRANSACTION_INVALID_SHAPE",
      detail:
        "the requested change would leave this transaction violating one of its own per-kind field-presence or sign constraints",
    });
  }
  return err;
}
