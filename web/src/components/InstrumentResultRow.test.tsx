import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { InstrumentSummary } from "../lib/api-client.js";
import { InstrumentPicker } from "./InstrumentPicker.js";
import { InstrumentResultRow } from "./InstrumentResultRow.js";

/**
 * The instrument row (FR-660..FR-662, AC-551, AC-552): one component for the
 * search results of every `AssetSearchPopover` consumer and for the picker's
 * selected state.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, searchInstruments: vi.fn() };
});

const mocked = vi.mocked(apiClient);

const APPLE_ID = "11111111-1111-4111-8111-111111111111";
const BTC_ID = "22222222-2222-4222-8222-222222222222";

const APPLE: InstrumentSummary = {
  id: APPLE_ID,
  kind: "SHARE",
  displayName: "Apple Inc",
  listingCurrency: "USD",
  isin: "US0378331005",
  exchangeMic: "XNAS",
  symbol: "AAPL",
  hasIcon: true,
};

const BITCOIN: InstrumentSummary = {
  id: BTC_ID,
  kind: "CRYPTO",
  displayName: "Bitcoin",
  listingCurrency: "EUR",
  isin: null,
  exchangeMic: null,
  symbol: "BTC",
};

/** `<img>`s pointing at the icon route — the element that would issue the request. */
function iconRequests(container: HTMLElement): HTMLImageElement[] {
  return [...container.querySelectorAll("img")].filter((img) =>
    img.getAttribute("src")?.endsWith("/icon"),
  );
}

afterEach(cleanup);

describe("InstrumentResultRow", () => {
  it("shows the uploaded logo, name, symbol · ISIN · exchange name, and the class chip", () => {
    const { container } = render(<InstrumentResultRow instrument={APPLE} />);
    const images = iconRequests(container);
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute("src")).toMatch(new RegExp(`/instruments/${APPLE_ID}/icon$`));
    expect(screen.getByText("Apple Inc")).toBeInTheDocument();
    expect(screen.getByTestId("instrument-result-meta").textContent).toBe(
      "AAPL · US0378331005 · NASDAQ",
    );
    expect(screen.getByText("Action")).toBeInTheDocument();
  });

  it("without an icon renders the monogram and makes no icon request", () => {
    const { container } = render(<InstrumentResultRow instrument={{ ...APPLE, hasIcon: false }} />);
    expect(iconRequests(container)).toHaveLength(0);
    expect(container.querySelector(".k-monogram-tile")?.textContent).toBe("App");
  });

  it("leaves no blank text or dangling separator when ISIN and exchange are null", () => {
    const { container, rerender } = render(<InstrumentResultRow instrument={BITCOIN} />);
    expect(iconRequests(container)).toHaveLength(0);
    expect(screen.getByTestId("instrument-result-meta").textContent).toBe("BTC");

    rerender(<InstrumentResultRow instrument={{ ...BITCOIN, symbol: null }} />);
    expect(screen.queryByTestId("instrument-result-meta")).not.toBeInTheDocument();

    rerender(
      <InstrumentResultRow
        instrument={{ ...APPLE, symbol: null, isin: "FR0000120073", exchangeMic: "XXXX" }}
      />,
    );
    // An uncurated MIC prints as the raw code rather than vanishing.
    expect(screen.getByTestId("instrument-result-meta").textContent).toBe("FR0000120073 · XXXX");
  });

  it("keeps the option's accessible name starting with the display name", () => {
    render(
      <ul role="listbox">
        <li role="option" aria-selected={false}>
          <InstrumentResultRow instrument={APPLE} />
        </li>
      </ul>,
    );
    expect(screen.getByRole("option", { name: /^Apple Inc/ })).toBeInTheDocument();
  });
});

function PickerHarness({
  onChange,
}: {
  onChange: (id: string, label: string, symbol: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <InstrumentPicker
      label="Instrument"
      value={value}
      error={undefined}
      testId="instrument-picker"
      onChange={(id, label, symbol) => {
        setValue(id);
        onChange(id, label, symbol);
      }}
    />
  );
}

describe("InstrumentPicker — results and the selected state", () => {
  beforeEach(() => {
    mocked.searchInstruments.mockResolvedValue([APPLE, BITCOIN]);
  });

  function renderPicker() {
    const onChange = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PickerHarness onChange={onChange} />
      </QueryClientProvider>,
    );
    return onChange;
  }

  async function search(text: string) {
    const input = screen.getByTestId("instrument-picker-search");
    fireEvent.change(input, { target: { value: text } });
    await screen.findAllByTestId("instrument-picker-option", undefined, { timeout: 3000 });
    return input;
  }

  it("renders each result as the row, and the pick as the same row plus « Changer »", async () => {
    const onChange = renderPicker();
    await search("a");
    const [apple] = screen.getAllByTestId("instrument-picker-option");
    expect(within(apple!).getByTestId("instrument-result-meta").textContent).toBe(
      "AAPL · US0378331005 · NASDAQ",
    );

    fireEvent.click(apple!);
    expect(onChange).toHaveBeenCalledWith(APPLE_ID, "Apple Inc (AAPL)", "AAPL");
    const selected = screen.getByTestId("instrument-picker-selected");
    expect(selected).toHaveTextContent("Apple Inc");
    expect(within(selected).getByTestId("instrument-result-meta").textContent).toBe(
      "AAPL · US0378331005 · NASDAQ",
    );
    expect(within(selected).getByText("Action")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("instrument-picker-change"));
    expect(onChange).toHaveBeenLastCalledWith("", "", "");
    expect(screen.getByTestId("instrument-picker-search")).toBeInTheDocument();
    expect(screen.queryByTestId("instrument-picker-selected")).not.toBeInTheDocument();
  });

  it("keeps arrows and Enter selecting the focused row", async () => {
    const onChange = renderPicker();
    const input = await search("b");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(BTC_ID, "Bitcoin (BTC)", "BTC");
    expect(screen.getByTestId("instrument-picker-selected")).toHaveTextContent("Bitcoin");
  });
});
