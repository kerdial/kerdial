import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useEscapeClosesPopover } from "../hooks/use-escape-closes-popover.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { countryDisplayLabel } from "../lib/country-display.js";
import { filterCountries } from "../lib/country-search.js";
import { Icon, IconButton } from "./ui/index.js";

/**
 * `<CountryPicker>` — a searchable list of the embedded ISO 3166-1 countries
 * (FR-737, EW-L2: « une liste déroulante avec recherche, pas un simple champ
 * texte »). Hand-built, no combobox dependency (EW-L9).
 *
 * It is the **second documented exception** to the native-controls rule
 * (FR-132; FR-739), after `LedgerInstrumentFilter`: 249 countries with a
 * search cannot be a native `<select>`. The sector selector of a weight row
 * stays native (nine fixed options).
 *
 * ## Contract
 *
 * Controlled. `value` is a stored code — possibly **outside the list** (a
 * stored domicile is validated by charset only, EW-L7, so `XK` can reach it).
 * `onChange` is called **only** with a code from the list or with `null` (the
 * « Effacer » action): typed text is a filter, never a value (AC-636). An
 * out-of-list `value` is shown raw (FR-738), is never among the options, and
 * survives any open/close untouched — it changes only when the user commits
 * another country or clears.
 *
 * ## Keyboard (AC-637) — the `AssetSearchPopover` skeleton
 *
 * - Typing opens the list and filters at once (`filterCountries`).
 * - `↓`/`↑` move the active option (and open a closed list). Nothing is active
 *   until the user arrows — Enter on a freshly typed query must not commit a
 *   row the user never looked at (the APG list-autocomplete rule).
 * - `Home`/`End` jump to the first/last option once the user is moving through
 *   the list; before that they stay the text field's own caret keys.
 * - `Enter` commits the active option; with none active it commits nothing.
 *   It is `preventDefault`ed while the list is open: the field sits in a form,
 *   where a bare Enter would submit it. A closed list leaves Enter alone.
 * - `Escape` closes the list and restores the committed text **without closing
 *   the dialog around it** — {@link useEscapeClosesPopover}, since Radix's
 *   dismiss layer listens on `document` capture and an `onKeyDown` is too late.
 * - Leaving the field (Tab, a click elsewhere) discards uncommitted text.
 *
 * DOM focus never leaves the input: the active option is published through
 * `aria-activedescendant` (the ARIA 1.2 editable combobox with a listbox
 * popup), scrolled into view, and drawn by the shared
 * `.k-ov-opt[aria-selected="true"]` treatment.
 *
 * ## Layout (AC-639)
 *
 * The list renders **in flow** under the field, as wide as it, with a capped
 * height that scrolls internally, and 44px rows. It is deliberately not an
 * absolutely positioned popover: the picker lives inside a scrolling Radix
 * dialog, where an overlay can be clipped or widen a phone-width page. The
 * cost is that opening the list pushes the fields below it down.
 */
