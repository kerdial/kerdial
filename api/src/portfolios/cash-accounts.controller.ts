import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import type { Db } from "@kerdial/platform-db";
import {
  CashAccountNameAlreadyExistsError,
  CashAccountPortfolioCapExceededError,
  CashAccountPortfolioNotFoundError,
  createCashAccount,
  getPortfolio,
  listCashAccountsWithBalances,
  renameCashAccount,
  setCashAccountArchived,
} from "@kerdial/ledger";
import type { SessionContext } from "@kerdial/platform-auth";
import { DB } from "../db/db.tokens.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { parseIdParam } from "../common/id-param.schema.js";
import { CurrentSession } from "../auth/current-session.decorator.js";
import {
  createCashAccountBodySchema,
  patchCashAccountBodySchema,
  toCashAccountResponse,
  toPortfolioCashResponse,
  type CashAccountResponse,
  type PortfolioCashResponse,
} from "./cash-accounts.schema.js";

/**
 * `/portfolios/:id/cash-accounts*` (CA-14) and `/portfolios/:id/cash`
 * (CA-16), spec
 * FR-150/FR-152/FR-160–FR-163/FR-164/FR-165. A thin controller over
 * `cash-account-service.ts`; every read/write is scoped to `session.tenantId`
 * by `withTenant`/RLS **inside** those service functions, never by a
 * `WHERE tenant_id = ?` written here (AC33).
 *
 * ## Why a second controller under the same `portfolios` prefix
 *
 * `PortfoliosController` is already 524 lines and mixes valuation reads with
 * CRUD, so these routes go in their own class rather than growing
 * it further. Nest allows two controllers to share a path prefix, and the
 * route table stays unambiguous by segment count — that controller's own
 * documented convention. `POST /portfolios/:id/cash-accounts` and
 * `GET /portfolios/:id/cash` have **three** path segments and
 * `PATCH /portfolios/:id/cash-accounts/:accountId` has **four**, while every
 * route on `PortfoliosController` has one, two or three with a distinct
 * literal in the segment this one fills with `cash-accounts`/`cash` — so
 * nothing here can be captured by, or capture, `PATCH /portfolios/:id` or
 * `GET /portfolios/overview`. The one pair worth naming explicitly is
 * `GET /portfolios/:id/cash` against `GET /portfolios/:id/holdings`: both are
 * three segments with the same `:id`, and they stay distinct only because
 * their third segments are different literals. Asserted by reflection in
 * `cash-accounts.controller.routes.test.ts`, not by this paragraph.
 *
 * ## There is no `@Delete`, and that is an assertion, not a convention
 *
 * OD-5(c) locked archive over hard delete, so no HTTP route on this class
 * removes a `cash_account` row; `PATCH { archived: true }` is the whole of
 * FR-165's user-facing surface. Migration `0038` *does* grant `app_web`
 * `DELETE` on the table — `deletePortfolio`'s ordered cascade runs as that
 * role and must destroy a portfolio's accounts (FR-166) — and the existence of
 * that grant is exactly why the absence of a route needs proving rather than
 * assuming. `cash-accounts.controller.routes.test.ts` reflects over this
 * class's real Nest metadata and asserts no method carries
 * `RequestMethod.DELETE`, paired with the positive companion that the two
 * routes which *do* exist are found with the right verbs and paths — so the
 * absence half can never pass by having enumerated nothing. That is AC-191
 * case 7's HTTP-non-exposure companion, which CA-3 could not assert
 * while this controller did not exist.
 *
 * ## Throttles (CD8, CD9)
 *
 * CD8/CD9 had the two writes join the shared portfolio-write cap and the
 * read join the shared cheap-read cap. ADR-0016 retired both; every
 * route here is bounded by the instance-wide admission bound and answers
 * `ADMISSION_BOUND_EXCEEDED` when it is full.
 */
