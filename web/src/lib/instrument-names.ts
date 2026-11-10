import { useQueries } from "@tanstack/react-query";
import { instrumentByIdQueryOptions } from "./queries.js";
import { cheapReadBudget, type RequestBudget } from "./request-budget.js";

/**
 * `instrument-names.ts` — UR-9. OD-9 confines the *holdings table*'s own name rendering to
 * `HoldingResponse.displayName` (UR-8's additive field, zero extra
 * requests) — this bounded client-side resolver is still required, in
 * Phase 1, for the surfaces that response field cannot help: the ledger
 * (`TransactionResponse` never carries `displayName`) and the
 * Instruments screen (a fully-sold-out instrument has no holdings row at
 * all).
 *
 * Batches the *distinct* non-null ids in `ids` through
 * `useQueries` — one `["instruments", id]` query per distinct id, the
 * **same** key `instrumentByIdQueryOptions` (`queries.ts`) already assigns
 * the (Phase 2) Instruments detail route, so a name fetched by either
 * surface is shared with the other, never fetched twice. Each query runs at
 * `background` priority through {@link cheapReadBudget},
 * with `staleTime`/`gcTime: Infinity` — an instrument's `displayName`
 * changes only by migration, matching `currenciesQueryOptions`'s own
 * precedent (`queries.ts`).
 */
export interface UseInstrumentNamesOptions {
  /**
   * Test-only override — mirrors this codebase's existing "escape hatch"
   * convention for a hardcoded real dependency (`ResponseCapOverrides`,
   * `upsertManualPricePoint`'s own `maxRowsPerTenant` parameter). Every real
   * call site takes the default, {@link cheapReadBudget}.
   */
  readonly budget?: RequestBudget;
}

/**
 * Every non-null, distinct id from `ids`, in first-seen order — the same
 * "distinct ids, not raw entries" convention the instrument-set
 * derivation and every other batched-fetch mechanism in this feature use.
 */
function distinctNonNullIds(ids: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const id of ids) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    distinct.push(id);
  }
  return distinct;
}

/**
 * Returns a `Map` of every *resolved* display name, keyed by `instrumentId`.
 * An id still loading, or whose lookup failed, is simply absent from the
 * map — {@link resolveInstrumentName} below is how a caller turns "absent"
 * into the documented fallback rendering, never a blank cell.
 */
export function useInstrumentNames(
  ids: readonly (string | null)[],
  options: UseInstrumentNamesOptions = {},
): Map<string, string> {
  const budget = options.budget ?? cheapReadBudget;
  const distinctIds = distinctNonNullIds(ids);

  const results = useQueries({
    queries: distinctIds.map((id) => instrumentByIdQueryOptions(id, budget)),
  });

  const names = new Map<string, string>();
  distinctIds.forEach((id, index) => {
    const displayName = results[index]?.data?.displayName;
    if (displayName !== undefined) names.set(id, displayName);
  });
  return names;
}

/**
 * The same `["instruments", id]` reads, answering `hasIcon` per id — so a
 * ledger row can draw the instrument's logo through `InstrumentIconTile`
 * (FR-314: `false` means no `<img>` and no request). Called beside
 * {@link useInstrumentNames} on the same ids it costs no request of its own:
 * TanStack Query shares one invocation per key.
 */
export function useInstrumentIcons(
  ids: readonly (string | null)[],
  options: UseInstrumentNamesOptions = {},
): Map<string, boolean> {
  const budget = options.budget ?? cheapReadBudget;
  const distinctIds = distinctNonNullIds(ids);
  const results = useQueries({
    queries: distinctIds.map((id) => instrumentByIdQueryOptions(id, budget)),
  });
  const icons = new Map<string, boolean>();
  distinctIds.forEach((id, index) => {
    const hasIcon = results[index]?.data?.hasIcon;
    if (hasIcon !== undefined) icons.set(id, hasIcon);
  });
  return icons;
}

/** First 8 characters of a raw id + `…` — never the full, unreadable UUID. */
const TRUNCATED_ID_VISIBLE_CHARS = 8;

export function truncateInstrumentId(id: string): string {
  return `${id.slice(0, TRUNCATED_ID_VISIBLE_CHARS)}…`;
}

export interface ResolvedInstrumentName {
  /** What to render as the cell's text. */
  readonly text: string;
  /** A `title` attribute value, carrying the full id — set only for the truncated-id fallback (loading/failed), never for a null id or a resolved name. */
  readonly title: string | undefined;
}

/**
 * `—` for a `null` id (DEPOSIT/WITHDRAWAL/
 * CURRENCY_EXCHANGE/INTEREST rows, a FEE that references no instrument, or a
 * sold-out instrument's absent holding), the
 * resolved name once `useInstrumentNames` has it, or — while still
 * loading, or if the lookup failed — a truncated id whose full value is
 * carried in `title` (never a blank cell, never a thrown error).
 */
export function resolveInstrumentName(
  names: ReadonlyMap<string, string>,
  id: string | null,
): ResolvedInstrumentName {
  if (id === null) return { text: "—", title: undefined };
  const resolved = names.get(id);
  if (resolved !== undefined) return { text: resolved, title: undefined };
  return { text: truncateInstrumentId(id), title: id };
}
