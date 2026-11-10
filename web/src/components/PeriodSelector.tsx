import {
  CUSTOM_RANGE_ID,
  CUSTOM_RANGE_LABEL,
  CUSTOM_RANGE_LONG_LABEL,
  customRangeRejectionMessage,
  PERIOD_PRESETS,
  resolveCustomRange,
  type PeriodPreset,
} from "../lib/period-presets.js";
import { FORM_COPY } from "../lib/copy/forms.js";
import type { PeriodSelectorCustom } from "../lib/range-search.js";
import { Input } from "./ui/index.js";

export interface PeriodSelectorProps {
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  /**
   * The presets to offer, defaulting to every one of them —
   * `period-presets.ts`'s full set, which is what Aperçu and Performance take
   * and what this control has always rendered.
   *
   * A prop rather than a second component: the Suivi screen offers `WATCHLIST_PERIOD_PRESETS` (this set minus
   * `MAX`, because `GET /watchlist`'s series load is bounded), and a copy of
   * this control would be two segmented groups to keep in step on labels,
   * `aria-pressed`, touch targets and the abbreviated/spelled-out split.
   * Nothing about the default call shape changes.
   */
  readonly presets?: readonly PeriodPreset[];
  /** Opt-in — absent means this control offers presets only, exactly as it did before. */
  readonly custom?: PeriodSelectorCustom;
}

/**
 * The overview's TWR/MWR period selector (T-45). Purely presentational — the caller
 * (`OverviewRoute.tsx`) owns the URL search-param round trip, so this
 * component only ever deals in preset ids (`period-presets.ts`) and, since
 * A `[from, to]` it has validated against the same bounds the server
 * enforces. `aria-pressed` marks the active option; every button is a >=44px
 * touch target, matching T-44's own touch-target convention.
 *
 * **The visible label is abbreviated, the accessible name is not.** Six
 * spelled-out presets wrapped `.k-pagehead-actions` onto extra lines on both
 * screens that mount this (Aperçu, Performance), so the button shows "3M"/"1A"
 * and carries `period-presets.ts`'s `longLabel` as both `title` and
 * `aria-label` — nothing is lost to a screen reader or to a hover, and the
 * header stays one line. `k-segmented-compact` is what keeps it there
 * (`components.css`: tighter padding, `nowrap`).
 *
 * ## The custom window
 *
 * **Which option is lit is derived from the URL, never from component state** —
 * `selected === CUSTOM_RANGE_ID`, the same derivation
 * `DividendPeriodSelector`/`matchDividendPeriod` uses, so a button cannot
 * drift out of step with the window it claims to describe. This control needs
 * no `useState` at all for the disclosure, because selecting «Perso.» always
 * writes a window: there is no "open but nothing applied" state to remember.
 *
 * **«Perso.» resolves no window of its own.** It calls `onOpen`, and the
 * caller seeds the URL with the window already on screen, so clicking it
 * changes which control is lit and not a single figure. A `CUSTOM` id written
 * with empty bounds would resolve (`resolveRange`) to the *default* preset's
 * window — the reader would click «Perso.» on a `MAX` chart and watch it jump
 * to one year.
 *
 * **An invalid window is refused here, not by the server.**
 * `resolveReturnWindow` rejects an out-of-bounds explicit bound rather than
 * clamping it (400), which is T-45's F1 finding in the other direction: the
 * reason is shown on the offending field and no request is issued, because
 * `resolveRange` keeps returning the fallback window until both bounds
 * validate.
 */
export function PeriodSelector({
  selected,
  onSelect,
  presets = PERIOD_PRESETS,
  custom,
}: PeriodSelectorProps) {
  const isCustom = custom !== undefined && selected === CUSTOM_RANGE_ID;
  const resolved = isCustom
    ? resolveCustomRange({
        ...(custom.from === undefined ? {} : { from: custom.from }),
        ...(custom.to === undefined ? {} : { to: custom.to }),
      })
    : undefined;
  const rejection =
    resolved === undefined || resolved.ok
      ? undefined
      : customRangeRejectionMessage(resolved.reason);
  // Which field carries the message: the one the reader must move to fix it.
  // `malformed` is the exception — it names whichever bound is unparseable,
  // and both, when both are.
  const reason = resolved === undefined || resolved.ok ? undefined : resolved.reason;
  const fromError =
    rejection !== undefined &&
    (reason === "reversed" ||
      reason === "too-early" ||
      reason === "too-wide" ||
      (reason === "malformed" && !isParseableDate(custom?.from)))
      ? rejection
      : undefined;
  const toError =
    rejection !== undefined &&
    (reason === "future" || (reason === "malformed" && !isParseableDate(custom?.to)))
      ? rejection
      : undefined;

  return (
    <div className="k-period">
      <div
        data-testid="period-selector"
        role="group"
        aria-label={FORM_COPY.period}
        className="k-segmented k-segmented-md k-segmented-compact"
      >
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid={`period-option-${preset.id}`}
            aria-pressed={preset.id === selected}
            aria-label={preset.longLabel}
            title={preset.longLabel}
            onClick={() => onSelect(preset.id)}
            data-selected={preset.id === selected}
            className="k-segment k-segment-button"
          >
            {preset.label}
          </button>
        ))}
        {custom !== undefined && (
          <button
            type="button"
            data-testid={`period-option-${CUSTOM_RANGE_ID}`}
            aria-pressed={isCustom}
            aria-label={CUSTOM_RANGE_LONG_LABEL}
            title={CUSTOM_RANGE_LONG_LABEL}
            onClick={custom.onOpen}
            data-selected={isCustom}
            className="k-segment k-segment-button"
          >
            {CUSTOM_RANGE_LABEL}
          </button>
        )}
      </div>

      {custom !== undefined && isCustom && (
        <div data-testid="period-custom" className="k-period-custom">
          <Input
            label={FORM_COPY.dateFrom}
            type="date"
            size="sm"
            data-testid="period-custom-from"
            value={custom.from ?? ""}
            {...(fromError === undefined ? {} : { error: fromError })}
            onChange={(event) =>
              custom.onChange({
                from: event.target.value,
                ...(custom.to === undefined ? {} : { to: custom.to }),
              })
            }
          />
          <Input
            label={FORM_COPY.dateTo}
            type="date"
            size="sm"
            data-testid="period-custom-to"
            value={custom.to ?? ""}
            {...(toError === undefined ? {} : { error: toError })}
            onChange={(event) =>
              custom.onChange({
                ...(custom.from === undefined ? {} : { from: custom.from }),
                to: event.target.value,
              })
            }
          />
        </div>
      )}
    </div>
  );
}

/** Only used to decide which of the two fields a `malformed` message belongs on. */
function isParseableDate(value: string | undefined): boolean {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
