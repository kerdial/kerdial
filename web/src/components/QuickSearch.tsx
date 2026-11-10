import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { InstrumentSummary, PortfolioSummary } from "../lib/api-client.js";
import { DEFAULT_PERIOD_PRESET_ID } from "../lib/period-presets.js";
import { matchesPortfolioName, meetsInstrumentSearchMinimum } from "../lib/quick-search.js";
import { portfoliosQueryOptions, quickSearchInstrumentsQueryOptions } from "../lib/queries.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { SHELL_COPY } from "../lib/copy/shell.js";

const QUICK_SEARCH_DEBOUNCE_MS = 250;
const QUICK_SEARCH_RESULT_LIMIT = 8;

/**
 * `QuickSearch.tsx` — UR-37 (FR-97). A ⌘K/Ctrl+K command palette reachable
 * from every screen (`AppShell.tsx` mounts exactly one instance), searching
 * **two domains only** — portfolios and instruments — **never**
 * transactions: `GET /transactions` has no text search, and the only
 * alternative is an unbounded offset scan, so
 * this component must never render a group, placeholder, or empty-state
 * string that implies transactions can be searched here.
 *
 * **AC123 scope note**: this mounts a real `role="combobox"` input, but it
 * is a global navigation launcher — it selects a *destination*, never a
 * *form field value* — not the "dropdown/combobox form control" FR-132/AC123
 * restricts to native `<select>`/`<input type="date">`. That rule (one
 * documented exception, the ledger's instrument filter, UR-19) governs
 * bounded-choice form pickers; it does not apply to a command palette any
 * more than it would to the browser's own address bar. Recorded here so a
 * future AC123 audit does not misread this as a second, undocumented
 * deviation from that rule.
 *
 * **Portfolios**: a client-side filter (`matchesPortfolioName`) over the
 * already-cached `["portfolios","list"]` query — the same key every other
 * screen shares (`portfoliosQueryOptions`). Opening the palette issues a
 * *new* request only if nothing has warmed that cache yet this session,
 * never a second, palette-only endpoint.
 *
 * **Instruments**: `quickSearchInstrumentsQueryOptions` (`queries.ts`) —
 * `background` priority through `cheapReadBudget`, debounced
 * {@link QUICK_SEARCH_DEBOUNCE_MS}, gated at `meetsInstrumentSearchMinimum`'s
 * ≥3-alphanumeric floor (the client-side mirror of the server's own
 * `hasThreeAlphanumericChars` gate, `quick-search.ts`). Below that floor this
 * shows a hint instead of results, under the identical predicate that
 * withholds the query — asserted at the network level by
 * `web/e2e/quick-search.spec.ts`, since "zero requests fired" is not
 * something a jsdom unit test can observe as convincingly as a real
 * intercepted route can.
 *
 * **Both reads are additionally gated on `open`** (`enabled: open && ...`):
 * the palette costs nothing merely by being mounted in the shell on every
 * screen.
 *
 * **Keyboard-only operation (an acceptance criterion)**: `⌘K`/`Ctrl+K` opens the
 * palette from anywhere — a `window`-level listener, mounted unconditionally
 * so it works regardless of which screen currently has focus.
 * `ArrowUp`/`ArrowDown` move a single flat active index across both groups in
 * display order (portfolios first, the UI revamp's drill-down map listing
 * "portfolio workspace | instrument detail" in that order); `Enter`
 * activates the current selection; `Escape` and an outside click close the
 * overlay — Radix `Dialog`'s own default behaviour, not reimplemented here.
 * The active option's id is reflected via `aria-activedescendant` on the
 * input (the standard `role="combobox"` + `role="listbox"` pattern), so the
 * visible highlight and what a screen reader announces never diverge.
 */
