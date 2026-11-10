import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { InstrumentSummary } from "../lib/api-client.js";
import { ASSET_CLASS_ORDER, assetClassLabel, type AssetClass } from "../lib/asset-class.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { instrumentSearchQueryOptions } from "../lib/queries.js";
import { InstrumentResultRow } from "./InstrumentResultRow.js";
import { Button, Input } from "./ui/index.js";

/**
 * LOW-2 (security review), inherited unchanged from the plain
 * `InstrumentPicker` field this popover replaces: how long `query` must sit
 * idle before the debounced value it feeds `instrumentSearchQueryOptions`
 * (and therefore `GET /instruments?query=`) actually updates.
 */
const INSTRUMENT_SEARCH_DEBOUNCE_MS = 250;

export interface AssetSearchPopoverProps {
  readonly label: string;
  /** `${testId}-search` is the combobox input, `${testId}-results` the listbox, `${testId}-create` the create action — the handles the picker has always exposed, kept identical so nothing downstream had to move. */
  readonly testId: string;
  readonly onSelect: (instrument: InstrumentSummary) => void;
  /** The create action hands back the exact text the user typed, so the caller can seed `InstrumentCreateDialog` with it — the popover never opens that dialog itself. */
  readonly onCreate: (query: string) => void;
}

/**
 * The asset-search popover over the transaction drawer's instrument combobox:
 * 412px, keyboard-first.
 *
 * **It adds no read of its own.** `instrumentSearchQueryOptions` — the same
 * `GET /instruments?query=` the picker field has always used, on the same
 * `["instruments","search",query]` key — is still the only request this
 * surface makes, at the same 250ms debounce. The class chips filter the
 * result set *in the client*: narrowing by kind server-side would mean a
 * second endpoint (`/instruments/catalogue`'s `kind` parameter, a different
 * shape and a different key) and would make the footer's count dishonest —
 * "N of M" is only meaningful while N and M come from the same fetch.
 *
 * **Keyboard operation** (the whole point of this component):
 *
 * - `↑`/`↓` move the focused row. Nothing is focused until the user arrows —
 *   `Enter` on a freshly typed query must not commit a row the user never
 *   looked at, so `activeIndex` starts at `-1` (the APG list-autocomplete
 *   rule, and the reason the hint says `↑↓` before it says `⏎`).
 * - `Enter` selects the focused row. It is `preventDefault`ed whenever the
 *   popover is open, focused row or not: this field lives inside the
 *   transaction `<form>`, where a bare `Enter` would otherwise submit a
 *   half-filled drawer.
 * - `Escape` closes **the popover only** — see {@link useEscapeClosesPopover}
 *   for why that needs a `window`-capture listener rather than the obvious
 *   `stopPropagation` in this component's own `onKeyDown`.
 *
 * DOM focus never leaves the input; the focused row is published through
 * `aria-activedescendant` on a real `role="combobox"` pointing at a real
 * `role="listbox"` of `role="option"` rows (the ARIA 1.2 pattern, not
 * clickable `<div>`s). The row is tinted `--surface-brand-soft` *behind a 3px
 * inset brand bar* (`.k-ov-opt[aria-selected="true"]`, `screens/overlays.css`)
 * so the focused row is distinguishable by shape as well as by hue.
 */
