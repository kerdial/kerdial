import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Route } from "@playwright/test";
import type { RoutableTarget } from "./mocks.js";

/**
 * Fixtures and route mocks for the `/import` wizard's Playwright specs
 * (CI-23).
 *
 * ## The files are the real committed fixture, not a synthetic string
 *
 * `setInputFiles` points at `importer/src/__fixtures__/portfolio-performance/`
 * — the same three synthetic files every server-side import test measures
 * against. A hand-rolled two-line CSV would have made the multipart
 * assertions below pass over a body no real import ever produces (the
 * investment file is 38 lines in the export's own BOM/CRLF/U+202F bytes),
 * and the whole point of the content-type assertion is that it is made
 * against a genuine upload.
 *
 * ## The counts are the server's for those files, not round numbers
 *
 * In particular the assets file is **24 imported / 1 skipped / 2 rejected**,
 * not 27/0/0: two rows never get a discovery lookup because the file needs
 * more than one request's own budget, and re-running is the designed remedy.
 * Pinning the honest triple here is what gives the wizard's "relancez
 * l'import" line something real to be asserted against.
 */
const here = dirname(fileURLToPath(import.meta.url));

export const IMPORT_FIXTURES = {
  assets: join(
    here,
    "..",
    "..",
    "importer",
    "src",
    "__fixtures__",
    "portfolio-performance",
    "assets.csv",
  ),
  cash: join(
    here,
    "..",
    "..",
    "importer",
    "src",
    "__fixtures__",
    "portfolio-performance",
    "cash.csv",
  ),
  investment: join(
    here,
    "..",
    "..",
    "importer",
    "src",
    "__fixtures__",
    "portfolio-performance",
    "investment.csv",
  ),
} as const;

export interface ImportSummaryFixture {
  mode: "DRY_RUN" | "APPLY";
  fileType: "ASSETS" | "CASH_ACCOUNT_TRANSACTIONS" | "INVESTMENT_ACCOUNT_TRANSACTIONS";
  rowCount: number;
  imported: number;
  skipped: number;
  rejected: number;
  byReason: Record<string, number>;
  rows: {
    line: number;
    index: number;
    outcome: "SKIP" | "REJECT";
    reason: string;
    message: string;
    /**
     * What the row said, so a reason is findable in the user's own file. Shaped
     * exactly like the server's `ImportRowSourceResponse`; `null` for a row
     * `parse` never produced.
     */
    source: {
      shape: "INSTRUMENT" | "CASH_MOVEMENT" | "DIVIDEND" | "TRADE";
      tradeDate: string | null;
      direction: "IN" | "OUT" | "ACQUIRE" | "DISPOSE" | null;
      instrument: string | null;
      amount: string | null;
      currency: string | null;
      quantity: string | null;
    } | null;
  }[];
  rowsTruncated: boolean;
  proposals?: {
    index: number;
    action: "CREATE" | "SKIP";
    kind: "SHARE" | "ETF" | "FUND" | "CRYPTO" | "INDEX";
    kindSource: "EXPENSE_RATIO" | "DISCOVERY" | "DEFAULT" | "USER";
    nameSuggestsFund: boolean;
    label: string | null;
    exchangeMic: string | null;
    micSource: "SUFFIX_TABLE" | "DISCOVERY" | "USER";
    matchQuality: "EXACT" | "PROBABLE" | null;
  }[];
  applyFailed: number;
  applyNotAttempted: number;
  discoveryCallsIssued: number;
}

