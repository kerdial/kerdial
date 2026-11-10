import { assertValidScale, tryFormatAmount, type FigureKind } from "../lib/figure-format.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";

/**
 * `<LedgerAmount>` — UR-18 (OD-4,
 * FR-109/AC102). Amended on 2026-08-17 — see `TransactionFxDisclosure.tsx`'s own header for the amendment.
 *
 * Renders one of `TransactionResponse`'s bare decimal-string fields
 * (`grossAmount`/`feeAmount`/`withholdingAmount`/`targetAmount`/`unitPrice`/
 * `quantity`/an FX rate) — a shape **no `ValuedAmount` ever describes**
 * (`GET /transactions*` carries no `provenance` envelope at all). Formats
 * through `figure-format.ts` (UR-5), the exact same formatters/degradation
 * `<Figure>` shares, but:
 *
 * - resolves `scale` **internally** via {@link resolveMinorUnit}, so a ledger
 *   call site cannot get it wrong (unlike `<Figure>`, which takes `scale` as
 *   a prop);
 * - renders `—` for a `null` amount (a genuinely absent leg — e.g. a
 *   DEPOSIT's `unitPrice`) and for an unformattable one, via the same
 *   `tryFormatAmount` degradation `<Figure>` uses;
 * - **has no provenance code path at all**: no `Figure` import, no
 *   `ValuedAmount` reference, no provenance-badge type name, no Radix
 *   `Tooltip` mount of any kind. This is a structural property, not a
 *   per-call-site convention — `figure-format-sole-importer.test.ts`-style
 *   source-text scanning (`LedgerAmount.test.tsx`) and a live mount-count
 *   proof both hold it to that.
 *
 * Its two classes — `.ledger-amount` (ink-black by default)
 * and `.ledger-amount-absent` — are declared in
 * `styles/screens/activity.css`, because this component belongs to the ledger
 * screen's restyle. They are named for the component rather than for
 * that screen, since the transaction drawer renders it too.
 *
 * `kind` only ever needs three of `figure-format.ts`'s four `FigureKind`
 * values for the ledger's own fields;
 * `"percentage"` is never a ledger field and is deliberately excluded here.
 */
export type LedgerAmountKind = Extract<FigureKind, "monetary" | "quantity" | "fxRate">;

export interface LedgerAmountProps {
  readonly amount: string | null;
  readonly currency: string | null;
  /** Defaults to `"monetary"` — the shape every `TransactionResponse` monetary field takes. */
  readonly kind?: LedgerAmountKind;
}

const UNAVAILABLE = (
  <span data-testid="ledger-amount" className="ledger-amount-absent">
    —
  </span>
);

export function LedgerAmount({ amount, currency, kind = "monetary" }: LedgerAmountProps) {
  if (amount === null) return UNAVAILABLE;

  const scale = resolveMinorUnit(currency ?? undefined);
  assertValidScale(kind, scale);
  const formatted = tryFormatAmount(kind, amount, scale);
  if (formatted === undefined) return UNAVAILABLE;

  return (
    <span data-testid="ledger-amount" className="k-num ledger-amount">
      {formatted}
      {kind === "monetary" && currency !== null ? ` ${currency}` : null}
    </span>
  );
}
