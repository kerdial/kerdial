import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMPORT_EDITED_ROW_NOTICE,
  IMPORT_FILE_TYPES,
  type ImportSummaryResponse,
} from "@kerdial/api-contracts";
// The sentinel and the curated list are imported, never
// mirrored by value: this suite's whole claim is that the form applies the
// *shared* rule, and a re-typed "__AUTRE__" or a hand-picked MIC that quietly
// joins the curated list later would test the wrong path.
import { CURATED_EXCHANGE_MICS, MIC_UNLISTED_SENTINEL } from "@kerdial/core-reference-data";
import {
  formatImportRowSource,
  needsDestination,
  nextGuidedFileType,
  sharedCatalogueImpactNotice,
} from "../lib/import-copy.js";
import {
  invalidateCatalogueSurfaces,
  invalidatePortfolioDerivedFigures,
} from "../lib/invalidate-derived.js";
import { portfoliosQueryOptions } from "../lib/queries.js";
import { ImportWizard, type ImportSearchState } from "./ImportWizard.js";

/**
 * `/import`'s five-step wizard
 * (CI-22), driven through the **real** client stack: `fetch` itself is the seam,
 * not `api-client.js`.
 *
 * That choice is the point of several assertions below. The criterion "the
 * confirm's `resolutions[]` reflects the **edited** value, not the original
 * proposal" is about what leaves the browser, so the test reads the actual
 * `FormData` the wizard handed to `fetch` — a mock of `importInstrumentsFile`
 * would have proven only that the wizard passed an object to a function, and
 * would have been equally green if the multipart body had dropped the field
 * entirely.
 *
 * The counts used throughout have the shape a real asset file produces: some
 * rows are **rejected, not imported** — they never get a discovery lookup
 * because the file needs more than one request's budget. Using the honest numbers here is what
 * makes the "tell the user to re-run" assertion mean something.
 */

/**
 * The `@tanstack/react-virtual` jsdom workaround `ControlsTable.test.tsx`/
 * `InstrumentTable.test.tsx`/`HoldingsTable.test.tsx` already use: the real
 * `useVirtualizer` measures its scroll container, jsdom reports every element
 * as zero-sized, and the honest consequence is that **no row renders at all**.
 * Mocking it here is what lets the proposal-editor assertions below address a
 * row by index; the virtualisation itself is exercised in a real engine by
 * this feature's Playwright specs.
 */
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 48,
        size: 48,
        key: index,
      })),
    getTotalSize: () => count * 48,
    measureElement: () => undefined,
  }),
}));

const PORTFOLIO_ID = "11111111-1111-4111-8111-111111111111";
const CASH_ACCOUNT_ID = "cacacaca-0001-4000-8000-000000000001";

function summary(overrides: Partial<ImportSummaryResponse> = {}): ImportSummaryResponse {
  return {
    mode: "DRY_RUN",
    fileType: "ASSETS",
    rowCount: 54,
    imported: 51,
    skipped: 0,
    rejected: 3,
    byReason: { EXCHANGE_MIC_LOOKUP_UNAVAILABLE: 3 },
    rows: [
      {
        line: 52,
        index: 50,
        outcome: "REJECT",
        reason: "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
        message: "no lookup was available within this request's budget",
        source: {
          shape: "INSTRUMENT",
          tradeDate: null,
          direction: null,
          instrument: "RHM.F",
          amount: null,
          currency: "EUR",
          quantity: null,
        },
      },
    ],
    rowsTruncated: false,
    applyFailed: 0,
    applyNotAttempted: 0,
    discoveryCallsIssued: 16,
    ...overrides,
  };
}

/**
 * Row 0 is an evidence-backed kind, row 1 is the live case: `GOLD.PA`, whose
 * source row carries no TER, so rule K defaulted it to `SHARE` while its own
 * name says « ETC ». The pair is what lets the tests below assert that the two
 * are *distinguished*, not merely both rendered.
 */
const PROPOSALS = [
  {
    index: 0,
    action: "CREATE" as const,
    kind: "ETF" as const,
    kindSource: "EXPENSE_RATIO" as const,
    nameSuggestsFund: false,
    label: "ESE.PA",
    exchangeMic: "XPAR",
    micSource: "SUFFIX_TABLE" as const,
    matchQuality: null,
  },
  {
    index: 1,
    action: "CREATE" as const,
    kind: "SHARE" as const,
    kindSource: "DEFAULT" as const,
    nameSuggestsFund: true,
    label: "GOLD.PA",
    exchangeMic: "XPAR",
    micSource: "DISCOVERY" as const,
    matchQuality: "PROBABLE" as const,
  },
];

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

let calls: RecordedCall[];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Every response the wizard's own reads need, keyed off the path — nothing else is served. */
function routeFetch(handlers: Readonly<Record<string, () => Response>>) {
  return vi.fn((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    for (const [fragment, respond] of Object.entries(handlers)) {
      if (String(url).includes(fragment)) return Promise.resolve(respond());
    }
    throw new Error(`unmocked request: ${String(url)}`);
  });
}

function importCalls(): RecordedCall[] {
  return calls.filter((call) => call.url.includes("/imports/"));
}

function bodyOf(call: RecordedCall): FormData {
  expect(call.init.body).toBeInstanceOf(FormData);
  return call.init.body as FormData;
}

/**
 * A harness that owns the search state the way the router does, so a
 * `go({ step })` inside the wizard genuinely re-renders it at the next step —
 * `ImportRoute.tsx` is the only other implementation of this prop and it does
 * exactly the same thing through `navigate`.
 */
function Harness({ initial }: { readonly initial: ImportSearchState }) {
  const [search, setSearch] = useState<ImportSearchState>(initial);
  return <ImportWizard search={search} onSearchChange={(updater) => setSearch(updater)} />;
}

function renderWizard(initial: ImportSearchState = {}): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    (
      <QueryClientProvider client={queryClient}>
        <Harness initial={initial} />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return queryClient;
}

/**
 * portfolio-archive AC-487: a form picker's current value is
 * archived only when the list refetches with it newly archived — simulated by
 * rewriting the shared `["portfolios","list"]` entry.
 */
function markArchivedInCache(queryClient: QueryClient, portfolioId: string): void {
  queryClient.setQueryData(portfoliosQueryOptions().queryKey, (current) =>
    current?.map((p) => (p.id === portfolioId ? { ...p, archived: true } : p)),
  );
}

/** `[value, label]` of every option a select offers, placeholder included. */
function optionPairs(testId: string): [string, string][] {
  const select = screen.getByTestId(testId) as HTMLSelectElement;
  return Array.from(select.options).map((option) => [option.value, option.text]);
}

function csvFile(name = "assets.csv"): File {
  return new File(["Date;Type\r\n"], name, { type: "text/csv" });
}

