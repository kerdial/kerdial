import type { PortfolioAccentColor } from "@kerdial/core-reference-data";

/**
 * `portfolio-accent.ts` — a stored accent token ⇒ the CSS custom property that
 * paints it (FR-472,
 * PD-15, L6).
 *
 * `asset-class.ts`'s shape exactly, and for its reason: a `var(...)`
 * **reference** is returned rather than a literal colour, so the value stays in
 * `kerdial.css` and the token lint rule has nothing to object to at the call
 * sites. A screen that picked a hex for an accent directly is how the same
 * slot ends up two different colours on two screens.
 *
 * **No token is added to `kerdial.css` by this feature** (L6). The six members
 * below are the six chart-ramp tokens that already ship, so no new colour
 * enters the token file, no contrast re-validation is owed, and
 * `chart-theme.drift.test.ts` is untouched.
 *
 * **The token names a slot, not a hue** — `PORTFOLIO_ACCENT_COLORS`' own
 * header (PD-3) records why: `--chart-1` may be re-pointed, and a stored
 * `TEAL` would then be a lie while a stored `CHART_1` stays true. The
 * human-readable hue word lives in `PORTFOLIO_COPY`, which is the layer meant
 * to change when a hue does.
 *
 * **Applied as a 2px inset ring on the tile, never as a fill and never as text
 * colour** (PD-15). The six tokens are vetted as *marks* on the app surface;
 * a saturated fill behind the wallet glyph would be a foreground/background
 * pairing nobody has checked, on a product with one theme and no contrast
 * formula anywhere in the codebase. The ring is the usage the tokens already
 * carry. The CSS rule that consumes this value lives in
 * `styles/screens/portfolios.css` (PD-T11).
 */
const ACCENT_COLOR: Record<PortfolioAccentColor, string> = {
  CHART_1: "var(--chart-1)",
  CHART_2: "var(--chart-2)",
  CHART_3: "var(--chart-3)",
  CHART_4: "var(--chart-4)",
  CHART_5: "var(--chart-5)",
  CHART_6: "var(--chart-6)",
};

export function portfolioAccentColor(token: PortfolioAccentColor): string {
  return ACCENT_COLOR[token];
}
