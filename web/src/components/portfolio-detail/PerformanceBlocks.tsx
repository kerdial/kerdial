import type { GlossaryTermId } from "../../lib/copy/glossary.js";
import { PORTFOLIO_COPY } from "../../lib/copy/portfolios.js";
import { Figure } from "../Figure.js";
import { JargonTerm } from "../ui/index.js";
import { toAutomatedFigure } from "../../lib/synthetic-figure.js";
import { ReturnUnavailable } from "../ReturnUnavailable.js";

/**
 * `PerformanceBlocks.tsx` — the TWR/MWR detail blocks and the sunken footer
 * strip the portfolio workspace's cards share, extracted
 * from `routes/PortfolioDetailView.tsx`.
 */

/**
 * `TWR_HINT`/`MWR_HINT` stood here and were imported by three siblings.
 * Both moved into `lib/copy/glossary.ts`, which is now the one
 * home for every jargon definition in the app — two other screens were
 * carrying a *third* and *fourth* wording of the same two ideas
 * (`OVERVIEW_COPY.twrHint`, `PERFORMANCE_COPY.twrHint`), which is what a
 * per-component constant cannot prevent and a catalogue can.
 */

export interface TwrResponseLike {
  readonly available: boolean;
  readonly cumulative?: string;
  readonly annualised?: string | null;
  readonly rangeDays?: number;
  readonly subPeriodCount?: number;
  readonly reasonCode?: string;
  readonly reason?: string;
}

export interface MwrResponseLike {
  readonly converged: boolean;
  readonly rate?: string;
  readonly method?: "newton" | "bisection";
  readonly iterations?: number;
  readonly reasonCode?: string;
  readonly reason?: string;
}

/**
 * Owner decision (supersedes AC135's "rendered verbatim"): an unavailable
 * figure reads as the French line its `reasonCode` maps to, with the API's
 * English `reason` behind a hint — see `ReturnUnavailable`. Still no branch on
 * the text of `reason`.
 */
export function TwrDetail({ twr }: { readonly twr: TwrResponseLike }) {
  if (!twr.available) {
    return (
      <p data-testid="performance-twr-unavailable" className="k-pf-muted">
        <ReturnUnavailable reasonCode={twr.reasonCode} reason={twr.reason} />
      </p>
    );
  }
  return (
    <dl className="k-pf-defs">
      <dt>{PORTFOLIO_COPY.twrCumulated}</dt>
      <dd data-testid="performance-twr-cumulative">
        <Figure value={toAutomatedFigure(twr.cumulative ?? "0")} kind="percentage" />
      </dd>
      <dt>{PORTFOLIO_COPY.twrAnnualised}</dt>
      <dd data-testid="performance-twr-annualised">
        {twr.annualised === null || twr.annualised === undefined ? (
          "—"
        ) : (
          <Figure value={toAutomatedFigure(twr.annualised)} kind="percentage" />
        )}
      </dd>
      <dt>{PORTFOLIO_COPY.twrRangeDays}</dt>
      <dd className="k-num" data-testid="performance-twr-range-days">
        {twr.rangeDays ?? "—"}
      </dd>
      <dt>{PORTFOLIO_COPY.subPeriods}</dt>
      <dd className="k-num" data-testid="performance-twr-sub-period-count">
        {twr.subPeriodCount ?? "—"}
      </dd>
    </dl>
  );
}

/** See {@link TwrDetail}'s own doc comment; identical stance for MWR. */
export function MwrDetail({ mwr }: { readonly mwr: MwrResponseLike }) {
  if (!mwr.converged) {
    return (
      <p data-testid="performance-mwr-unavailable" className="k-pf-muted">
        <ReturnUnavailable reasonCode={mwr.reasonCode} reason={mwr.reason} />
      </p>
    );
  }
  return (
    <dl className="k-pf-defs">
      <dt>{PORTFOLIO_COPY.mwrRate}</dt>
      <dd data-testid="performance-mwr-rate">
        <Figure value={toAutomatedFigure(mwr.rate ?? "0")} kind="percentage" />
      </dd>
      <dt>{PORTFOLIO_COPY.mwrMethodShort}</dt>
      <dd data-testid="performance-mwr-method">{mwr.method ?? "—"}</dd>
      <dt>{PORTFOLIO_COPY.mwrIterations}</dt>
      <dd className="k-num" data-testid="performance-mwr-iterations">
        {mwr.iterations ?? "—"}
      </dd>
    </dl>
  );
}

/** One footer-strip cell — the sunken row a performance/allocation card ends on. */
export function FootStripItem({
  label,
  value,
  term,
}: {
  readonly label: string;
  readonly value: string;
  /** « Méthode MWR » names an acronym in a footer cell, and once named it unexplained; the hint fixes that. */
  readonly term?: GlossaryTermId;
}) {
  return (
    <div className="k-pf-footstrip-item">
      <span className="micro-label">
        {term === undefined ? label : <JargonTerm term={term}>{label}</JargonTerm>}
      </span>
      <span className="k-pf-footstrip-value k-num">{value}</span>
    </div>
  );
}
