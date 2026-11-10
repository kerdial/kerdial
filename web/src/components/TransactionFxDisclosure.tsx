import type { TransactionResponse } from "../lib/api-client.js";
import { TRANSACTION_DETAIL_COPY } from "../lib/copy/transaction-detail.js";
import { Badge, JargonTerm } from "./ui/index.js";
import { LedgerAmount } from "./LedgerAmount.js";

/**
 * `<TransactionFxDisclosure>` — UR-18 (OD-4).
 *
 * > ⚠ **AMENDED (2026-08-17).**
 * > AC139 / AC142: renders **all three** independent FX legs
 * > (principal / fee / withholding) — each with its own `Rate`/`Source`/
 * > `ObservedOn`/`UserInput` quintet — and states explicitly that only the
 * > principal leg is correctable (`PATCH /transactions/:id/fx-rate` takes
 * > `{fxRate}` only; fee/withholding legs are unreachable by any edit path).
 *
 * Rendered **only** inside the transaction detail panel (`?tx=<uuid>`,
 * `ActivityRoute.tsx`), never per-row — the ledger row itself carries no FX
 * marker at all, deliberately, so nothing on a row can be mistaken for
 * `<Figure>`'s badge vocabulary.
 *
 * **One leg is left: the principal.** Its `fxRate`/`fxRateSource` are never
 * null on the wire (always resolved at write time), so it always renders. The
 * fee leg was removed first and the withholding leg later, for one reason: both
 * are now denominated by the settling account and carried at the principal's
 * implied rate, so neither has a rate of its own to disclose, and with no
 * uncorrectable leg left the «only the principal is correctable» note has
 * nothing to qualify here (the correction dialog still states it).
 *
 * `fxRateSource` is typed `string` on the wire (not an enum) — a known value
 * (`USER_PINNED`/`PROVIDER`/`IMPLIED_BASE`/`QUOTE_PROVIDER`, `<Figure>`'s own
 * `FxSource` set, assumed but **not imported from
 * `Figure.tsx`** — this component has no dependency on that provenance
 * vocabulary at all) maps to a French label; an unrecognised value renders
 * **verbatim**, under the same neutral "Source" label, never a crash.
 */
export type TransactionFxDisclosureTransaction = Pick<
  TransactionResponse,
  "fxRate" | "fxRateSource" | "fxRateObservedOn" | "fxRateUserInput"
>;

export interface TransactionFxDisclosureProps {
  readonly transaction: TransactionFxDisclosureTransaction;
}

/** Assumed to be the `ValuedAmount` `FxSource` set — a plain string map, never imported from `Figure.tsx` (no dependency on that provenance vocabulary here). */
const KNOWN_FX_SOURCE_LABELS: Readonly<Record<string, string>> = {
  USER_PINNED: "Épinglé par l'utilisateur",
  PROVIDER: "Fournisseur de cours",
  IMPLIED_BASE: "Devise de base (taux 1)",
  QUOTE_PROVIDER: "Fournisseur de cotation",
};

/** A known source maps to its French label; an unrecognised one renders verbatim — never a crash, never a guessed translation. */
function fxSourceText(source: string): string {
  return KNOWN_FX_SOURCE_LABELS[source] ?? source;
}

const FR_DATE = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });

/** French display of an ISO date; falls back to the raw string if it does not parse — same degradation convention `Figure.tsx`'s own `formatFrenchDate` uses. */
function formatFrenchDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) ? FR_DATE.format(parsed) : iso;
}

interface FxLeg {
  readonly key: "principal";
  readonly title: string;
  readonly rate: string;
  readonly source: string;
  readonly observedOn: string | null;
  readonly userInput: string | null;
}

function buildLegs(t: TransactionFxDisclosureTransaction): FxLeg[] {
  const legs: FxLeg[] = [
    {
      key: "principal",
      title: "Principal",
      rate: t.fxRate,
      source: t.fxRateSource,
      observedOn: t.fxRateObservedOn,
      userInput: t.fxRateUserInput,
    },
  ];
  // **A «Frais» leg stood here earlier.** A cost carried its own
  // resolved rate (FR-60/AC49) and this disclosure showed it beside the
  // principal's. L5 retired that rate and `0049` dropped the columns: a cost
  // is now carried at the principal leg's own rate, which the "Principal" row
  // above already states. Showing it twice under two names would imply two
  // independent resolutions, which is exactly what stopped being true. A
  // «Retenue à la source» leg followed it out, for the same reason.
  return legs;
}

export function TransactionFxDisclosure({ transaction }: TransactionFxDisclosureProps) {
  const legs = buildLegs(transaction);

  return (
    <div data-testid="transaction-fx-disclosure" className="k-ov-section">
      {legs.map((leg) => (
        <section key={leg.key} data-testid={`transaction-fx-leg-${leg.key}`} className="k-ov-group">
          <h4 className="k-ov-group-title">{leg.title}</h4>
          <dl className="k-ov-rows">
            <div className="k-ov-row">
              <dt className="k-ov-row-label">
                <JargonTerm term="fxRate">{TRANSACTION_DETAIL_COPY.fxRate}</JargonTerm>
              </dt>
              <dd className="k-ov-row-value" data-testid={`transaction-fx-leg-${leg.key}-rate`}>
                <LedgerAmount amount={leg.rate} currency={null} kind="fxRate" />
              </dd>
            </div>
            <div className="k-ov-row">
              <dt className="k-ov-row-label">{TRANSACTION_DETAIL_COPY.fxSource}</dt>
              <dd className="k-ov-row-value" data-testid={`transaction-fx-leg-${leg.key}-source`}>
                {fxSourceText(leg.source)}
              </dd>
            </div>
            {leg.observedOn !== null && (
              <div className="k-ov-row">
                <dt className="k-ov-row-label">{TRANSACTION_DETAIL_COPY.fxObservedOn}</dt>
                <dd
                  className="k-ov-row-value"
                  data-testid={`transaction-fx-leg-${leg.key}-observed-on`}
                >
                  {formatFrenchDate(leg.observedOn)}
                </dd>
              </div>
            )}
            {leg.userInput !== null && (
              <div className="k-ov-row">
                <dt className="k-ov-row-label">{TRANSACTION_DETAIL_COPY.fxUserInput}</dt>
                <dd className="k-ov-row-value" data-testid={`transaction-fx-leg-${leg.key}-pinned`}>
                  <Badge tone="brand" icon="pin">
                    <LedgerAmount amount={leg.userInput} currency={null} kind="fxRate" />
                  </Badge>
                </dd>
              </div>
            )}
          </dl>
        </section>
      ))}
    </div>
  );
}
