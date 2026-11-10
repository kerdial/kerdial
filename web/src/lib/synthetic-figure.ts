import type { DerivedFromFlag, ValuedAmount } from "../components/Figure.js";

/**
 * Wraps a bare decimal string in the minimal `ValuedAmount` envelope
 * `<Figure>` requires, for the handful of wire fields T-39's API returns as a
 * plain string rather than a full `ValuedAmount` (the
 * architecture's envelope is documented for *monetary* figures; a few derived-but-unpriced
 * numbers never got one).
 *
 * F7 (security review, T-45, LOW): `derivedFrom` defaults to `[]`
 * (no badge; `Figure.tsx` only ever keys its "M"/"D"/pinned-FX badges off
 * `MANUAL_PRICE`/`DELAYED_QUOTE`/`PINNED_FX`, so `[]` renders identically to
 * the previous, overclaiming default of `["AUTOMATED"]`) rather than
 * asserting a provenance this helper cannot actually verify:
 *
 * - `return.twr.cumulative`/`return.twr.annualised`/`return.mwr.rate`
 *   (`api/src/portfolios/portfolios.schema.ts`'s `TwrOutcome`/`MwrResult`)
 *   are computed *over* potentially manually-priced, delayed, or FX-pinned
 *   inputs — a return figure's own aggregate provenance is not actually
 *   knowable from this wire shape alone, so claiming `AUTOMATED` (implying
 *   "definitely none of those") would overclaim. `[]` is the honest,
 *   make-no-claim default these call sites use.
 * - A holding's `quantity`, by contrast, genuinely is `AUTOMATED`: a ledger
 *   sum of transaction quantities has no price/FX concept attached at all
 *   (never manually entered, delayed, or pinned in the sense those flags
 *   mean) — `HoldingsTable.tsx`/`HoldingsCardList.tsx` pass
 *   `derivedFrom: ["AUTOMATED"]` explicitly for it, since that claim is
 *   actually true there.
 */
export function toAutomatedFigure(
  amount: string,
  currency = "",
  derivedFrom: readonly DerivedFromFlag[] = [],
): ValuedAmount {
  return { amount, currency, provenance: { derivedFrom } };
}