@Controller("portfolios")
export class CashAccountsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `POST /portfolios/:id/cash-accounts` (FR-150, AC-172, AC-173).
   *
   * **AC-172 lives here.** Two accounts in this portfolio may both be `EUR`,
   * with different names, and both persist with distinct ids — currency is not
   * part of any uniqueness key on `cash_account`, in any form, and neither
   * this method nor `createCashAccount` reads one account's currency to decide
   * anything about another's.
   *
   * Bounded by `MAX_CASH_ACCOUNTS_PER_PORTFOLIO` since F2 — a 409, not
   * the concurrency throttle's 429; see `#mapCashAccountError`. That cap is
   * also what bounds `getCashBalances` below.
   */
  @Post(":id/cash-accounts")
  @HttpCode(201)
  async create(
    @Param("id") rawPortfolioId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<CashAccountResponse> {
    const portfolioId = parseIdParam(rawPortfolioId);
    const parsed = parseOrThrow(createCashAccountBodySchema, body);

    try {
      const row = await createCashAccount(this.db, {
        tenantId: session.tenantId,
        portfolioId,
        name: parsed.name,
        currency: parsed.currency,
      });
      return toCashAccountResponse(row);
    } catch (err) {
      throw this.#mapCashAccountError(err);
    }
  }

  /**
   * `PATCH /portfolios/:id/cash-accounts/:accountId` — rename (FR-164,
   * AC-184) or archive/un-archive (FR-165, OD-5(c)), exactly one per request
   * (see `patchCashAccountBodySchema` for why both at once is refused rather
   * than applied in two transactions).
   *
   * Walked deliberately against `create`'s full validation set rather than
   * written as a thin variation of it — across three prior API tasks in this
   * repo *every* security finding landed on an edit path and none on a create.
   * Point by point: the same `parseIdParam` on `:id` **plus** one on
   * `:accountId` (create has one path param, this has two, and the second is
   * the one a create-shaped implementation forgets); the same
   * `portfolioNameSchema`, the same object, so a name valid here is valid there
   * and vice versa; the same portfolio-row lock, taken by the same
   * `lockPortfolio` helper inside the service; the same 409 on a name
   * collision, from the same constraint, mapped by the same
   * `#mapCashAccountError` this method and `create` both delegate to — one
   * mapper, so a status that is right on create cannot be wrong here. What is
   * deliberately *not* symmetric: `currency` is absent from this body entirely
   * (OD-2's immutability), and this method has the extra `undefined` → 404
   * `CASH_ACCOUNT_NOT_FOUND` branch that create, which mints its own id, has no
   * equivalent of.
   */
  @Patch(":id/cash-accounts/:accountId")
  async patch(
    @Param("id") rawPortfolioId: string,
    @Param("accountId") rawAccountId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<CashAccountResponse> {
    const portfolioId = parseIdParam(rawPortfolioId);
    const cashAccountId = parseIdParam(rawAccountId);
    const parsed = parseOrThrow(patchCashAccountBodySchema, body);

    try {
      const row =
        parsed.name !== undefined
          ? await renameCashAccount(this.db, {
              tenantId: session.tenantId,
              portfolioId,
              cashAccountId,
              name: parsed.name,
            })
          : await setCashAccountArchived(this.db, {
              tenantId: session.tenantId,
              portfolioId,
              cashAccountId,
              // The schema guarantees exactly one field is present, so this
              // branch is only reached with `archived` set — asserted by
              // `cash-accounts.schema.test.ts`, not assumed from the `?.`.
              archived: parsed.archived!,
            });
      if (!row) {
        // Distinct from the 404 below: the portfolio exists (CD10's lock found
        // its row), but it holds no such account — an unknown id, another
        // tenant's (invisible under RLS, AC33), or a sibling portfolio's.
        throw problemException(404, {
          title: "Cash account not found",
          code: "CASH_ACCOUNT_NOT_FOUND",
          detail: `Portfolio ${portfolioId} has no cash account ${cashAccountId}.`,
        });
      }
      return toCashAccountResponse(row);
    } catch (err) {
      throw this.#mapCashAccountError(err);
    }
  }

  /**
   * `GET /portfolios/:id/cash` (CA-16; FR-160–FR-163, AC-180–AC-183) — every
   * cash account in this portfolio with its current balance, plus FR-161's
   * per-currency total and the `calc_epoch` all of it was read at.
   *
   * **The route this whole feature exists to serve**, and the first HTTP route
   * in this product to read materialised cash state — it closes the root
   * spec's "Cash by currency" register row (V3).
   *
   * ## The 404 is a separate, prior statement, deliberately
   *
   * `#requirePortfolio` runs *before* the snapshot and its only job is
   * producing the 404; it never contributes a figure to the
   * body. That ordering matters because the snapshot itself must be **one**
   * statement — see `listCashAccountsWithBalances`' own doc comment for why,
   * and `cash-account-balances-statement-count.integration.test.ts` for the
   * measurement. The service's `undefined` is mapped to the same 404 as a
   * belt-and-braces second answer for the case where the portfolio is deleted
   * between the two statements; a client cannot tell the two apart, and should
   * not.
   *
   * ## What this route does *not* do
   *
   * No provider or ingestion call, and no materialisation (AC-181). Unlike
   * `portfolio_daily_valuation`, `cash_balance` is recomputed wholesale inside
   * the *write* transaction (`recomputeAndInvalidate`), so there is no
   * materialise-on-read half here for a reader to race — the property is
   * structural, not restraint.
   *
   * It also filters nothing: archived accounts are listed and counted,
   * and a negative balance is reported and flagged rather
   * than refused (OD-6, locked — nothing enforces a floor, here or anywhere).
   *
   * ## Unpaginated, and bounded by the write path instead (F2)
   *
   * This route returns every account in the portfolio, and it stays that way.
   * The design's original claim that the result set is "bounded by the
   * response" was circular — the response was the unbounded thing, measured at
   * 50,821 accounts returned in 146 ms and rendered into a single `<select>`.
   * The fix is a cap on `create` (`MAX_CASH_ACCOUNTS_PER_PORTFOLIO` = 200), not
   * a `LIMIT` here: FR-161's per-currency total is folded from exactly the rows
   * this statement returns, so a `LIMIT` would not make the response cheap, it
   * would make the **total silently wrong** by the balances of the accounts
   * that fell off the end. A slow response is recoverable; a total that omits
   * money is not. This is therefore a stated reliance on the write-path cap,
   * asserted in `cash-account-balances.integration.test.ts` rather than assumed.
   */
  @Get(":id/cash")
  async getCashBalances(
    @Param("id") rawPortfolioId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<PortfolioCashResponse> {
    const portfolioId = parseIdParam(rawPortfolioId);
    await this.#requirePortfolio(portfolioId, session.tenantId);

    const snapshot = await listCashAccountsWithBalances(this.db, {
      tenantId: session.tenantId,
      portfolioId,
    });
    if (!snapshot) {
      throw problemException(404, {
        title: "Portfolio not found",
        code: "PORTFOLIO_NOT_FOUND",
        detail: `Portfolio ${portfolioId} does not exist for this tenant.`,
      });
    }
    return toPortfolioCashResponse(snapshot);
  }

  /** `PortfoliosController#requirePortfolio`'s own shape, over the same `getPortfolio`: a 404 when this tenant has no such portfolio (AC33 — another tenant's row is invisible, not merely forbidden). */
  async #requirePortfolio(portfolioId: string, tenantId: string): Promise<void> {
    const row = await getPortfolio(this.db, tenantId, portfolioId);
    if (!row) {
      throw problemException(404, {
        title: "Portfolio not found",
        code: "PORTFOLIO_NOT_FOUND",
        detail: `Portfolio ${portfolioId} does not exist for this tenant.`,
      });
    }
  }

  /**
   * The single error mapper both write methods delegate to — create/edit
   * symmetry made structural rather than reviewed: there is one place a
   * cash-account error's status is decided, so the two paths cannot disagree.
   *
   * Anything not named here (an `HttpException` this controller itself threw
   * included) is returned unchanged for the global `problem-json.filter.ts` to
   * handle.
   */
  #mapCashAccountError(err: unknown): unknown {
    if (err instanceof CashAccountPortfolioNotFoundError) {
      // Deliberately the same `PORTFOLIO_NOT_FOUND` code `PortfoliosController`
      // already uses for an unknown/other-tenant portfolio id: from the
      // client's side it is the same fact, and CD10's lock is what guarantees
      // the concurrent-delete case reports it as that rather than as a
      // misleading 409 or an unmapped 500.
      return problemException(404, {
        title: "Portfolio not found",
        code: "PORTFOLIO_NOT_FOUND",
        detail: err.message,
      });
    }
    if (err instanceof CashAccountNameAlreadyExistsError) {
      return problemException(409, {
        title: "Cash account name already exists",
        code: "CASH_ACCOUNT_NAME_ALREADY_EXISTS",
        detail: err.message,
      });
    }
    if (err instanceof CashAccountPortfolioCapExceededError) {
      // F2: the per-portfolio account cap, mapped exactly as
      // `PortfolioTenantCapExceededError` is — **409, not 429**, for N6's
      // reason (`portfolios.controller.ts`): this is permanent state, not a
      // rate. Retrying the identical request, however long the client waits,
      // never succeeds until an account is removed, and no `Retry-After`
      // accompanies it. Only `create` can raise it; `patch` shares this mapper
      // and cannot, since neither rename nor archive adds a row.
      return problemException(409, {
        title: "Cash account limit reached",
        code: "CASH_ACCOUNT_PORTFOLIO_CAP_EXCEEDED",
        detail: err.message,
      });
    }
    return err;
  }
}