async function selectFileAndAnalyse(name = "assets.csv"): Promise<void> {
  const input = screen.getByTestId("import-file-input");
  fireEvent.change(input, { target: { files: [csvFile(name)] } });
  fireEvent.click(screen.getByTestId("import-analyse"));
  await waitFor(() => expect(screen.getByTestId("import-review-step")).toBeInTheDocument());
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("document", document);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ImportWizard — step 1, and the ASSETS shortcut", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", routeFetch({ "/portfolios": () => jsonResponse({ items: [] }) }));
  });

  it("offers all three file types explicitly — nothing is detected (NG3)", () => {
    renderWizard();
    expect(screen.getByTestId("import-type-card-ASSETS")).toBeInTheDocument();
    expect(screen.getByTestId("import-type-card-CASH_ACCOUNT_TRANSACTIONS")).toBeInTheDocument();
    expect(
      screen.getByTestId("import-type-card-INVESTMENT_ACCOUNT_TRANSACTIONS"),
    ).toBeInTheDocument();
  });

  it("skips the destination step for ASSETS and asks for one straight away for a transaction file", () => {
    renderWizard();
    fireEvent.click(screen.getByTestId("import-choose-ASSETS"));
    expect(screen.getByTestId("import-file-step")).toBeInTheDocument();
    // The positive companion: the same wizard *does* stop at the destination
    // for the file type that needs one, so the skip above is a rule and not a
    // missing screen.
    fireEvent.click(screen.getByTestId("import-back-from-file"));
    fireEvent.click(screen.getByTestId("import-choose-CASH_ACCOUNT_TRANSACTIONS"));
    expect(screen.getByTestId("import-destination-step")).toBeInTheDocument();
  });

  it("constrains the file input to CSV client-side", () => {
    renderWizard({ type: "ASSETS", step: "file" });
    expect(screen.getByTestId("import-file-input")).toHaveAttribute("accept", ".csv,text/csv");
  });

  it("refuses a non-CSV selection outright, and issues no request for it", () => {
    renderWizard({ type: "ASSETS", step: "file" });
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [new File(["nope"], "releve.pdf", { type: "application/pdf" })] },
    });

    expect(screen.getByTestId("import-file-rejected")).toHaveTextContent(
      "Ce fichier n'est pas un CSV",
    );
    // The refusal is the whole point: the analyse button is still unarmed…
    expect(screen.getByTestId("import-analyse")).toBeDisabled();
    // …and clicking it anyway sends nothing. A one-shot read, not a retrying
    // matcher: "no request was ever issued" is not an eventually-true claim.
    fireEvent.click(screen.getByTestId("import-analyse"));
    expect(importCalls()).toEqual([]);

    // Positive companion: the same input accepts a real CSV immediately after,
    // so the guard is a filter and not a dead control.
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [csvFile()] },
    });
    expect(screen.queryByTestId("import-file-rejected")).toBeNull();
    expect(screen.getByTestId("import-file-name")).toHaveTextContent("assets.csv");
  });
});