export interface CountryPickerProps {
  /** The visible label, and the combobox's accessible name. */
  readonly label: string;
  /** A stored ISO 3166-1 alpha-2 code — possibly outside the list — or `null`. */
  readonly value: string | null;
  /** Called only with a code from the list, or `null` when the user clears. */
  readonly onChange: (next: string | null) => void;
  /** Codes already chosen elsewhere (other rows of a weight set): not offered. */
  readonly excludedCodes?: ReadonlySet<string>;
  /** `${testId}-input` is the combobox, `${testId}-listbox`, `${testId}-option`, `${testId}-clear`, `${testId}-status`, `${testId}-empty`. */
  readonly testId: string;
  readonly error?: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

export function CountryPicker({
  label,
  value,
  onChange,
  excludedCodes,
  testId,
  error,
  hint,
  disabled = false,
}: CountryPickerProps) {
  // `null` while the user is not typing: the field then shows the committed
  // value and an open list offers every country.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const domId = useId();
  const inputId = `${domId}-input`;
  const listboxId = `${domId}-listbox`;
  const messageId = `${domId}-message`;

  const options = filterCountries(query ?? "", excludedCodes);
  const activeOption = open ? options[activeIndex] : undefined;
  const optionId = (code: string): string => `${domId}-option-${code}`;
  const committedText = value === null ? "" : countryDisplayLabel(value);

  const closeList = useCallback(() => {
    setOpen(false);
    setQuery(null);
    setActiveIndex(-1);
  }, []);

  useEscapeClosesPopover(open, rootRef, closeList);

  const activeId = activeOption === undefined ? undefined : optionId(activeOption.code);
  useEffect(() => {
    if (activeId === undefined) return;
    // Optional call: jsdom implements no `scrollIntoView`.
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  function commit(code: string): void {
    closeList();
    onChange(code);
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    const last = options.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      // Opening a closed list starts on the committed country when it is
      // offered, so ↓ ↑ browse around the current choice.
      const current = options.findIndex((country) => country.code === value);
      setActiveIndex((i) => (open ? Math.min(i + 1, last) : Math.max(current, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (open && i >= 0 ? Math.max(i - 1, 0) : last));
    } else if ((event.key === "Home" || event.key === "End") && open && activeIndex >= 0) {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : last);
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      if (activeOption !== undefined) commit(activeOption.code);
    }
  }

  const hasError = error !== undefined;
  const message = error ?? hint;
  const statusText = !open
    ? ""
    : options.length === 0
      ? INSTRUMENT_COPY.countryPickerNoMatch
      : options.length === 1
        ? INSTRUMENT_COPY.countryPickerOneResult
        : fill(INSTRUMENT_COPY.countryPickerResults, { count: String(options.length) });

  return (
    <div className="k-field k-field-md k-country-picker" ref={rootRef}>
      <label htmlFor={inputId} className="k-field-label">
        {label}
      </label>
      <div className={`k-input-shell${hasError ? " k-input-shell-error" : ""}`}>
        <Icon name="search" size="sm" className="k-input-icon" />
        <input
          id={inputId}
          type="text"
          className="k-input"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={open && options.length > 0 ? listboxId : undefined}
          aria-activedescendant={activeId}
          aria-invalid={hasError ? true : undefined}
          aria-describedby={message !== undefined ? messageId : undefined}
          data-testid={`${testId}-input`}
          placeholder={INSTRUMENT_COPY.countryPickerPlaceholder}
          disabled={disabled}
          value={query ?? committedText}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onClick={() => setOpen(true)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={closeList}
          onKeyDown={onInputKeyDown}
        />
        {value !== null && !disabled && (
          <IconButton
            icon="x"
            label={COMMON_COPY.clear}
            size="sm"
            data-testid={`${testId}-clear`}
            onClick={() => {
              closeList();
              onChange(null);
            }}
          />
        )}
      </div>

      {open && options.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          data-testid={`${testId}-listbox`}
          className="k-country-picker-list"
          // Keeps focus in the input: a press on a row or on the list's own
          // scrollbar would otherwise blur the field and close the list
          // before the click lands (the `AssetSearchPopover` finding).
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((country, index) => (
            <li
              key={country.code}
              id={optionId(country.code)}
              role="option"
              aria-selected={index === activeIndex}
              data-testid={`${testId}-option`}
              data-code={country.code}
              className="k-ov-opt"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(country.code)}
            >
              {country.nameFr}
            </li>
          ))}
        </ul>
      )}
      {open && options.length === 0 && (
        <p className="k-ov-pop-note" data-testid={`${testId}-empty`}>
          {INSTRUMENT_COPY.countryPickerNoMatch}
        </p>
      )}

      <p
        role="status"
        aria-live="polite"
        className="k-visually-hidden"
        data-testid={`${testId}-status`}
      >
        {statusText}
      </p>

      {message !== undefined ? (
        <p
          id={messageId}
          className={hasError ? "k-field-error" : "k-field-hint"}
          role={hasError ? "alert" : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
