import { useState } from "react";
import {
  DIVIDEND_PERIOD_IDS,
  dividendPeriodLabel,
  dividendPeriodLongLabel,
  matchDividendPeriod,
  resolveDividendPeriod,
  type DividendPeriodRange,
} from "../lib/dividend-period-presets.js";
import { Input } from "./ui/index.js";
import { FORM_COPY } from "../lib/copy/forms.js";

/**
 * The Dividendes screen's period control — DS-8
 * (FR-271/FR-272,
 * AC-286; LD-6, DV8, DV9).
 *
 * A **sibling** of `PeriodSelector.tsx` in the `SegmentedControl` family, not a
 * fork of it and not an extension of it (DV8): `PeriodSelector` defaults to
 * `1Y` and resolves every preset to a bounded trailing window, which is exactly
 * the behaviour FR-271 forbids here — the unselected default has to be the
 * tenant's entire history. Reusing it would have made AC-286 unsatisfiable, and
 * changing it would have broken the overview. Neither file is modified.
 *
 * **The control is stateless about the window.** Which preset is lit comes from
 * `matchDividendPeriod(props)`, derived on every render from the URL the route
 * owns — never mirrored into component state, so a preset button cannot drift
 * out of step with the window it claims to describe. The one piece of local
 * state is whether the two custom date fields are revealed, which is a
 * disclosure, not data.
 *
 * **Abbreviated labels, spelled-out accessible names.** Seven buttons reading
 * "Depuis le début" / "Depuis le 1er janvier" / four years / "Personnalisée…"
 * made this the app's tallest page header: the row wrapped onto three lines and
 * pushed the portfolio filter beside it onto a fourth. The visible token is now
 * `dividendPeriodLabel`'s one word ("Tout", "2026", …, "Perso.") and
 * `dividendPeriodLongLabel` is carried as each button's `title` and
 * `aria-label`, so nothing a screen reader or a hover sees changed. The custom
 * date fields sit **beside** the row rather than under it, for the same reason.
 *
 * **«Personnalisée…» changes no window.** Clicking it opens the two
 * `<input type="date">` fields over whatever window is already applied; the
 * user then edits a bound. A preset that resolved «Personnalisée…» to some
 * window of its own would silently overwrite the dates a bookmark carried.
 */
export interface DividendPeriodSelectorProps {
  readonly from?: string;
  readonly to?: string;
  readonly onChange: (range: DividendPeriodRange) => void;
  /** Injectable purely for deterministic tests, mirroring `resolveDividendPeriod`'s own parameter. */
  readonly today?: string;
}

export function DividendPeriodSelector({ from, to, onChange, today }: DividendPeriodSelectorProps) {
  const selected = matchDividendPeriod({ from, to }, today);
  const [customOpen, setCustomOpen] = useState(false);
  const showCustomFields = customOpen || selected === "CUSTOM";

  return (
    <div className="dividends-period">
      <div
        data-testid="dividend-period-selector"
        role="group"
        aria-label={FORM_COPY.period}
        className="k-segmented k-segmented-md k-segmented-compact"
      >
        {DIVIDEND_PERIOD_IDS.map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`dividend-period-option-${id}`}
            aria-pressed={id === selected}
            aria-label={dividendPeriodLongLabel(id, today)}
            title={dividendPeriodLongLabel(id, today)}
            data-selected={id === selected}
            className="k-segment k-segment-button"
            onClick={() => {
              if (id === "CUSTOM") {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              onChange(resolveDividendPeriod(id, today));
            }}
          >
            {dividendPeriodLabel(id, today)}
          </button>
        ))}
      </div>

      {showCustomFields && (
        <div data-testid="dividend-period-custom" className="dividends-period-custom">
          <Input
            label={FORM_COPY.dateFrom}
            type="date"
            size="sm"
            data-testid="dividend-period-from"
            value={from ?? ""}
            onChange={(event) =>
              onChange({
                ...(event.target.value === "" ? {} : { from: event.target.value }),
                ...(to === undefined ? {} : { to }),
              })
            }
          />
          <Input
            label={FORM_COPY.dateTo}
            type="date"
            size="sm"
            data-testid="dividend-period-to"
            value={to ?? ""}
            onChange={(event) =>
              onChange({
                ...(from === undefined ? {} : { from }),
                ...(event.target.value === "" ? {} : { to: event.target.value }),
              })
            }
          />
        </div>
      )}
    </div>
  );
}