describe("ImportWizard — the dry run, and the counts it reports", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/imports/instruments": () => jsonResponse(summary({ proposals: PROPOSALS })),
        "/portfolios": () => jsonResponse({ items: [] }),
      }),
    );
  });

  it("issues mode=DRY_RUN with the selected file as a multipart part, and reports 51/0/3 exactly", async () => {
    renderWizard({ type: "ASSETS", step: "file" });
    await selectFileAndAnalyse();

    const body = bodyOf(importCalls()[0]!);
    expect(body.get("mode")).toBe("DRY_RUN");
    expect((body.get("file") as File).name).toBe("assets.csv");
    // A dry run submits no resolutions: there is nothing confirmed yet.
    expect(body.has("resolutions")).toBe(false);

    expect(screen.getByTestId("import-review-counts-imported")).toHaveTextContent("51");
    expect(screen.getByTestId("import-review-counts-skipped")).toHaveTextContent("0");
    expect(screen.getByTestId("import-review-counts-rejected")).toHaveTextContent("3");
  });

  it("tells the user to re-run when the discovery budget cut rows short, rather than presenting 51 as the whole file", async () => {
    renderWizard({ type: "ASSETS", step: "file" });
    await selectFileAndAnalyse();

    const hint = screen.getByTestId("import-review-rerun-hint");
    expect(hint).toHaveTextContent("Relancez l'import du même fichier");
    // The per-reason breakdown names the reason too, in French, never as a
    // bare code (IMP-AC-13).
    expect(screen.getByTestId("import-review-counts-reasons")).toHaveTextContent(
      "La place de cotation n'a pas pu être recherchée",
    );
  });

  /**
   * **RF7 / FT-43** — the same claim `import-wizard.spec.ts` makes in a real
   * browser, asserted here too because the e2e lane does not run under
   * `pnpm verify --fast` and a notice nobody sees is the failure mode.
   *
   * Both directions in one case: present on a transaction file, absent on an
   * asset file. An asset row carries no idempotency key, so the warning would
   * be a false statement there — and a notice rendered unconditionally would
   * pass a one-sided test.
   */
  it("RF7 — warns about the one-time duplicate before the confirm, on a transaction file only", async () => {
    renderWizard({ type: "ASSETS", step: "file" });
    await selectFileAndAnalyse();
    expect(screen.queryByTestId("import-review-reimport-notice")).toBeNull();

    cleanup();
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/imports/transactions": () =>
          jsonResponse(summary({ fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS" })),
        "/portfolios": () => jsonResponse({ items: [] }),
      }),
    );
    renderWizard({ type: "INVESTMENT_ACCOUNT_TRANSACTIONS", step: "file" });
    await selectFileAndAnalyse("investment.csv");
    const notice = screen.getByTestId("import-review-reimport-notice");
    expect(notice).toHaveTextContent("importées une seconde fois");
    // On screen at the moment the confirm is available — not after it.
    expect(screen.getByTestId("import-confirm")).toBeInTheDocument();
  });

  it("submits the EDITED kind on confirm, not the proposal the dry run returned", async () => {
    renderWizard({ type: "ASSETS", step: "file" });
    await selectFileAndAnalyse();

    fireEvent.change(screen.getByTestId("import-proposals-row-1-kind"), {
      target: { value: "ETF" },
    });
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(importCalls()).toHaveLength(2));

    const applyBody = bodyOf(importCalls()[1]!);
    expect(applyBody.get("mode")).toBe("APPLY");
    const submitted = JSON.parse(String(applyBody.get("resolutions"))) as typeof PROPOSALS;
    expect(submitted).toHaveLength(2);
    // The edited row carries the new kind…
    expect(submitted[1]!.kind).toBe("ETF");
    // …and the untouched one is unchanged, so this is an edit and not a
    // wholesale rewrite of the list.
    expect(submitted[0]).toEqual(PROPOSALS[0]);
  });

  it("records an overridden exchange as USER-sourced, never keeping the provider's own provenance", async () => {
    renderWizard({ type: "ASSETS", step: "file" });
    await selectFileAndAnalyse();

    fireEvent.change(screen.getByTestId("import-proposals-row-1-mic-select"), {
      target: { value: "XETR" },
    });
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(importCalls()).toHaveLength(2));

    const submitted = JSON.parse(
      String(bodyOf(importCalls()[1]!).get("resolutions")),
    ) as typeof PROPOSALS;
    expect(submitted[1]!.exchangeMic).toBe("XETR");
    expect(submitted[1]!.micSource).toBe("USER");
    expect(submitted[0]!.micSource).toBe("SUFFIX_TABLE");
  });

  /**
   * The "Autre" MIC input used to dead-end on a bad value: the
   * component caps length and uppercases but applied no format rule, so `ab`
   * reached the server and the tightened echo-back schema refused the
   * **whole request** with a 400 and nothing pointing at the field.
   *
   * Both halves are asserted, because a client check that simply disabled the
   * control would satisfy the negative one on its own.
   */
  describe("a hand-typed MIC is checked in the form, not only by the server", () => {
    const typeCustomMic = (value: string): void => {
      // "Autre — saisir le code MIC" reveals the free-text input; the sentinel
      // itself never reaches the submitted value (D8).
      fireEvent.change(screen.getByTestId("import-proposals-row-1-mic-select"), {
        target: { value: MIC_UNLISTED_SENTINEL },
      });
      fireEvent.change(screen.getByTestId("import-proposals-row-1-mic-input"), {
        target: { value },
      });
    };

    it("shows a per-field message and refuses to submit a MIC exchangeMicSchema rejects", async () => {
      renderWizard({ type: "ASSETS", step: "file" });
      await selectFileAndAnalyse();
      const callsBefore = importCalls().length;

      typeCustomMic("ab");

      // The message, on the field — not a whole-request failure after the fact.
      expect(screen.getByTestId("import-proposals-row-1-mic-error")).toHaveTextContent(
        "Code MIC invalide",
      );
      const confirm = screen.getByTestId("import-confirm");
      expect(confirm).toBeDisabled();

      // And clicking it changes nothing: no APPLY request is issued at all.
      fireEvent.click(confirm);
      expect(importCalls()).toHaveLength(callsBefore);
    });

    it("a valid hand-typed MIC still submits, exactly — the check is not a disabled input", async () => {
      renderWizard({ type: "ASSETS", step: "file" });
      await selectFileAndAnalyse();

      // A well-formed MIC that is deliberately NOT curated, so this exercises
      // the free-text path rather than a `<select>` option — asserted, not
      // assumed, because the curated list grows.
      const uncurated = "XJSE";
      expect(CURATED_EXCHANGE_MICS.some((exchange) => exchange.mic === uncurated)).toBe(false);
      typeCustomMic(uncurated);

      expect(screen.queryByTestId("import-proposals-row-1-mic-error")).toBeNull();
      expect(screen.getByTestId("import-confirm")).not.toBeDisabled();

      fireEvent.click(screen.getByTestId("import-confirm"));
      await waitFor(() => expect(importCalls()).toHaveLength(2));

      const submitted = JSON.parse(
        String(bodyOf(importCalls()[1]!).get("resolutions")),
      ) as typeof PROPOSALS;
      expect(submitted[1]!.exchangeMic).toBe(uncurated);
      expect(submitted[1]!.micSource).toBe("USER");
    });

    it("an empty MIC is not an error — no exchange chosen is a legitimate proposal the server accepts", async () => {
      renderWizard({ type: "ASSETS", step: "file" });
      await selectFileAndAnalyse();

      typeCustomMic("");

      expect(screen.queryByTestId("import-proposals-row-1-mic-error")).toBeNull();
      expect(screen.getByTestId("import-confirm")).not.toBeDisabled();
    });
  });

  /**
   * The review step's whole job for `kind`. A wrong kind is written once
   * and never editable again (`instrument.kind` is `app_owner`-only), so the
   * defaults have to be visibly different from the evidence-backed values, and
   * the ones that contradict their own name have to be different again.
   */
  it("marks the row whose kind was defaulted against a fund-shaped name, and leaves the evidenced row unmarked", async () => {
    renderWizard({ type: "ASSETS", step: "file" });
    await selectFileAndAnalyse();

    const evidenced = screen.getByTestId("import-proposals-row-0-kind-source");
    expect(evidenced).toHaveAttribute("data-kind-source", "EXPENSE_RATIO");
    expect(evidenced).toHaveAttribute("data-kind-needs-confirmation", "false");
    expect(evidenced).toHaveTextContent("frais courants");

    const defaulted = screen.getByTestId("import-proposals-row-1-kind-source");
    expect(defaulted).toHaveAttribute("data-kind-source", "DEFAULT");
    expect(defaulted).toHaveAttribute("data-kind-needs-confirmation", "true");
    expect(defaulted).toHaveTextContent("à confirmer");

    // And the row is identifiable without reopening the file.
    expect(screen.getByTestId("import-proposals-row-1-label")).toHaveTextContent("GOLD.PA");
  });

  it("records an overridden kind as USER-sourced, and drops the flag it was carrying", async () => {
    renderWizard({ type: "ASSETS", step: "file" });
    await selectFileAndAnalyse();

    fireEvent.change(screen.getByTestId("import-proposals-row-1-kind"), {
      target: { value: "ETF" },
    });
    // The user has now decided this row, so it is no longer one of the rows
    // asking to be decided.
    expect(screen.getByTestId("import-proposals-row-1-kind-source")).toHaveAttribute(
      "data-kind-needs-confirmation",
      "false",
    );

    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(importCalls()).toHaveLength(2));

    const submitted = JSON.parse(
      String(bodyOf(importCalls()[1]!).get("resolutions")),
    ) as typeof PROPOSALS;
    expect(submitted[1]!.kind).toBe("ETF");
    expect(submitted[1]!.kindSource).toBe("USER");
    expect(submitted[0]!.kindSource).toBe("EXPENSE_RATIO");
  });
});

