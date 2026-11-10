import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sniffInstrumentIcon } from "@kerdial/api-contracts";
import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { InstrumentDetailResponse } from "../lib/api-client.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { MESSAGE_TABLE } from "../lib/problem-messages.js";
import { preflightIconBytes } from "../lib/icon-pick.js";
import { InstrumentIconForm } from "./InstrumentIconForm.js";

/**
 * `InstrumentIconForm.test.tsx` — IK-13 (FR-291, FR-292–FR-294's client pre-flight,
 * FR-303, FR-315).
 *
 * Lane: `pnpm test` (`test:main`), jsdom (`vitest.config.ts`'s
 * `web/src/**\/*.test.tsx` include and `environmentMatchGlobs`). No
 * `test:main` `--exclude` pattern matches this basename.
 *
 * ## What jsdom proves here, and what it does not
 *
 * Everything below drives the real `<input type="file">` with a real `File`
 * and a `change` event, so every pre-flight branch, the facts panel, the
 * confirm step and both mutations are genuinely exercised.
 *
 * It does **not** prove that clicking the input opens an OS file dialog, that
 * the dialog honours `accept`, or that a focus trap inside `Dialog` leaves the
 * confirm button mounted between `mousedown` and `mouseup` — jsdom has no
 * picker, no OS and no layout, and this repo has a recorded case of a focus
 * trap unmounting a row between those two events with every jsdom test green.
 * The dialog-with-a-file-input interaction therefore belongs to GATE-3's
 * browser lane; what is settled here is the logic the browser would drive.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, setInstrumentIcon: vi.fn(), deleteInstrumentIcon: vi.fn() };
});

const mockedApiClient = vi.mocked(apiClient);

const INSTRUMENT_ID = "11111111-1111-1111-1111-111111111111";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A byte-valid PNG header: the 8-byte signature, the IHDR chunk length and
 * tag, and the two 32-bit big-endian dimension fields — exactly what
 * `sniffInstrumentIcon` reads. Not a decodable image, which is
 * the point: the server never decodes either (SD-4).
 */
function pngBytes(widthPx: number, heightPx: number, extraBytes = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + extraBytes);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, widthPx);
  view.setUint32(20, heightPx);
  return bytes;
}

/** `GIF89a…` — an accepted-looking image whose leading bytes are neither PNG nor JPEG. */
function gifBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  return bytes;
}

