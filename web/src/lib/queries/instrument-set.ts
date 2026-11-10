import type { TransactionScanResult } from "./transactions.js";

/**
 * `deriveInstrumentSet` — UR-26 (the "held state (détenu / historique / jamais
 * détenu, derived)" column). The actual union: every distinct held
 * `instrumentId` (from `["portfolios","holdings","combined"]`, already
 * fetched elsewhere — zero extra requests for this half) **union**
 * {@link transactionsInstrumentScanQueryOptions}'s scanned ids.
 *
 * **Only two of the three states this column names are reachable from this
 * derivation**: `"held"` (in the holdings-derived set) and `"historical"`
 * (scanned but not currently held — a fully-sold-out instrument, AC107's
 * substrate). `"none"` (« jamais détenu ») cannot occur here **by
 * construction** — the union is exactly "holds or has transacted", so a
 * never-transacted instrument is never a member of this set at all.
 *
 * IB12
 * widened {@link InstrumentHeldState} with that third state, for the
 * catalogue row source `deriveInstrumentSet` deliberately does not produce
 * (see {@link deriveHeldState}). **`deriveInstrumentSet` itself is
 * unmodified and still can never return `"none"`** — that is what keeps
 * AC-19 ("the default view's row set is unchanged") true by construction
 * rather than by inspection, and `queries.test.ts`'s own "never invents a
 * 'jamais détenu' entry" case is the standing proof of it (RB6).
 */
export type InstrumentHeldState = "held" | "historical" | "none";

export interface InstrumentSetEntry {
  readonly instrumentId: string;
  readonly heldState: InstrumentHeldState;
}

export interface InstrumentSetResult {
  /** Every distinct instrument, held-first then historical, each in first-seen order within its own group. */
  readonly entries: readonly InstrumentSetEntry[];
  /** Propagated from {@link TransactionScanResult.truncated} — the held half of the union has no cap of its own (one unpaginated request). */
  readonly truncated: boolean;
}

export function deriveInstrumentSet(
  heldInstrumentIds: readonly string[],
  scan: TransactionScanResult,
): InstrumentSetResult {
  const heldSeen = new Set<string>();
  const heldEntries: InstrumentSetEntry[] = [];
  for (const id of heldInstrumentIds) {
    if (heldSeen.has(id)) continue;
    heldSeen.add(id);
    heldEntries.push({ instrumentId: id, heldState: "held" });
  }

  const historicalSeen = new Set<string>();
  const historicalEntries: InstrumentSetEntry[] = [];
  for (const id of scan.instrumentIds) {
    if (heldSeen.has(id) || historicalSeen.has(id)) continue;
    historicalSeen.add(id);
    historicalEntries.push({ instrumentId: id, heldState: "historical" });
  }

  return { entries: [...heldEntries, ...historicalEntries], truncated: scan.truncated };
}

/**
 * IB12 (FR-189) — the held/not-held indicator for a row whose **id did not come
 * from {@link deriveInstrumentSet}**: a catalogue row
 * (`instrumentCatalogueQueryOptions`, `GET /instruments`), which may be one
 * this tenant holds, one it has only ever transacted, or one it has never
 * touched at all.
 *
 * Deliberately a separate function rather than a widening of
 * `deriveInstrumentSet`: that function's inputs *are* "held ∪ transacted", so
 * it has no `"none"` to return, and leaving it alone is what makes the
 * default view's row set provably unchanged (AC-19). This one takes the two
 * membership sets directly — the caller builds them once per render from the
 * same `holdingsQueryOptions`/`transactionsInstrumentScanQueryOptions` reads
 * the default view already keeps mounted (so a catalogue page costs no extra
 * request), and each row is then an O(1) lookup rather than a scan of
 * a 5 000-id array per row.
 *
 * "Held" wins over "transacted": an instrument that appears in both is
 * currently held, exactly as `deriveInstrumentSet` resolves the same overlap.
 */
export function deriveHeldState(
  instrumentId: string,
  heldInstrumentIds: ReadonlySet<string>,
  transactedInstrumentIds: ReadonlySet<string>,
): InstrumentHeldState {
  if (heldInstrumentIds.has(instrumentId)) return "held";
  if (transactedInstrumentIds.has(instrumentId)) return "historical";
  return "none";
}