describe("ImportWizard — the result step", () => {
  it("renders F-E's shared UI-copy constant verbatim for an ALREADY_IMPORTED row", async () => {
    const applied = summary({
      mode: "APPLY",
      fileType: "CASH_ACCOUNT_TRANSACTIONS",
      rowCount: 52,
      imported: 0,
      skipped: 52,
      rejected: 0,
      byReason: { ALREADY_IMPORTED: 52 },
      rows: [
        {
          line: 2,
          index: 0,
          outcome: "SKIP",
          reason: "ALREADY_IMPORTED",
          message: "already imported",
          source: {
            shape: "CASH_MOVEMENT",
            tradeDate: "2019-11-04",
            direction: "IN",
            instrument: null,
            amount: "2000",
            currency: "EUR",
            quantity: null,
          },
        },
      ],
      discoveryCallsIssued: 0,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/imports/transactions": () => jsonResponse(applied),
        "/portfolios": () => jsonResponse({ items: [] }),
      }),
    );

    renderWizard({
      type: "CASH_ACCOUNT_TRANSACTIONS",
      step: "file",
      portfolio: PORTFOLIO_ID,
      account: CASH_ACCOUNT_ID,
    });
    await selectFileAndAnalyse("cash.csv");
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(screen.getByTestId("import-result-step")).toBeInTheDocument());

    // Verbatim, and from `core/api-contracts` — a locally re-typed sentence
    // would fail this comparison the day the shared one is reworded.
    expect(screen.getByTestId("import-result-rows-edited-row-notice")).toHaveTextContent(
      IMPORT_EDITED_ROW_NOTICE,
    );
  });

  it("shows applyFailed / applyNotAttempted whenever either is non-zero, instead of a silently partial import", async () => {
    const applied = summary({
      mode: "APPLY",
      fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
      rowCount: 245,
      imported: 200,
      skipped: 0,
      rejected: 45,
      byReason: { APPLY_NOT_ATTEMPTED: 45 },
      rows: [],
      applyFailed: 0,
      applyNotAttempted: 45,
      discoveryCallsIssued: 0,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/imports/transactions": () => jsonResponse(applied),
        "/portfolios": () => jsonResponse({ items: [] }),
      }),
    );

    renderWizard({
      type: "INVESTMENT_ACCOUNT_TRANSACTIONS",
      step: "file",
      portfolio: PORTFOLIO_ID,
      account: CASH_ACCOUNT_ID,
    });
    await selectFileAndAnalyse("investment.csv");
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(screen.getByTestId("import-result-step")).toBeInTheDocument());

    expect(screen.getByTestId("import-result-counts-apply-shortfall")).toHaveTextContent("45");
    // The positive companion: the same panel says nothing when both are zero,
    // so the line above is a signal rather than permanent furniture.
    expect(screen.queryByTestId("import-review-counts-apply-shortfall")).toBeNull();
  });

  it("offers the next file in the guided sequence", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/imports/instruments": () => jsonResponse(summary({ proposals: [] })),
        "/portfolios": () => jsonResponse({ items: [] }),
      }),
    );
    renderWizard({ type: "ASSETS", step: "file" });
    await selectFileAndAnalyse();
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(screen.getByTestId("import-result-step")).toBeInTheDocument());

    const next = screen.getByTestId("import-next-file");
    expect(next).toHaveTextContent("Opérations du compte espèces");
    fireEvent.click(next);
    // …and it lands on that type's own destination step, with the previous
    // file's summary dropped rather than carried over.
    expect(screen.getByTestId("import-destination-step")).toBeInTheDocument();
  });
});

describe("ImportWizard — the stated limitation (a refresh loses the File)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", routeFetch({ "/portfolios": () => jsonResponse({ items: [] }) }));
  });

  it("returns to the file step and says so, rather than rendering an empty review", () => {
    // Exactly what a browser refresh produces: the URL still reads `review`,
    // and the component state that held the `File` is gone.
    renderWizard({ type: "ASSETS", step: "review" });

    expect(screen.getByTestId("import-file-step")).toBeInTheDocument();
    expect(screen.queryByTestId("import-review-step")).toBeNull();
    expect(screen.getByTestId("import-file-lost")).toHaveTextContent(
      "Le fichier sélectionné n'est pas conservé",
    );
  });

  it("does not show that notice on a normal arrival at the file step", () => {
    renderWizard({ type: "ASSETS", step: "file" });
    expect(screen.getByTestId("import-file-step")).toBeInTheDocument();
    expect(screen.queryByTestId("import-file-lost")).toBeNull();
  });
});

/**
 * `portfolio-export-import` Batch E (EI-33/EI-34/EI-35) — the two Kerdial
 * packages, the two « Exporter » actions and the post-apply fan-out.
 *
 * The fan-out assertions mock `invalidate-derived.js` rather than inspecting
 * the query cache, because the criterion is *which flag value* was passed:
 * `epochWillAdvance: false` for a catalogue (it moves no `calc_epoch`)
 * and `true` for anything that writes ledger rows. A test that only observed
 * "some invalidation happened" would pass with the two swapped, which is the
 * failure to guard against.
 */
vi.mock("../lib/invalidate-derived.js", () => ({
  invalidatePortfolioDerivedFigures: vi.fn(() => Promise.resolve({ status: "verified" })),
  invalidateCatalogueSurfaces: vi.fn(() => Promise.resolve()),
}));

function catalogueSummary(mode: "DRY_RUN" | "APPLY"): ImportSummaryResponse {
  return {
    mode,
    fileType: "KERDIAL_CATALOGUE",
    rowCount: 15,
    imported: 13,
    skipped: 1,
    rejected: 1,
    byReason: { CATALOGUE_ENTRY_UNCHANGED: 1, PROVIDER_MAPPING_CONFLICT: 1 },
    rows: [],
    rowsTruncated: false,
    entries: [
      {
        section: "instruments",
        index: 4,
        outcome: "SKIP",
        reason: "CATALOGUE_ENTRY_UNCHANGED",
        message: "every field already matches the destination",
      },
      {
        section: "instruments",
        index: 9,
        outcome: "REJECT",
        reason: "PROVIDER_MAPPING_CONFLICT",
        message: "the pinned symbol belongs to another instrument",
      },
    ],
    sections: {
      instruments: 12,
      portfolios: 3,
      cashAccounts: 4,
      icons: 7,
      manualPrices: 480,
      watchlistItems: 2,
      fxRatesUser: 5,
    },
    sharedCatalogueImpact: { instrumentsModified: 2, priceHistoriesDiscarded: 1 },
    applyFailed: 0,
    applyNotAttempted: 0,
    discoveryCallsIssued: 0,
  };
}

function kerdialCsvSummary(
  mode: "DRY_RUN" | "APPLY",
  overrides: Partial<ImportSummaryResponse> = {},
): ImportSummaryResponse {
  return {
    mode,
    fileType: "KERDIAL_TRANSACTIONS",
    rowCount: 900,
    imported: 880,
    skipped: 18,
    rejected: 2,
    byReason: { ALREADY_IMPORTED: 18, DRIP_SOURCE_NOT_RESOLVED: 2 },
    rows: [
      {
        line: 88,
        index: 86,
        outcome: "REJECT",
        reason: "DRIP_SOURCE_NOT_RESOLVED",
        message: "the reinvested dividend was not found in this file",
        source: {
          shape: "DRIP",
          tradeDate: "2024-03-08",
          direction: "ACQUIRE",
          instrument: "AI.PA",
          amount: null,
          currency: "EUR",
          quantity: "2",
        },
      },
    ],
    rowsTruncated: false,
    applyFailed: 0,
    applyNotAttempted: 0,
    discoveryCallsIssued: 0,
    ...overrides,
  };
}

