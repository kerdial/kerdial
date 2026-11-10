import type { HTMLAttributes, ReactNode } from "react";
import type { GlossaryTermId } from "../../lib/copy/glossary.js";
import { DefinitionHint, GlossaryHint } from "./GlossaryHint.js";
import { Icon, type IconName } from "./Icon.js";

/**
 * The KPI tile: a micro-label, a value, and an optional signed delta.
 *
 * `value` is a **pre-formatted node**, never a number. Formatting stays in
 * `figure-format.ts`/`<Figure>` so a tile cannot round or localise a figure
 * differently from the table showing the same number — which is exactly the
 * class of bug that is invisible until two screens disagree.
 *
 * `hintTerm`/`hint` render the design's `circle-help` affordance.
 *
 * **It is a real tooltip now.** It used to be
 * `<Icon name="circle-help" label={hint}/>` — an `aria-label` and nothing
 * else, so the explanation existed for a screen reader and for nobody looking
 * at the screen. Both props go through `GlossaryHint.tsx`'s focusable trigger
 * instead, which keeps the old `aria-label` fallback (the definition is still
 * the control's accessible name) and adds the visible, Esc-dismissible half
 * that was missing.
 *
 * `hintTerm` is the catalogued form and the one a jargon term must use —
 * `<StatTile hintTerm="twr">` cannot drift from the same term's definition on
 * the table header two screens away. `hint` stays for the handful of tiles
 * whose explanation is not a glossary term at all (the day-change tile's
 * "price move only, flows excluded" caveat).
 */
export type StatTileTone = "default" | "sunken" | "brand" | "inverse";

export interface StatTileProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  readonly label: string;
  readonly value: ReactNode;
  /** Rendered under the value — normally a `<DeltaValue>`. */
  readonly delta?: ReactNode;
  readonly deltaSuffix?: string;
  readonly icon?: IconName;
  /** A glossary term — the catalogued form. Takes precedence over `hint`. */
  readonly hintTerm?: GlossaryTermId;
  /** A one-sentence explanation that is not a glossary term. Always catalogue copy. */
  readonly hint?: string;
  readonly tone?: StatTileTone;
}

export function StatTile({
  label,
  value,
  delta,
  deltaSuffix,
  icon,
  hintTerm,
  hint,
  tone = "default",
  ...rest
}: StatTileProps) {
  return (
    <div {...rest} className={`k-stat k-stat-${tone}`} data-tone={tone}>
      <div className="k-stat-head">
        <span className="micro-label">{label}</span>
        {icon !== undefined ? <Icon name={icon} size="sm" className="k-stat-icon" /> : null}
        {hintTerm !== undefined ? <GlossaryHint term={hintTerm} /> : null}
        {hintTerm === undefined && hint !== undefined ? (
          <DefinitionHint definition={hint} testId="stat-tile-hint" />
        ) : null}
      </div>
      <div className="k-stat-value">{value}</div>
      {delta !== undefined ? (
        <div className="k-stat-delta">
          {delta}
          {deltaSuffix !== undefined ? <span className="k-stat-suffix">{deltaSuffix}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
