import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstrumentBodySchema, INDUSTRY_LABEL_MAX_LENGTH } from "@kerdial/api-contracts";
import { MIC_UNLISTED_SENTINEL, PROVIDER_SECTOR_TO_CODE } from "@kerdial/core-reference-data";
import * as apiClient from "../lib/api-client.js";
import { InstrumentCreateDialog } from "./InstrumentCreateDialog.js";
import {
  InstrumentCreateForm,
  buildInstrumentRequestPayload,
  defaultInstrumentFormValues,
  resolveExistingInstrument,
  type InstrumentFormValues,
} from "./InstrumentCreateForm.js";

/**
 * The instrument-creation UI task's own acceptance criteria — a companion
 * Playwright suite (`web/e2e/instrument-create.spec.ts`) proves the full
 * journey (empty-search create, standalone create, duplicate outcome) across
 * a real dialog/picker integration; this file covers the form's own
 * validation/shape/duplicate-resolution logic once, in jsdom, the same way
 * `TransactionForm.test.tsx` covers T-44's component logic.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    createInstrument: vi.fn(),
    searchInstruments: vi.fn(),
    // IC-15: `CurrencySelect`/`InstrumentDiscoverySearch` are now rendered
    // unconditionally inside this form, so both of their own data sources
    // need a mock here too, exactly like `searchInstruments` already did —
    // otherwise every test below would hit the real (unmocked) `fetch`.
    fetchCurrencies: vi.fn(),
    searchInstrumentDiscovery: vi.fn(),
  };
});

const mockedApiClient = vi.mocked(apiClient);
const { ApiError } = apiClient;

function renderForm(initialDisplayName?: string): {
  onCreated: (instrument: apiClient.InstrumentSummary, outcome: "created" | "existing") => void;
  onCancel: () => void;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  render(
    (
      <QueryClientProvider client={queryClient}>
        <InstrumentCreateForm
          onCreated={onCreated}
          onCancel={onCancel}
          {...(initialDisplayName !== undefined ? { initialDisplayName } : {})}
        />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { onCreated, onCancel };
}

function selectKind(kind: string): void {
  fireEvent.change(screen.getByTestId("instrument-kind-select"), { target: { value: kind } });
}

/** Mirrors `TransactionForm.test.tsx`'s `fieldErrorText` — proves an error routes to the *correct* field's slot, not merely that some error text exists somewhere on the page. */
/**
 * The inline error belonging to one field. The form's own fields are
 * the kit's `<Input>`/`<Select>`, whose wrapper is `.k-field` rather than a
 * `<label>`; `ExchangeMicSelect`/`CurrencySelect` are shared components this
 * screen does not own and keep their own plain wrappers. Walking to whichever
 * of the two encloses the input keeps this helper indifferent to which kind of
 * field it is handed — which is the only reason it can stay one helper.
 */
function fieldErrorText(inputTestId: string): string | null {
  const input = screen.getByTestId(inputTestId);
  const field = input.closest(".k-field") ?? input.closest("label") ?? input.parentElement;
  const alert = field?.querySelector('[role="alert"]');
  return alert?.textContent ?? null;
}

/** Waits for `CurrencySelect`'s own `GET /currencies` fetch to resolve and populate its `<option>`s — the select structurally cannot accept a value absent from that list (IC-13). */
async function waitForCurrencyOptions(
  testId = "instrument-listing-currency-select",
): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId(testId).querySelectorAll("option").length).toBeGreaterThan(1),
  );
}