export function QuickSearch() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), QUICK_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function onWindowKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, []);

  const portfoliosQuery = useQuery({ ...portfoliosQueryOptions(), enabled: open });

  const trimmedQuery = debouncedQuery.trim();
  const instrumentSearchEnabled = open && meetsInstrumentSearchMinimum(trimmedQuery);
  const instrumentsQuery = useQuery({
    ...quickSearchInstrumentsQueryOptions(trimmedQuery),
    enabled: instrumentSearchEnabled,
  });

  const allPortfolioMatches = useMemo(
    // portfolio-archive FR-596 / PA-L11: no route to an archived portfolio
    // from here — the « Archivés » group and the URL are the only ways back.
    () =>
      (portfoliosQuery.data ?? []).filter(
        (p) => p.archived !== true && matchesPortfolioName(p.name, query),
      ),
    [portfoliosQuery.data, query],
  );
  const portfolioResults = allPortfolioMatches.slice(0, QUICK_SEARCH_RESULT_LIMIT);
  const portfoliosTruncated = allPortfolioMatches.length > QUICK_SEARCH_RESULT_LIMIT;

  const instrumentResults = (instrumentsQuery.data ?? []).slice(0, QUICK_SEARCH_RESULT_LIMIT);

  const totalResultCount = portfolioResults.length + instrumentResults.length;
  const activeOptionIndex =
    totalResultCount === 0 ? -1 : Math.min(activeIndex, totalResultCount - 1);

  function reset(): void {
    setQuery("");
    setDebouncedQuery("");
    setActiveIndex(0);
  }

  function selectPortfolio(portfolio: PortfolioSummary): void {
    setOpen(false);
    reset();
    void navigate({
      to: "/portfolios/$portfolioId",
      params: { portfolioId: portfolio.id },
      search: { range: DEFAULT_PERIOD_PRESET_ID, tab: "overview" },
    });
  }

  function selectInstrument(instrument: InstrumentSummary): void {
    setOpen(false);
    reset();
    void navigate({
      to: "/instruments/$instrumentId",
      params: { instrumentId: instrument.id },
    });
  }

  function selectByIndex(index: number): void {
    if (index < 0) return;
    if (index < portfolioResults.length) {
      selectPortfolio(portfolioResults[index]!);
    } else {
      selectInstrument(instrumentResults[index - portfolioResults.length]!);
    }
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (totalResultCount > 0) {
        setActiveIndex((i) => Math.min(i + 1, totalResultCount - 1));
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (totalResultCount > 0) {
        setActiveIndex((i) => Math.max(i - 1, 0));
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectByIndex(activeOptionIndex);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="quick-search-trigger"
        className="k-btn k-btn-ghost k-btn-sm"
        onClick={() => setOpen(true)}
      >
        {SHELL_COPY.search} <span className="k-quicksearch-hint k-quicksearch-kbd">⌘K</span>
      </button>

      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="k-scrim" />
          <Dialog.Content
            data-testid="quick-search-dialog"
            className="fixed left-1/2 top-24 z-50 w-full max-w-lg -translate-x-1/2 rounded-lg bg-white p-4 shadow-xl focus:outline-none"
          >
            <Dialog.Title className="sr-only">{SHELL_COPY.quickSearchTitle}</Dialog.Title>
            <Dialog.Description className="sr-only">
              {SHELL_COPY.quickSearchDescription}
            </Dialog.Description>

            <div className="flex items-center gap-2">
              <input
                type="text"
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-controls="quick-search-listbox"
                aria-activedescendant={
                  activeOptionIndex >= 0 ? `quick-search-option-${activeOptionIndex}` : undefined
                }
                data-testid="quick-search-input"
                className="k-quicksearch-input"
                placeholder={SHELL_COPY.quickSearchPlaceholder}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onInputKeyDown}
              />
              <Dialog.Close asChild>
                <button
                  type="button"
                  data-testid="quick-search-close"
                  aria-label={COMMON_COPY.close}
                  className="k-iconbtn k-iconbtn-md k-iconbtn-plain"
                >
                  ×
                </button>
              </Dialog.Close>
            </div>

            <div id="quick-search-listbox" role="listbox" className="mt-3 flex flex-col gap-3">
              <section aria-label={SHELL_COPY.quickSearchPortfolios}>
                <h2 className="micro-label">{SHELL_COPY.quickSearchPortfolios}</h2>
                {portfolioResults.length === 0 ? (
                  <p data-testid="quick-search-portfolios-empty" className="k-quicksearch-note">
                    {SHELL_COPY.quickSearchNoPortfolio}
                  </p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-1">
                    {portfolioResults.map((portfolio, index) => (
                      <li key={portfolio.id}>
                        <button
                          type="button"
                          id={`quick-search-option-${index}`}
                          role="option"
                          aria-selected={index === activeOptionIndex}
                          data-testid="quick-search-result-portfolio"
                          className={`w-full rounded px-2 py-1 text-left text-sm ${
                            index === activeOptionIndex
                              ? "bg-surface-brand-soft"
                              : "hover:bg-paper-100"
                          }`}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => selectPortfolio(portfolio)}
                        >
                          {portfolio.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {portfoliosTruncated && (
                  <p className="k-quicksearch-hint">{SHELL_COPY.quickSearchPortfoliosTruncated}</p>
                )}
              </section>

              <section aria-label={SHELL_COPY.quickSearchInstruments}>
                <h2 className="micro-label">{SHELL_COPY.quickSearchInstruments}</h2>
                {!meetsInstrumentSearchMinimum(trimmedQuery) ? (
                  <p data-testid="quick-search-instrument-hint" className="k-quicksearch-note">
                    {SHELL_COPY.quickSearchInstrumentMinimum}
                  </p>
                ) : instrumentResults.length === 0 ? (
                  <p data-testid="quick-search-instruments-empty" className="k-quicksearch-note">
                    {SHELL_COPY.quickSearchNoInstrument}
                  </p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-1">
                    {instrumentResults.map((instrument, index) => {
                      const flatIndex = portfolioResults.length + index;
                      return (
                        <li key={instrument.id}>
                          <button
                            type="button"
                            id={`quick-search-option-${flatIndex}`}
                            role="option"
                            aria-selected={flatIndex === activeOptionIndex}
                            data-testid="quick-search-result-instrument"
                            className={`w-full rounded px-2 py-1 text-left text-sm ${
                              flatIndex === activeOptionIndex
                                ? "bg-surface-brand-soft"
                                : "hover:bg-paper-100"
                            }`}
                            onMouseEnter={() => setActiveIndex(flatIndex)}
                            onClick={() => selectInstrument(instrument)}
                          >
                            {instrument.displayName}
                            {instrument.symbol !== null && (
                              <span className="text-text-muted"> ({instrument.symbol})</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