/** The assets file's triple: the discovery budget binds, so two rows are left for a re-run. */
export function assetsSummary(mode: "DRY_RUN" | "APPLY"): ImportSummaryFixture {
  const unavailable = (index: number, instrument: string) => ({
    line: index + 2,
    index,
    outcome: "REJECT" as const,
    reason: "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
    message: "no lookup was available within this request's budget and deadline",
    source: {
      shape: "INSTRUMENT" as const,
      tradeDate: null,
      direction: null,
      instrument,
      amount: null,
      currency: "EUR",
      quantity: null,
    },
  });
  return {
    mode,
    fileType: "ASSETS",
    rowCount: 27,
    imported: 24,
    skipped: 1,
    rejected: 2,
    byReason: { INSTRUMENT_ALREADY_EXISTS: 1, EXCHANGE_MIC_LOOKUP_UNAVAILABLE: 2 },
    rows: [
      {
        line: 13,
        index: 11,
        outcome: "SKIP",
        reason: "INSTRUMENT_ALREADY_EXISTS",
        message: "this listing is already in the instrument catalogue",
        source: {
          shape: "INSTRUMENT",
          tradeDate: null,
          direction: null,
          instrument: "SU.PA",
          amount: null,
          currency: "EUR",
          quantity: null,
        },
      },
      unavailable(25, "SOL"),
      unavailable(26, "SCPIDEMO01"),
    ],
    rowsTruncated: false,
    proposals: [
      {
        index: 0,
        action: "CREATE",
        kind: "ETF",
        kindSource: "EXPENSE_RATIO",
        nameSuggestsFund: false,
        label: "IWDA.AS",
        exchangeMic: "XAMS",
        micSource: "SUFFIX_TABLE",
        matchQuality: null,
      },
      {
        index: 4,
        action: "CREATE",
        kind: "SHARE",
        // A live case: no TER in the file, so rule K defaulted to SHARE
        // while the row's own name says « ETC ».
        kindSource: "DEFAULT",
        nameSuggestsFund: true,
        label: "PPFB.DE",
        exchangeMic: "XETR",
        micSource: "SUFFIX_TABLE",
        matchQuality: null,
      },
    ],
    applyFailed: 0,
    applyNotAttempted: 0,
    // The decisive property: a confirm re-uses the reviewed list and calls
    // no provider at all.
    discoveryCallsIssued: mode === "DRY_RUN" ? 16 : 0,
  };
}

/** 18 imported / 33 covered by the investment file / 1 zero-value dividend marker. */
export function cashSummary(mode: "DRY_RUN" | "APPLY"): ImportSummaryFixture {
  return {
    mode,
    fileType: "CASH_ACCOUNT_TRANSACTIONS",
    rowCount: 52,
    imported: 18,
    skipped: 34,
    rejected: 0,
    byReason: { COVERED_BY_INVESTMENT_FILE: 33, ZERO_VALUE_DIVIDEND_MARKER: 1 },
    // No `COVERED_BY_INVESTMENT_FILE` entry: the server counts OD-1's
    // cross-file skip and stops enumerating it (33 identical rows would bury
    // the one that needs a word). Its total stays in `byReason` above, and the
    // UI states it in one sentence.
    rows: [
      {
        line: 30,
        index: 28,
        outcome: "SKIP",
        reason: "ZERO_VALUE_DIVIDEND_MARKER",
        message:
          "the source records a zero-value dividend line, which carries no cash leg to import",
        source: {
          shape: "DIVIDEND",
          tradeDate: "2022-11-15",
          direction: null,
          instrument: "ISP.MI",
          amount: "0",
          currency: "EUR",
          quantity: null,
        },
      },
    ],
    rowsTruncated: false,
    applyFailed: 0,
    applyNotAttempted: 0,
    discoveryCallsIssued: 0,
  };
}

/** 34 imported / 3 trades of an unresolvable listing. */
export function investmentSummary(mode: "DRY_RUN" | "APPLY"): ImportSummaryFixture {
  const unresolved = (
    index: number,
    tradeDate: string,
    direction: "ACQUIRE" | "DISPOSE",
    quantity: string,
  ) => ({
    line: index + 2,
    index,
    outcome: "REJECT" as const,
    reason: "INSTRUMENT_NOT_RESOLVED",
    message: "no instrument matched this row",
    source: {
      shape: "TRADE" as const,
      tradeDate,
      direction,
      instrument: "NESM.F",
      amount: null,
      currency: "EUR",
      quantity,
    },
  });
  return {
    mode,
    fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
    rowCount: 37,
    imported: 34,
    skipped: 0,
    rejected: 3,
    byReason: { INSTRUMENT_NOT_RESOLVED: 3 },
    rows: [
      unresolved(6, "2021-06-14", "ACQUIRE", "10"),
      unresolved(13, "2022-04-04", "ACQUIRE", "5"),
      unresolved(17, "2022-09-29", "DISPOSE", "5"),
    ],
    rowsTruncated: false,
    applyFailed: 0,
    applyNotAttempted: 0,
    discoveryCallsIssued: 0,
  };
}

/** One intercepted upload, kept whole so a spec can assert on what actually arrived. */
export interface RecordedUpload {
  readonly url: string;
  readonly contentType: string;
  readonly mode: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly filename: string;
}

