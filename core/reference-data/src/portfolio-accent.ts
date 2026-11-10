/**
 * The portfolio accent vocabulary (PD-2, PD-3, FR-451, FR-472).
 *
 * Sibling of `instrument-icon.ts` and, for the reason this package's own header
 * states, deliberately **framework-free**: `.dependency-cruiser.cjs`'s
 * `web-no-server-runtime-imports` only admits `core/*` into `web/src`, so
 * putting the vocabulary here is what lets the accent picker import it at
 * runtime with **no** `web/src/lib/api-limits.ts` mirror and no new depcruise
 * exception.
 */

/**
 * L6 — the accent is one of the **six existing chart-ramp tokens**, stored as
 * the token identifier. No new colour enters `web/src/styles/kerdial.css`, so
 * no contrast re-validation is owed and `chart-theme.drift.test.ts` is
 * untouched.
 *
 * **The member names the token slot, not the hue** (PD-3). `kerdial.css`
 * defines `--chart-1: var(--teal-500)` … `--chart-6: var(--ink-400)`; a member
 * named `TEAL` would be a claim about that mapping, and the mapping is
 * precisely the thing the token file is allowed to re-point. A member named
 * `CHART_1` is a claim about the *slot*, which is what L6 says is stored — so
 * if the ramp is ever re-ordered, charts and portfolio accents move together
 * (the single-palette property `asset-class.ts` exists to preserve) instead of
 * one lying about the other. The human-readable hue word lives in
 * `PORTFOLIO_COPY`, which is the layer that is meant to change when a hue does.
 *
 * The six `--class-*` tokens are aliases of five of these and are deliberately
 * **not** offered: they carry an asset-class meaning everywhere else in the
 * product.
 *
 * Spread into `portfolioAccentColorEnum`
 * (`platform/db/src/schema/portfolio.ts`), so the database type and this tuple
 * are the same list by construction — the
 * `INSTRUMENT_ICON_CONTENT_TYPES`/`instrumentIconContentTypeEnum` construction,
 * itself the `instrumentSectorEnum`/`SECTOR_CODES` one. Member **order** is
 * therefore load-bearing: `portfolio-icon-schema.integration.test.ts` compares
 * `pg_enum`'s labels to this array in order. Because the enum *is* the
 * constraint, FR-451's "refused, never coerced" is a database fact rather than
 * an application rule, and no CHECK is added beside the column.
 */
export const PORTFOLIO_ACCENT_COLORS = [
  "CHART_1",
  "CHART_2",
  "CHART_3",
  "CHART_4",
  "CHART_5",
  "CHART_6",
] as const;

/** One of {@link PORTFOLIO_ACCENT_COLORS}. */
export type PortfolioAccentColor = (typeof PORTFOLIO_ACCENT_COLORS)[number];
