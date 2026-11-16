import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { AssetSearchPopover } from "./AssetSearchPopover.js";
import { Dialog } from "./ui/index.js";

/**
 * The Escape rule `useEscapeClosesPopover` carries, pinned on its first
 * consumer now that the hook is shared with the country picker (FD-4): inside
 * a Radix dialog, Escape closes the popover and the dialog stays open.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, searchInstruments: vi.fn().mockResolvedValue([]) };
});

it("Escape closes the popover and not the dialog around it", () => {
  const onClose = vi.fn();
  render(
    (
      <QueryClientProvider client={new QueryClient()}>
        <Dialog open onClose={onClose} title="Ajouter une opération">
          <AssetSearchPopover
            label="Instrument"
            testId="asset"
            onSelect={vi.fn()}
            onCreate={vi.fn()}
          />
        </Dialog>
      </QueryClientProvider>
    ) as ReactElement,
  );
  const input = screen.getByTestId("asset-search");
  fireEvent.change(input, { target: { value: "app" } });
  expect(screen.getByTestId("asset-popover")).toBeInTheDocument();

  fireEvent.keyDown(input, { key: "Escape" });

  expect(screen.queryByTestId("asset-popover")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
