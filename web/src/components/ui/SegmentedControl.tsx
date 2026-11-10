import { useId } from "react";

/**
 * The range control on every performance card (1D … ALL).
 *
 * Built as a radio group rather than a row of buttons: it is a single-choice
 * control, arrow keys should move between options, and the browser gives all
 * of that for free once the semantics are right. A row of `<button>`s looks
 * identical and behaves worse.
 */
export interface SegmentedOption {
  readonly value: string;
  readonly label: string;
}

export interface SegmentedControlProps {
  readonly options: readonly SegmentedOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Names the group for screen readers — "Période", "Plage de dates". */
  readonly label: string;
  readonly size?: "sm" | "md" | "lg";
  readonly fullWidth?: boolean;
  /** Puts `data-testid="<prefix><value>"` on each option's radio — the handle a spec clicks (`transaction-dialog-refresh` FR-646: `family-tab-<FAMILY>`). Absent, no test id is rendered. */
  readonly testIdPrefix?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  size = "md",
  fullWidth = false,
  testIdPrefix,
}: SegmentedControlProps) {
  const name = useId();

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`k-segmented k-segmented-${size}${fullWidth ? " k-segmented-full" : ""}`}
    >
      {options.map((option) => {
        const id = `${name}-${option.value}`;
        const selected = option.value === value;
        return (
          <label key={option.value} htmlFor={id} className="k-segment" data-selected={selected}>
            <input
              type="radio"
              id={id}
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="k-segment-input"
              data-testid={
                testIdPrefix === undefined ? undefined : `${testIdPrefix}${option.value}`
              }
            />
            <span className="k-segment-label">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}
