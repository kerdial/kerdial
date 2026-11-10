import { useEffect, useState } from "react";
import { CURATED_EXCHANGE_MICS, MIC_UNLISTED_SENTINEL } from "@kerdial/core-reference-data";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";

/**
 * DD11, IC-13 — the MIC combobox (AC-8/AC-9/AC-10, decision D8), replacing
 * the free-text `<input maxLength={4}>` `InstrumentCreateForm.tsx` used to
 * render directly.
 *
 * **Not a Radix `Select`** — see `CurrencySelect.tsx`'s identical note:
 * `@radix-ui/react-select` is not a dependency of this workspace (confirmed
 * by inspection), so this is a native `<select>` grouped by country
 * (`<optgroup>`), plus a final "Autre — saisir le code MIC" option
 * (`MIC_UNLISTED_SENTINEL`). AC-8's substance — "not a bare free-text
 * `<input>`... a user cannot, by default, type an arbitrary 4-character
 * string and have it silently accepted" — is exactly what a native `<select>`
 * guarantees structurally.
 *
 * **The sentinel is never part of the submitted value (D8).** This
 * component's `value`/`onChange` contract only ever carries a real MIC (or
 * an empty string, or a free-typed candidate the caller has not yet
 * validated) — `MIC_UNLISTED_SENTINEL` itself is purely internal UI state
 * (which "mode" the control is in), asserted directly by this component's
 * own test suite (a red-confirmed assertion per this cycle's binding rules),
 * not merely by the absence of a code path that would emit it.
 */
export interface ExchangeMicSelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly testId: string;
  readonly error?: string;
  readonly disabled?: boolean;
}

const FIELD_CLASS =
  "min-h-11 w-full rounded border border-border-default px-2 py-1 text-text-strong disabled:bg-paper-100";

/** Groups the curated list by `countryCode` for the combobox's `<optgroup>`s, preserving `CURATED_EXCHANGE_MICS`'s own declared order (no re-sort — the dataset is already ordered sensibly by the curator). */
function groupByCountry(): Map<string, (typeof CURATED_EXCHANGE_MICS)[number][]> {
  const groups = new Map<string, (typeof CURATED_EXCHANGE_MICS)[number][]>();
  for (const exchange of CURATED_EXCHANGE_MICS) {
    const group = groups.get(exchange.countryCode);
    if (group) {
      group.push(exchange);
    } else {
      groups.set(exchange.countryCode, [exchange]);
    }
  }
  return groups;
}

const GROUPED_EXCHANGES = groupByCountry();

/** Whether `mic` is a genuine curated entry — used to decide which control-mode this component starts in. */
function isCuratedMic(mic: string): boolean {
  return CURATED_EXCHANGE_MICS.some((exchange) => exchange.mic === mic);
}

export function ExchangeMicSelect({
  value,
  onChange,
  testId,
  error,
  disabled = false,
}: ExchangeMicSelectProps) {
  // "Autre" mode is entered either by explicitly choosing it, or (a value
  // already present that is not itself a curated MIC, e.g. restored form
  // state) by inferring it on first render — never by the sentinel ever
  // reaching `value` itself.
  const [autre, setAutre] = useState<boolean>(value !== "" && !isCuratedMic(value));

  // AC-9: a second discovery selection (or any other external `setValue`)
  // can hand this component a fresh curated MIC while it is still showing
  // the "Autre" free-text input from an earlier interaction — the lazy
  // `useState` initializer above only ever runs once, so without this
  // effect the control would be stuck in "Autre" mode, out of sync with a
  // now-curated `value`. Only reacts one way (autre -> curated): the
  // reverse (curated -> a non-curated value) only ever happens via this
  // component's own "Autre" selection handler below, which already sets
  // `autre` itself.
  useEffect(() => {
    if (value !== "" && isCuratedMic(value)) {
      setAutre(false);
    }
  }, [value]);

  return (
    <div className="flex flex-col gap-1">
      <select
        data-testid={`${testId}-select`}
        className={FIELD_CLASS}
        disabled={disabled}
        value={autre ? MIC_UNLISTED_SENTINEL : value}
        onChange={(event) => {
          const selected = event.target.value;
          if (selected === MIC_UNLISTED_SENTINEL) {
            setAutre(true);
            // Clears any previously curated selection — the sentinel itself
            // is never written to `value` (D8).
            onChange("");
          } else {
            setAutre(false);
            onChange(selected);
          }
        }}
      >
        <option value="">{INSTRUMENT_COPY.chooseExchange}</option>
        {[...GROUPED_EXCHANGES.entries()].map(([countryCode, exchanges]) => (
          <optgroup key={countryCode} label={countryCode}>
            {exchanges.map((exchange) => (
              <option key={exchange.mic} value={exchange.mic}>
                {exchange.label}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={MIC_UNLISTED_SENTINEL}>{INSTRUMENT_COPY.otherExchange}</option>
      </select>
      {autre && (
        <input
          type="text"
          data-testid={`${testId}-input`}
          className={FIELD_CLASS}
          maxLength={4}
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
      )}
      {error !== undefined && (
        // Addressable on its own: the review step renders
        // other `role="alert"` regions (the RF7 re-import notice among them),
        // so a suite asserting *this* field's message needs more than the role.
        <p role="alert" data-testid={`${testId}-error`} className="k-field-error">
          {error}
        </p>
      )}
    </div>
  );
}
