import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { invalidateAndVerifyCalcEpoch } from "./calc-epoch.js";
// The two catalogue keys are **imported from the modules that declare them**,
// unlike the eight portfolio prefixes below which this file owns outright.
// Those eight exist here because this module is their only consumer; these two
// are a screen's own query key and the toggle state's own prefix, already
// declared and already documented next to the reads they belong to, so
// re-typing them here would be a second copy of a key whose only job is to
// match the first exactly. Neither module imports this one, so no cycle.
import { WATCHLIST_PREFIX } from "./queries/watchlist.js";
import { FX_OVERVIEW_QUERY_KEY } from "./queries/fx.js";

/**
 * The one shared invalidation helper every portfolio-
 * mutating call site routes through, closing **L2** (`TransactionForm.tsx`
 * and `PortfolioDeleteDialog.tsx` used to invalidate only
 * `["portfolios","overview"]`/`["portfolios","holdings"]`, missing the new
 * `["portfolios","performance"]` key entirely) for good — a future derived
 * key is added here, once, not re-derived at N mutation call sites.
 *
 * Always invalidates all eight derived-figure prefixes:
 * {@link OVERVIEW_PREFIX}, {@link HOLDINGS_PREFIX}, {@link PERFORMANCE_PREFIX},
 * {@link LIST_PREFIX}, {@link CASH_PREFIX}, {@link DIVIDENDS_PREFIX},
 * {@link VALUE_SERIES_PREFIX}, {@link CLOSED_POSITIONS_PREFIX}. Each is a bare
 * two-element prefix, deliberately never
 * carrying the `scope`/`portfolioId` slot added *after* the resource —
 * `exact: false` (TanStack Query's default prefix-match semantics) means
 * this same bare prefix already matches both the combined dashboard's key
 * and any per-portfolio detail key, with zero per-caller knowledge of which
 * scopes are currently mounted.
 *
 * `opts.epochWillAdvance` — whether this mutation is expected to bump
 * `portfolio.calc_epoch` server-side:
 *
 * - `true`: `overview`/`holdings` route through
 *   {@link invalidateAndVerifyCalcEpoch} (unchanged semantics/shape —
 *   bounded retry until the refetched `calcEpoch` is proven to have
 *   advanced); `performance`/`list` get a plain `invalidateQueries`.
 *   **Neither `performance` nor `list` is ever routed through
 *   `invalidateAndVerifyCalcEpoch`** — neither carries
 *   a `calcEpoch` on the wire (`performance`'s response is
 *   `{from,to,return:{twr,mwr}}`; `list` is a plain `PortfolioResponse[]`),
 *   so there is nothing for `isCalcEpochBearing` to ever match — routing
 *   either through the epoch helper would silently no-op the "verify"
 *   half forever, masking a real problem as a permanently-unverifiable one.
 * - `false`: all four get a plain `invalidateQueries({ refetchType: "active"
 *   })`, and the aggregate result is `{ status: "not-applicable" }` — there
 *   is no verification predicate to fail, because none is attempted. This
 *   remains the honest state for manual-price mutations, but the
 *   reason changed with AR-13b (ADR-0007):
 *   `upsertManualPricePoint` now fans out `recomputeAndInvalidate` to every
 *   portfolio holding or having traded the instrument, so the epoch **may**
 *   advance — but is not guaranteed to (a price for an instrument nobody
 *   holds yet, the everyday create-then-price flow, fans out to zero
 *   portfolios). A boolean cannot say "maybe", and routing the mutation
 *   through `invalidateAndVerifyCalcEpoch` would exhaust its 3-attempt
 *   retry budget on exactly those unheld-instrument entries and surface a
 *   spurious "freshness could not be confirmed" notice. The plain refetch
 *   still lands fresh data either way — for held instruments the fan-out
 *   has already committed before the response returns.
 *   **The caller must not read `"not-applicable"` as "the new price is
 *   reflected in TWR/MWR"** — it renders no freshness claim at all.
 *
 * Returns the aggregate result as {@link InvalidationOutcome} — a 3-state
 * discriminated union rather than the boolean `CalcEpochVerificationResult`
 * `invalidateAndVerifyCalcEpoch` itself uses. UR-35's independent-tester pass
 * flagged that a plain boolean collapses "verification genuinely
 * confirmed" and "verification was never attempted" into the same `true`,
 * which is only safe today because the one `epochWillAdvance: false` caller
 * (`queries.ts`'s `postManualPricePointMutationOptions`) never inspects the
 * result — a future caller that did would be misled. `"not-applicable"`
 * makes that state unrepresentable-as-success.
 */

const OVERVIEW_PREFIX = ["portfolios", "overview"] as const satisfies QueryKey;
const HOLDINGS_PREFIX = ["portfolios", "holdings"] as const satisfies QueryKey;
export const PERFORMANCE_PREFIX = ["portfolios", "performance"] as const satisfies QueryKey;

