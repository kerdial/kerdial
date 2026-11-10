/**
 * `copy/fill.ts` — the one way a catalogued string takes a value.
 *
 * **The catalogue formats nothing.** Numbers, money, percentages and dates
 * reach it already rendered: `figure-format.ts` is the sole formatter for
 * figures (it has a sole-importer test saying so), `frCount` in
 * `problem-messages.ts` is the sole pluraliser, and dates go through the
 * helpers that already exist. A catalogue that formatted its own values would
 * be a second locale implementation hiding inside the copy layer, and it would
 * be the one nothing tests.
 *
 * So an interpolating entry is a **pattern** — a plain string with `{name}`
 * slots — and this fills it with strings the caller has already formatted.
 * Keeping the pattern a string rather than a function is what lets the copy
 * audits read it: `empty-state-copy-audit.test.ts` scans catalogue *values*,
 * and a function body is not a value it can scan.
 *
 * An unfilled slot throws rather than rendering `{count}` to a user. That is
 * the failure this helper is allowed to have: loud, in a test, at the call
 * site that forgot the value.
 */
const SLOT = /\{(\w+)\}/g;

export function fill(pattern: string, values: Readonly<Record<string, string>>): string {
  return pattern.replace(SLOT, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(
        `copy: no value for slot {${name}} in "${pattern}" — pass it pre-formatted (figure-format.ts, frCount, or the date helpers).`,
      );
    }
    return value;
  });
}