/**
 * Reads the multipart body Playwright captured, without a parser.
 *
 * This is deliberately crude — a regex over the raw part headers — because
 * anything richer would need the boundary to be *given* to it, and the boundary
 * is precisely what is under test (CI-21: `apiFetch` used to stamp
 * `application/json` on a `FormData` body, leaving the server with no boundary
 * at all). Reading the parts straight out of the body proves the browser
 * generated real multipart, not merely that the client intended to.
 */
function readParts(body: string): { fields: Record<string, string>; filename: string } {
  const fields: Record<string, string> = {};
  let filename = "";
  const partPattern =
    /name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r\n]+\r\n)?\r\n([\s\S]*?)\r\n--/g;
  let match: RegExpExecArray | null;
  while ((match = partPattern.exec(body)) !== null) {
    const [, name, file, value] = match;
    if (file !== undefined) {
      filename = file;
      continue;
    }
    fields[name!] = value!;
  }
  return { fields, filename };
}

export interface ImportRouteMocks {
  /** Every upload the browser actually issued, in order. */
  readonly uploads: () => RecordedUpload[];
}

/**
 * Registers both import routes, answering each with the summary its file type
 * and `mode` predict.
 *
 * `context.route`, never `page.route`: every `/api/v1/**` request runs under a
 * controlling service worker (`vite.config.ts`'s `NetworkOnly` rule) whose own
 * `fetch` handler issues the request regardless of a page-level registration —
 * this repository's own recorded flake root cause.
 */
export async function mockImportRoutes(target: RoutableTarget): Promise<ImportRouteMocks> {
  const uploads: RecordedUpload[] = [];

  async function answer(route: Route, summaryFor: (mode: "DRY_RUN" | "APPLY") => unknown) {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = request.postData() ?? "";
    const { fields, filename } = readParts(body);
    const mode = fields["mode"] ?? "";
    uploads.push({
      url: request.url(),
      contentType: request.headers()["content-type"] ?? "",
      mode,
      fields,
      filename,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(summaryFor(mode === "APPLY" ? "APPLY" : "DRY_RUN")),
    });
  }

  await target.route("**/api/v1/imports/instruments", (route) => answer(route, assetsSummary));
  await target.route("**/api/v1/imports/transactions", (route) =>
    answer(route, (mode) => {
      const fileType = readParts(route.request().postData() ?? "").fields["fileType"];
      return fileType === "INVESTMENT_ACCOUNT_TRANSACTIONS"
        ? investmentSummary(mode)
        : cashSummary(mode);
    }),
  );

  return { uploads: () => uploads };
}

/**
 * The CI-21 assertion, made where it is strongest: on the request the **server
 * side of the wire** received, in a real browser, after a real `FormData`
 * serialisation.
 */
export function expectMultipartWithBoundary(upload: RecordedUpload): void {
  const [mediaType, boundaryParam] = upload.contentType.split(";").map((part) => part.trim());
  expect(mediaType).toBe("multipart/form-data");
  const boundary = /^boundary=(.+)$/.exec(boundaryParam ?? "")?.[1];
  expect(boundary, `no boundary in ${upload.contentType}`).toBeTruthy();
  expect((boundary ?? "").length).toBeGreaterThan(0);
}

/* ────────────────  `portfolio-export-import` — the Kerdial pair  ──────────────── */

/**
 * The Kerdial fixtures (EI-37).
 *
 * The **CSV is the real committed fixture** the server-side tests measure
 * against (`importer/src/__fixtures__/kerdial-csv/minimal-tier.csv`), for the
 * reason the header of this file already gives for the three
 * Portfolio-Performance files: an upload assertion made against a hand-rolled
 * two-line string proves nothing about a real multipart body.
 *
 * The **catalogue has no committed fixture at this branch point** — the
 * round-trip document AC-425 calls for is EI-17's, not this batch's — so the
 * JSON one is built here, inline and minimal, and said so out loud rather than
 * dressed up as a corpus file. Nothing parses it: both Kerdial routes are
 * mocked below, so the bytes only have to be a genuine `.json` upload for the
 * client-side type check and the multipart boundary to be exercised.
 */
export const KERDIAL_FIXTURES = {
  transactions: join(
    here,
    "..",
    "..",
    "importer",
    "src",
    "__fixtures__",
    "kerdial-csv",
    "minimal-tier.csv",
  ),
} as const;

export const KERDIAL_CATALOGUE_UPLOAD = {
  name: "kerdial-instruments.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      exportedAt: "2026-09-24T00:00:00.000Z",
      instruments: [],
      portfolios: [],
      fxRatesUser: [],
    }),
    "utf8",
  ),
} as const;

