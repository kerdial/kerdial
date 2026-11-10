/**
 * Shared pure types for `core/domain` — pulled forward by T-14 (ahead of the
 * rest of C10, T-24–T-28) because `ledger`'s `FxRateResolver` (T-18) needs
 * them before the calculation engine as a whole is built (T-14's
 * "dependency gap"). `core/domain` may import nothing but
 * `core/decimal` — this file imports nothing at all, since these are plain
 * string-literal aliases and a generic interface.
 *
 * `market/ports` (T-13) already defines `IsoDate`, `CurrencyCode`, and
 * `CurrencyPair` locally, because `core/domain` did not exist yet when it was
 * built (see that package's `types.ts` header comment). That duplication is
 * deliberate and is **not** collapsed here: refactoring `market/ports` to
 * import from `core/domain` instead is out of T-14's scope (it only pulls
 * forward the LOCF algorithm and the types the LOCF/`FxRateResolver` path
 * needs) and would be scope creep into T-13, already built and committed.
 * Noting the duplication here for a later task, not silently fixing it.
 * `market/ports` also defines `InstrumentKind`, which no T-14 consumer needs,
 * so it is not duplicated in this file.
 */

/**
 * Plain ISO calendar date string, `YYYY-MM-DD`, no time-of-day component.
 * Lexicographic string ordering on this format is
 * identical to chronological ordering — `locf` (`./locf.ts`) relies on that
 * to compare dates without parsing them.
 */
export type IsoDate = string;

/** ISO 4217 three-letter currency code (e.g. `"EUR"`, `"USD"`). */
export type CurrencyCode = string;

/**
 * An unordered currency pair for FX rate lookups — `base`/`quote` follow this
 * codebase's canonical direction convention:
 * `amount_base = amount_quote × rate`. Structurally identical to
 * `market/ports`'s `CurrencyPair` (see this file's header) — interchangeable
 * without a runtime conversion.
 */
export interface CurrencyPair {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
}

/**
 * The minimal shape `locf` is designed to operate on once a caller has
 * projected its own richer record (an `fx_rate_daily` row, an
 * `instrument_price_daily` row, ...) down to "a value dated on some day."
 * `locf` itself is more general — it takes any `T[]` plus a `dateOf`
 * projection — but `DatedObservation<T>` is the common shape both of T-14's
 * named future callers (`ledger`'s `FxRateResolver`, T-18; `core/domain`'s
 * own `resolvePrice`/PMP/TWR code, T-24–T-28) are expected to reduce their
 * series to before calling it, so it is defined once here rather than
 * redeclared by each caller.
 *
 * `observedOn` is named to match the persisted audit column,
 * `fx_rate_observed_on`: the date the underlying value was actually
 * published, not the (possibly later, weekend/holiday) date it is being
 * resolved for.
 */
export interface DatedObservation<T> {
  readonly observedOn: IsoDate;
  readonly value: T;
}