function jsonFile(name = "kerdial-instruments.json"): File {
  return new File(["{}"], name, { type: "application/json" });
}

describe("ImportWizard — the two Kerdial packages (EI-33)", () => {
  beforeEach(() => {
    vi.mocked(invalidatePortfolioDerivedFigures).mockClear();
    vi.mocked(invalidateCatalogueSurfaces).mockClear();
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/imports/kerdial/catalogue": () => jsonResponse(catalogueSummary("DRY_RUN")),
        "/imports/kerdial/transactions": () => jsonResponse(kerdialCsvSummary("DRY_RUN")),
        "/portfolios": () => jsonResponse({ items: [] }),
      }),
    );
  });

  it("offers a card for each of the five file types — the three PP ones and the two Kerdial packages", () => {
    renderWizard();
    for (const type of IMPORT_FILE_TYPES) {
      expect(screen.getByTestId(`import-type-card-${type}`)).toBeInTheDocument();
    }
  });

  it.each([
    ["ASSETS", false],
    ["CASH_ACCOUNT_TRANSACTIONS", true],
    ["INVESTMENT_ACCOUNT_TRANSACTIONS", true],
    ["KERDIAL_CATALOGUE", false],
    ["KERDIAL_TRANSACTIONS", false],
  ] as const)("needsDestination(%s) is %s, and the wizard routes accordingly", (type, needs) => {
    expect(needsDestination(type)).toBe(needs);
    renderWizard();
    fireEvent.click(screen.getByTestId(`import-choose-${type}`));
    expect(screen.queryByTestId("import-destination-step") !== null).toBe(needs);
    expect(screen.queryByTestId("import-file-step") !== null).toBe(!needs);
  });

  it("walks its own two-file sequence, and never leads into the PP one", () => {
    // FR-556's "either alone" property, asserted on the sequence itself: the
    // two journeys are separate lists, so neither one's last step offers the
    // other's first.
    expect(nextGuidedFileType("KERDIAL_CATALOGUE")).toBe("KERDIAL_TRANSACTIONS");
    expect(nextGuidedFileType("KERDIAL_TRANSACTIONS")).toBeUndefined();
    expect(nextGuidedFileType("ASSETS")).toBe("CASH_ACCOUNT_TRANSACTIONS");
    expect(nextGuidedFileType("INVESTMENT_ACCOUNT_TRANSACTIONS")).toBeUndefined();
  });

  it("accepts JSON for the catalogue and refuses a CSV for it, with no request issued", () => {
    renderWizard({ type: "KERDIAL_CATALOGUE", step: "file" });
    expect(screen.getByTestId("import-file-input")).toHaveAttribute(
      "accept",
      ".json,application/json",
    );
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [csvFile("kerdial-transactions.csv")] },
    });
    expect(screen.getByTestId("import-file-rejected")).toHaveTextContent(
      "Ce fichier n'est pas un JSON",
    );
    fireEvent.click(screen.getByTestId("import-analyse"));
    expect(importCalls()).toEqual([]);

    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [jsonFile()] },
    });
    expect(screen.queryByTestId("import-file-rejected")).toBeNull();
    expect(screen.getByTestId("import-file-name")).toHaveTextContent("kerdial-instruments.json");
  });

  it("posts the catalogue to its own route with file and mode only — no destination, no resolutions", async () => {
    renderWizard({ type: "KERDIAL_CATALOGUE", step: "file" });
    fireEvent.change(screen.getByTestId("import-file-input"), { target: { files: [jsonFile()] } });
    fireEvent.click(screen.getByTestId("import-analyse"));
    await waitFor(() => expect(screen.getByTestId("import-review-step")).toBeInTheDocument());

    const [call] = importCalls();
    expect(call?.url).toContain("/imports/kerdial/catalogue");
    const body = bodyOf(call!);
    expect(body.get("mode")).toBe("DRY_RUN");
    expect((body.get("file") as File).name).toBe("kerdial-instruments.json");
    expect([...body.keys()].sort()).toEqual(["file", "mode"]);
  });

  it("renders the catalogue's sections and its per-entry table, not a row table", async () => {
    renderWizard({ type: "KERDIAL_CATALOGUE", step: "file" });
    fireEvent.change(screen.getByTestId("import-file-input"), { target: { files: [jsonFile()] } });
    fireEvent.click(screen.getByTestId("import-analyse"));
    await waitFor(() => expect(screen.getByTestId("import-review-step")).toBeInTheDocument());

    // What the file carried, in the user's own words.
    expect(screen.getByTestId("import-review-sections")).toHaveTextContent("480");
    expect(screen.getByTestId("import-review-sections")).toHaveTextContent(
      "cours saisis à la main",
    );
    // The entries table, addressed by section and index — and the row table
    // deliberately absent: a route reports rows **or** entries, never both.
    expect(screen.getAllByTestId("import-review-entries-row")).toHaveLength(2);
    expect(screen.getAllByTestId("import-review-entries-row-entry")[0]).toHaveTextContent(
      "titres · 4",
    );
    expect(screen.getAllByTestId("import-review-entries-row-reason")[1]).toHaveTextContent(
      "déjà attribué à un autre titre",
    );
    expect(screen.queryByTestId("import-review-rows")).toBeNull();
    // The shared-catalogue impact, before the confirm.
    expect(screen.getByTestId("import-review-shared-impact")).toHaveTextContent(
      "2 instruments du catalogue partagé seront modifiés par cet import, dont 1 perdra son historique de cours",
    );
    // RF7's `pp2` notice is about a fingerprint recipe a Kerdial package has
    // never used, so it would be a false statement here.
    expect(screen.queryByTestId("import-review-reimport-notice")).toBeNull();
  });

  it("states the shared-catalogue impact only when there is one, in the right number", () => {
    expect(
      sharedCatalogueImpactNotice({ instrumentsModified: 0, priceHistoriesDiscarded: 0 }),
    ).toBeNull();
    expect(
      sharedCatalogueImpactNotice({ instrumentsModified: 1, priceHistoriesDiscarded: 0 }),
    ).toBe("1 instrument du catalogue partagé sera modifié par cet import.");
    expect(
      sharedCatalogueImpactNotice({ instrumentsModified: 5, priceHistoriesDiscarded: 3 }),
    ).toContain("dont 3 perdront leur historique de cours");
  });

  it("posts the Kerdial CSV to its own route and reports its rows", async () => {
    renderWizard({ type: "KERDIAL_TRANSACTIONS", step: "file" });
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [csvFile("kerdial-transactions.csv")] },
    });
    fireEvent.click(screen.getByTestId("import-analyse"));
    await waitFor(() => expect(screen.getByTestId("import-review-step")).toBeInTheDocument());

    expect(importCalls()[0]?.url).toContain("/imports/kerdial/transactions");
    expect(screen.getByTestId("import-review-counts-imported")).toHaveTextContent("880");
    // The three Kerdial-only shapes are named on the row's own line: a `DRIP`
    // carries `ACQUIRE` and would otherwise read as an ordinary purchase.
    expect(screen.getByTestId("import-review-rows-row-source")).toHaveTextContent(
      "dividende réinvesti",
    );
  });

  it("names a FEE row on its own line — without the label it reads as a bare date and amount (portfolio-cash)", () => {
    const line = formatImportRowSource({
      shape: "FEE",
      tradeDate: "2026-07-01",
      direction: null,
      instrument: "AI.PA",
      amount: "12.50",
      currency: "EUR",
      quantity: null,
    });
    expect(line).toContain("frais de portefeuille");
    expect(line).toContain("AI.PA");
  });
});

