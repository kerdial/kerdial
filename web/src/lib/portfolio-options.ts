import type { PortfolioSummary } from "./api/portfolios.js";
import { PORTFOLIO_COPY } from "./copy/portfolios.js";

type PortfolioOptionSource = Pick<PortfolioSummary, "id" | "name" | "archived">;

/**
 * portfolio-archive FR-596 / PA-L1 — the option list of every
 * portfolio picker and filter: non-archived portfolios, plus the current value
 * when it is archived, labelled with the « (archivé) » suffix so an edit form
 * or a deep-linked filter (PA-L10) never shows a blank or silently changes its
 * value. List order is kept; the placeholder option stays at each call site.
 *
 * `!== true` rather than `!p.archived`: a loosely-typed fixture (an e2e mock)
 * that omits the field reads as not archived instead of hiding everything.
 *
 * **Not for name lookups** (active-filter chips, ledger rows, delete dialogs):
 * those must still resolve an archived portfolio's name.
 */
export function portfolioSelectOptions(
  portfolios: readonly PortfolioOptionSource[],
  current: string,
  valueOf: "id" | "name" = "id",
): { value: string; label: string }[] {
  return portfolios
    .filter((p) => p.archived !== true || p[valueOf] === current)
    .map((p) => ({
      value: p[valueOf],
      label: p.archived === true ? `${p.name} ${PORTFOLIO_COPY.archivedSuffix}` : p.name,
    }));
}
