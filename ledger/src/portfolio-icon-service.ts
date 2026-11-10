import { and, eq, sql } from "drizzle-orm";
import { portfolioIcon, withTenant, type Db } from "@kerdial/platform-db";
import type { InstrumentIconContentType } from "@kerdial/core-reference-data";
import { lockPortfolioRow } from "./portfolio-lock.js";
import type { PortfolioIconInput } from "./portfolio-service.js";

/**
 * `ledger`'s portfolio-icon service —
 * L2, L7, FR-460–FR-465,
 * FR-479, SD-2, SD-4, SD-5, PD-5, PD-6, PD-7.
 *
 * Owns the whole lifetime of a `portfolio_icon` row: the per-tenant uploaded
 * icon for one portfolio. `instrument-icon-service.ts`'s body with three things
 * removed and one added, each of which is a decision rather than an adaptation:
 *
 *  - **removed: the per-tenant row cap** (FR-479, SD-4). There is at most one
 *    icon per portfolio and portfolios are already capped at
 *    `MAX_PORTFOLIOS_PER_TENANT`, so a second cap would bound nothing the first
 *    does not — and it would cost the `count(*)` that cap's own comment
 *    justifies. `instrument_icon` needs one because instruments are shared
 *    catalogue rows a tenant can icon without limit.
 *  - **removed: `source`** (FR-462, SD-2). Bank logos have no automated-fetch
 *    roadmap, so there is no provenance seam to represent — see the table's own
 *    schema comment for why anticipating one would be the generality that
 *    precedent's SD-4 warns against.
 *  - **removed: the service-level bounds re-assertion.** `setInstrumentIcon`
 *    re-checks SD-1/SD-2/SD-3 because FR-301's provider lane is a *stated*
 *    second caller that would not pass through the route's schema. This module
 *    has no such second caller: FR-460's validation is
 *    `validateInstrumentIconUpload`'s, run in `api` (PD-12/PD-T7), and the
 *    table's own three CHECKs are the un-bypassable floor. Duplicating the
 *    numbers here would be a third copy of ceilings L2 asks to be *the same*.
 *  - **added: {@link lockPortfolioRow} as the first statement of the write**
 *    (PD-7) — see {@link setPortfolioIcon}.
 *
 * **Why `withTenant`.** `portfolio_icon` is tenant-owned with row-level
 * security both `ENABLE`d and `FORCE`d and a `GRANT` to `app_web` only
 * (migration `0068`), so every function below goes through `withTenant` — the
 * only sanctioned way to obtain a handle with `app.tenant_id` set. RLS, not the
 * explicit `eq(portfolioIcon.tenantId, …)` predicates, is what makes a
 * cross-tenant read return zero rows rather than another tenant's; those
 * predicates are the belt-and-suspenders `instrument-icon-service.ts` and
 * `manual-price-service.ts` both document. Proved as the real roles by
 * GATE-1 (`rls-cross-tenant-isolation.integration.test.ts`, AC-402).
 *
 * **An icon write fans out to nothing**. No
 * `recomputeAndInvalidate`, no `calc_epoch` bump, no
 * `destroyDerivedStateForPortfolio`, no queue enqueue. An icon is presentation;
 * it moves no figure. Stated explicitly because every *other* write in this
 * package fans out, so its absence would otherwise read as an omission — and
 * asserted, not merely stated, in `portfolio-icon-service.integration.test.ts`.
 */

