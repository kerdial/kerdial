import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import type { Db, TenantId } from "@kerdial/platform-db";
import {
  getPortfolio,
  getTransactionById,
  listTransactions,
  summarizeTransactionCalendar,
  type FeeInput,
  type TransactionEdit,
  type TransactionReadRecord,
  type TransactionRecord,
  type WithholdingInput,
} from "@kerdial/ledger";
import type { SessionContext } from "@kerdial/platform-auth";
import type { MarketRuntime } from "@kerdial/market-composition";
import { DB } from "../db/db.tokens.js";
import { MARKET_RUNTIME } from "../market/market-runtime.tokens.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { parseIdParam } from "../common/id-param.schema.js";
import { buildCursorPage, decodeOffsetCursor, parsePageLimit } from "../common/pagination.js";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { createTransactionWriteServiceForTenant } from "./transaction-write-service.factory.js";
import { mapTransactionWriteError } from "./write-error.mapper.js";
import {
  GUARDED_FX_EDIT_FIELDS,
  correctFxRateBodySchema,
  createTransactionBodySchema,
  editTransactionBodySchema,
  listTransactionsQuerySchema,
  toTransactionCalendarResponse,
  toTransactionResponse,
  transactionCalendarQuerySchema,
  type CreateTransactionBody,
  type ListTransactionsQuery,
  type TransactionCalendarResponse,
  type TransactionResponse,
} from "./transactions.schema.js";

/**
 * `/transactions/*` — T-38. Thin
 * controllers over T-19/T-20's `TransactionWriteService` (create, all seven
 * kinds plus the asset-settled BUY), T-22's `editTransaction`/
 * `deleteTransaction`/`correctFxRate`, and T-38's own
 * `transaction-read-service.js` (`listTransactions`/`getTransactionById`). No
 * business logic here: every decision (FX precedence, over-sell rejection,
 * DRIP source validation, posting expansion, invalidation) lives in
 * `@kerdial/ledger`.
 *
 * **FR-57/AC47 at the HTTP boundary.** `PATCH /transactions/:id` cannot
 * change a stored FX leg: {@link GUARDED_FX_EDIT_FIELDS} is checked against
 * the raw request body before Zod even parses it, and a request naming any
 * of them is rejected with a 400 `problem+json` pointing at
 * `PATCH /transactions/:id/fx-rate` — the only endpoint that calls
 * `correctFxRate()`. See `transactions.schema.ts`'s doc comment on
 * `editTransactionBodySchema` for the full reasoning.
 *
 * **`MARKET_RUNTIME` (IB8).** Injected only to be handed to
 * {@link createTransactionWriteServiceForTenant} at each of the four write
 * call sites below, which is what activates
 * `TransactionWriteService#triggerInstrumentBackfill` — the "first transaction
 * referencing an instrument" backfill trigger, latent until this cycle. The
 * token is provided `global: true` by `MarketRuntimeModule.forRoot`, so this
 * needs no module wiring change, and it is `null` in every configuration
 * without `INGESTION_DATABASE_URL` (and in every test app built through
 * `test-support/test-app.ts`'s default), where the trigger stays inert exactly
 * as before.
 */