describe("ImportWizard — the self-driving continuation", () => {
  beforeEach(() => {
    vi.mocked(invalidatePortfolioDerivedFigures).mockClear();
    vi.mocked(invalidateCatalogueSurfaces).mockClear();
  });

  /**
   * One ten-row Kerdial CSV across three runs. One row was imported before
   * this chain began (`ALREADY_IMPORTED: 1` from the first run on) and one is
   * a genuine reject; every later run re-skips what the earlier ones wrote.
   */
  const RUNS = [
    kerdialCsvSummary("APPLY", {
      rowCount: 10,
      imported: 6,
      skipped: 1,
      rejected: 3,
      byReason: { ALREADY_IMPORTED: 1, DRIP_SOURCE_NOT_RESOLVED: 1, APPLY_NOT_ATTEMPTED: 2 },
      applyNotAttempted: 2,
    }),
    kerdialCsvSummary("APPLY", {
      rowCount: 10,
      imported: 1,
      skipped: 7,
      rejected: 2,
      byReason: { ALREADY_IMPORTED: 7, DRIP_SOURCE_NOT_RESOLVED: 1, APPLY_NOT_ATTEMPTED: 1 },
      applyNotAttempted: 1,
    }),
    kerdialCsvSummary("APPLY", {
      rowCount: 10,
      imported: 1,
      skipped: 8,
      rejected: 1,
      byReason: { ALREADY_IMPORTED: 8, DRIP_SOURCE_NOT_RESOLVED: 1 },
      applyNotAttempted: 0,
    }),
  ];

  /** The dry run, then each APPLY answered by the next entry — a function, so a test can hold one open. */
  async function confirmKerdialCsv(applies: readonly (() => Promise<Response>)[]): Promise<void> {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/portfolios"))
          return Promise.resolve(jsonResponse({ items: [] }));
        const applied = importCalls().length - 2;
        if (applied < 0) return Promise.resolve(jsonResponse(kerdialCsvSummary("DRY_RUN")));
        const answer = applies[applied];
        if (answer === undefined) throw new Error(`unexpected APPLY #${String(applied + 1)}`);
        return answer();
      }),
    );
    renderWizard({ type: "KERDIAL_TRANSACTIONS", step: "file" });
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [csvFile("kerdial-transactions.csv")] },
    });
    fireEvent.click(screen.getByTestId("import-analyse"));
    await waitFor(() => expect(screen.getByTestId("import-review-step")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(screen.getByTestId("import-result-step")).toBeInTheDocument());
  }

  const answer = (body: ImportSummaryResponse) => () => Promise.resolve(jsonResponse(body));

  it("re-posts the same file until nothing is left, and shows what the whole chain did", async () => {
    await confirmKerdialCsv(RUNS.map(answer));

    await waitFor(() => expect(screen.queryByTestId("import-continue-stop")).toBeNull());
    const applies = importCalls().slice(1);
    expect(applies).toHaveLength(3);
    for (const call of applies) {
      expect(call.url).toContain("/imports/kerdial/transactions");
      expect(bodyOf(call).get("mode")).toBe("APPLY");
      expect((bodyOf(call).get("file") as File).name).toBe("kerdial-transactions.csv");
    }
    // 6 + 1 + 1 written by the chain; the one row imported before it stays a
    // skip; the reject is the reject. Not the last run's 1 / 8 / 1.
    expect(screen.getByTestId("import-result-counts-imported")).toHaveTextContent("8");
    expect(screen.getByTestId("import-result-counts-skipped")).toHaveTextContent("1");
    expect(screen.getByTestId("import-result-counts-rejected")).toHaveTextContent("1");
    expect(screen.queryByTestId("import-continue")).toBeNull();
    expect(screen.queryByTestId("import-continue-notice")).toBeNull();
    expect(invalidatePortfolioDerivedFigures).toHaveBeenCalledTimes(1);
  });

  it("« Arrêter » lets the request in flight finish and posts nothing after it", async () => {
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    await confirmKerdialCsv([answer(RUNS[0]!), () => held, answer(RUNS[2]!)]);

    // The first run is on screen, the second is in flight.
    await waitFor(() => expect(importCalls()).toHaveLength(3));
    expect(screen.getByTestId("import-continue-progress")).toHaveTextContent(
      "Import en cours : 8 / 10 lignes traitées",
    );
    fireEvent.click(screen.getByTestId("import-continue-stop"));
    release(jsonResponse(RUNS[1]!));

    await waitFor(() => expect(screen.getByTestId("import-continue")).toBeInTheDocument());
    expect(importCalls()).toHaveLength(3);
    expect(screen.getByTestId("import-result-counts-imported")).toHaveTextContent("7");
  });

  it("stops with a message when a run leaves as many rows unattempted as the one before", async () => {
    await confirmKerdialCsv([answer(RUNS[0]!), answer(RUNS[0]!), answer(RUNS[2]!)]);

    await waitFor(() =>
      expect(screen.getByTestId("import-continue-halted")).toHaveTextContent(
        "n'a traité aucune ligne de plus que la précédente",
      ),
    );
    expect(importCalls().slice(1)).toHaveLength(2);
    expect(screen.getByTestId("import-continue")).toBeInTheDocument();
  });

  it("does not continue when every row was attempted", async () => {
    await confirmKerdialCsv([answer(RUNS[2]!)]);
    expect(importCalls().slice(1)).toHaveLength(1);
    expect(screen.queryByTestId("import-continue")).toBeNull();
    expect(screen.queryByTestId("import-continue-notice")).toBeNull();
  });
});

