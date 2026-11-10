import type { RealizedGainResponse } from "../lib/api-client.js";
import { summarizeRealizedGains } from "../lib/positions.js";
import { DeltaValue, deltaSign, GlossaryHint } from "./ui/index.js";

export interface RealizedGainsIndicatorProps {
  readonly gains: readonly RealizedGainResponse[];
}

/**
 * AC144 (the AC126 refinement, orchestrator, 2026-08-17): a compact realised-result
 * **signal**, rendered in the collapsed row/card so a holding's realised
 * result is visible while scanning Positions with no interaction at all.
 *
 * **It now distinguishes a gain from a loss.** It used to label every outcome
 * « Gains réalisés » and print the total untinted, so a realised loss read as
 * a gain that happened to be negative — the one thing the money-meaning
 * colours exist to prevent. French has the domain pair for this, so the label
 * itself carries the direction (*plus-value* / *moins-value*) and the amount is
 * tinted through the same `<DeltaValue>` the unrealised column already uses:
 * one visual vocabulary for direction on this screen, not two.
 *
 * The sign comes from the summary's raw signed total, never from the formatted
 * text — `deltaSign` tolerates display text but the raw decimal is what it is
 * documented to prefer, and an unparseable total stays `flat` (neutral grey)
 * rather than inventing a direction.
 *
 * Renders nothing for a holding with no realised result — the same "present
 * only when sales occurred" rule `<HoldingRealizedGains>` follows (AC25).
 */
export function RealizedGainsIndicator({ gains }: RealizedGainsIndicatorProps) {
  const summary = summarizeRealizedGains(gains);
  if (summary === undefined) return null;

  const sign = deltaSign(summary.totalAmount);
  const label =
    sign === "gain"
      ? "Plus-value réalisée"
      : sign === "loss"
        ? "Moins-value réalisée"
        : "Résultat réalisé";

  return (
    <p
      data-testid="holding-realized-gains-indicator"
      data-sign={sign}
      className="holdings-gains-indicator"
    >
      {/* One definition covers all three labels — `GLOSSARY_COPY.realized`
          is sign-neutral on purpose, since a reader who does not know what a
          realised result is meets it here under whichever of the three names
          this holding happens to warrant. */}
      <span>
        {label} <GlossaryHint term="realized" /> ({summary.count}) :{" "}
      </span>
      <DeltaValue text={summary.totalText} sign={sign} size="sm" />
    </p>
  );
}