/**
 * The performance screen's chart series
 * (`GET /portfolios/value-series`). A derived figure like every other one
 * here: a transaction write moves the daily value series exactly as it moves
 * the overview total, and this prefix is what stops the chart from keeping a
 * pre-write shape under a post-write total.
 *
 * Plain `invalidateQueries`, never {@link invalidateAndVerifyCalcEpoch}, for
 * the reason already recorded for `performance`/`list`: the response
 * (`{from,to,baseCurrency,points,provenance}`) carries no `calcEpoch`, so the
 * verify half could only ever no-op.
 */
export const VALUE_SERIES_PREFIX = ["portfolios", "value-series"] as const satisfies QueryKey;
const LIST_PREFIX = ["portfolios", "list"] as const satisfies QueryKey;
/**
 * CA-19. A **transaction**
 * write moves cash, so this prefix joins the set above — and it is
 * deliberately *not* routed through {@link invalidateAndVerifyCalcEpoch}
 * even though `GET /portfolios/:id/cash` does carry a `calcEpoch` on the
 * wire (FR-162). `isCalcEpochBearing` would match it, so the choice is real:
 * `invalidateAndVerifyCalcEpoch`'s contract is "block the dialog until this
 * read is *proven* caught up", and the two reads worth blocking on are the
 * ones whose figures the user is looking at when the dialog closes
 * (overview/holdings). Adding a third would widen every write's critical
 * path — and its own retry budget — for a panel that is usually not even
 * mounted. A plain invalidation still refetches it whenever it *is* mounted.
 *
 * A **cash-account** write (rename/archive) bumps no `calc_epoch` at all
 * (a label change moves no figure), so it invalidates this prefix
 * **only** — {@link invalidateCashAccounts}, never this function.
 */
export const CASH_PREFIX = ["portfolios", "cash"] as const satisfies QueryKey;

/**
 * `dividend-screen` DS-8.
 * A transaction write can add, edit or delete a DIVIDEND row, so
 * `GET /dividends/summary` is a derived figure like any other here.
 *
 * **Never routed through {@link invalidateAndVerifyCalcEpoch}**, and that is
 * the direct consequence of DS-1's "no `calcEpoch` on this response" choice
 * (DV10): `transaction_posting` is a write-time projection, not lazily
 * materialised state, so the response carries no epoch, `isCalcEpochBearing`
 * could never match it, and the "verify" half would silently no-op forever —
 * masking a real problem as a permanently-unverifiable one. That is the
 * identical reasoning this file already records for `performance` and `list`.
 *
 * The bare two-element prefix matches every window/portfolio variant of the
 * key (`queries/dividends.ts` appends the params object after it), so no
 * caller has to know which scope is currently mounted.
 */
export const DIVIDENDS_PREFIX = ["dividends", "summary"] as const satisfies QueryKey;

/**
 * `closed-positions` CP-6.
 * A transaction write can close a position outright — a sale of the last unit
 * moves an instrument from the open list to this one — so the « Clôturées »
 * tab is a derived figure like every other prefix here.
 *
 * **Plainly invalidated, never through {@link invalidateAndVerifyCalcEpoch}**,
 * and unlike `performance`/`list`/`dividends` the reason is not "the response
 * carries no `calcEpoch`": it does (`ClosedPositionsResponse.calcEpoch`), so
 * `isCalcEpochBearing` *would* match it and the choice is a real one. It is
 * the CA-19 precedent applied verbatim (see {@link CASH_PREFIX}): that helper's
 * contract is "block the dialog until this read is *proven* caught up", and the
 * two reads worth blocking on are the ones the user is looking at when a write
 * dialog closes — overview and holdings. The closed view sits behind a tab
 * that is lazily fetched and usually not even mounted; routing it through the
 * verify path would widen every write's critical path and burn its 3-attempt
 * retry budget for a panel nobody is watching. A plain invalidation still
 * refetches it whenever it *is* mounted.
 */
export const CLOSED_POSITIONS_PREFIX = [
  "portfolios",
  "closed-positions",
] as const satisfies QueryKey;

/**
 * `portfolio-export-import` EI-35 — the security master, as one bare root.
 *
 * `["instruments"]` is not a prefix any single read declares: `queries/
 * instruments.ts` builds `["instruments","search",q]`, `["instruments",id]`,
 * `["instruments",id,"prices",…]` and four more inline. The root is what they
 * all share, and a catalogue import can move every one of them — it creates
 * instruments, renames them, attaches icons and writes manual price points.
 * So the root is declared here, once, rather than seven keys enumerated at the
 * one call site that needs them.
 */