describe("ImportWizard — the post-apply fan-out (EI-35)", () => {
  beforeEach(() => {
    vi.mocked(invalidatePortfolioDerivedFigures).mockClear();
    vi.mocked(invalidateCatalogueSurfaces).mockClear();
  });

  async function applyOnce(
    type: "KERDIAL_CATALOGUE" | "KERDIAL_TRANSACTIONS" | "INVESTMENT_ACCOUNT_TRANSACTIONS",
  ): Promise<void> {
    const body =
      type === "KERDIAL_CATALOGUE"
        ? catalogueSummary
        : type === "KERDIAL_TRANSACTIONS"
          ? (mode: "DRY_RUN" | "APPLY") => kerdialCsvSummary(mode)
          : (mode: "DRY_RUN" | "APPLY") =>
              summary({ mode, fileType: type, imported: 232, rejected: 0, byReason: {} });
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/imports/": () => jsonResponse(body(importCalls().length === 0 ? "DRY_RUN" : "APPLY")),
        "/portfolios": () => jsonResponse({ items: [] }),
      }),
    );
    renderWizard({
      type,
      step: "file",
      portfolio: PORTFOLIO_ID,
      account: CASH_ACCOUNT_ID,
    });
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [type === "KERDIAL_CATALOGUE" ? jsonFile() : csvFile()] },
    });
    fireEvent.click(screen.getByTestId("import-analyse"));
    await waitFor(() => expect(screen.getByTestId("import-review-step")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(screen.getByTestId("import-result-step")).toBeInTheDocument());
  }

  it("a catalogue apply invalidates with epochWillAdvance FALSE — it moves no calc_epoch", async () => {
    await applyOnce("KERDIAL_CATALOGUE");
    expect(invalidatePortfolioDerivedFigures).toHaveBeenCalledWith(expect.anything(), {
      epochWillAdvance: false,
    });
    // …plus the surfaces no portfolio prefix covers: a catalogue that added
    // five instruments must not leave the Titres screen on its old list.
    expect(invalidateCatalogueSurfaces).toHaveBeenCalledTimes(1);
  });

  it("a Kerdial transactions apply invalidates with epochWillAdvance TRUE", async () => {
    await applyOnce("KERDIAL_TRANSACTIONS");
    expect(invalidatePortfolioDerivedFigures).toHaveBeenCalledWith(expect.anything(), {
      epochWillAdvance: true,
    });
    expect(invalidateCatalogueSurfaces).toHaveBeenCalledTimes(1);
  });

  it("a Portfolio-Performance transactions apply is unchanged: TRUE, and no catalogue fan-out", async () => {
    await applyOnce("INVESTMENT_ACCOUNT_TRANSACTIONS");
    expect(invalidatePortfolioDerivedFigures).toHaveBeenCalledWith(expect.anything(), {
      epochWillAdvance: true,
    });
    expect(invalidateCatalogueSurfaces).not.toHaveBeenCalled();
  });
});

describe("ImportWizard — the two « Exporter » actions (EI-34)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", routeFetch({ "/portfolios": () => jsonResponse({ items: [] }) }));
  });

  it("renders both as plain anchors with download, on the landing step, with no request issued", () => {
    renderWizard();

    const catalogue = screen.getByTestId("import-export-catalogue");
    const transactions = screen.getByTestId("import-export-transactions");
    // Plain navigations, never `fetch` + blob: the tag itself is the assertion.
    expect(catalogue.tagName).toBe("A");
    expect(transactions.tagName).toBe("A");
    expect(catalogue).toHaveAttribute("href", "/api/v1/exports/instruments?icons=included");
    expect(transactions).toHaveAttribute("href", "/api/v1/exports/transactions");
    expect(catalogue).toHaveAttribute("download");
    expect(transactions).toHaveAttribute("download");
    // Rendering the card issues nothing — there is no pre-flight request.
    expect(calls.filter((call) => call.url.includes("/exports/"))).toEqual([]);
  });

  it("states the ceiling and the icons=omitted remedy with no user action at all", () => {
    renderWizard();
    // Not behind a tooltip, a disclosure or a hover: a user who hits the 413
    // has already read the remedy, because a plain navigation cannot render
    // the problem+json body as anything but raw JSON.
    expect(screen.getByTestId("import-export-ceiling")).toHaveTextContent("32 Mio");
    const withoutIcons = screen.getByTestId("import-export-catalogue-no-icons");
    expect(withoutIcons).toHaveAttribute("href", "/api/v1/exports/instruments?icons=omitted");
    expect(withoutIcons).toHaveAttribute("download");
  });
});

/**
 * `security-transfer` FR-583 — the review step's
 * destination picker, read off the `FormData` that actually leaves the
 * browser, and the reason it is not only on the first confirm: every
 * automatic continuation re-posts the same answers, or the remaining transfers
 * would be written alone without a word.
 */