export function AssetSearchPopover({ label, testId, onSelect, onCreate }: AssetSearchPopoverProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [kindFilter, setKindFilter] = useState<AssetClass | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const domId = useId();
  const listboxId = `${domId}-listbox`;
  const optionIdPrefix = `${domId}-option`;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), INSTRUMENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const searchQuery = useQuery(instrumentSearchQueryOptions(debouncedQuery));
  const found: InstrumentSummary[] = searchQuery.data ?? [];
  const shown = kindFilter === null ? found : found.filter((row) => row.kind === kindFilter);

  // "Still searching" covers both halves of the delay a user actually feels:
  // the debounce that has not committed yet, and the request it will commit.
  // Without the first half the popover would claim "aucune correspondance"
  // for 250ms after every keystroke.
  const searching =
    (query.trim() !== "" && query.trim() !== debouncedQuery.trim()) || searchQuery.isLoading;
  const showsEmptyState = !searching && shown.length === 0;

  const activeOptionIndex = activeIndex >= shown.length ? -1 : activeIndex;

  useEscapeClosesPopover(open, rootRef, setOpen);

  function commitQuery(next: string): void {
    setQuery(next);
    setActiveIndex(-1);
    setOpen(next.trim() !== "");
  }

  function select(instrument: InstrumentSummary): void {
    setOpen(false);
    onSelect(instrument);
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open && query.trim() !== "") setOpen(true);
      if (shown.length > 0) setActiveIndex((i) => Math.min(i + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length > 0) setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && open) {
      // Always prevented while open — see this component's own doc comment:
      // an unhandled Enter here submits the transaction drawer.
      event.preventDefault();
      const instrument = shown[activeOptionIndex];
      if (instrument !== undefined) select(instrument);
    }
  }

  // Closes when focus genuinely moves to something outside the popover. A
  // `null` `relatedTarget` (the window losing focus, and Safari's
  // mousedown-on-a-button) deliberately does *not* close it: unmounting the
  // rows between mousedown and click is how a click on a result would land
  // on nothing at all.
  function onRootBlur(event: ReactFocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    if (next === null) return;
    if (!event.currentTarget.contains(next)) setOpen(false);
  }

  const createAction = (
    <Button
      variant="soft"
      size="sm"
      iconLeft="plus"
      data-testid={`${testId}-create`}
      onClick={() => onCreate(query.trim())}
    >
      {INSTRUMENT_COPY.createInstrumentAction}
    </Button>
  );

  const chips = (
    <div className="k-ov-pop-chips" role="group" aria-label={INSTRUMENT_COPY.filterByAssetClass}>
      {ASSET_CLASS_ORDER.map((kind) => (
        <button
          key={kind}
          type="button"
          className="k-ov-chip"
          // A filter chip is a toggle, so it is `aria-pressed` rather than
          // `aria-selected`: the rows are the selectable things here, and
          // reusing the row's own state attribute on the filters would make
          // "selected" mean two different things inside one popover.
          aria-pressed={kindFilter === kind}
          data-testid={`${testId}-chip-${kind}`}
          onClick={() => {
            setKindFilter((current) => (current === kind ? null : kind));
            setActiveIndex(-1);
          }}
        >
          {assetClassLabel(kind)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="k-ov-search" ref={rootRef} onBlur={onRootBlur}>
      <Input
        label={label}
        iconLeft="search"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open && shown.length > 0 ? listboxId : undefined}
        aria-activedescendant={
          open && activeOptionIndex >= 0 ? `${optionIdPrefix}-${activeOptionIndex}` : undefined
        }
        data-testid={`${testId}-search`}
        value={query}
        placeholder={INSTRUMENT_COPY.searchPlaceholder}
        onChange={(event) => commitQuery(event.target.value)}
        onFocus={() => {
          if (query.trim() !== "") setOpen(true);
        }}
        onKeyDown={onInputKeyDown}
      />

      {open && (
        <div className="k-ov-pop" data-testid={`${testId}-popover`}>
          <p className="k-ov-pop-hint">
            <span aria-hidden="true">↑↓</span>
            {INSTRUMENT_COPY.keyboardHintNavigate}
            <span aria-hidden="true">⏎</span>
            {INSTRUMENT_COPY.keyboardHintSelect}
          </p>

          {/* The empty state hands over the action that fills it: with nothing
              to pick, "Créer un instrument…" is the FIRST focusable element in
              the popover, ahead of the class chips. */}
          {showsEmptyState && <div className="k-ov-pop-lead">{createAction}</div>}
          {showsEmptyState && (
            <p className="k-ov-pop-note" data-testid={`${testId}-empty`}>
              {found.length === 0 ? INSTRUMENT_COPY.noSearchMatch : INSTRUMENT_COPY.noClassMatch}
            </p>
          )}

          {chips}

          {searching && (
            <p className="k-ov-pop-note" data-testid={`${testId}-searching`}>
              {INSTRUMENT_COPY.searching}
            </p>
          )}

          {/* Rendered only when it has options, so `${testId}-results` keeps
              meaning "there are results" exactly as it did before. */}
          {shown.length > 0 && (
            <ul
              id={listboxId}
              role="listbox"
              aria-label={INSTRUMENT_COPY.resultsLabel}
              data-testid={`${testId}-results`}
              className="k-ov-results"
            >
              {shown.map((instrument, index) => (
                <li
                  key={instrument.id}
                  id={`${optionIdPrefix}-${index}`}
                  role="option"
                  aria-selected={index === activeOptionIndex}
                  data-testid={`${testId}-option`}
                  className="k-ov-opt"
                  onMouseEnter={() => setActiveIndex(index)}
                  // A row is not focusable, so a bare mousedown would blur the
                  // input; the drawer's Radix focus trap then re-seats focus on
                  // a dialog control OUTSIDE this root, `onRootBlur` closes the
                  // popover, and the row unmounts between mousedown and mouseup
                  // — the browser never dispatches the click at all (found by
                  // the T-44 e2e; jsdom's fireEvent.click cannot reproduce it).
                  // Preventing the mousedown default keeps focus in the input,
                  // which is also the ARIA combobox convention.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(instrument)}
                >
                  <InstrumentResultRow instrument={instrument} />
                </li>
              ))}
            </ul>
          )}

          <div className="k-ov-pop-foot">
            <p className="k-ov-pop-count" data-testid={`${testId}-count`}>
              {matchCountLabel(shown.length, found.length)}
            </p>
            {!showsEmptyState && createAction}
          </div>

          {/* The catalogue's provenance, on the surface where a
              seeded row actually reaches a user.

              **Once per popover, never per row.** OD-2's reasoning about
              per-candidate labels applies: a badge on every result would be
              noise, and the user needs the fact once. Rendered only when there
              are results, so an empty search does not explain a catalogue it
              just failed to find anything in.

              This is the *other half* of an earlier footnote's removal. That
              removal was right —
              `InstrumentsView` never calls `GET /instruments`, so the footnote
              sat on a screen where no seeded row is shown. What was missing
              afterwards was any provenance at all; this is it, on the six
              `?query=` surfaces that reach this shared popover. */}
          {shown.length > 0 && (
            <p className="k-ov-pop-note" data-testid={`${testId}-catalogue-hint`}>
              {INSTRUMENT_COPY.catalogueSampleHint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The footer count, and it is the honest one: how many rows the popover is
 * *showing* out of how many the search actually *found*. They differ exactly
 * when a class chip is narrowing the list, which is the case the count exists
 * for — a bare "5 résultats" over a filtered list of 2 is the lie this avoids.
 */
function matchCountLabel(shown: number, found: number): string {
  if (found === 0) return "Aucune correspondance";
  return `${shown} sur ${found} correspondance${found > 1 ? "s" : ""}`;
}

/**
 * `Escape` closes the popover and stops there — the drawer behind it stays
 * open (one of the popover's own acceptance criteria).
 *
 * This cannot be done from the component's `onKeyDown`. Radix's
 * `DismissableLayer` — which every `Dialog`/drawer in this app is built on —
 * listens for `Escape` on `document` in the **capture** phase, so it sees the
 * key before React has dispatched a single synthetic event (React attaches its
 * own listeners to the root/portal container, both of which are *below*
 * `document`). `event.stopPropagation()` in an `onKeyDown` handler therefore
 * runs too late to stop it, and the drawer closes underneath the popover.
 *
 * A capture listener on `window` is one node earlier in the propagation path
 * than Radix's, so it runs first regardless of mount order. It stops
 * propagation (Radix's listener is never reached) and marks the event handled
 * (`preventDefault`, which Radix also honours) — belt and braces, deliberately,
 * because the ordering above is a property of a third-party module's internals.
 *
 * Scoped twice over, so the drawer's own `Escape` is untouched the rest of the
 * time: the listener exists only while the popover is `open`, and it ignores
 * any event whose target is outside the popover's own subtree.
 */
function useEscapeClosesPopover(
  open: boolean,
  rootRef: { current: HTMLElement | null },
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return;
    function onKeyDownCapture(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      const root = rootRef.current;
      const target = event.target;
      if (root === null || !(target instanceof Node) || !root.contains(target)) return;
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
    }
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [open, rootRef, setOpen]);
}