const INSTRUMENTS_PREFIX = ["instruments"] as const satisfies QueryKey;

export interface InvalidatePortfolioDerivedFiguresOptions {
  readonly epochWillAdvance: boolean;
}

/** {@link invalidatePortfolioDerivedFigures}'s outcome — see this file's own header doc comment. */
export type InvalidationOutcome =
  | { readonly status: "verified" }
  | { readonly status: "unverified" }
  | { readonly status: "not-applicable" };

export async function invalidatePortfolioDerivedFigures(
  queryClient: QueryClient,
  opts: InvalidatePortfolioDerivedFiguresOptions,
): Promise<InvalidationOutcome> {
  if (!opts.epochWillAdvance) {
    await Promise.all(
      [
        OVERVIEW_PREFIX,
        HOLDINGS_PREFIX,
        PERFORMANCE_PREFIX,
        LIST_PREFIX,
        CASH_PREFIX,
        DIVIDENDS_PREFIX,
        VALUE_SERIES_PREFIX,
        CLOSED_POSITIONS_PREFIX,
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey, refetchType: "active" })),
    );
    return { status: "not-applicable" };
  }

  const [overviewResult, holdingsResult] = await Promise.all([
    invalidateAndVerifyCalcEpoch(queryClient, OVERVIEW_PREFIX),
    invalidateAndVerifyCalcEpoch(queryClient, HOLDINGS_PREFIX),
    queryClient.invalidateQueries({ queryKey: PERFORMANCE_PREFIX }),
    queryClient.invalidateQueries({ queryKey: LIST_PREFIX }),
    queryClient.invalidateQueries({ queryKey: CASH_PREFIX }),
    queryClient.invalidateQueries({ queryKey: DIVIDENDS_PREFIX }),
    queryClient.invalidateQueries({ queryKey: VALUE_SERIES_PREFIX }),
    queryClient.invalidateQueries({ queryKey: CLOSED_POSITIONS_PREFIX }),
  ]);
  return overviewResult.verified && holdingsResult.verified
    ? { status: "verified" }
    : { status: "unverified" };
}

/**
 * A **cash-account** write's own, deliberately narrow invalidation (CA-19,
 * rename and archive/un-archive change a label and a
 * visibility flag — no posting moves, no balance changes, and
 * `calc_epoch` is not bumped server-side. Invalidating the full derived set
 * here would refetch overview/holdings/performance for a write that provably
 * cannot have moved any of them, and routing it through
 * `invalidateAndVerifyCalcEpoch` would wait out that helper's whole retry
 * budget on an epoch nothing is going to advance — the recorded
 * `upsertManualPricePoint` failure, exactly.
 *
 * Scoped to one portfolio's key, not the bare prefix: a rename in portfolio A
 * has no bearing on portfolio B's accounts, and this is the one cash call
 * site that always knows which portfolio it is writing to.
 */
export async function invalidateCashAccounts(
  queryClient: QueryClient,
  portfolioId: string,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: [...CASH_PREFIX, portfolioId] });
}

/**
 * The **catalogue** surfaces a Kerdial import writes that are not portfolio
 * derived figures at all (`portfolio-export-import`'s closing
 * paragraph, EI-35).
 *
 * A catalogue package creates instruments, icons, manually entered prices,
 * watchlist rows and user FX rates. None of those is a figure
 * {@link invalidatePortfolioDerivedFigures} covers — its eight prefixes are all
 * `["portfolios", …]` or `["dividends", …]` — so without this call an import
 * that added five instruments leaves the Titres screen showing the list from
 * before it, which is the visible symptom.
 *
 * **Three bare prefixes, not eight keys.** `["instruments"]` prefix-matches the
 * list, the search, each instrument's detail *and* its
 * `["instruments", id, "prices"]` manual-price window — so the manual prices a
 * catalogue carries need no separate entry, and neither does a key added later
 * under that root. `["watchlist"]` is the prefix `queries/watchlist.ts` already
 * documents as covering both the rows and the per-instrument toggle state.
 * `FX_OVERVIEW_QUERY_KEY` is the Devises screen's single key.
 *
 * **Deliberately not routed through `invalidateAndVerifyCalcEpoch`, and not
 * even offered the choice**: none of these three responses carries a
 * `calcEpoch`, and a catalogue apply moves no
 * `calc_epoch` at all. There is nothing for a verification to wait for.
 *
 * `refetchType: "active"` matches the `epochWillAdvance: false` branch above:
 * a screen that is not mounted is marked stale and refetched when it next
 * mounts, which is the same freshness with none of the cost.
 */
export async function invalidateCatalogueSurfaces(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    [INSTRUMENTS_PREFIX, WATCHLIST_PREFIX, FX_OVERVIEW_QUERY_KEY].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey, refetchType: "active" }),
    ),
  );
}
