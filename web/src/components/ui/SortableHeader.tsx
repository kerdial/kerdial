import { Icon } from "./Icon.js";
import type { SortState } from "../../lib/table-sort.js";

export interface SortableHeaderProps<K extends string> {
  readonly label: string;
  readonly sortKey: K;
  readonly state: SortState<K> | undefined;
  readonly onToggle: (key: K) => void;
  /** Right-aligns the control for a numeric column, matching its cells. */
  readonly numeric?: boolean;
  readonly testId?: string;
}

/**
 * One clickable column header, shared by the Positions and Instruments tables
 * so the two cannot drift on affordance, keyboard behaviour or `aria-sort`.
 *
 * **A real `<button>`, not a click handler on the header `<span>`.** The header
 * cells are `<span>`s in a CSS grid rather than `<th>`s, so nothing is focusable
 * or activatable by default; a `div`/`span` with `onClick` would be reachable by
 * mouse only. The button carries the accessible name and the state, and the
 * `aria-sort` goes on the cell that wraps it (the caller's job — `role` and
 * `aria-sort` belong on the columnheader, not on the control inside it).
 *
 * The arrow is decorative — `Icon` is `aria-hidden` whenever it carries no
 * `label`, which is the case here: the direction is already announced through
 * `aria-sort` on the cell, and announcing it twice is the noise that makes
 * screen-reader users turn a table off.
 */
export function SortableHeader<K extends string>({
  label,
  sortKey,
  state,
  onToggle,
  numeric = false,
  testId,
}: SortableHeaderProps<K>) {
  const active = state?.key === sortKey;
  const direction = active ? state.direction : undefined;

  return (
    <button
      type="button"
      className={`k-sort-header${numeric ? " k-sort-header-num" : ""}${active ? " k-sort-header-active" : ""}`}
      data-testid={testId}
      data-sort-key={sortKey}
      data-sort-direction={direction}
      // The name says what the click will *do*, not what the column is —
      // "Trier par Valeur" is actionable where a bare "Valeur" leaves a
      // screen-reader user guessing whether the control sorts, filters or
      // opens something.
      aria-label={`Trier par ${label}`}
      onClick={() => {
        onToggle(sortKey);
      }}
    >
      <span>{label}</span>
      <Icon
        name={direction === "desc" ? "chevron-down" : "chevron-up"}
        size="xs"
        // Placeholder-but-invisible when inactive, so the label does not shift
        // horizontally the moment a column becomes sorted.
        className={active ? "k-sort-arrow k-sort-arrow-active" : "k-sort-arrow"}
      />
    </button>
  );
}