describe("ImportWizard — a transfer's destination (security-transfer FR-583)", () => {
  const WALLET_ID = "22222222-2222-4222-8222-222222222222";
  const DECISION = {
    index: 2,
    line: 4,
    tradeDate: "2025-07-09",
    instrumentId: "33333333-3333-4333-8333-333333333333",
    instrument: "BTC",
    quantity: "0.01",
    marketValue: "1240.8",
    currency: "EUR",
  };
  const transferSummary = (overrides: Partial<ImportSummaryResponse>) =>
    summary({
      fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
      rowCount: 3,
      imported: 3,
      skipped: 0,
      rejected: 0,
      byReason: {},
      rows: [],
      discoveryCallsIssued: 0,
      ...overrides,
    });

  /** The dry run, then each APPLY answered in turn. */
  async function reviewTransferFile(
    applies: readonly ImportSummaryResponse[],
    extraPortfolios: readonly { id: string; name: string; archived: boolean }[] = [],
  ): Promise<QueryClient> {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/portfolios")) {
          return Promise.resolve(
            jsonResponse({
              items: [
                { id: PORTFOLIO_ID, name: "PEA" },
                { id: WALLET_ID, name: "Wallet" },
                ...extraPortfolios,
              ],
              nextCursor: null,
            }),
          );
        }
        const applied = importCalls().length - 2;
        if (applied < 0) {
          return Promise.resolve(jsonResponse(transferSummary({ transferDecisions: [DECISION] })));
        }
        const answer = applies[applied];
        if (answer === undefined) throw new Error(`unexpected APPLY #${String(applied + 1)}`);
        return Promise.resolve(jsonResponse(answer));
      }),
    );
    const queryClient = renderWizard({
      type: "INVESTMENT_ACCOUNT_TRANSACTIONS",
      step: "file",
      portfolio: PORTFOLIO_ID,
      account: CASH_ACCOUNT_ID,
    });
    await selectFileAndAnalyse("investment.csv");
    await waitFor(() =>
      expect(screen.getByTestId("import-transfer-decisions-select-2")).toHaveTextContent("Wallet"),
    );
    return queryClient;
  }

  const answersOf = (call: RecordedCall): unknown => {
    const field = bodyOf(call).get("transferDestinations");
    return field === null ? null : JSON.parse(field as string);
  };

  it("offers every other portfolio, never the one imported into, and echoes the answer on every APPLY of the chain", async () => {
    await reviewTransferFile([
      transferSummary({
        mode: "APPLY",
        imported: 2,
        rejected: 1,
        byReason: { APPLY_NOT_ATTEMPTED: 1 },
        applyNotAttempted: 1,
      }),
      transferSummary({
        mode: "APPLY",
        imported: 1,
        skipped: 2,
        byReason: { ALREADY_IMPORTED: 2 },
      }),
    ]);
    const card = screen.getByTestId("import-transfer-decisions-row-2");
    expect(card).toHaveTextContent("Transfert sortant");
    expect(card).toHaveTextContent("BTC");
    const select = screen.getByTestId("import-transfer-decisions-select-2");
    expect(select).not.toHaveTextContent("PEA");

    fireEvent.change(select, { target: { value: "Wallet" } });
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(importCalls()).toHaveLength(3));
    await waitFor(() => expect(screen.queryByTestId("import-continue-stop")).toBeNull());

    const [dryRun, first, continuation] = importCalls();
    // A dry run asks; it answers nothing.
    expect(bodyOf(dryRun!).has("transferDestinations")).toBe(false);
    expect(answersOf(first!)).toEqual([{ index: 2, portfolioName: "Wallet" }]);
    // The automatic continuation carries the very same answers.
    expect(answersOf(continuation!)).toEqual([{ index: 2, portfolioName: "Wallet" }]);
  });

  it("holds the confirm while a new portfolio's name is blank, then sends the typed name", async () => {
    await reviewTransferFile([transferSummary({ mode: "APPLY" })]);
    fireEvent.change(screen.getByTestId("import-transfer-decisions-select-2"), {
      target: { value: " new" },
    });
    expect(screen.getByTestId("import-confirm")).toBeDisabled();
    fireEvent.change(screen.getByTestId("import-transfer-decisions-name-2"), {
      target: { value: "Ledger" },
    });
    expect(screen.getByTestId("import-confirm")).toBeEnabled();

    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(importCalls()).toHaveLength(2));
    expect(answersOf(importCalls()[1]!)).toEqual([{ index: 2, portfolioName: "Ledger" }]);
  });

  it("sends no answer for a row left on « Aucun » — the transfer is written alone (Step A)", async () => {
    await reviewTransferFile([transferSummary({ mode: "APPLY" })]);
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(importCalls()).toHaveLength(2));
    expect(bodyOf(importCalls()[1]!).has("transferDestinations")).toBe(false);
  });

  it("portfolio-archive AC-486: an archived portfolio is not offered as a transfer destination", async () => {
    await reviewTransferFile(
      [],
      [{ id: "44444444-4444-4444-8444-444444444444", name: "Ancien", archived: true }],
    );
    expect(optionPairs("import-transfer-decisions-select-2").map(([value]) => value)).not.toContain(
      "Ancien",
    );
  });

  it("portfolio-archive AC-487: the chosen destination, once archived, stays listed once, suffixed, and selected", async () => {
    const queryClient = await reviewTransferFile([]);
    fireEvent.change(screen.getByTestId("import-transfer-decisions-select-2"), {
      target: { value: "Wallet" },
    });

    markArchivedInCache(queryClient, WALLET_ID);

    await waitFor(() =>
      expect(
        optionPairs("import-transfer-decisions-select-2").filter(([value]) => value === "Wallet"),
      ).toEqual([["Wallet", "Wallet (archivé)"]]),
    );
    expect(screen.getByTestId("import-transfer-decisions-select-2")).toHaveValue("Wallet");
  });
});

describe("ImportWizard — portfolio-archive: the destination picker", () => {
  const ACTIVE_ID = "55555555-5555-4555-8555-555555555555";
  const OLD_ID = "66666666-6666-4666-8666-666666666666";

  function stubPortfolios(items: readonly { id: string; name: string; archived: boolean }[]) {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/cash": () => jsonResponse({ accounts: [], byCurrency: [], calcEpoch: "1" }),
        "/currencies": () => jsonResponse([]),
        "/portfolios": () => jsonResponse({ items, nextCursor: null }),
      }),
    );
  }

  it("AC-486: an archived portfolio is not offered when nothing is chosen", async () => {
    stubPortfolios([
      { id: ACTIVE_ID, name: "Actif", archived: false },
      { id: OLD_ID, name: "Ancien", archived: true },
    ]);
    renderWizard({ type: "CASH_ACCOUNT_TRANSACTIONS", step: "destination" });

    await waitFor(() =>
      expect(optionPairs("import-portfolio-select").map(([value]) => value)).toEqual([
        "",
        ACTIVE_ID,
      ]),
    );
    expect(screen.queryByText("Tous vos portefeuilles sont archivés")).toBeNull();
  });

  it("AC-487: the chosen destination, once archived, stays listed once, suffixed, and selected", async () => {
    stubPortfolios([
      { id: ACTIVE_ID, name: "Actif", archived: false },
      { id: OLD_ID, name: "Ancien", archived: false },
    ]);
    const queryClient = renderWizard({ type: "CASH_ACCOUNT_TRANSACTIONS", step: "destination" });
    await waitFor(() =>
      expect(optionPairs("import-portfolio-select").map(([value]) => value)).toContain(OLD_ID),
    );
    fireEvent.change(screen.getByTestId("import-portfolio-select"), {
      target: { value: OLD_ID },
    });

    markArchivedInCache(queryClient, OLD_ID);

    await waitFor(() =>
      expect(optionPairs("import-portfolio-select")).toEqual([
        ["", expect.any(String)],
        [ACTIVE_ID, "Actif"],
        [OLD_ID, "Ancien (archivé)"],
      ]),
    );
    expect(screen.getByTestId("import-portfolio-select")).toHaveValue(OLD_ID);
  });

  it("every portfolio archived: the select keeps its placeholder and says why", async () => {
    stubPortfolios([{ id: OLD_ID, name: "Ancien", archived: true }]);
    renderWizard({ type: "CASH_ACCOUNT_TRANSACTIONS", step: "destination" });

    expect(await screen.findByText("Tous vos portefeuilles sont archivés")).toBeInTheDocument();
    expect(optionPairs("import-portfolio-select").map(([value]) => value)).toEqual([""]);
  });
});