function instrumentDetail(
  overrides: Partial<InstrumentDetailResponse> = {},
): InstrumentDetailResponse {
  return {
    id: INSTRUMENT_ID,
    kind: "SHARE",
    displayName: "Air Liquide SA",
    listingCurrency: "EUR",
    exchangeMic: "XPAR",
    isin: "FR0000120073",
    symbol: "AI",
    figi: null,
    primaryIdentifier: "ISIN",
    quotePolicy: "AUTO",
    status: "ACTIVE",
    sectorCode: null,
    industryLabel: null,
    domicileCountry: null,
    listingCountry: null,
    hasIcon: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface Handlers {
  readonly onSaved: () => void;
  readonly onRemoved: () => void;
  readonly onCancel: () => void;
}

function renderForm(detail: InstrumentDetailResponse, handlers: Partial<Handlers> = {}) {
  const onSaved = handlers.onSaved ?? vi.fn();
  const onRemoved = handlers.onRemoved ?? vi.fn();
  const onCancel = handlers.onCancel ?? vi.fn();
  const result = render(
    (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InstrumentIconForm
          instrument={detail}
          onSaved={onSaved}
          onRemoved={onRemoved}
          onCancel={onCancel}
        />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { ...result, onSaved, onRemoved, onCancel };
}

/** Picks `file` through the real input, the way a browser would. */
async function pick(file: File): Promise<void> {
  const input = screen.getByTestId("instrument-icon-file-input");
  fireEvent.change(input, { target: { files: [file] } });
  // The handler awaits `file.arrayBuffer()`, so the facts/rejection line
  // appears a microtask later.
  await waitFor(() => {
    expect(
      screen.queryByTestId("instrument-icon-facts") ??
        screen.queryByTestId("instrument-icon-rejected"),
    ).not.toBeNull();
  });
}

/**
 * `Uint8Array<ArrayBuffer>`, not the bare `Uint8Array`: the DOM's `BlobPart`
 * only admits a view over a real `ArrayBuffer`, and `Uint8Array`'s default
 * `ArrayBufferLike` includes `SharedArrayBuffer`. Narrowing here rather than
 * casting at the call site keeps the fixture builders honest.
 */
function fileOf(bytes: Uint8Array<ArrayBuffer>, name: string, type = "image/png"): File {
  return new File([bytes], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<InstrumentIconForm> — the pre-flight", () => {
  it("states the three ceilings, interpolated from the constants", () => {
    renderForm(instrumentDetail());
    const line = screen.getByTestId("instrument-icon-constraints").textContent!;
    expect(line).toBe(INSTRUMENT_COPY.iconConstraints);
    expect(line).toContain(String(INSTRUMENT_ICON_MAX_BYTES / 1024));
    expect(line).toContain(String(INSTRUMENT_ICON_MAX_PIXELS));
  });

  it("accepts a 128x128 PNG and reports its facts — no preview, and no blob:/data: anywhere", async () => {
    const { container } = renderForm(instrumentDetail());
    expect(screen.getByTestId("instrument-icon-submit")).toBeDisabled();

    await pick(fileOf(pngBytes(128, 128), "logo-air-liquide.png"));

    const facts = screen.getByTestId("instrument-icon-facts").textContent!;
    expect(facts).toContain("logo-air-liquide.png");
    expect(facts).toContain("PNG");
    expect(facts).toContain("128 × 128 px");
    expect(facts).toContain("Ko");
    expect(facts).toContain(INSTRUMENT_COPY.iconReady);
    expect(screen.getByTestId("instrument-icon-submit")).toBeEnabled();

    // FR-303/V6: `img-src 'self'` admits neither, so a picked-file thumbnail
    // could not render even if it were built. The absence half…
    for (const element of Array.from(container.querySelectorAll("[src]"))) {
      const src = element.getAttribute("src")!;
      expect(src.startsWith("data:")).toBe(false);
      expect(src.startsWith("blob:")).toBe(false);
    }
    // …and its positive companion, so "no element has a bad src" cannot pass
    // by there being no facts panel at all: the panel is what stands in for
    // the preview, and it is present and populated above.
    expect(facts.length).toBeGreaterThan("logo-air-liquide.png".length);
  });

  it("refuses an oversized file WITHOUT reading it", async () => {
    renderForm(instrumentDetail());
    const oversized = fileOf(pngBytes(64, 64), "huge.png");
    // The real `size` is small; overriding it is what lets this assert the
    // *order* of the two checks rather than allocating 256 KiB of fixture.
    Object.defineProperty(oversized, "size", { value: INSTRUMENT_ICON_MAX_BYTES + 1 });
    const arrayBuffer = vi.fn(() => {
      throw new Error("the ceiling must be checked before the bytes are read");
    });
    Object.defineProperty(oversized, "arrayBuffer", { value: arrayBuffer });

    fireEvent.change(screen.getByTestId("instrument-icon-file-input"), {
      target: { files: [oversized] },
    });

    await waitFor(() => {
      expect(screen.getByTestId("instrument-icon-rejected")).toBeInTheDocument();
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(screen.getByTestId("instrument-icon-rejected").textContent).toContain(
      MESSAGE_TABLE["INSTRUMENT_ICON_TOO_LARGE"]!.text,
    );
    expect(screen.queryByTestId("instrument-icon-facts")).toBeNull();
    expect(screen.getByTestId("instrument-icon-submit")).toBeDisabled();
  });

  it("refuses an over-512px image, an unsupported signature and an unreadable header, each with its own sentence", async () => {
    const cases = [
      {
        file: fileOf(pngBytes(INSTRUMENT_ICON_MAX_PIXELS + 1, 512), "big.png"),
        code: "INSTRUMENT_ICON_DIMENSIONS_EXCEEDED",
      },
      {
        file: fileOf(gifBytes(), "logo.png", "image/png"),
        code: "INSTRUMENT_ICON_UNSUPPORTED_FORMAT",
      },
      {
        // A PNG signature with the IHDR cut off mid-header.
        file: fileOf(pngBytes(128, 128).subarray(0, 20), "truncated.png"),
        code: "INSTRUMENT_ICON_UNREADABLE",
      },
    ] as const;

    for (const { file, code } of cases) {
      const view = renderForm(instrumentDetail());
      await pick(file);
      expect(
        screen.getByTestId("instrument-icon-rejected").textContent,
        `${file.name} did not get ${code}'s sentence`,
      ).toContain(MESSAGE_TABLE[code]!.text);
      expect(screen.getByTestId("instrument-icon-submit")).toBeDisabled();
      view.unmount();
    }

    // Paired positive companion for the whole group: the boundary value is
    // *accepted*, so a pre-flight that rejected everything would not pass.
    renderForm(instrumentDetail());
    await pick(
      fileOf(
        pngBytes(INSTRUMENT_ICON_MAX_PIXELS, INSTRUMENT_ICON_MAX_PIXELS),
        "exactly-at-the-ceiling.png",
      ),
    );
    expect(screen.getByTestId("instrument-icon-facts").textContent).toContain("512 × 512 px");
    expect(screen.getByTestId("instrument-icon-submit")).toBeEnabled();
  });

  it("gives the same verdict the server's own reader gives for the same bytes", () => {
    // The client's pre-flight is not a second implementation: it calls
    // `sniffInstrumentIcon`, the exact function `api`'s validate module runs.
    // This pins the two together on the same fixtures.
    for (const bytes of [pngBytes(128, 128), pngBytes(600, 10), gifBytes()]) {
      const sniff = sniffInstrumentIcon(bytes);
      const preflight = preflightIconBytes("f.png", bytes);
      if (!sniff.ok) {
        expect(preflight.kind).toBe("rejected");
        continue;
      }
      const overCeiling =
        sniff.widthPx > INSTRUMENT_ICON_MAX_PIXELS || sniff.heightPx > INSTRUMENT_ICON_MAX_PIXELS;
      expect(preflight.kind).toBe(overCeiling ? "rejected" : "ready");
      if (preflight.kind === "ready") {
        expect(preflight.widthPx).toBe(sniff.widthPx);
        expect(preflight.heightPx).toBe(sniff.heightPx);
        expect(preflight.contentType).toBe(sniff.contentType);
      }
    }
  });
});

describe("<InstrumentIconForm> — submitting", () => {
  it("sends the sniffed type and the exact bytes, and no filename", async () => {
    mockedApiClient.setInstrumentIcon.mockResolvedValue({
      instrumentId: INSTRUMENT_ID,
      contentType: "image/png",
      byteLength: 24,
      widthPx: 128,
      heightPx: 128,
      source: "MANUAL",
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
    const { onSaved } = renderForm(instrumentDetail());

    const bytes = pngBytes(128, 128, 8);
    // `type` is the browser's guess from the extension — the value FR-292
    // refuses to trust. Deliberately wrong here.
    await pick(fileOf(bytes, "mon-icône.png", "image/jpeg"));
    fireEvent.click(screen.getByTestId("instrument-icon-submit"));

    await waitFor(() => expect(mockedApiClient.setInstrumentIcon).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.setInstrumentIcon.mock.calls[0]!;
    expect(payload.instrumentId).toBe(INSTRUMENT_ID);
    // The **sniffed** type, not the file's own `image/jpeg` label.
    expect(payload.declaredContentType).toBe("image/png");
    // Standard base64, and it round-trips to the picked bytes byte for byte.
    expect(payload.bytesBase64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    const decoded = Uint8Array.from(atob(payload.bytesBase64), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
    // FR-304/NFR-4(b): no client-supplied filename reaches the server.
    expect(JSON.stringify(payload)).not.toContain("mon-icône");
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("surfaces the server's own coded rejection through problem-messages", async () => {
    mockedApiClient.setInstrumentIcon.mockRejectedValue(
      new apiClient.ApiError(429, { code: "INSTRUMENT_ICON_TENANT_CAP_EXCEEDED" }),
    );
    const { onSaved } = renderForm(instrumentDetail());
    await pick(fileOf(pngBytes(64, 64), "logo.png"));
    fireEvent.click(screen.getByTestId("instrument-icon-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("instrument-icon-error").textContent).toBe(
        MESSAGE_TABLE["INSTRUMENT_ICON_TENANT_CAP_EXCEEDED"]!.text,
      );
    });
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("<InstrumentIconForm> — removing", () => {
  it("offers removal only when there is an icon, behind a confirm step", async () => {
    mockedApiClient.deleteInstrumentIcon.mockResolvedValue(undefined);

    // The negative half first: nothing to remove, no control, and the
    // « aucune icône » line instead.
    const none = renderForm(instrumentDetail({ hasIcon: false }));
    expect(screen.queryByTestId("instrument-icon-remove")).toBeNull();
    expect(screen.getByTestId("instrument-icon-none").textContent).toBe(INSTRUMENT_COPY.iconNone);
    none.unmount();

    const { onRemoved } = renderForm(instrumentDetail({ hasIcon: true }));
    // One click does not delete: the confirm step stands between them.
    fireEvent.click(screen.getByTestId("instrument-icon-remove"));
    expect(mockedApiClient.deleteInstrumentIcon).not.toHaveBeenCalled();
    expect(screen.getByTestId("instrument-icon-remove-confirm").textContent).toBe(
      INSTRUMENT_COPY.iconRemoveConfirm,
    );

    // …and it can be backed out of.
    fireEvent.click(screen.getByTestId("instrument-icon-remove-cancel"));
    expect(screen.queryByTestId("instrument-icon-remove-confirm")).toBeNull();
    expect(mockedApiClient.deleteInstrumentIcon).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("instrument-icon-remove"));
    fireEvent.click(screen.getByTestId("instrument-icon-remove-confirmed"));
    await waitFor(() => expect(mockedApiClient.deleteInstrumentIcon).toHaveBeenCalledTimes(1));
    // First argument only: TanStack Query passes the mutation context as a
    // second one, which a `toHaveBeenCalledWith(id)` would fail on for the
    // wrong reason.
    expect(mockedApiClient.deleteInstrumentIcon.mock.calls[0]![0]).toBe(INSTRUMENT_ID);
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
  });

  it("labels the submit « Remplacer l'icône » when one is already set", () => {
    const replacing = renderForm(instrumentDetail({ hasIcon: true }));
    expect(screen.getByTestId("instrument-icon-submit").textContent).toBe(
      INSTRUMENT_COPY.iconReplace,
    );
    replacing.unmount();

    renderForm(instrumentDetail({ hasIcon: false }));
    expect(screen.getByTestId("instrument-icon-submit").textContent).toBe(INSTRUMENT_COPY.iconAdd);
  });
});

describe("LD-5/NG2/NG3/NG4 — management lives on the detail screen and nowhere else", () => {
  /** Every `.ts`/`.tsx` under `web/src`, tests excluded. */
  function sources(): { file: string; text: string }[] {
    const out: { file: string; text: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
          out.push({
            file: full.slice(join(here, "..").length + 1),
            text: readFileSync(full, "utf8"),
          });
        }
      }
    };
    walk(join(here, ".."));
    return out;
  }

  it("is imported by exactly one call site — the instrument detail view", () => {
    const importers = sources()
      .filter(({ text }) => /from "[^"]*InstrumentIconForm\.js"/.test(text))
      .map(({ file }) => file);
    expect(importers).toEqual(["routes/InstrumentDetailView.tsx"]);
  });

  it("is reachable from none of the four surfaces NG2/NG3/NG4 name", () => {
    // Named files rather than a walk, for `controls-copy-audit.test.ts`'s own
    // reason: a wrong path throws on `readFileSync` instead of silently
    // scanning nothing. Both the form and the tile are checked — an icon
    // *control* on a picker would need one of them.
    for (const file of [
      "components/InstrumentCreateForm.tsx",
      "components/InstrumentCreateDialog.tsx",
      "components/AssetSearchPopover.tsx",
      "components/InstrumentDiscoverySearch.tsx",
    ]) {
      const text = readFileSync(join(here, "..", file), "utf8");
      expect(text, `${file} reaches for the icon form`).not.toContain("InstrumentIconForm");
      expect(text, `${file} reaches for the icon tile`).not.toContain("InstrumentIconTile");
    }
  });

  it("constructs no blob: or data: URL, in source or in the DOM", async () => {
    const source = readFileSync(join(here, "InstrumentIconForm.tsx"), "utf8");
    // Comments are stripped first: this component's own header *explains* why
    // `URL.createObjectURL` cannot be used, and prose must not defeat the
    // check that it is not used (`figure-format-sole-importer.test.ts`'s own
    // discrimination requirement, in miniature).
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("createObjectURL");
    expect(code).not.toContain("blob:");
    expect(code).not.toContain("data:");

    const { container } = renderForm(instrumentDetail());
    await pick(fileOf(pngBytes(64, 64), "logo.png"));
    const srcs = Array.from(container.querySelectorAll("[src]")).map((element) =>
      element.getAttribute("src"),
    );
    expect(srcs.filter((src) => src?.startsWith("blob:") || src?.startsWith("data:"))).toEqual([]);
  });
});
