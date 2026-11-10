import { Controller, Get, Inject, Query } from "@nestjs/common";
import {
  AmbiguousDividendTaxLegError,
  TooManyDividendInstrumentsError,
  summarizeDividends,
} from "@kerdial/ledger";
import type { SessionContext } from "@kerdial/platform-auth";
import type { Db } from "@kerdial/platform-db";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { DB } from "../db/db.tokens.js";
import {
  dividendSummaryQuerySchema,
  toDividendSummaryResponse,
  type DividendSummaryResponse,
} from "./dividends.schema.js";

/**
 * `/dividends/*` — the Dividendes screen's one read
 * (FR-265,
 * FR-271–FR-273, FR-279, FR-281, FR-282, FR-284).
 *
 * **Why its own controller, and not `/transactions/dividends` or
 * `/portfolios/dividends`** (DV1). The resource is *dividend income*, not a
 * page of transactions and not a property of one portfolio: it answers across
 * every portfolio by default (LD-5) and it returns figures no
 * `TransactionResponse` carries. Hanging it off `/transactions` would put an
 * aggregate behind a controller whose reads are all row lists — and would sit
 * it next to `listTransactionsQuerySchema`, which is exactly the file AC-294
 * exists to prove this cycle does not touch. Hanging it off `/portfolios/:id`
 * would make the combined view (the default) the awkward case.
 *
 * Auth and CSRF come from the global `AuthGuard`/`CsrfGuard` (`app.module.ts`),
 * so there is no new auth surface here; a request with no session is the
 * guard's 401, swept by `auth.e2e.test.ts`'s AC32 route enumeration
 * automatically.
 */
@Controller("dividends")
export class DividendsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `GET /dividends/summary?from=&to=&portfolio=` — gross and withholding per
   * instrument, per calendar year and per calendar month, plus the combined
   * total, from **one** `GROUP BY` (LD-3(b), FR-279).
   *
   * DV5/FR-281 asked this route to join the shared cheap-read cap rather
   * than add its own; the instance-wide admission bound has since replaced that cap.
   * (The paragraph below is that cycle's reasoning, kept for the record:
   * that list carries one entry per interceptor *instance*, not per route, so
   * the ceiling this route contends for is already counted (its own doc
   * comment: "two lines here would double-count a ceiling that cannot be
   * exceeded twice"). One bounded indexed query, one pooled connection, one
   * read per screen mount — the profile that class describes.
   *
   * **No 404 for a `portfolio` id this tenant does not own.** It matches no
   * rows and yields the empty shape — `getTransactionById`'s own "another
   * tenant's rows are invisible, not merely forbidden" stance. The
   * alternative (probing `getPortfolio` first, as the `:id`-scoped valuation
   * routes do) would add a second query to a route whose whole point is being
   * one.
   */
  @Get("summary")
  async summary(
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<DividendSummaryResponse> {
    const parsed = parseOrThrow(dividendSummaryQuerySchema, query);

    try {
      const summary = await summarizeDividends(this.db, {
        tenantId: session.tenantId,
        ...(parsed.from !== undefined ? { from: parsed.from } : {}),
        ...(parsed.to !== undefined ? { to: parsed.to } : {}),
        ...(parsed.portfolio !== undefined ? { portfolioId: parsed.portfolio } : {}),
        // `responseCapOverrides` is deliberately not reachable from here: it is
        // DS-1's test-only escape hatch for proving the cap without seeding
        // 1,000 instruments, and a client-settable cap would make the refusal
        // below opt-out.
      });
      return toDividendSummaryResponse(summary);
    } catch (err) {
      throw this.#mapSummaryError(err);
    }
  }

  /**
   * The error table's two 422s, mapped the way `PortfoliosController#mapValuationError`
   * maps `VALUATION_RESPONSE_TOO_LARGE`: 422 is "well-formed request, not
   * currently servable as asked", and 413 is wrong because RFC 9110 §15.5.14
   * describes an oversized *request* payload — the inverse direction, and this
   * is a `GET`.
   *
   * **`DividendBaseCurrencyMismatchError` is deliberately absent**, and that is
   * a decision rather than an oversight: it describes corrupt stored state
   * (a posting whose `base_currency` disagrees with its tenant's, which
   * `trg_transaction_posting_base_currency_fill` makes unreachable on
   * trigger-valid data), not an unservable request. It falls through to a 500,
   * which is the honest status for "this deployment's data is wrong"; mapping
   * it to a 4xx would tell the caller to fix their request.
   */
  #mapSummaryError(err: unknown): unknown {
    // DV6 — never a truncated `instruments[]`: a truncated array would make
    // `total` disagree with the rows shown, which is G5's exact prohibition.
    if (err instanceof TooManyDividendInstrumentsError) {
      return problemException(422, {
        title: "Dividend summary response too large",
        code: "DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE",
        detail: err.message,
      });
    }
    // DV11 — a DIVIDEND carrying a `fee_amount` (out-of-band data: no API path
    // produces one) emits cost-component `TAX` postings this aggregate cannot
    // tell from withholding. The whole request is refused rather than the leg
    // being summed into a figure that quietly disagrees with the Activity tab.
    if (err instanceof AmbiguousDividendTaxLegError) {
      return problemException(422, {
        title: "Dividend summary cannot separate withholding from transaction cost",
        code: "DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG",
        detail: err.message,
      });
    }
    return err;
  }
}