export interface KerdialSummaryOverrides {
  readonly imported?: number;
  readonly skipped?: number;
  readonly rejected?: number;
  readonly byReason?: Record<string, number>;
  readonly applyNotAttempted?: number;
}

/**
 * A catalogue summary: `rows: []`, `entries` and `sections` present — the shape
 * `POST /imports/kerdial/catalogue` answers with, and the one the wizard must
 * render through the per-entry table rather than the row table.
 */
export function kerdialCatalogueSummary(
  mode: "DRY_RUN" | "APPLY",
  overrides: KerdialSummaryOverrides = {},
): unknown {
  return {
    mode,
    fileType: "KERDIAL_CATALOGUE",
    rowCount: 15,
    imported: overrides.imported ?? 13,
    skipped: overrides.skipped ?? 1,
    rejected: overrides.rejected ?? 1,
    byReason: overrides.byReason ?? {
      CATALOGUE_ENTRY_UNCHANGED: 1,
      PROVIDER_MAPPING_CONFLICT: 1,
    },
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
    applyFailed: 0,
    applyNotAttempted: overrides.applyNotAttempted ?? 0,
    discoveryCallsIssued: 0,
  };
}

/** A Kerdial transactions summary: rows, no entries, no sections. */
export function kerdialTransactionsSummary(
  mode: "DRY_RUN" | "APPLY",
  overrides: KerdialSummaryOverrides = {},
): unknown {
  return {
    mode,
    fileType: "KERDIAL_TRANSACTIONS",
    rowCount: 9,
    imported: overrides.imported ?? 7,
    skipped: overrides.skipped ?? 1,
    rejected: overrides.rejected ?? 1,
    byReason: overrides.byReason ?? { ALREADY_IMPORTED: 1, DRIP_SOURCE_NOT_RESOLVED: 1 },
    rows: [
      {
        line: 8,
        index: 6,
        outcome: "REJECT",
        reason: "DRIP_SOURCE_NOT_RESOLVED",
        message: "the reinvested dividend was not found in this file",
        source: {
          shape: "DRIP",
          tradeDate: "2026-03-08",
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
    applyNotAttempted: overrides.applyNotAttempted ?? 0,
    discoveryCallsIssued: 0,
  };
}

export interface KerdialRouteMocks {
  readonly uploads: () => RecordedUpload[];
  /** Replaces the next answer with a `problem+json` refusal — the whole-file failures. */
  readonly refuseNextWith: (status: number, code: string) => void;
  /** Replaces the summary builder, so one test can walk a file across several applies. */
  readonly answerWith: (
    build: (route: "catalogue" | "transactions", mode: "DRY_RUN" | "APPLY") => unknown,
  ) => void;
}

/**
 * The two Kerdial routes, recorded and answered.
 *
 * `context.route`, never `page.route`, for the reason this file's
 * {@link mockImportRoutes} already records: a controlling service worker's own
 * `fetch` handler bypasses page-level interception.
 */
export async function mockKerdialImportRoutes(target: RoutableTarget): Promise<KerdialRouteMocks> {
  const uploads: RecordedUpload[] = [];
  let refusal: { status: number; code: string } | null = null;
  let build: (route: "catalogue" | "transactions", mode: "DRY_RUN" | "APPLY") => unknown = (
    which,
    mode,
  ) => (which === "catalogue" ? kerdialCatalogueSummary(mode) : kerdialTransactionsSummary(mode));

  async function answer(route: Route, which: "catalogue" | "transactions") {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const { fields, filename } = readParts(request.postData() ?? "");
    const mode = fields["mode"] === "APPLY" ? "APPLY" : "DRY_RUN";
    uploads.push({
      url: request.url(),
      contentType: request.headers()["content-type"] ?? "",
      mode,
      fields,
      filename,
    });
    if (refusal !== null) {
      const { status, code } = refusal;
      refusal = null;
      await route.fulfill({
        status,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "refused",
          status,
          code,
          detail: "an English, technical sentence the UI must never render",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(build(which, mode)),
    });
  }

  await target.route("**/api/v1/imports/kerdial/catalogue", (route) => answer(route, "catalogue"));
  await target.route("**/api/v1/imports/kerdial/transactions", (route) =>
    answer(route, "transactions"),
  );

  return {
    uploads: () => uploads,
    refuseNextWith: (status, code) => {
      refusal = { status, code };
    },
    answerWith: (next) => {
      build = next;
    },
  };
}
