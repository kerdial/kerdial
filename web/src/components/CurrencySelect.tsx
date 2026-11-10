import { useQuery } from "@tanstack/react-query";
import { currenciesQueryOptions } from "../lib/queries.js";
import { FORM_COPY } from "../lib/copy/forms.js";

/**
 * IC-13 — the listing-currency combobox (AC-11), replacing the free-text
 * `<input maxLength={3}>` `InstrumentCreateForm.tsx` used to render directly.
 *
 * **Not a Radix `Select`**: a "Radix `Select`/combobox, already a
 * dependency" was the first idea, but `@radix-ui/react-select` is
 * **not** a dependency of `web` (only `@radix-ui/react-dialog` and
 * `@radix-ui/react-tooltip` are, per `web/package.json`) and is not present
 * anywhere in this workspace's pnpm store — confirmed by inspection, not
 * assumed. Adding it would violate this cycle's own "no new npm
 * dependencies" constraint (the `/home` volume this repo lives on has well
 * under 1 GB free). `TransactionForm.tsx`'s own `InstrumentPicker` already
 * documents the identical situation for its combobox
 * ("Deliberately not a Radix combobox (no such primitive is a dependency
 * here)"). A native `<select>` satisfies AC-11's actual requirement — "a
 * select/combobox... not a free-text `<input>` accepting any 3-letter
 * string" — exactly: HTML's own accessibility mapping gives a single-select
 * `<select>` the implicit ARIA role `combobox`, and (unlike the old
 * `<input>`) it structurally cannot accept a value absent from its own
 * `<option>` list.
 */
export interface CurrencySelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly testId: string;
  readonly disabled?: boolean;
}

const FIELD_CLASS =
  "min-h-11 w-full rounded border border-border-default px-2 py-1 text-text-strong disabled:bg-paper-100";

export function CurrencySelect({ value, onChange, testId, disabled = false }: CurrencySelectProps) {
  // `staleTime`/`gcTime` both `Infinity` — this ~180-row seeded
  // reference list only ever changes on a migration, so it is fetched at
  // most once per session, never refetched on remount (IC-13's own
  // acceptance criterion, verified directly against this query-cache
  // configuration by `CurrencySelect.test.tsx`, not merely by counting
  // network calls in one test run).
  const currenciesQuery = useQuery(currenciesQueryOptions());
  const currencies = currenciesQuery.data ?? [];

  return (
    <select
      data-testid={testId}
      className={FIELD_CLASS}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{FORM_COPY.chooseCurrency}</option>
      {currencies.map((currency) => (
        <option key={currency.code} value={currency.code}>
          {currency.code} — {currency.name}
        </option>
      ))}
      {/* A value already selected (e.g. from a discovery pre-selection, or
          typed before the list finished loading) that is not yet among the
          fetched options is kept selectable rather than silently reset to
          the placeholder — the list is deterministic and this only ever
          matters for the brief window before the first fetch resolves. */}
      {value !== "" && !currencies.some((currency) => currency.code === value) && (
        <option value={value}>{value}</option>
      )}
    </select>
  );
}