async function fillValidShare(): Promise<void> {
  fireEvent.change(screen.getByTestId("instrument-display-name-input"), {
    target: { value: "Air Liquide" },
  });
  fireEvent.change(screen.getByTestId("instrument-isin-input"), {
    target: { value: "FR0000120073" },
  });
  fireEvent.change(screen.getByTestId("instrument-exchange-mic-select"), {
    target: { value: "XPAR" },
  });
  await waitForCurrencyOptions();
  fireEvent.change(screen.getByTestId("instrument-listing-currency-select"), {
    target: { value: "EUR" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.searchInstruments.mockResolvedValue([]);
  mockedApiClient.searchInstrumentDiscovery.mockResolvedValue([]);
  mockedApiClient.fetchCurrencies.mockResolvedValue([
    { code: "EUR", name: "Euro", minorUnit: 2 },
    { code: "USD", name: "Dollar américain", minorUnit: 2 },
  ]);
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("buildInstrumentRequestPayload — structural per-kind shape (pure, no rendering)", () => {
  function values(overrides: Partial<InstrumentFormValues>): InstrumentFormValues {
    return { ...defaultInstrumentFormValues(), ...overrides };
  }

  // AC1: a share/ETF/fund is added by ISIN + exchange MIC.
  //
  // IC-15 changes this test's own previous claim ("no symbol
  // key at all"): `symbol` is now rendered — and submitted, when filled —
  // for ISIN-based kinds too, so `buildInstrumentRequestPayload` "simply
  // stops omitting it on the ISIN branch". Left
  // blank, `symbol` is still `undefined`-valued (so still absent from the
  // JSON `POST /instruments` body once `JSON.stringify` drops it — no wire
  // regression), which is the property asserted below instead of the old
  // "key never present at all" one.
  it("SHARE: isin/exchangeMic present; symbol omitted from the wire when blank, included when filled (IC-15)", () => {
    const blank = buildInstrumentRequestPayload(
      values({ kind: "SHARE", isin: "FR0000120073", exchangeMic: "XPAR", listingCurrency: "EUR" }),
    );
    expect(blank["isin"]).toBe("FR0000120073");
    expect(blank["exchangeMic"]).toBe("XPAR");
    expect(blank["symbol"]).toBeUndefined();
    expect(JSON.parse(JSON.stringify(blank))).not.toHaveProperty("symbol");

    const withSymbol = buildInstrumentRequestPayload(
      values({
        kind: "SHARE",
        isin: "FR0000120073",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        symbol: "TTE.PA",
      }),
    );
    expect(withSymbol["symbol"]).toBe("TTE.PA");
  });

  // AC2: a crypto instrument is added by symbol alone — no isin/exchangeMic key at all.
  it("CRYPTO: symbol present, no isin/exchangeMic key at all", () => {
    const body = buildInstrumentRequestPayload(
      values({ kind: "CRYPTO", symbol: "DOGE", listingCurrency: "USD" }),
    );
    expect(body["symbol"]).toBe("DOGE");
    expect("isin" in body).toBe(false);
    expect("exchangeMic" in body).toBe(false);
  });

  it("INDEX: symbol present, no isin/exchangeMic key at all (also symbol-based)", () => {
    const body = buildInstrumentRequestPayload(
      values({ kind: "INDEX", symbol: "^GSPC", listingCurrency: "USD" }),
    );
    expect(body["symbol"]).toBe("^GSPC");
    expect("isin" in body).toBe(false);
    expect("exchangeMic" in body).toBe(false);
  });

  it("ETF/FUND: also isin-based, same as SHARE — symbol still optional, omitted from the wire when blank", () => {
    const etf = buildInstrumentRequestPayload(
      values({ kind: "ETF", isin: "IE00B4L5Y983", exchangeMic: "XLON", listingCurrency: "USD" }),
    );
    expect(JSON.parse(JSON.stringify(etf))).not.toHaveProperty("symbol");
    const fund = buildInstrumentRequestPayload(
      values({ kind: "FUND", isin: "FR0000131600", exchangeMic: "XPAR", listingCurrency: "EUR" }),
    );
    expect(JSON.parse(JSON.stringify(fund))).not.toHaveProperty("symbol");
  });

  it("figi is included when filled, omitted (not an empty string) when blank", () => {
    const withFigi = buildInstrumentRequestPayload(
      values({
        kind: "SHARE",
        isin: "FR0000120073",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        figi: "BBG000BLNNH6",
      }),
    );
    expect(withFigi["figi"]).toBe("BBG000BLNNH6");

    const withoutFigi = buildInstrumentRequestPayload(
      values({ kind: "SHARE", isin: "FR0000120073", exchangeMic: "XPAR", listingCurrency: "EUR" }),
    );
    expect(withoutFigi["figi"]).toBeUndefined();
  });

  // LOW UX-consistency note (security review): isin/exchangeMic/listingCurrency
  // are uppercase-only validators with no schema-side transform (unlike
  // `symbol`'s own `.toUpperCase()`) — a lowercase-typed value is uppercased
  // client-side before validation so it is accepted rather than rejected,
  // with no drift from what the shared schema ultimately validates.
  it("uppercases a lowercase-typed isin/exchangeMic/listingCurrency before submission", () => {
    const body = buildInstrumentRequestPayload(
      values({
        kind: "SHARE",
        isin: "fr0000120073",
        exchangeMic: "xpar",
        listingCurrency: "eur",
        displayName: "Air Liquide",
      }),
    );
    expect(body["isin"]).toBe("FR0000120073");
    expect(body["exchangeMic"]).toBe("XPAR");
    expect(body["listingCurrency"]).toBe("EUR");
  });

  /**
   * LOW (security review): the
   * industry label is the one payload field the user never types — it arrives
   * from a discovery candidate, and `GET /instruments/discovery` applies no
   * runtime response validation to it, so a provider label longer than
   * `industryLabelSchema`'s `.max()` reaches this form verbatim. Sent as-is it
   * failed the resolver, which routed the issue to a field this form does not
   * render: submit silently did nothing at all. Dropped instead, the same way
   * `market/composition`'s own write site drops it — the sector, which is the
   * aggregatable half, still lands.
   */
  it("drops an industry label the shared schema would reject, keeping the sector (never sends an unsubmittable body)", () => {
    const overLong = "z".repeat(INDUSTRY_LABEL_MAX_LENGTH + 1);
    const body = buildInstrumentRequestPayload(
      values({
        kind: "SHARE",
        isin: "FR0000120073",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Air Liquide",
        sectorCode: "MATERIAUX",
        industryLabel: overLong,
      }),
    );
    expect(body["sectorCode"]).toBe("MATERIAUX");
    expect(body["industryLabel"]).toBeUndefined();
    // The whole body is submittable — the property the silent-no-op bug broke.
    expect(createInstrumentBodySchema.safeParse(body).success).toBe(true);
  });

  it("trims an industry label exactly as the shared schema does, and keeps one at the bound", () => {
    const atBound = "y".repeat(INDUSTRY_LABEL_MAX_LENGTH);
    const base = {
      kind: "SHARE" as const,
      isin: "FR0000120073",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "Air Liquide",
    };
    expect(
      buildInstrumentRequestPayload(values({ ...base, industryLabel: `  ${atBound}  ` }))[
        "industryLabel"
      ],
    ).toBe(atBound);
    expect(
      buildInstrumentRequestPayload(values({ ...base, industryLabel: "   " }))["industryLabel"],
    ).toBeUndefined();
  });
});

describe("InstrumentCreateForm — kind switch structurally swaps fields (not merely hides them)", () => {
  // IC-15: `symbol` is now rendered for ISIN-based kinds too
  // (previously this test asserted its *absence* for SHARE — that omission
  // is exactly what IC-15 changes, so the
  // assertion is updated to match the new, explicitly-specified shape, not
  // merely to force a pass).
  it("SHARE (default) shows isin/exchangeMic AND symbol (IC-15, AC-3's autofill target)", () => {
    renderForm();
    expect(screen.getByTestId("instrument-isin-input")).toBeInTheDocument();
    expect(screen.getByTestId("instrument-exchange-mic-select")).toBeInTheDocument();
    expect(screen.getByTestId("instrument-symbol-input")).toBeInTheDocument();
  });

  it("CRYPTO shows symbol, not isin/exchangeMic", () => {
    renderForm();
    selectKind("CRYPTO");
    expect(screen.getByTestId("instrument-symbol-input")).toBeInTheDocument();
    expect(screen.queryByTestId("instrument-isin-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-exchange-mic-select")).not.toBeInTheDocument();
  });
});

describe("InstrumentCreateForm — schema error routing to fields", () => {
  it("an invalid ISIN check digit routes its error to the isin field, not elsewhere", async () => {
    renderForm();
    fireEvent.change(screen.getByTestId("instrument-display-name-input"), {
      target: { value: "Bad ISIN" },
    });
    fireEvent.change(screen.getByTestId("instrument-isin-input"), {
      target: { value: "FR0000131600" }, // correct shape, wrong ISO 6166 check digit
    });
    fireEvent.change(screen.getByTestId("instrument-exchange-mic-select"), {
      target: { value: "XPAR" },
    });
    await waitForCurrencyOptions();
    fireEvent.change(screen.getByTestId("instrument-listing-currency-select"), {
      target: { value: "EUR" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(fieldErrorText("instrument-isin-input")).not.toBeNull());
    expect(fieldErrorText("instrument-exchange-mic-select")).toBeNull();
    expect(mockedApiClient.createInstrument).not.toHaveBeenCalled();
  });

  // Note: a lowercase MIC is no longer "malformed" — the LOW UX-consistency
  // fix (security review) uppercases isin/exchangeMic/listingCurrency before
  // validation, so "xpar" is now accepted as "XPAR" (see the dedicated
  // `buildInstrumentRequestPayload` uppercasing test above). A genuinely
  // malformed MIC (wrong charset/length) still routes its error correctly —
  // reached, post-IC-13, via the "Autre" escape hatch (AC-10), the only path
  // by which a non-curated/malformed value can be submitted at all.
  it("a malformed MIC (punctuation, not just wrong case) routes its error to the exchangeMic field", async () => {
    renderForm();
    await fillValidShare();
    fireEvent.change(screen.getByTestId("instrument-exchange-mic-select"), {
      target: { value: MIC_UNLISTED_SENTINEL },
    });
    fireEvent.change(screen.getByTestId("instrument-exchange-mic-input"), {
      target: { value: "XP-R" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(fieldErrorText("instrument-exchange-mic-input")).not.toBeNull());
    expect(mockedApiClient.createInstrument).not.toHaveBeenCalled();
  });

  it("CRYPTO with no symbol routes its error to the symbol field (AC2)", async () => {
    renderForm();
    selectKind("CRYPTO");
    fireEvent.change(screen.getByTestId("instrument-display-name-input"), {
      target: { value: "Dogecoin" },
    });
    await waitForCurrencyOptions();
    fireEvent.change(screen.getByTestId("instrument-listing-currency-select"), {
      target: { value: "USD" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(fieldErrorText("instrument-symbol-input")).not.toBeNull());
    expect(mockedApiClient.createInstrument).not.toHaveBeenCalled();
  });

  it("a missing displayName is rejected before the API is ever called", async () => {
    renderForm();
    fireEvent.change(screen.getByTestId("instrument-isin-input"), {
      target: { value: "FR0000120073" },
    });
    fireEvent.change(screen.getByTestId("instrument-exchange-mic-select"), {
      target: { value: "XPAR" },
    });
    await waitForCurrencyOptions();
    fireEvent.change(screen.getByTestId("instrument-listing-currency-select"), {
      target: { value: "EUR" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(fieldErrorText("instrument-display-name-input")).not.toBeNull());
    expect(mockedApiClient.createInstrument).not.toHaveBeenCalled();
  });
});

describe("InstrumentCreateForm — successful creation (AC1/AC2's positive half)", () => {
  it("SHARE: calls onCreated with outcome 'created' once the API resolves", async () => {
    const created: apiClient.InstrumentSummary = {
      id: "created-1",
      kind: "SHARE",
      displayName: "Air Liquide",
      listingCurrency: "EUR",
      isin: "FR0000120073",
      exchangeMic: "XPAR",
      symbol: null,
    };
    mockedApiClient.createInstrument.mockResolvedValueOnce(created);
    const { onCreated } = renderForm();
    await fillValidShare();

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created, "created"));
  });

  it("prefills displayName from initialDisplayName (the picker's own in-progress search text)", () => {
    renderForm("Wrapped Bitcoin");
    expect(screen.getByTestId("instrument-display-name-input")).toHaveValue("Wrapped Bitcoin");
  });
});

describe("InstrumentCreateForm — duplicate outcome (AC1's negative half)", () => {
  it("a 409 with a locatable existing row shows the calm duplicate notice, and 'use existing' selects it", async () => {
    const existing: apiClient.InstrumentSummary = {
      id: "existing-1",
      kind: "SHARE",
      displayName: "Air Liquide",
      listingCurrency: "EUR",
      isin: "FR0000120073",
      exchangeMic: "XPAR",
      symbol: null,
    };
    mockedApiClient.createInstrument.mockRejectedValueOnce(
      new ApiError(409, { code: "INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC" }),
    );
    mockedApiClient.searchInstruments.mockResolvedValueOnce([existing]);

    const { onCreated } = renderForm();
    await fillValidShare();
    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() =>
      expect(screen.getByTestId("instrument-duplicate-notice")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("instrument-duplicate-notice").textContent).toContain("Air Liquide");

    fireEvent.click(screen.getByTestId("instrument-duplicate-use-existing"));
    expect(onCreated).toHaveBeenCalledWith(existing, "existing");
  });

  it("a 409 whose existing row cannot be located shows the calm unresolved notice, never a raw error", async () => {
    mockedApiClient.createInstrument.mockRejectedValueOnce(
      new ApiError(409, { code: "INSTRUMENT_DUPLICATE_CRYPTO_SYMBOL" }),
    );
    mockedApiClient.searchInstruments.mockResolvedValueOnce([]); // search comes back empty

    renderForm();
    selectKind("CRYPTO");
    fireEvent.change(screen.getByTestId("instrument-display-name-input"), {
      target: { value: "Dogecoin" },
    });
    fireEvent.change(screen.getByTestId("instrument-symbol-input"), {
      target: { value: "DOGE" },
    });
    await waitForCurrencyOptions();
    fireEvent.change(screen.getByTestId("instrument-listing-currency-select"), {
      target: { value: "USD" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() =>
      expect(screen.getByTestId("instrument-duplicate-unresolved-notice")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("instrument-create-error")).not.toBeInTheDocument();
  });

  it("a non-409 error still renders the ordinary create-error alert, not a duplicate notice", async () => {
    mockedApiClient.createInstrument.mockRejectedValueOnce(new Error("boom"));
    renderForm();
    await fillValidShare();

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(screen.getByTestId("instrument-create-error")).toBeInTheDocument());
    expect(screen.queryByTestId("instrument-duplicate-notice")).not.toBeInTheDocument();
  });
});

describe("resolveExistingInstrument — the 409 lookup helper (pure, no rendering)", () => {
  it("matches an isin-based duplicate on (isin, exchangeMic), not isin alone", async () => {
    mockedApiClient.searchInstruments.mockResolvedValueOnce([
      {
        id: "wrong-mic",
        kind: "SHARE",
        displayName: "Same ISIN, different listing",
        listingCurrency: "USD",
        isin: "FR0000120073",
        exchangeMic: "XNYS",
        symbol: null,
      },
      {
        id: "right-mic",
        kind: "SHARE",
        displayName: "Air Liquide",
        listingCurrency: "EUR",
        isin: "FR0000120073",
        exchangeMic: "XPAR",
        symbol: null,
      },
    ]);
    const result = await resolveExistingInstrument({
      kind: "SHARE",
      isin: "FR0000120073",
      exchangeMic: "XPAR",
    });
    expect(result?.id).toBe("right-mic");
  });

  it("matches a symbol-based duplicate on symbol", async () => {
    mockedApiClient.searchInstruments.mockResolvedValueOnce([
      {
        id: "btc-1",
        kind: "CRYPTO",
        displayName: "Bitcoin",
        listingCurrency: "USD",
        isin: null,
        exchangeMic: null,
        symbol: "BTC",
      },
    ]);
    const result = await resolveExistingInstrument({ kind: "CRYPTO", symbol: "BTC" });
    expect(result?.id).toBe("btc-1");
  });

  // MEDIUM (security review): `symbol` alone is not a unique key across the
  // whole catalogue — an ISIN-based row can freely carry the same string in
  // its own `symbol` column as an unrelated, non-unique attribute. The
  // reviewer's exact scenario: an ETF that merely happens to carry "BTC" as
  // its `symbol` sorts FIRST in the search results, ahead of the real CRYPTO
  // "BTC" row — a `symbol`-alone match would incorrectly resolve to the ETF.
  it("a symbol-based 409 never resolves to an unrelated ISIN-based row sharing the same symbol text, even when it sorts first", async () => {
    mockedApiClient.searchInstruments.mockResolvedValueOnce([
      {
        id: "etf-with-btc-symbol",
        kind: "ETF",
        displayName: "Some ETF (unrelated ticker collision)",
        listingCurrency: "USD",
        isin: "US0000000001",
        exchangeMic: "XNAS",
        symbol: "BTC",
      },
      {
        id: "btc-crypto-1",
        kind: "CRYPTO",
        displayName: "Bitcoin",
        listingCurrency: "USD",
        isin: null,
        exchangeMic: null,
        symbol: "BTC",
      },
    ]);
    const result = await resolveExistingInstrument({ kind: "CRYPTO", symbol: "BTC" });
    expect(result?.id).toBe("btc-crypto-1");
  });

  // Adjacent walk: the same symbol-primary identity match must not break
  // for INDEX (the other symbol-based kind) — `createInstrumentBySymbol`
  // sets `isin: null` for INDEX exactly as it does for CRYPTO.
  it("matches an INDEX duplicate on (symbol, kind, isin IS NULL) too, not only CRYPTO", async () => {
    mockedApiClient.searchInstruments.mockResolvedValueOnce([
      {
        id: "unrelated-share-with-same-symbol",
        kind: "SHARE",
        displayName: "Unrelated share",
        listingCurrency: "USD",
        isin: "US0000000002",
        exchangeMic: "XNAS",
        symbol: "^GSPC",
      },
      {
        id: "gspc-index-1",
        kind: "INDEX",
        displayName: "S&P 500",
        listingCurrency: "USD",
        isin: null,
        exchangeMic: null,
        symbol: "^GSPC",
      },
    ]);
    const result = await resolveExistingInstrument({ kind: "INDEX", symbol: "^GSPC" });
    expect(result?.id).toBe("gspc-index-1");
  });

  // LOW (security review): the server stores/dedupes the uppercased symbol
  // (`createInstrumentBodySchema`'s own `.trim().toUpperCase()` transform),
  // but a strict, un-normalised `===` compare against the raw, lowercase
  // form input previously dropped a genuine match.
  it("a lowercase-typed symbol still resolves to an existing uppercase-stored row", async () => {
    mockedApiClient.searchInstruments.mockResolvedValueOnce([
      {
        id: "doge-1",
        kind: "CRYPTO",
        displayName: "Dogecoin",
        listingCurrency: "USD",
        isin: null,
        exchangeMic: null,
        symbol: "DOGE",
      },
    ]);
    const result = await resolveExistingInstrument({ kind: "CRYPTO", symbol: "doge" });
    expect(result?.id).toBe("doge-1");
  });

  it("returns undefined (never throws) when the search itself rejects", async () => {
    mockedApiClient.searchInstruments.mockRejectedValueOnce(new Error("network down"));
    const result = await resolveExistingInstrument({ kind: "CRYPTO", symbol: "BTC" });
    expect(result).toBeUndefined();
  });

  it("returns undefined for a query shorter than the search endpoint's own 3-character minimum", async () => {
    const result = await resolveExistingInstrument({ kind: "CRYPTO", symbol: "GE" });
    expect(result).toBeUndefined();
    expect(mockedApiClient.searchInstruments).not.toHaveBeenCalled();
  });
});

describe("InstrumentCreateForm — the create mutation is never queued/replayed offline (T-44)", () => {
  afterEach(() => {
    // `onlineManager` is a module-level singleton shared by every
    // `QueryClient` in the process — leaving it flipped would silently
    // affect every later test file's mutations too (same note T-44's own
    // suite carries).
    onlineManager.setOnline(true);
  });

  // Mirrors `TransactionForm.test.tsx`'s identical proof: `onlineManager`
  // (TanStack Query's own offline signal) is independent of this
  // component's `useOnlineStatus` hook (a separate `navigator.onLine`/
  // window-event signal, exercised at the Playwright layer instead) — this
  // proves the mutation's own `networkMode: "always"` configuration, not
  // the button-disable UI layer.
  it('is not paused while onlineManager reports offline ("always", not the default "online")', async () => {
    const created: apiClient.InstrumentSummary = {
      id: "created-1",
      kind: "SHARE",
      displayName: "Air Liquide",
      listingCurrency: "EUR",
      isin: "FR0000120073",
      exchangeMic: "XPAR",
      symbol: null,
    };
    mockedApiClient.createInstrument.mockResolvedValueOnce(created);
    renderForm();
    await fillValidShare();

    onlineManager.setOnline(false);
    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
  });

  it("never replays on reconnect — exactly one attempt total, offline or not", async () => {
    mockedApiClient.createInstrument.mockRejectedValueOnce(new Error("boom"));
    renderForm();
    await fillValidShare();

    onlineManager.setOnline(false);
    fireEvent.submit(screen.getByTestId("instrument-create-form"));
    await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));

    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1);
  });
});

/**
 * IC-15's own wiring (AC-3/AC-4/AC-9). The
 * companion Playwright suite (`web/e2e/instrument-discovery.spec.ts`) proves
 * the full dialog-level journey; this file covers the autofill/submitted-
 * value logic once, in jsdom, the same split `InstrumentCreateForm.test.tsx`
 * already keeps for the rest of the form.
 */
describe("InstrumentCreateForm — discovery selection wiring (IC-15)", () => {
  async function selectDiscoveryCandidate(
    candidate: {
      providerSymbol: string;
      tickerSymbol: string | null;
      displayName: string;
      listingCurrency: string;
      exchangeHint: { code: string; suggestedMic: string | null } | null;
      matchQuality: "EXACT" | "PROBABLE";
      sectorCode?: string | null;
      industryLabel?: string | null;
    },
    query = "TotalEnergies",
  ): Promise<void> {
    mockedApiClient.searchInstrumentDiscovery.mockResolvedValueOnce([candidate]);
    fireEvent.change(screen.getByTestId("instrument-discovery-search-input"), {
      target: { value: query },
    });
    await waitFor(() =>
      expect(screen.getByTestId("instrument-discovery-result")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("instrument-discovery-result"));
  }

  it("AC-3: selecting a candidate autofills displayName/symbol/currency and pre-selects the MIC dropdown, verbatim", async () => {
    renderForm();
    await waitForCurrencyOptions();
    await selectDiscoveryCandidate({
      providerSymbol: "TTE.PA",
      tickerSymbol: null,
      displayName: "TotalEnergies SE",
      listingCurrency: "EUR",
      exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
      matchQuality: "PROBABLE",
    });

    expect(screen.getByTestId("instrument-display-name-input")).toHaveValue("TotalEnergies SE");
    expect(screen.getByTestId("instrument-symbol-input")).toHaveValue("TTE.PA");
    expect(screen.getByTestId("instrument-listing-currency-select")).toHaveValue("EUR");
    expect(screen.getByTestId("instrument-exchange-mic-select")).toHaveValue("XPAR");
  });

  // RED-CONFIRM (this cycle's binding rule 2, narrowed): the negative
  // property this feature must never regress is that a discovery selection
  // never populates `isin` from anything the *provider* returned (Locked
  // decision D2's actual rationale — the equity provider does not return an
  // ISIN, so inventing one from provider data would be a data-integrity
  // bug). A name query ("TotalEnergies") is not itself an ISIN, so this is
  // still the pure "nothing from the provider ever lands in isin" case —
  // distinct from (and still holding alongside) the new, narrower
  // echo-the-user's-own-query-back behaviour covered below.
  it("a discovery selection from a name query never populates the isin field (decision D2)", async () => {
    renderForm();
    await waitForCurrencyOptions();
    await selectDiscoveryCandidate({
      providerSymbol: "TTE.PA",
      tickerSymbol: null,
      displayName: "TotalEnergies SE",
      listingCurrency: "EUR",
      exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
      matchQuality: "PROBABLE",
    });

    expect(screen.getByTestId("instrument-isin-input")).toHaveValue("");
  });

  // The friction this fix closes: after an ISIN-shaped, check-digit-VALID
  // search, selecting a candidate fills `isin` with the user's own query
  // (uppercased/trimmed), and that value reaches the submitted payload.
  it("fills isin from the user's own valid-ISIN query on candidate selection, and it reaches the submitted payload", async () => {
    const created: apiClient.InstrumentSummary = {
      id: "created-1",
      kind: "SHARE",
      displayName: "Air Liquide",
      listingCurrency: "EUR",
      isin: "FR0000120073",
      exchangeMic: "XPAR",
      symbol: "AI.PA",
    };
    mockedApiClient.createInstrument.mockResolvedValueOnce(created);
    renderForm();
    await waitForCurrencyOptions();
    await selectDiscoveryCandidate(
      {
        providerSymbol: "AI.PA",
        tickerSymbol: null,
        displayName: "Air Liquide",
        listingCurrency: "EUR",
        exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
        matchQuality: "EXACT",
      },
      "fr0000120073",
    );

    expect(screen.getByTestId("instrument-isin-input")).toHaveValue("FR0000120073");

    fireEvent.submit(screen.getByTestId("instrument-create-form"));
    await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
    const submittedBody = mockedApiClient.createInstrument.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(submittedBody["isin"]).toBe("FR0000120073");
  });

  // Proves the check digit is genuinely consulted, not just the 12-character
  // shape: "FR0000120070" has the exact ISIN shape but fails ISO 6166's
  // check digit (confirmed against `isValidIsinCheckDigit` directly), so
  // selecting a candidate after that query must leave `isin` empty.
  it("leaves isin empty when the query has the right shape but a wrong check digit", async () => {
    renderForm();
    await waitForCurrencyOptions();
    await selectDiscoveryCandidate(
      {
        providerSymbol: "AI.PA",
        tickerSymbol: null,
        displayName: "Air Liquide",
        listingCurrency: "EUR",
        exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
        matchQuality: "EXACT",
      },
      "FR0000120070",
    );

    expect(screen.getByTestId("instrument-isin-input")).toHaveValue("");
  });

  // AC-3/D2's own boundary, restated: a CRYPTO search never even renders an
  // isin field, but the echo-back logic must also never populate it
  // internally for a symbol-based kind — proven by selecting a CRYPTO
  // candidate off an ISIN-shaped, check-digit-valid query, then switching to
  // SHARE (which does render the field) and confirming it is still empty.
  it("a CRYPTO search with an ISIN-shaped query never fills isin, even internally", async () => {
    renderForm();
    selectKind("CRYPTO");
    await selectDiscoveryCandidate(
      {
        providerSymbol: "bitcoin",
        tickerSymbol: "BTC",
        displayName: "Bitcoin",
        listingCurrency: "USD",
        exchangeHint: null,
        matchQuality: "EXACT",
      },
      "US0378331005",
    );

    selectKind("SHARE");
    await waitForCurrencyOptions();
    expect(screen.getByTestId("instrument-isin-input")).toHaveValue("");
  });

  it("a crypto candidate's tickerSymbol (never the raw providerSymbol coin id) autofills symbol", async () => {
    renderForm();
    selectKind("CRYPTO");
    await selectDiscoveryCandidate({
      providerSymbol: "bitcoin",
      tickerSymbol: "BTC",
      displayName: "Bitcoin",
      listingCurrency: "USD",
      exchangeHint: null,
      matchQuality: "EXACT",
    });

    expect(screen.getByTestId("instrument-symbol-input")).toHaveValue("BTC");
  });

  it("AC-9: the MIC dropdown pre-selection is changeable before submit, and the changed value is what gets submitted", async () => {
    const created: apiClient.InstrumentSummary = {
      id: "created-1",
      kind: "SHARE",
      displayName: "TotalEnergies SE",
      listingCurrency: "EUR",
      isin: "FR0000120073",
      exchangeMic: "XNYS",
      symbol: "TTE.PA",
    };
    mockedApiClient.createInstrument.mockResolvedValueOnce(created);
    renderForm();
    await waitForCurrencyOptions();
    await selectDiscoveryCandidate({
      providerSymbol: "TTE.PA",
      tickerSymbol: null,
      displayName: "TotalEnergies SE",
      listingCurrency: "EUR",
      exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
      matchQuality: "PROBABLE",
    });
    expect(screen.getByTestId("instrument-exchange-mic-select")).toHaveValue("XPAR");

    // The user overrides the suggestion before submit.
    fireEvent.change(screen.getByTestId("instrument-exchange-mic-select"), {
      target: { value: "XNYS" },
    });
    fireEvent.change(screen.getByTestId("instrument-isin-input"), {
      target: { value: "FR0000120073" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    // AC-4/AC-9: the submitted body reflects the *changed* dropdown value,
    // never the original suggestion.
    await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
    const submittedBody = mockedApiClient.createInstrument.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(submittedBody["exchangeMic"]).toBe("XNYS");
  });

  // RED-CONFIRM: the sentinel that backs the "Autre" escape hatch must never
  // reach the submitted request body, even when a discovery-suggested MIC is
  // itself later switched to "Autre" by the user.
  it("switching to Autre after a discovery pre-selection never submits the sentinel", async () => {
    mockedApiClient.createInstrument.mockResolvedValueOnce({
      id: "created-1",
      kind: "SHARE",
      displayName: "TotalEnergies SE",
      listingCurrency: "EUR",
      isin: "FR0000120073",
      exchangeMic: "ZZZZ",
      symbol: "TTE.PA",
    });
    renderForm();
    await waitForCurrencyOptions();
    await selectDiscoveryCandidate({
      providerSymbol: "TTE.PA",
      tickerSymbol: null,
      displayName: "TotalEnergies SE",
      listingCurrency: "EUR",
      exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
      matchQuality: "PROBABLE",
    });

    fireEvent.change(screen.getByTestId("instrument-exchange-mic-select"), {
      target: { value: MIC_UNLISTED_SENTINEL },
    });
    fireEvent.change(screen.getByTestId("instrument-exchange-mic-input"), {
      target: { value: "ZZZZ" },
    });
    fireEvent.change(screen.getByTestId("instrument-isin-input"), {
      target: { value: "FR0000120073" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
    const submittedBody = mockedApiClient.createInstrument.mock.calls[0]?.[0];
    expect(submittedBody?.["exchangeMic"]).toBe("ZZZZ");
    expect(submittedBody?.["exchangeMic"]).not.toBe(MIC_UNLISTED_SENTINEL);
  });

  /**
   * IR-10 (FR-7, AC-7) — the classification carry-through. Three properties, each
   * asserted on observable output rather than on the wiring: it is
   * **displayed** (read-only, no input element), it is **submitted**, and it
   * is **dropped** for a kind FR-7 excludes.
   */
  describe("classification carry-through (IR-10)", () => {
    const materialsCandidate = {
      providerSymbol: "MT.AS",
      tickerSymbol: null,
      displayName: "ArcelorMittal",
      listingCurrency: "EUR",
      exchangeHint: { code: "AMS", suggestedMic: "XAMS" },
      matchQuality: "EXACT" as const,
      sectorCode: "MATERIAUX",
      industryLabel: "Steel",
    };

    it("shows the mapped sector's French label as read-only confirmation text — never an editable input", async () => {
      renderForm();
      await waitForCurrencyOptions();
      await selectDiscoveryCandidate(materialsCandidate);

      const confirmation = screen.getByTestId("instrument-classification-confirmation");
      expect(confirmation).toHaveTextContent("Matériaux");
      expect(confirmation).toHaveTextContent("Steel");
      // The whole point of "confirmation text, never an input": no form
      // control anywhere in the rendered DOM carries the value.
      expect(confirmation.tagName).toBe("P");
      expect(confirmation.querySelector("input")).toBeNull();
      expect(confirmation.querySelector("select")).toBeNull();
      expect(screen.queryByDisplayValue("MATERIAUX")).toBeNull();
      expect(screen.queryByDisplayValue("Matériaux")).toBeNull();
      expect(screen.queryByDisplayValue("Steel")).toBeNull();
      // …and the raw provider taxonomy string is nowhere on the surface. The
      // label is read out of `PROVIDER_SECTOR_TO_CODE` at run time, never
      // spelled out: FR-2 permits that vocabulary as text only in
      // `core/reference-data/src/sector.ts` and `market/adapters`.
      const rawProviderLabel = Object.entries(PROVIDER_SECTOR_TO_CODE).find(
        ([, code]) => code === "MATERIAUX",
      )![0];
      expect(screen.queryByText(new RegExp(rawProviderLabel))).toBeNull();
    });

    it("submits the classification it displayed, and leaves isin untouched by the selection (locked D2)", async () => {
      mockedApiClient.createInstrument.mockResolvedValueOnce({
        id: "created-1",
        kind: "SHARE",
        displayName: "ArcelorMittal",
        listingCurrency: "EUR",
        isin: "LU1598757687",
        exchangeMic: "XAMS",
        symbol: "MT.AS",
      });
      renderForm();
      await waitForCurrencyOptions();
      await selectDiscoveryCandidate(materialsCandidate);
      // The candidate never fills `isin` (the provider returns none) — the
      // user types it, exactly as before this feature.
      expect(screen.getByTestId("instrument-isin-input")).toHaveValue("");
      fireEvent.change(screen.getByTestId("instrument-isin-input"), {
        target: { value: "LU1598757687" },
      });

      fireEvent.submit(screen.getByTestId("instrument-create-form"));

      await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
      const body = mockedApiClient.createInstrument.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body["sectorCode"]).toBe("MATERIAUX");
      expect(body["industryLabel"]).toBe("Steel");
      expect(body["isin"]).toBe("LU1598757687");
    });

    it("FR-7: switching the kind to ETF after a SHARE selection drops both fields from the payload rather than sending a 400-bound body", async () => {
      mockedApiClient.createInstrument.mockResolvedValueOnce({
        id: "created-1",
        kind: "ETF",
        displayName: "ArcelorMittal",
        listingCurrency: "EUR",
        isin: "LU1598757687",
        exchangeMic: "XAMS",
        symbol: "MT.AS",
      });
      renderForm();
      await waitForCurrencyOptions();
      await selectDiscoveryCandidate(materialsCandidate);
      selectKind("ETF");
      await waitForCurrencyOptions();
      fireEvent.change(screen.getByTestId("instrument-isin-input"), {
        target: { value: "LU1598757687" },
      });

      expect(screen.queryByTestId("instrument-classification-confirmation")).toBeNull();

      fireEvent.submit(screen.getByTestId("instrument-create-form"));
      await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
      const body = mockedApiClient.createInstrument.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body["sectorCode"]).toBeUndefined();
      expect(body["industryLabel"]).toBeUndefined();
    });

    it("a candidate with no classification (an unmapped or unclassified hit) shows nothing and submits nothing", async () => {
      mockedApiClient.createInstrument.mockResolvedValueOnce({
        id: "created-1",
        kind: "SHARE",
        displayName: "ArcelorMittal",
        listingCurrency: "EUR",
        isin: "LU1598757687",
        exchangeMic: "XAMS",
        symbol: "MT.AS",
      });
      renderForm();
      await waitForCurrencyOptions();
      await selectDiscoveryCandidate({
        ...materialsCandidate,
        sectorCode: null,
        industryLabel: null,
      });

      expect(screen.queryByTestId("instrument-classification-confirmation")).toBeNull();

      fireEvent.change(screen.getByTestId("instrument-isin-input"), {
        target: { value: "LU1598757687" },
      });
      fireEvent.submit(screen.getByTestId("instrument-create-form"));
      await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
      const body = mockedApiClient.createInstrument.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body["sectorCode"]).toBeUndefined();
      expect(body["industryLabel"]).toBeUndefined();
    });

    /**
     * LOW (security review): a candidate whose provider industry
     * label is longer than `industryLabelSchema`'s `.max()` — which the
     * discovery response's own declared cap does **not** enforce at runtime —
     * used to put this form into a dead end: the resolver failed, the issue was
     * routed to `errors.industryLabel`, which nothing here renders, so pressing
     * « Créer » sent no request and showed no message, and the only recovery was
     * to abandon discovery and retype every field. The label is dropped from the
     * payload instead (`market/composition`'s write site already treats this
     * exact input class the same way), and, because it is not carried, it is not
     * shown either: the confirmation text's contract is "what the submitted body
     * carries".
     */
    it("an over-long provider industry label still creates the instrument — the label is dropped, the sector is kept, and submit is never a silent no-op", async () => {
      const overLong = "z".repeat(INDUSTRY_LABEL_MAX_LENGTH + 1);
      mockedApiClient.createInstrument.mockResolvedValueOnce({
        id: "created-1",
        kind: "SHARE",
        displayName: "ArcelorMittal",
        listingCurrency: "EUR",
        isin: "LU1598757687",
        exchangeMic: "XAMS",
        symbol: "MT.AS",
      });
      renderForm();
      await waitForCurrencyOptions();
      await selectDiscoveryCandidate({ ...materialsCandidate, industryLabel: overLong });

      fireEvent.change(screen.getByTestId("instrument-isin-input"), {
        target: { value: "LU1598757687" },
      });
      fireEvent.submit(screen.getByTestId("instrument-create-form"));

      // The request is actually sent — the property the dead end broke, and
      // therefore the first thing asserted.
      await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
      const body = mockedApiClient.createInstrument.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body["sectorCode"]).toBe("MATERIAUX");
      expect(body["industryLabel"]).toBeUndefined();

      // Shown: the mapped sector. Not shown: a label that will not be stored.
      const confirmation = screen.getByTestId("instrument-classification-confirmation");
      expect(confirmation).toHaveTextContent("Matériaux");
      expect(confirmation.textContent).not.toContain(overLong);
    });
  });

  it("AC-5: leaving the discovery search field untouched still allows a fully manual submission", async () => {
    const created: apiClient.InstrumentSummary = {
      id: "created-1",
      kind: "SHARE",
      displayName: "Air Liquide",
      listingCurrency: "EUR",
      isin: "FR0000120073",
      exchangeMic: "XPAR",
      symbol: null,
    };
    mockedApiClient.createInstrument.mockResolvedValueOnce(created);
    const { onCreated } = renderForm();
    await fillValidShare();

    expect(screen.getByTestId("instrument-discovery-search-input")).toHaveValue("");
    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created, "created"));
    expect(mockedApiClient.searchInstrumentDiscovery).not.toHaveBeenCalled();
  });
});

/**
 * scpi cycle, AC-507 (FR-618). An SCPI is unlisted and priced by hand: no search box, no
 * place de cotation, an optional ISIN beside a « Code », a fixed manual quote
 * policy, the two attribute fields, and a body with no `exchangeMic` and no
 * `quotePolicy` key.
 */
describe("InstrumentCreateForm — the SCPI branch (AC-507)", () => {
  /** The body `createInstrument` was handed, as it goes on the wire (`JSON.stringify` drops `undefined`). */
  function wireBody(callIndex = 0): Record<string, unknown> {
    const body = mockedApiClient.createInstrument.mock.calls[callIndex]?.[0];
    return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  }

  const scpiA: apiClient.InstrumentSummary = {
    id: "scpi-a",
    kind: "SCPI",
    displayName: "Corum Origin",
    listingCurrency: "EUR",
    isin: "FR0000120073",
    exchangeMic: null,
    symbol: null,
  };

  async function fillScpiAWithIsin(): Promise<void> {
    selectKind("SCPI");
    fireEvent.change(screen.getByTestId("instrument-display-name-input"), {
      target: { value: "Corum Origin" },
    });
    fireEvent.change(screen.getByTestId("instrument-isin-input"), {
      target: { value: "FR0000120073" },
    });
    await waitForCurrencyOptions();
  }

  it("choosing « SCPI » shows no search box and no exchange field, an optional ISIN, a « Code », the fixed manual policy and both attribute fields", async () => {
    renderForm();
    expect(screen.getByTestId("instrument-discovery-search-input")).toBeInTheDocument();
    selectKind("SCPI");

    expect(screen.queryByTestId("instrument-discovery-search-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-exchange-mic-select")).not.toBeInTheDocument();
    expect(screen.getByLabelText("ISIN (facultatif)")).toBe(
      screen.getByTestId("instrument-isin-input"),
    );
    expect(screen.getByLabelText("Code")).toBe(screen.getByTestId("instrument-symbol-input"));
    expect(screen.getByText("Obligatoire si l'ISIN est vide")).toBeInTheDocument();
    expect(screen.getByTestId("instrument-scpi-quote-policy")).toHaveTextContent("Saisie manuelle");
    expect(screen.getByLabelText("Société de gestion")).toBe(
      screen.getByTestId("instrument-management-company-input"),
    );
    // NFR-76: a text input carrying a decimal string, never `type="number"`.
    const fee = screen.getByLabelText("Frais de souscription (%)");
    expect(fee).toBe(screen.getByTestId("instrument-subscription-fee-input"));
    expect(fee).toHaveAttribute("type", "text");
  });

  it("the listing currency defaults to EUR when empty, and a currency already chosen survives the switch (SC-L12)", async () => {
    renderForm();
    await waitForCurrencyOptions();
    selectKind("SCPI");
    await waitFor(() =>
      expect(screen.getByTestId("instrument-listing-currency-select")).toHaveValue("EUR"),
    );
    cleanup();

    renderForm();
    await waitForCurrencyOptions();
    fireEvent.change(screen.getByTestId("instrument-listing-currency-select"), {
      target: { value: "USD" },
    });
    selectKind("SCPI");
    expect(screen.getByTestId("instrument-listing-currency-select")).toHaveValue("USD");
  });

  it("submitting with only name, currency and code posts one body with kind SCPI, the code, and no exchangeMic or quotePolicy key", async () => {
    mockedApiClient.createInstrument.mockResolvedValueOnce({
      ...scpiA,
      isin: null,
      symbol: "CORUMO",
    });
    renderForm();
    await waitForCurrencyOptions();
    selectKind("SCPI");
    fireEvent.change(screen.getByTestId("instrument-display-name-input"), {
      target: { value: "Corum Origin" },
    });
    fireEvent.change(screen.getByTestId("instrument-symbol-input"), {
      target: { value: "CORUMO" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
    expect(wireBody()).toEqual({
      kind: "SCPI",
      displayName: "Corum Origin",
      listingCurrency: "EUR",
      symbol: "CORUMO",
    });
    expect(wireBody()).not.toHaveProperty("exchangeMic");
    expect(wireBody()).not.toHaveProperty("quotePolicy");
  });

  it("the two attributes are sent trimmed when given, the fee as the typed decimal string", async () => {
    mockedApiClient.createInstrument.mockResolvedValueOnce(scpiA);
    renderForm();
    await fillScpiAWithIsin();
    fireEvent.change(screen.getByTestId("instrument-management-company-input"), {
      target: { value: "  Corum Asset Management " },
    });
    fireEvent.change(screen.getByTestId("instrument-subscription-fee-input"), {
      target: { value: "12.00" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(mockedApiClient.createInstrument).toHaveBeenCalledTimes(1));
    expect(wireBody()).toEqual({
      kind: "SCPI",
      displayName: "Corum Origin",
      listingCurrency: "EUR",
      isin: "FR0000120073",
      managementCompany: "Corum Asset Management",
      subscriptionFeePct: "12.00",
    });
  });

  it("neither ISIN nor code shows the error on the code field and posts nothing", async () => {
    renderForm();
    await waitForCurrencyOptions();
    selectKind("SCPI");
    fireEvent.change(screen.getByTestId("instrument-display-name-input"), {
      target: { value: "Corum Origin" },
    });

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(fieldErrorText("instrument-symbol-input")).not.toBeNull());
    expect(fieldErrorText("instrument-isin-input")).toBeNull();
    expect(mockedApiClient.createInstrument).not.toHaveBeenCalled();
  });

  it("choosing SHARE afterwards restores the listed form: search box and exchange field back, attribute fields gone", () => {
    renderForm();
    selectKind("SCPI");
    selectKind("SHARE");

    expect(screen.getByTestId("instrument-discovery-search-input")).toBeInTheDocument();
    expect(screen.getByTestId("instrument-exchange-mic-select")).toBeInTheDocument();
    expect(screen.getByLabelText("ISIN")).toBe(screen.getByTestId("instrument-isin-input"));
    expect(screen.queryByTestId("instrument-management-company-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-subscription-fee-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-scpi-quote-policy")).not.toBeInTheDocument();
  });

  it("a 409 on a MIC-less SCPI duplicate resolves to the existing SCPI, not the « could not be located » notice", async () => {
    mockedApiClient.createInstrument.mockRejectedValueOnce(
      new ApiError(409, { code: "INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC" }),
    );
    mockedApiClient.searchInstruments.mockResolvedValueOnce([scpiA]);
    const { onCreated } = renderForm();
    await fillScpiAWithIsin();

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() =>
      expect(screen.getByTestId("instrument-duplicate-notice")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("instrument-duplicate-unresolved-notice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("instrument-duplicate-use-existing"));
    expect(onCreated).toHaveBeenCalledWith(scpiA, "existing");
  });

  it("a cross-kind 409 (an SCPI typed with a listed SHARE's ISIN) still shows the « could not be located » notice", async () => {
    mockedApiClient.createInstrument.mockRejectedValueOnce(
      new ApiError(409, { code: "INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC" }),
    );
    mockedApiClient.searchInstruments.mockResolvedValueOnce([
      { ...scpiA, id: "share-1", kind: "SHARE", displayName: "Air Liquide", exchangeMic: "XPAR" },
    ]);
    renderForm();
    await fillScpiAWithIsin();

    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() =>
      expect(screen.getByTestId("instrument-duplicate-unresolved-notice")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("instrument-duplicate-notice")).not.toBeInTheDocument();
  });
});

/**
 * `scpi` cycle, independent tester pass — what the per-task tests above do not
 * cross: values left in form state by a kind the user switched away from, and
 * the second entry point to the form, `InstrumentCreateDialog` (opened from the
 * instruments list, the transaction picker and the watchlist).
 */
describe("InstrumentCreateForm — leftover values across a kind switch (SCPI)", () => {
  function leftovers(kind: string): InstrumentFormValues {
    return {
      ...defaultInstrumentFormValues(),
      kind: kind as InstrumentFormValues["kind"],
      displayName: "Corum Origin",
      listingCurrency: "EUR",
      isin: "FR0000120073",
      symbol: "CORUMO",
      exchangeMic: "XPAR",
      sectorCode: "FINANCE",
      industryLabel: "Immobilier",
      managementCompany: "Corum Asset Management",
      subscriptionFeePct: "8.50",
    };
  }

  it("an SCPI body carries no exchangeMic, sector or industry left over from a listed kind", () => {
    const body = buildInstrumentRequestPayload(leftovers("SCPI"));
    for (const key of ["exchangeMic", "sectorCode", "industryLabel", "quotePolicy"]) {
      expect(body, key).not.toHaveProperty(key);
    }
    expect(body).toMatchObject({
      kind: "SCPI",
      isin: "FR0000120073",
      symbol: "CORUMO",
      managementCompany: "Corum Asset Management",
      subscriptionFeePct: "8.50",
    });
    expect(createInstrumentBodySchema.safeParse(JSON.parse(JSON.stringify(body))).success).toBe(
      true,
    );
  });

  it("no other kind's body carries an SCPI attribute left over from the SCPI branch", () => {
    for (const kind of ["SHARE", "ETF", "FUND", "CRYPTO", "INDEX"]) {
      const body = buildInstrumentRequestPayload(leftovers(kind));
      expect(body, kind).not.toHaveProperty("managementCompany");
      expect(body, kind).not.toHaveProperty("subscriptionFeePct");
      expect(
        createInstrumentBodySchema.safeParse(JSON.parse(JSON.stringify(body))).success,
        kind,
      ).toBe(true);
    }
  });
});

describe("InstrumentCreateDialog — an SCPI created from the dialog (every caller)", () => {
  function renderDialog() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    render(
      (
        <QueryClientProvider client={queryClient}>
          <InstrumentCreateDialog open onOpenChange={onOpenChange} onCreated={onCreated} />
        </QueryClientProvider>
      ) as ReactElement,
    );
    return { onCreated, onOpenChange };
  }

  const created = (kind: "SCPI" | "SHARE"): apiClient.InstrumentSummary => ({
    id: `${kind}-1`,
    kind,
    displayName: "Corum Origin",
    listingCurrency: "EUR",
    isin: null,
    exchangeMic: kind === "SHARE" ? "XPAR" : null,
    symbol: "CORUMO",
  });

  it("an SCPI create reports `created` to the caller and closes the dialog, with no history-fetch success panel", async () => {
    mockedApiClient.createInstrument.mockResolvedValueOnce(created("SCPI"));
    const { onCreated, onOpenChange } = renderDialog();
    await waitForCurrencyOptions();
    selectKind("SCPI");
    fireEvent.change(screen.getByTestId("instrument-display-name-input"), {
      target: { value: "Corum Origin" },
    });
    fireEvent.change(screen.getByTestId("instrument-symbol-input"), {
      target: { value: "CORUMO" },
    });
    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created("SCPI"), "created"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("instrument-create-success")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-history-status")).not.toBeInTheDocument();
  });

  it("the control: a SHARE create through the same dialog shows the success panel and stays open", async () => {
    mockedApiClient.createInstrument.mockResolvedValueOnce(created("SHARE"));
    const { onCreated, onOpenChange } = renderDialog();
    await fillValidShare();
    fireEvent.submit(screen.getByTestId("instrument-create-form"));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created("SHARE"), "created"));
    expect(await screen.findByTestId("instrument-create-success")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
