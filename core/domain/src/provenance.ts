/**
 * `mergeProvenance` — T-39. Every monetary figure the API returns carries a
 * `derivedFrom` flag set that "propagates through aggregation": a portfolio
 * total whose constituents include one manually priced OPCVM carries
 * `MANUAL_PRICE`, even though most of the total's other holdings are
 * automated. This is the single `mergeProvenance()` function in
 * `core/domain` — every caller that aggregates several already-flagged figures into one
 * (a holding's current value from its price+FX flags, a portfolio total from
 * its holdings, a combined cross-portfolio total from several portfolios)
 * goes through this one function, so the union rule is defined exactly once.
 *
 * ## Pure and DB-free (D13)
 *
 * A plain set union over plain arrays: no I/O, no clock. `core/domain` may
 * import nothing but `core/decimal` (the `core-domain-purity` rule) — this
 * file imports nothing at all, like `./flow-class.ts`.
 *
 * ## Deliberately just a union — the "何 flags apply to this one figure"
 * decision belongs to the caller
 *
 * `mergeProvenance` does not decide which flags a single price/FX
 * observation carries (that is `valuation`'s concern, T-39, which is closer
 * to the data the flag describes) — it only combines flag sets that are
 * already decided. Callers that want an explicit "nothing manual/pinned/
 * delayed/carried applied here" signal add `AUTOMATED` themselves before
 * calling this function; `mergeProvenance` never injects it, so an empty
 * input list of flag sets — meaning "no figures were combined at all" —
 * yields an empty result rather than a synthesised default.
 */

/**
 * The closed set of provenance flags a `ValuedAmount.provenance.derivedFrom`
 * array may contain. `CRYPTO_QUOTE` is the crypto-settlement addition (a
 * transaction's principal leg priced via a
 * `QuoteProvider` rather than an FX rate); `AUTOMATED` marks a figure derived
 * solely from automated data, with no manual, pinned, delayed, or crypto-quote
 * component (AC29's negative clause).
 */
export type DerivedFromFlag =
  "MANUAL_PRICE" | "DELAYED_QUOTE" | "PINNED_FX" | "CARRIED_FX" | "CRYPTO_QUOTE" | "AUTOMATED";

/**
 * Canonical, stable output order — every caller sees the same order for the
 * same flag set regardless of the order its inputs were combined in, so a
 * response body (and a test asserting against one) never depends on
 * insertion order.
 */
const CANONICAL_ORDER: readonly DerivedFromFlag[] = [
  "MANUAL_PRICE",
  "DELAYED_QUOTE",
  "PINNED_FX",
  "CARRIED_FX",
  "CRYPTO_QUOTE",
  "AUTOMATED",
];

/**
 * Unions any number of already-computed `derivedFrom` flag sets into one,
 * deduplicated and in {@link CANONICAL_ORDER}. This is the one place the
 * "propagates through aggregation" rule is implemented: a holding's own
 * `derivedFrom` is the merge of its price flags and its FX flags; a
 * portfolio total's `derivedFrom` is the merge of every holding's; a combined
 * cross-portfolio total's `derivedFrom` is the merge of every portfolio
 * total's — always this same function, never a bespoke union at each level.
 *
 * An empty `flagSets` (or every element empty) returns `[]` — this function
 * never fabricates `AUTOMATED` on the caller's behalf (see this module's
 * header).
 *
 * ## `AUTOMATED` survives the merge only when it is the *only* flag present
 * (security review finding M3)
 *
 * Every figure's own assembly (`valuation/src/holdings-valuation.ts`'s
 * `finalize()`) defaults an empty flag set to `['AUTOMATED']` *before*
 * handing it to this function, so an aggregate's inputs routinely include one
 * constituent's `['AUTOMATED']` alongside another's `['MANUAL_PRICE']`. A
 * plain set union would then let both survive into the aggregate's own
 * `derivedFrom` — asserting `AUTOMATED` ("derived solely from an automated
 * source", AC29's negative clause) on a figure that is simultaneously flagged
 * `MANUAL_PRICE`, i.e. asserting a claim and its negation at once. A client
 * that only checks `derivedFrom.includes('AUTOMATED')` would then render a
 * manual-contaminated total as fully automated. The fix is applied in this
 * one place, the single point every aggregation level already funnels
 * through: after the union, `AUTOMATED` is removed whenever any other flag is
 * also present — it is retained in the result **iff it is the only flag**
 * across every input.
 */
export function mergeProvenance(
  flagSets: readonly (readonly DerivedFromFlag[])[],
): DerivedFromFlag[] {
  const present = new Set<DerivedFromFlag>();
  for (const flags of flagSets) {
    for (const flag of flags) {
      present.add(flag);
    }
  }
  if (present.size > 1 && present.has("AUTOMATED")) {
    present.delete("AUTOMATED");
  }
  return CANONICAL_ORDER.filter((flag) => present.has(flag));
}