/**
 * CD10's shape, for `portfolio_icon`: raised by {@link setPortfolioIcon} when
 * the `SELECT … FROM portfolio … FOR UPDATE` it takes as its **first**
 * statement finds no row — an unknown id, or another tenant's (RLS makes the
 * two indistinguishable, AC33), or one a concurrent `deletePortfolio` has just
 * destroyed.
 *
 * That last case is the whole reason the lock exists, and it is a **500 this
 * error's existence is what removes**. Without the lock the
 * sequence is: an existence probe sees the portfolio → a concurrent
 * `deletePortfolio` commits → the `INSERT` violates
 * `portfolio_icon_portfolio_id_portfolio_id_fk` with a `23503`. That constraint
 * is **not** in `api/src/common/problem-json.filter.ts`'s
 * `CLIENT_CAUSED_FK_CONSTRAINTS` — correctly so, by N3's own reasoning: that
 * allow-list is for FK targets taken verbatim from a request *body* — so it
 * falls through to a generic **500** on a perfectly ordinary user action. The
 * honest answer is `404`, and taking the `portfolio` row `FOR UPDATE` first is
 * what makes it the only reachable one, because it makes the two paths mutually
 * exclusive. `cash-account-service.ts`'s own
 * `CashAccountPortfolioNotFoundError` records the identical hazard for
 * `cash_account`; this is the second instance, not a new pattern.
 */
export class PortfolioIconPortfolioNotFoundError extends Error {
  readonly tenantId: string;
  readonly portfolioId: string;

  constructor(tenantId: string, portfolioId: string) {
    super(
      `Portfolio ${portfolioId} does not exist for this tenant — it may have been deleted ` +
        `concurrently (PD-7: the portfolio row is locked FOR UPDATE before the icon is written).`,
    );
    this.name = "PortfolioIconPortfolioNotFoundError";
    this.tenantId = tenantId;
    this.portfolioId = portfolioId;
  }
}

/**
 * What {@link setPortfolioIcon} returns and what `PUT /portfolios/:id/icon`
 * answers with — **the metadata, never the bytes**. The stored `bytes` column
 * is up to 256 KiB and the caller just sent it, so returning it would double
 * every upload's transfer for no consumer.
 */
export interface PortfolioIconMeta {
  readonly tenantId: string;
  readonly portfolioId: string;
  /** The type the magic-byte check determined, never the one the client declared (FR-460). */
  readonly contentType: InstrumentIconContentType;
  readonly byteLength: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly updatedAt: Date;
}

/** `PortfolioIconInput` plus the two key columns — one shape for the create-time insert and this one, so the two writers cannot drift. */
export interface SetPortfolioIconParams extends PortfolioIconInput {
  readonly tenantId: string;
  readonly portfolioId: string;
}

/**
 * Stores or replaces this tenant's icon for `portfolioId` — the table's own
 * primary key, so a set on a portfolio that already has one **is** a replace,
 * not a second row (FR-461).
 *
 * **Two statements, in this order, and the order is the point.**
 *
 * 1. {@link lockPortfolioRow} — rung 2 of `portfolio-lock.ts`'s global lock
 *    order, taken alone, so it cannot be an edge of any cycle. No row ⇒
 *    {@link PortfolioIconPortfolioNotFoundError} (the API's `404`). This is the
 *    probe *and* the race fix, which is why the route deliberately has no
 *    `#requirePortfolio` pre-probe of its own (PD-7): a probe that is not a
 *    lock re-opens exactly the window the lock closes. FR-459's "no lock beyond
 *    the row's own `UPDATE` is required" is about `calc_epoch` and derived
 *    figures and holds unchanged — this lock buys referential integrity, not
 *    freshness.
 * 2. **One** `INSERT … ON CONFLICT DO UPDATE`. **FR-461's atomicity comes from
 *    that single statement**, never from a delete-then-insert pair: a failed
 *    replace therefore leaves the previous icon byte-identical and still
 *    renderable, rather than leaving the portfolio iconless.
 *
 * `.returning()` omits `bytes` for the reason {@link PortfolioIconMeta} states.
 */
