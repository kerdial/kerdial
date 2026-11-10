import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { WatchlistRow } from "../lib/api-client.js";
import { WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES } from "../lib/api-limits.js";
import { fill } from "../lib/copy/fill.js";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { WatchlistTargetEditor, watchlistTargetPriceScaleError } from "./WatchlistTargetEditor.js";

/**
 * `WatchlistTargetEditor` — UR-53/FR-341's editor, on its own
 * (it was `WatchlistRowEditor` inside `WatchlistTable.tsx`; these cases moved
 * here from `WatchlistTable.test.tsx` and `WatchlistView.test.tsx` with the
 * component, unchanged in what they assert).
 *
 * Two contracts are pinned: the **three-way PATCH body** (absent = untouched,
 * `null` = cleared, value = set) and the **WL-1 scale guard**, whose
 * discriminating assertion is a request *count* taken after a valid save has
 * landed — a bare `not.toHaveBeenCalled()` straight after the click passes
 * on a build with no guard at all, because the mutation is asynchronous
 * (MEASURED during that fix's red-confirm).
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, patchWatchlistItem: vi.fn(), fetchWatchlist: vi.fn() };
});

const mocked = vi.mocked(apiClient);
const APPLE = "11111111-1111-4111-8111-111111111111";

function row(overrides: Partial<WatchlistRow> = {}): WatchlistRow {
  return {
    instrumentId: APPLE,
    kind: "SHARE",
    displayName: "Apple Inc",
    hasIcon: false,
    status: "ACTIVE",
    listingCurrency: "USD",
    listingCountry: "US",
    sectorCode: null,
    industryLabel: null,
    domicileCountry: null,
    watchedSince: "2026-01-15",
    targetPrice: null,
    note: null,
    currentPrice: { amount: "198.20", currency: "USD", provenance: { derivedFrom: [] } },
    dayChange: "1.20",
    dayChangePercent: "0.0061",
    metrics: { unusableSeries: false, periodReturns: {} },
    series: [],
    ...overrides,
  };
}

function renderEditor(current: WatchlistRow = row()): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    (
      <Tooltip.Provider>
        <QueryClientProvider client={client}>
          <WatchlistTargetEditor row={current} testId="watchlist-edit" />
        </QueryClientProvider>
      </Tooltip.Provider>
    ) as ReactElement,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<WatchlistTargetEditor> — the three-way PATCH body (UR-53, AC-345)", () => {
  it("states both absences before any edit, in words rather than blank cells", () => {
    renderEditor();
    expect(screen.getByTestId("watchlist-edit-target")).toHaveTextContent(
      WATCHLIST_COPY.targetPriceEmpty,
    );
    expect(screen.getByTestId("watchlist-edit-note")).toHaveTextContent(WATCHLIST_COPY.noteEmpty);
  });

  it("sends both fields when both changed, and closes on success", async () => {
    mocked.patchWatchlistItem.mockResolvedValue({
      instrumentId: APPLE,
      targetPrice: "250.00",
      note: "surveiller le T3",
      watchedSince: "2026-01-15",
    });
    renderEditor();

    fireEvent.click(screen.getByTestId("watchlist-edit-open"));
    fireEvent.change(screen.getByTestId("watchlist-edit-target-input"), {
      target: { value: "250.00" },
    });
    fireEvent.change(screen.getByTestId("watchlist-edit-note-input"), {
      target: { value: "surveiller le T3" },
    });
    fireEvent.click(screen.getByTestId("watchlist-edit-save"));

    await waitFor(() => expect(mocked.patchWatchlistItem).toHaveBeenCalledTimes(1));
    expect(mocked.patchWatchlistItem.mock.calls[0]?.[0]).toEqual({
      instrumentId: APPLE,
      targetPrice: "250.00",
      note: "surveiller le T3",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("watchlist-edit-target-input")).not.toBeInTheDocument(),
    );
  });

  it("clears a stored value with an explicit null, and leaves the untouched field absent", async () => {
    mocked.patchWatchlistItem.mockResolvedValue({
      instrumentId: APPLE,
      targetPrice: null,
      note: "surveiller le T3",
      watchedSince: "2026-01-15",
    });
    renderEditor(row({ targetPrice: "250.00", note: "surveiller le T3" }));

    fireEvent.click(screen.getByTestId("watchlist-edit-open"));
    fireEvent.change(screen.getByTestId("watchlist-edit-target-input"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("watchlist-edit-save"));

    await waitFor(() => expect(mocked.patchWatchlistItem).toHaveBeenCalledTimes(1));
    const body = mocked.patchWatchlistItem.mock.calls[0]?.[0];
    expect(body).toEqual({ instrumentId: APPLE, targetPrice: null });
    // The note was never touched, so it must not be on the request at all —
    // `{note: null}` here would wipe a note the user did not edit.
    expect("note" in (body as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe("<WatchlistTargetEditor> — refuses a 19th decimal (WL-1)", () => {
  const EXPECTED_MESSAGE = fill(WATCHLIST_COPY.targetPriceScaleError, {
    max: String(WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES),
  });

  function openEditor(): HTMLElement {
    renderEditor();
    fireEvent.click(screen.getByTestId("watchlist-edit-open"));
    return screen.getByTestId("watchlist-edit-target-input");
  }

  it("states the bound in French, marks the field invalid, and issues NO request — the next, VALID save is the first call", async () => {
    mocked.patchWatchlistItem.mockResolvedValue({
      instrumentId: APPLE,
      targetPrice: "250.5",
      note: null,
      watchedSince: "2026-01-15",
    });

    const input = openEditor();
    fireEvent.change(input, { target: { value: "0.0000000000000000001" } });

    expect(await screen.findByText(EXPECTED_MESSAGE)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");

    fireEvent.click(screen.getByTestId("watchlist-edit-save"));
    fireEvent.change(input, { target: { value: "250.5" } });
    fireEvent.click(screen.getByTestId("watchlist-edit-save"));

    await waitFor(() => expect(mocked.patchWatchlistItem).toHaveBeenCalledTimes(1));
    expect(mocked.patchWatchlistItem.mock.calls[0]?.[0]).toEqual({
      instrumentId: APPLE,
      targetPrice: "250.5",
    });
  });

  it("ACCEPTS exactly 18 decimals and sends them verbatim — the positive companion", async () => {
    mocked.patchWatchlistItem.mockResolvedValue({
      instrumentId: APPLE,
      targetPrice: "1.234567890123456789",
      note: null,
      watchedSince: "2026-01-15",
    });

    const input = openEditor();
    fireEvent.change(input, { target: { value: "1.234567890123456789" } });
    expect(screen.queryByText(EXPECTED_MESSAGE)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("watchlist-edit-save"));

    await waitFor(() => expect(mocked.patchWatchlistItem).toHaveBeenCalledTimes(1));
    expect(mocked.patchWatchlistItem.mock.calls[0]?.[0]).toEqual({
      instrumentId: APPLE,
      targetPrice: "1.234567890123456789",
    });
  });
});

describe("watchlistTargetPriceScaleError — the bound itself, and what it deliberately ignores", () => {
  it("refuses 19 places and accepts 18", () => {
    expect(watchlistTargetPriceScaleError("0.0000000000000000001")).toBe(
      fill(WATCHLIST_COPY.targetPriceScaleError, {
        max: String(WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES),
      }),
    );
    expect(watchlistTargetPriceScaleError("1.234567890123456789")).toBeUndefined();
  });

  it("leaves an empty, a whole and an unparseable entry to the server's own refusal", () => {
    // Not a second copy of the request schema — see the helper's doc comment.
    expect(watchlistTargetPriceScaleError("")).toBeUndefined();
    expect(watchlistTargetPriceScaleError("  ")).toBeUndefined();
    expect(watchlistTargetPriceScaleError("250")).toBeUndefined();
    expect(watchlistTargetPriceScaleError("pas un nombre")).toBeUndefined();
  });
});