/**
 * One aggregate constituent's provenance, as {@link summarizeProvenance}
 * reads it — structurally compatible with `valuation`'s `FigureProvenance`
 * (this module cannot import it: `core/domain` imports nothing, and the
 * dependency points the other way). Every field is optional except the flag
 * set, mirroring the envelope: a leaf that resolved no FX carries no
 * `fxSource`, a figure with no live price carries no `priceAsOf`.
 */
export interface ProvenanceSummaryLeaf {
  readonly derivedFrom: readonly DerivedFromFlag[];
  readonly priceSource?: string;
  readonly priceAsOf?: string;
  readonly priceIsStale?: boolean;
  readonly fxSource?: string;
  readonly fxRateObservedOn?: string;
  /**
   * The constituent could not be valued and was left out of the aggregate —
   * a cash currency with no rate on or before the date (portfolio-cash
   * PC-L2). Any such leaf makes the summary `complete: false`.
   */
  readonly unvalued?: true;
}

/**
 * ADR-0010's aggregate provenance summary — what a portfolio total, a
 * combined cross-portfolio total, or a TWR/MWR figure carries instead of a
 * singular `priceSource`/`fxSource` standing for many inputs.
 *
 * `complete` was structurally `true` in phase 1 (ADR-0010 as amended
 * 2026-09-01): the read path fails loud on any holding that
 * cannot be valued (`UnresolvablePriceError` → 422). ADR-0010's cash-only
 * amendment (portfolio-cash PC-L2) makes `false` reachable: a
 * cash currency with no rate is excluded from the total and carried as an
 * `unvalued` leaf, and any such leaf makes the aggregate incomplete.
 * Holdings stay fail-loud.
 */
export interface ProvenanceSummary {
  /** Distinct contributing source identifiers, as the leaf envelopes name them (price `sourceKey`s and FX sources), sorted. */
  readonly sources: readonly string[];
  /** The least fresh input's observation date — the honest "as of" for the aggregate. Absent when no leaf carries one. */
  readonly oldestObservationAt?: string;
  readonly newestObservationAt?: string;
  /** Inputs flagged stale against the NFR-1/NFR-2 staleness budget (the leaf's own `priceIsStale`). */
  readonly staleInputCount: number;
  /** Inputs carrying `MANUAL_PRICE` — `manual_price_point` contributions. */
  readonly manualInputCount: number;
  /** `USER_PINNED` FX anywhere in the tree. */
  readonly pinnedFxPresent: boolean;
  /** LOCF carry-forward (`CARRIED_FX`) anywhere in the tree. */
  readonly carriedFxPresent: boolean;
  /** Denominator: the N-of-M framing for every count above. */
  readonly leafCount: number;
  readonly complete: boolean;
  /** Unchanged semantics — still {@link mergeProvenance} over the leaves' flag sets. */
  readonly derivedFrom: readonly DerivedFromFlag[];
}

/**
 * ADR-0010 — the summary side of "`mergeProvenance()` stays the
 * single implementation": this function is that implementation's extension
 * with the counters, the observation range and `complete`, and its
 * `derivedFrom` is exactly {@link mergeProvenance} over the same leaves, so
 * an aggregate's flag set cannot diverge from its own summary.
 *
 * Pure and DB-free like everything in this module: the caller hands it the
 * already-assembled leaf envelopes; nothing is fetched, inferred, or
 * defaulted. An empty `leaves` array yields the empty summary
 * (`leafCount: 0`, no sources, no range) rather than a fabricated one.
 */
export function summarizeProvenance(
  leaves: readonly ProvenanceSummaryLeaf[],
  options: { readonly complete?: boolean } = {},
): ProvenanceSummary {
  const sources = new Set<string>();
  let oldest: string | undefined;
  let newest: string | undefined;
  let staleInputCount = 0;
  let manualInputCount = 0;

  const observe = (date: string | undefined): void => {
    if (date === undefined) return;
    if (oldest === undefined || date < oldest) oldest = date;
    if (newest === undefined || date > newest) newest = date;
  };

  for (const leaf of leaves) {
    if (leaf.priceSource !== undefined) sources.add(leaf.priceSource);
    if (leaf.fxSource !== undefined) sources.add(leaf.fxSource);
    observe(leaf.priceAsOf);
    observe(leaf.fxRateObservedOn);
    if (leaf.priceIsStale === true) staleInputCount += 1;
    if (leaf.derivedFrom.includes("MANUAL_PRICE")) manualInputCount += 1;
  }

  const derivedFrom = mergeProvenance(leaves.map((leaf) => leaf.derivedFrom));

  return {
    sources: [...sources].sort(),
    ...(oldest === undefined ? {} : { oldestObservationAt: oldest }),
    ...(newest === undefined ? {} : { newestObservationAt: newest }),
    staleInputCount,
    manualInputCount,
    pinnedFxPresent: derivedFrom.includes("PINNED_FX"),
    carriedFxPresent: derivedFrom.includes("CARRIED_FX"),
    leafCount: leaves.length,
    complete: (options.complete ?? true) && !leaves.some((leaf) => leaf.unvalued === true),
    derivedFrom,
  };
}
