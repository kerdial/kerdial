import type { DividendTotalsRow } from "../lib/api-client.js";
import { DIVIDEND_COPY } from "../lib/copy/dividends.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { tryFormatAmount } from "../lib/figure-format.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { Card, GlossaryHint } from "./ui/index.js";

/**
 * The Dividendes hero.
 *
 * One large figure, `total.grossBase`, and three companions beside it. The
 * total is the response's own (FR-270: the server's fold, not a re-sum here),
 * as the old footer row's was; it moved up because a total is the answer, and
 * the answer belongs before the detail.
 *
 * **Withholding is a positive magnitude with no sign** (LD-1). Beside the
 * gross, a « −482,15 » would read as "subtract this from that", and the
 * difference is the one figure this screen never forms. The term carries its
 * glossary definition here: it is the one place on the screen the words
 * « Retenue à la source » are spelled out — the payer rows abbreviate to
 * « ret. » and point back to this.
 *
 * **The payment count is a sum the client is allowed to make.** The old table
 * refused to total the « Versements » column because the response carries no
 * total count; that refusal was about *money* columns, where a client sum can
 * disagree with the server's fold. A payment belongs to exactly one instrument
 * (a DIVIDEND row has one `instrument_id`), so the per-instrument distinct
 * counts partition the payments and their integer sum is exact by
 * construction — the same reasoning `dividend-summary-service.ts` uses to sum
 * per-month counts into the per-instrument one.
 */
export interface DividendHeroProps {
  readonly total: DividendTotalsRow;
  readonly instrumentCount: number;
  readonly paymentCount: number;
  readonly baseCurrency: string;
}

export function DividendHero({
  total,
  instrumentCount,
  paymentCount,
  baseCurrency,
}: DividendHeroProps) {
  const gross = tryFormatAmount("monetary", total.grossBase, resolveMinorUnit(baseCurrency));
  return (
    <Card data-testid="dividend-hero">
      <div className="dividends-hero">
        <div className="dividends-hero-main">
          <span className="dividends-eyebrow">{DIVIDEND_COPY.heroGross}</span>
          <span className="dividends-hero-value k-num" data-testid="dividend-total-gross">
            {gross === undefined ? (
              <LedgerAmount amount={total.grossBase} currency={baseCurrency} />
            ) : (
              <>
                {gross} <span className="dividends-hero-unit">{baseCurrency}</span>
              </>
            )}
          </span>
        </div>
        <dl className="dividends-hero-stats">
          <div className="dividends-hero-stat">
            <dt className="dividends-eyebrow">
              {DIVIDEND_COPY.heroWithholding}
              <GlossaryHint term="withholding" />
            </dt>
            <dd className="dividends-hero-stat-value" data-testid="dividend-total-withholding">
              <LedgerAmount amount={total.withholdingBase} currency={baseCurrency} />
            </dd>
          </div>
          <div className="dividends-hero-stat">
            <dt className="dividends-eyebrow">{DIVIDEND_COPY.heroPayments}</dt>
            <dd className="dividends-hero-stat-value k-num" data-testid="dividend-payment-count">
              {paymentCount}
            </dd>
          </div>
          <div className="dividends-hero-stat">
            <dt className="dividends-eyebrow">{DIVIDEND_COPY.heroInstruments}</dt>
            <dd className="dividends-hero-stat-value k-num" data-testid="dividend-instrument-count">
              {instrumentCount}
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}