@Controller("transactions")
export class TransactionsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MARKET_RUNTIME) private readonly marketRuntime: MarketRuntime | null,
  ) {}

  /** `POST /transactions` (FR-6..FR-10, FR-59, FR-66) — all seven kinds, plus the asset-settled BUY. */
  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<TransactionResponse> {
    this.#rejectUncreatableTransferBody(body);
    const parsed = parseOrThrow(createTransactionBodySchema, body);

    // Defence in depth against cross-tenant injection: `portfolio` is
    // tenant-owned and RLS-protected, but a raw FK check alone would not
    // stop a client naming another tenant's portfolio id (referential
    // integrity checks are not RLS-aware) — `getPortfolio` is the same
    // tenant-scoped lookup `GET /portfolios/:id` would use.
    const portfolioRow = await getPortfolio(this.db, session.tenantId, parsed.portfolioId);
    if (!portfolioRow) {
      throw problemException(404, { title: "Portfolio not found", code: "PORTFOLIO_NOT_FOUND" });
    }

    const service = await createTransactionWriteServiceForTenant(
      this.db,
      session.tenantId,
      this.marketRuntime,
    );

    let row: TransactionRecord;
    try {
      row = await this.#record(service, parsed);
    } catch (err) {
      throw this.#mapWriteError(err);
    }
    return toTransactionResponse(await this.#withTransferLink(session.tenantId, row));
  }

  /**
   * `GET /transactions?portfolio=&instrument=&from=&to=&kind=&currency=&minAmount=&maxAmount=&cursor=&limit=`
   * — the documented filtering capability (the dedicated filter
   * UI, FR-37/AC27, is [P1-LATER]/C20).
   *
   * The last four filters came later. `kind` is what retires the Activité
   * screen's client-side type narrowing (which filtered one loaded page and
   * said so in an apology next to the control); `currency` scopes to the
   * trade's own denomination; `minAmount`/`maxAmount` bound `gross_amount` in
   * **that** denomination, which is why {@link #requireCurrencyForAmountBounds}
   * refuses either of them without a `currency`.
   *
   * Bounded by the instance-wide admission bound (formerly MEDIUM-2's
   * shared per-tenant cheap-read cap).
   */
  @Get()
  async list(
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<{ items: TransactionResponse[]; nextCursor: string | null }> {
    const parsed = parseOrThrow(listTransactionsQuerySchema, query);
    this.#requireCurrencyForAmountBounds(parsed);
    const offset = decodeOffsetCursor(parsed.cursor);
    const limit = parsePageLimit(parsed.limit);

    const rows = await listTransactions(this.db, session.tenantId, {
      ...(parsed.portfolio !== undefined ? { portfolioId: parsed.portfolio } : {}),
      ...(parsed.instrument !== undefined ? { instrumentId: parsed.instrument } : {}),
      ...(parsed.from !== undefined ? { fromDate: parsed.from } : {}),
      ...(parsed.to !== undefined ? { toDate: parsed.to } : {}),
      ...(parsed.order !== undefined ? { order: parsed.order } : {}),
      ...(parsed.kind !== undefined ? { kinds: parsed.kind } : {}),
      ...(parsed.currency !== undefined ? { txnCurrency: parsed.currency } : {}),
      ...(parsed.minAmount !== undefined ? { minGrossAmount: parsed.minAmount } : {}),
      ...(parsed.maxAmount !== undefined ? { maxGrossAmount: parsed.maxAmount } : {}),
      limit: limit + 1,
      offset,
    });

    const page = buildCursorPage(rows, offset, limit);
    return { items: page.items.map(toTransactionResponse), nextCursor: page.nextCursor };
  }

  /**
   * `GET /transactions/calendar?portfolio=&instrument=&from=&to=&kind=&currency=&minAmount=&maxAmount=`
   * — the Activité screen's « Calendrier » tab: transaction
   * count and traded volume in the ledger base per calendar month and year,
   * plus the total, from **one** `GROUP BY` over exactly the scope `list`
   * pages through (`scopeConditions` is shared, so the two cannot drift).
   *
   * **Declared before `GET /transactions/:id`**, and that is load-bearing:
   * Nest matches routes in declaration order, and `calendar` would otherwise
   * reach `getOne`, whose `parseIdParam` refuses it as a malformed uuid (400).
   *
   * Same query schema as the list minus `cursor`/`limit`/`order`, same
   * currency-bounds refusal, same shared cheap-read concurrency cap. No
   * `calcEpoch` — a direct read of write-time state, like the list.
   */
  @Get("calendar")
  async calendar(
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<TransactionCalendarResponse> {
    const parsed = parseOrThrow(transactionCalendarQuerySchema, query);
    this.#requireCurrencyForAmountBounds(parsed);

    const calendar = await summarizeTransactionCalendar(this.db, session.tenantId, {
      ...(parsed.portfolio !== undefined ? { portfolioId: parsed.portfolio } : {}),
      ...(parsed.instrument !== undefined ? { instrumentId: parsed.instrument } : {}),
      ...(parsed.from !== undefined ? { fromDate: parsed.from } : {}),
      ...(parsed.to !== undefined ? { toDate: parsed.to } : {}),
      ...(parsed.kind !== undefined ? { kinds: parsed.kind } : {}),
      ...(parsed.currency !== undefined ? { txnCurrency: parsed.currency } : {}),
      ...(parsed.minAmount !== undefined ? { minGrossAmount: parsed.minAmount } : {}),
      ...(parsed.maxAmount !== undefined ? { maxGrossAmount: parsed.maxAmount } : {}),
    });
    return toTransactionCalendarResponse(calendar);
  }

  /**
   * `GET /transactions/:id` — AC9's read-back half ("a subsequent GET returns 404" after delete).
   *
   * MEDIUM-2 (security review): see `list`'s own doc comment.
   */
  @Get(":id")
  async getOne(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<TransactionResponse> {
    const id = parseIdParam(rawId);
    const row = await getTransactionById(this.db, session.tenantId, id);
    if (!row) {
      throw problemException(404, {
        title: "Transaction not found",
        code: "TRANSACTION_NOT_FOUND",
      });
    }
    return toTransactionResponse(row);
  }

  /** `PATCH /transactions/:id` (FR-13, AC8) — the generic in-place edit. Never the FX-correction path; see this class's own doc comment. */
  @Patch(":id")
  async patch(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<TransactionResponse> {
    const id = parseIdParam(rawId);
    this.#rejectGuardedFxFields(body);
    this.#rejectKindEdit(body);
    const parsed = parseOrThrow(editTransactionBodySchema, body);

    if (Object.keys(parsed).length === 0) {
      throw problemException(400, {
        title: "Empty edit",
        code: "TRANSACTION_EDIT_EMPTY",
        detail: "at least one editable field must be supplied",
      });
    }

    const service = await createTransactionWriteServiceForTenant(
      this.db,
      session.tenantId,
      this.marketRuntime,
    );
    let row: TransactionRecord;
    try {
      row = await service.editTransaction({
        id,
        changedBy: session.userId,
        changes: parsed as TransactionEdit,
      });
    } catch (err) {
      throw this.#mapWriteError(err);
    }
    return toTransactionResponse(await this.#withTransferLink(session.tenantId, row));
  }

  /**
   * `PATCH /transactions/:id/fx-rate` (FR-64, AC50) — the **only**
   * `fx_correction` HTTP path. Calls `correctFxRate()` and nothing else.
   */
  @Patch(":id/fx-rate")
  async patchFxRate(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<TransactionResponse> {
    const id = parseIdParam(rawId);
    const parsed = parseOrThrow(correctFxRateBodySchema, body);

    const service = await createTransactionWriteServiceForTenant(
      this.db,
      session.tenantId,
      this.marketRuntime,
    );
    let row: TransactionRecord;
    try {
      row = await service.correctFxRate({
        id,
        fxRate: parsed.fxRate,
        changedBy: session.userId,
      });
    } catch (err) {
      throw this.#mapWriteError(err);
    }
    return toTransactionResponse(await this.#withTransferLink(session.tenantId, row));
  }

  /** `DELETE /transactions/:id` (AC9, FR-13) — a hard delete. */
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<void> {
    const id = parseIdParam(rawId);
    const service = await createTransactionWriteServiceForTenant(
      this.db,
      session.tenantId,
      this.marketRuntime,
    );
    try {
      await service.deleteTransaction({ id, changedBy: session.userId });
    } catch (err) {
      throw this.#mapWriteError(err);
    }
  }

  /**
   * FR-57/AC47: a raw request body naming any FX-leg column is rejected
   * outright, before {@link editTransactionBodySchema} (which never defines
   * these fields at all) even runs — so the rejection is explicit and
   * per-field, not merely "the field had no effect".
   */
  /**
   * F4 (security review, T-38): the four currency-leg fields
   * are guarded here too (see `transactions.schema.ts`'s
   * `GUARDED_FX_EDIT_FIELDS` doc comment) — but, unlike an FX-rate field,
   * there is no dedicated endpoint that lets one of these fields be corrected
   * in place (`PATCH /transactions/:id/fx-rate` only ever touches the
   * principal `fx_rate`), so the per-field message for one of them points at
   * delete+recreate instead.
   *
   * NEW-2 (final narrow remediation review, T-38):
   * `txnSettlementInstrumentId` joins this set for the same reason — a
   * resolved FX rate is pinned for the settlement asset the row was written
   * with, exactly as it is pinned for a currency. `tradeDate` left the set
   * under D1 (a date change keeps the stored rate).
   */
  private static readonly GUARDED_STRUCTURAL_FIELDS = new Set<string>([
    "txnCurrency",
    "targetCurrency",
    "feeCurrency",
    "txnSettlementInstrumentId",
  ]);

  /**
   * (migration `0079`): a withholding is one amount in the settling
   * account's currency. These columns no longer exist, so they are not in
   * {@link GUARDED_FX_EDIT_FIELDS} (typed against the live table) — but a body
   * still naming one is refused per field rather than silently stripped.
   */
  private static readonly RETIRED_WITHHOLDING_FIELDS = [
    "withholdingCurrency",
    "whtCashAccountId",
    "whtFxRate",
    "whtFxRateSource",
    "whtFxRateProviderKey",
    "whtFxRateObservedOn",
    "whtFxRateUserInput",
  ] as const;

  #rejectGuardedFxFields(body: unknown): void {
    if (typeof body !== "object" || body === null) return;
    const retired = TransactionsController.RETIRED_WITHHOLDING_FIELDS.filter(
      (field) => field in body,
    );
    if (retired.length > 0) {
      throw problemException(400, {
        title: "These withholding fields no longer exist",
        code: "TRANSACTION_FX_EDIT_FORBIDDEN",
        detail:
          `A withholding has no currency, rate or account of its own any more: it is one amount ` +
          `(withholdingAmount) in the settling account's currency. Not allowed here: ${retired.join(", ")}`,
        errors: retired.map((field) => ({
          field,
          message:
            "no longer exists: the withholding has no own currency, rate or account; only withholdingAmount can be edited",
        })),
      });
    }
    const present = GUARDED_FX_EDIT_FIELDS.filter((field) => field in body);
    if (present.length > 0) {
      throw problemException(400, {
        title: "Cannot change an FX rate or currency/settlement leg via PATCH /transactions/:id",
        code: "TRANSACTION_FX_EDIT_FORBIDDEN",
        detail:
          `An FX rate can only be corrected via PATCH /transactions/:id/fx-rate (FR-64, AC47/AC50); ` +
          `a currency or settlement-instrument field cannot be corrected in place at all ` +
          `(the row's resolved FX rate was pinned for the old value, and would go stale) ` +
          `— delete this transaction and recreate it with the right value instead. ` +
          `Not allowed here: ${present.join(", ")}`,
        errors: present.map((field) => ({
          field,
          message: TransactionsController.GUARDED_STRUCTURAL_FIELDS.has(field)
            ? "cannot be changed via PATCH /transactions/:id; delete and recreate the transaction with the right value"
            : "cannot be changed via PATCH /transactions/:id; use PATCH /transactions/:id/fx-rate",
        })),
      });
    }
  }

  /**
   * `cash-interest` (F-A1, C-7): a PATCH body naming `kind`
   * is refused on the raw body, before Zod. `editTransactionBodySchema` would
   * otherwise strip the key — `{kind}` became an empty edit and `{kind, note}`
   * a silent 200 that ignored the kind. A kind is not editable for any row:
   * every shape CHECK, flow class and posting hangs on it.
   */
  #rejectKindEdit(body: unknown): void {
    if (typeof body !== "object" || body === null) return;
    if (!("kind" in body)) return;
    throw problemException(400, {
      title: "A transaction's kind cannot be changed",
      code: "TRANSACTION_KIND_NOT_EDITABLE",
      detail:
        "le type d'une transaction n'est pas modifiable : supprimez puis recréez la transaction",
      errors: [
        {
          field: "kind",
          message:
            "cannot be changed via PATCH /transactions/:id; delete and recreate the transaction",
        },
      ],
    });
  }

  /**
   * The two create bodies that are refused
   * for what they *are*, answered with their own codes rather than the generic
   * `VALIDATION_ERROR` — checked on the raw body before Zod runs, as
   * {@link #rejectGuardedFxFields} is, so the code does not depend on the rest
   * of the body parsing.
   *
   * `createTransactionBodySchema` refuses both too (on `kind` and on
   * `destinationPortfolioId`), which is what the web form validates against;
   * this is the server's naming of the same two refusals.
   */
  #rejectUncreatableTransferBody(body: unknown): void {
    if (typeof body !== "object" || body === null) return;
    const raw = body as Record<string, unknown>;
    if (raw["kind"] === "TRANSFER_IN") {
      throw problemException(400, {
        title: "A TRANSFER_IN is created only through its TRANSFER_OUT",
        code: "TRANSACTION_TRANSFER_IN_NOT_CREATABLE",
        detail:
          "record the TRANSFER_OUT with a destinationPortfolioId; its receiving leg is written with it",
        errors: [{ field: "kind", message: "TRANSFER_IN cannot be created directly" }],
      });
    }
    if (
      raw["kind"] === "TRANSFER_OUT" &&
      typeof raw["destinationPortfolioId"] === "string" &&
      typeof raw["portfolioId"] === "string" &&
      // Lowercased: a uuid is case-insensitive to Postgres.
      raw["destinationPortfolioId"].toLowerCase() === raw["portfolioId"].toLowerCase()
    ) {
      throw problemException(400, {
        title: "A transfer's destination must differ from its source portfolio",
        code: "TRANSFER_DESTINATION_IS_SOURCE",
        errors: [
          {
            field: "destinationPortfolioId",
            message: "must differ from portfolioId (FR-577)",
          },
        ],
      });
    }
  }

  /**
   * The row a write returned, with its transfer partner.
   *
   * The write service returns the stored row only, so for the two transfer
   * kinds the response is read back through the list/detail projection — one
   * statement, after the commit. Every other kind has no partner, and costs no
   * extra read. If the row was deleted in the gap (a concurrent delete of the
   * pair), the write's own row is answered unlinked: it is what was written.
   */
  async #withTransferLink(
    tenantId: TenantId,
    row: TransactionRecord,
  ): Promise<TransactionReadRecord> {
    const unlinked = { ...row, transferLinkedTransactionId: null, transferLinkedPortfolioId: null };
    if (row.kind !== "TRANSFER_OUT" && row.kind !== "TRANSFER_IN") return unlinked;
    return (await getTransactionById(this.db, tenantId, row.id)) ?? unlinked;
  }

  /**
   * **An amount bound is meaningless without the currency it is
   * denominated in.**
   *
   * `transaction.gross_amount` is stored in the trade's own `txn_currency` and
   * this endpoint converts nothing, so `?minAmount=1000` across a mixed-currency
   * ledger would compare 1 000 JPY against 1 000 EUR and return a page whose
   * membership means nothing — the class of quietly-wrong answer this cycle
   * exists to remove, not a shape a caller could inspect and correct.
   *
   * **422, not 400**, on the same reading `PortfoliosController#mapValuationError`
   * and `DividendsController#mapSummaryError` already apply: every parameter
   * here is individually well-formed and the syntax is fine — the *combination*
   * is not something this resource can answer. The remedy is stated in `detail`
   * and named per-field, so a client is told which parameter to add rather than
   * which to remove.
   */
  #requireCurrencyForAmountBounds(
    parsed: Pick<ListTransactionsQuery, "currency" | "minAmount" | "maxAmount">,
  ): void {
    if (parsed.currency !== undefined) return;
    const bounds = (["minAmount", "maxAmount"] as const).filter(
      (field) => parsed[field] !== undefined,
    );
    if (bounds.length === 0) return;
    throw problemException(422, {
      title: "An amount filter requires a currency",
      code: "TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY",
      detail:
        `gross_amount is denominated in the transaction's own txn_currency and is never converted, ` +
        `so an amount bound can only be honoured within a single currency — add currency=<ISO 4217> ` +
        `alongside it. Supplied without one: ${bounds.join(", ")}`,
      errors: bounds.map((field) => ({
        field,
        message: "requires the currency query parameter to be set as well",
      })),
    });
  }

  #buildFee(parsed: CreateTransactionBody): FeeInput | undefined {
    if (!parsed.fee) return undefined;
    return {
      // FR-213: optional since phase 2 — when components are supplied the
      // total is their exact sum, resolved by the service so the client and
      // the database cannot disagree about the arithmetic.
      ...(parsed.fee.amount !== undefined ? { amount: parsed.fee.amount } : {}),
      // `currency`, `cashAccountId` and `fxRateUserInput` used to be mapped
      // here. `feeBodySchema` is a `z.strictObject` of exactly
      // `amount` and `components` now, so a body still carrying them is a 400
      // naming the field rather than a silent strip (RF8).
      ...(parsed.fee.components !== undefined ? { components: parsed.fee.components } : {}),
    };
  }

  #buildWithholding(parsed: CreateTransactionBody): WithholdingInput | undefined {
    if (!parsed.withholding) return undefined;
    // One amount, denominated by the settling account.
    return { amount: parsed.withholding.amount };
  }

  async #record(
    service: Awaited<ReturnType<typeof createTransactionWriteServiceForTenant>>,
    parsed: CreateTransactionBody,
  ): Promise<TransactionRecord> {
    const fee = this.#buildFee(parsed);
    const common = {
      portfolioId: parsed.portfolioId,
      tradeDate: parsed.tradeDate,
      ...(parsed.tradeTs !== undefined ? { tradeTs: parsed.tradeTs } : {}),
      ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      // Spread conditionally, like `note` and `tradeTs` beside
      // it: `exactOptionalPropertyTypes` distinguishes an absent key from an
      // explicit `undefined`, and `transactionReferenceSchema` produces
      // exactly `undefined` for a blank the user typed and then cleared — so
      // "absent" must not travel to the service as a supplied key.
      ...(parsed.reference !== undefined ? { reference: parsed.reference } : {}),
    };
    /**
     * FT-17 (FR-253/FR-255): the principal leg's own denomination, forwarded
     * to the seven kinds whose param types declare it. **Absent when the client
     * omitted it**, which is the degenerate case and is what keeps every
     * pre-cycle body byte-compatible (AC-278) — never `{ cashCurrency:
     * undefined }`, because `#resolveCashLeg` branches on `undefined` versus
     * supplied and an explicit `undefined` would read the same but travel
     * through the `exactOptionalPropertyTypes` boundary as a supplied key.
     *
     * Deliberately **not** spread into `recordCurrencyExchange` or
     * `recordSettledBuy`: neither param type declares these fields (FR-235,
     * FR-236), and adding them would not compile. A CURRENCY_EXCHANGE body
     * carrying the *degenerate* pair is accepted by the create schema and
     * dropped here, which is observably identical to forwarding it — the
     * service writes exactly that pair itself, and
     * `transaction_currency_exchange_cash_leg_pinned` refuses any other.
     * A contradicting pair never gets this far: the schema rejects it 400.
     */
    const cashLeg = {
      ...(parsed.cashCurrency !== undefined ? { cashCurrency: parsed.cashCurrency } : {}),
      ...(parsed.cashAmount !== undefined ? { cashAmount: parsed.cashAmount } : {}),
    };

    switch (parsed.kind) {
      case "BUY": {
        if (parsed.settlement) {
          return service.recordSettledBuy({
            ...common,
            // superRefine already guarantees these are present for this branch.
            instrumentId: parsed.instrumentId!,
            quantity: parsed.quantity!,
            settlement: {
              instrumentId: parsed.settlement.instrumentId,
              amount: parsed.settlement.amount,
              ...(parsed.settlement.fxRateUserInput !== undefined
                ? { fxRateUserInput: parsed.settlement.fxRateUserInput }
                : {}),
            },
            ...(fee !== undefined ? { fee } : {}),
          });
        }
        return service.recordBuy({
          ...common,
          instrumentId: parsed.instrumentId!,
          quantity: parsed.quantity!,
          unitPrice: parsed.unitPrice!,
          txnCurrency: parsed.currency!,
          cashAccountId: parsed.cashAccountId!,
          ...cashLeg,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
          ...(fee !== undefined ? { fee } : {}),
        });
      }
      case "SELL":
        return service.recordSell({
          ...common,
          instrumentId: parsed.instrumentId!,
          quantity: parsed.quantity!,
          unitPrice: parsed.unitPrice!,
          txnCurrency: parsed.currency!,
          cashAccountId: parsed.cashAccountId!,
          ...cashLeg,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
          ...(fee !== undefined ? { fee } : {}),
        });
      case "DEPOSIT":
        return service.recordDeposit({
          ...common,
          amount: parsed.amount!,
          currency: parsed.currency!,
          cashAccountId: parsed.cashAccountId!,
          ...cashLeg,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
        });
      case "WITHDRAWAL":
        return service.recordWithdrawal({
          ...common,
          amount: parsed.amount!,
          currency: parsed.currency!,
          cashAccountId: parsed.cashAccountId!,
          ...cashLeg,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
        });
      case "DIVIDEND": {
        const withholding = this.#buildWithholding(parsed);
        return service.recordDividend({
          ...common,
          instrumentId: parsed.instrumentId!,
          amount: parsed.amount!,
          currency: parsed.currency!,
          cashAccountId: parsed.cashAccountId!,
          ...cashLeg,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
          ...(withholding !== undefined ? { withholding } : {}),
        });
      }
      case "DRIP":
        return service.recordDrip({
          ...common,
          instrumentId: parsed.instrumentId!,
          sourceDividendId: parsed.sourceDividendId!,
          quantity: parsed.quantity!,
          unitPrice: parsed.unitPrice!,
          txnCurrency: parsed.currency!,
          cashAccountId: parsed.cashAccountId!,
          ...cashLeg,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
          ...(fee !== undefined ? { fee } : {}),
        });
      case "SHARE_DISTRIBUTION":
        // The one branch with no cash leg to forward — no
        // `cashAccountId`, and `cashLeg` is deliberately not spread (the param
        // type declares neither field, exactly as it does not for
        // `recordCurrencyExchange`/`recordSettledBuy`). `amount` is the
        // distribution's market value; the create schema guarantees the four
        // required fields are present for this branch.
        return service.recordShareDistribution({
          ...common,
          instrumentId: parsed.instrumentId!,
          quantity: parsed.quantity!,
          marketValue: parsed.amount!,
          currency: parsed.currency!,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
        });
      case "TRANSFER_OUT":
        // `security-transfer`: like SHARE_DISTRIBUTION, no
        // cash leg to forward; `amount` is the market value. The importer-only
        // fields of `RecordTransferOutParams` are never passed from here.
        return service.recordTransferOut({
          ...common,
          instrumentId: parsed.instrumentId!,
          quantity: parsed.quantity!,
          marketValue: parsed.amount!,
          currency: parsed.currency!,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
          ...(parsed.destinationPortfolioId !== undefined
            ? { destinationPortfolioId: parsed.destinationPortfolioId }
            : {}),
        });
      case "CURRENCY_EXCHANGE":
        return service.recordCurrencyExchange({
          ...common,
          amount: parsed.amount!,
          currency: parsed.currency!,
          cashAccountId: parsed.cashAccountId!,
          targetCurrency: parsed.targetCurrency!,
          targetCashAccountId: parsed.targetCashAccountId!,
          exchangeRate: parsed.exchangeRate!,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
          ...(fee !== undefined ? { fee } : {}),
        });
      case "INTEREST": {
        // DEPOSIT's fields plus DIVIDEND's
        // optional withholding; the create schema guarantees the three
        // required fields are present for this branch.
        const withholding = this.#buildWithholding(parsed);
        return service.recordInterest({
          ...common,
          amount: parsed.amount!,
          currency: parsed.currency!,
          cashAccountId: parsed.cashAccountId!,
          ...cashLeg,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
          ...(withholding !== undefined ? { withholding } : {}),
        });
      }
      case "FEE":
        // WITHDRAWAL's fields plus an optional
        // instrument reference; the create schema guarantees the three
        // required fields are present for this branch.
        return service.recordFee({
          ...common,
          amount: parsed.amount!,
          currency: parsed.currency!,
          cashAccountId: parsed.cashAccountId!,
          ...cashLeg,
          ...(parsed.fxRateUserInput !== undefined
            ? { fxRateUserInput: parsed.fxRateUserInput }
            : {}),
          ...(parsed.instrumentId !== undefined ? { instrumentId: parsed.instrumentId } : {}),
        });
    }
  }

  /**
   * Translates `ledger`'s domain errors to `problem+json` — every one of
   * them is a rejected input (4xx), never a raw 500.
   *
   * The table itself moved to `write-error.mapper.ts` unchanged, because
   * `csv-import` F-D requires `ImportsController` to reuse it rather than
   * write a second one (see that module's own doc comment). This method stays
   * as the four write handlers' single call site, so the class reads exactly
   * as it did.
   */
  #mapWriteError(err: unknown): unknown {
    return mapTransactionWriteError(err);
  }
}