export async function setPortfolioIcon(
  db: Db,
  params: SetPortfolioIconParams,
): Promise<PortfolioIconMeta> {
  // `Buffer.from(view)` **copies**, and the copy is the point: the
  // `Buffer.from(view.buffer)` form reads the whole backing store, so a
  // `Uint8Array` view at a non-zero `byteOffset` would store a neighbouring
  // payload's bytes. `instrument-icon-sniff-robustness.test.ts` guards the
  // reader against exactly that shape; this is the same hazard on the write.
  const bytes = Buffer.from(params.bytes);
  const updatedAt = new Date();

  return withTenant(db, params.tenantId, async (tx) => {
    if (!(await lockPortfolioRow(tx, params.tenantId, params.portfolioId))) {
      throw new PortfolioIconPortfolioNotFoundError(params.tenantId, params.portfolioId);
    }

    const [row] = await tx
      .insert(portfolioIcon)
      .values({
        tenantId: params.tenantId,
        portfolioId: params.portfolioId,
        bytes,
        contentType: params.contentType,
        byteLength: bytes.length,
        widthPx: params.widthPx,
        heightPx: params.heightPx,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [portfolioIcon.tenantId, portfolioIcon.portfolioId],
        set: {
          bytes: sql`excluded.bytes`,
          contentType: sql`excluded.content_type`,
          byteLength: sql`excluded.byte_length`,
          widthPx: sql`excluded.width_px`,
          heightPx: sql`excluded.height_px`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({
        tenantId: portfolioIcon.tenantId,
        portfolioId: portfolioIcon.portfolioId,
        contentType: portfolioIcon.contentType,
        byteLength: portfolioIcon.byteLength,
        widthPx: portfolioIcon.widthPx,
        heightPx: portfolioIcon.heightPx,
        updatedAt: portfolioIcon.updatedAt,
      });

    return row!;
  });
}

/**
 * Removes this tenant's icon for `portfolioId`, if there is one.
 *
 * **No lock and no probe, deliberately** — and the asymmetry with
 * {@link setPortfolioIcon} is not an oversight: deleting a child row cannot
 * violate a foreign key, and a portfolio that has been deleted concurrently has
 * no icon row left to delete either way. There is no failure for a lock to
 * prevent.
 *
 * **Idempotent by construction** — one `DELETE` whose zero-row outcome is not
 * an error, so the route answers `204` whether or not a row existed. Two tabs,
 * or a double-click, would otherwise make the second attempt an error for
 * having succeeded; and a `404` here would turn removal into an existence
 * oracle for a row the caller is not allowed to see anyway.
 */
export async function removePortfolioIcon(
  db: Db,
  params: { readonly tenantId: string; readonly portfolioId: string },
): Promise<void> {
  await withTenant(db, params.tenantId, async (tx) => {
    await tx
      .delete(portfolioIcon)
      .where(
        and(
          eq(portfolioIcon.tenantId, params.tenantId),
          eq(portfolioIcon.portfolioId, params.portfolioId),
        ),
      );
  });
}

/**
 * This tenant's stored icon bytes for `portfolioId`, or `null` — one lookup on
 * the whole primary key.
 *
 * **`portfolio` is never read**, and this one does *not* transfer from
 * `getInstrumentIcon`'s reasoning. There, "no such instrument" and "nobody has
 * iconed it" must be the same code path because instruments are shared
 * catalogue rows and the route would otherwise become an existence oracle for
 * them. Here the portfolio is the caller's own and FR-463/SD-5 explicitly does
 * not ask for that guarantee; the probe is omitted because it would cost a
 * statement to produce a `404` this PK lookup already produces, and would open
 * a TOCTOU between the two. Recorded so the next reader does not add one on the
 * strength of the analogy.
 */
export async function getPortfolioIcon(
  db: Db,
  params: { readonly tenantId: string; readonly portfolioId: string },
): Promise<{ bytes: Buffer; contentType: InstrumentIconContentType } | null> {
  return withTenant(db, params.tenantId, async (tx) => {
    const [row] = await tx
      .select({ bytes: portfolioIcon.bytes, contentType: portfolioIcon.contentType })
      .from(portfolioIcon)
      .where(
        and(
          eq(portfolioIcon.tenantId, params.tenantId),
          eq(portfolioIcon.portfolioId, params.portfolioId),
        ),
      );
    return row ?? null;
  });
}
