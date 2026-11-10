import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InstrumentKind } from "@kerdial/api-contracts";
import { ApiError, type DiscoveryCandidate } from "../lib/api-client.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { instrumentDiscoveryQueryOptions } from "../lib/queries.js";
import { sectorDisplayLabel } from "../lib/sector-display.js";
import { Input } from "./ui/index.js";

/**
 * IC-14 — the
 * debounced typeahead over `GET /instruments/discovery` (FR-1–FR-6,
 * AC-1/AC-2/AC-6/AC-7). Renders candidates and emits a selection; wiring the
 * emitted selection into the create form's autofill logic is IC-15's job,
 * not this component's (kept reusable/decoupled from `InstrumentCreateForm`,
 * same separation `InstrumentPicker` keeps from `TransactionForm`).
 *
 * 400ms debounce (longer than `TransactionForm.tsx`'s own
 * 250ms local-search debounce because this one hits a live external
 * provider, not an indexed local query): each keystroke's effect clears the
 * previous pending timer before scheduling its own, so only the last
 * keystroke in a burst ever actually commits (`TransactionForm.tsx`'s
 * `InstrumentPicker`/LOW-2 precedent, applied here). `signal` is threaded
 * through `instrumentDiscoveryQueryOptions`'s `queryFn` (MEDIUM-1 precedent),
 * so a superseded in-flight request is genuinely aborted, not merely
 * ignored, once TanStack Query drops the old query key's last observer
 * (NFR-1).
 */
export interface InstrumentDiscoverySearchProps {
  readonly kind: InstrumentKind;
  /**
   * `query` is the exact debounced search text that produced the candidate
   * list the user is selecting from (not the possibly-further-edited live
   * input) — the create form's own ISIN-echo-back logic (IC-15 follow-up)
   * needs the literal string the user typed, never anything the provider
   * returned, to keep decision D2 (discovery never autofills `isin`
   * from *provider* data) intact.
   */
  readonly onSelect: (candidate: DiscoveryCandidate, query: string) => void;
}

const DISCOVERY_DEBOUNCE_MS = 400;

/**
 * The label for a candidate's mapped sector code, or `undefined` when the
 * candidate carries no classification at all — the field is absent (a
 * non-SHARE query, FR-7) or `null` (a provider string this repo's map does not
 * know, FR-3). A candidate row is a search result, so "no classification"
 * renders **no chip** rather than « Non classé » on every row (a sector chip shows only "when present").
 *
 * The code-to-text step itself is `sectorDisplayLabel`'s, not this function's
 * This used to call `sectorLabel` directly and therefore rendered
 * *nothing* for a code the vocabulary has no label for, where the rest of the
 * app rendered the code. One function decides that now.
 */
function sectorChipLabel(sectorCode: string | null | undefined): string | undefined {
  return sectorCode === null || sectorCode === undefined || sectorCode === ""
    ? undefined
    : sectorDisplayLabel(sectorCode);
}

/**
 * Maps a discovery-call failure to a calm, distinguishable French message
 * (AC-7; DD8's provider-error mapping). Each of
 * the three provider-error codes gets its own distinguishable string — 429
 * (rate-limited, ours or the provider's own), 503 (unavailable — provider or
 * `MARKET_RUNTIME` absent), and 502 (malformed response) are never rendered
 * with the same text, so a user (and this suite's own red-confirm) can tell
 * them apart, not just infer "some error happened".
 */
function discoveryErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "DISCOVERY_PROVIDER_RATE_LIMITED":
      case "DISCOVERY_RATE_THROTTLED":
        return "Trop de recherches — réessayez dans quelques secondes.";
      case "DISCOVERY_PROVIDER_MALFORMED":
        return "Réponse inattendue de la source — saisie manuelle possible.";
      default:
        return "Source momentanément indisponible — saisie manuelle possible.";
    }
  }
  return "Source momentanément indisponible — saisie manuelle possible.";
}

export function InstrumentDiscoverySearch({ kind, onSelect }: InstrumentDiscoverySearchProps) {
  const [query, setQuery] = useState("");
  // The debounced value alone drives `instrumentDiscoveryQueryOptions` — see
  // this component's own doc comment.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), DISCOVERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const discoveryQuery = useQuery(instrumentDiscoveryQueryOptions(kind, debouncedQuery));
  const candidates: DiscoveryCandidate[] = discoveryQuery.data ?? [];

  return (
    // A sunken block, not a second card — the card recipe's rule about never
    // nesting a shadowed card inside another (this sits inside the create
    // dialog).
    <div className="k-inst-discovery">
      <Input
        type="text"
        label={INSTRUMENT_COPY.discoverySearch}
        iconLeft="search"
        data-testid="instrument-discovery-search-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {discoveryQuery.isError && (
        <p role="status" data-testid="instrument-discovery-error" className="k-inst-note">
          {discoveryErrorMessage(discoveryQuery.error)}
        </p>
      )}

      {!discoveryQuery.isError &&
        debouncedQuery.trim() !== "" &&
        !discoveryQuery.isLoading &&
        candidates.length === 0 && (
          <p role="status" data-testid="instrument-discovery-empty" className="k-inst-note">
            {INSTRUMENT_COPY.discoveryEmpty}
          </p>
        )}

      {candidates.length > 0 && (
        <ul
          role="listbox"
          data-testid="instrument-discovery-results"
          className="k-inst-discovery-results"
        >
          {candidates.map((candidate, index) => (
            <li key={`${candidate.providerSymbol}-${index}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-testid="instrument-discovery-result"
                className="k-inst-discovery-option"
                onClick={() => onSelect(candidate, debouncedQuery)}
              >
                {candidate.displayName} ({candidate.tickerSymbol ?? candidate.providerSymbol})
                {candidate.exchangeHint !== null && (
                  <span className="k-inst-discovery-option-meta">
                    {" "}
                    — {candidate.exchangeHint.code}
                  </span>
                )}
                {/* IR-10: the mapped sector's own French label, through
                    `sectorDisplayLabel` — the single code-to-text site in
                    `web` — and never the provider's own string. Absent for a
                    non-SHARE query and `null` for an unmapped provider sector,
                    both of which render nothing at all here (see
                    `sectorChipLabel`'s own comment for why this surface gates
                    on presence rather than showing « Non classé »). */}
                {sectorChipLabel(candidate.sectorCode) !== undefined && (
                  <span
                    className="k-inst-discovery-option-meta"
                    data-testid="instrument-discovery-result-sector"
                  >
                    {" "}
                    — {sectorChipLabel(candidate.sectorCode)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
