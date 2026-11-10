import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "@kerdial/importer";
import type { MarketRuntime } from "@kerdial/market-composition";
import type { ProviderSymbolMatch } from "@kerdial/market-ports";
import { instrument, tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";

/**
 * `csv-import` CI-16 — `ImportDiscoveryPort` bound to the real
 * `MarketRuntime.discovery`, which is the whole reason `importer` can be
 * forbidden from importing any `market/*` package at all (ID1).
 *
 * ## What "the real binding" means here, and what it does not
 *
 * The `MarketRuntime` below is a hand-written fake, the same shape
 * `instruments-discovery.e2e.test.ts` uses for the interactive route. What is
 * **not** faked is the thing under test: `createImportDiscoveryPort` and
 * its wiring into `planImport`. Every case below goes through the real
 * adapter, the real `DiscoveryBudget`, the real proposals/echo-back mechanism
 * and the real HTTP route — a stub port would have bypassed all four.
 *
 * The adapter is not a pass-through, and that is asserted rather than assumed:
 * `ProviderSymbolMatch.providerExchangeCode` is the *provider's own* exchange
 * taxonomy, and `market/ports`' own rule is that it must never be written to an
 * instrument directly. The adapter maps it through `core/reference-data`'s
 * curated table, so `"NMS"` becomes `XNAS` and an unrecognised code becomes
 * `null` — both halves are cases below.
 *
 * **CI-16's acceptance criterion asks for this to be shown by watching the
 * shared provider token bucket drain, and this file does not do that.**
 * `market/composition`'s index exports `createMarketRuntime` and nothing else
 * that can build a guarded discovery lane (`createDiscoveryProvider` and
 * `createDiscovery` are internal), and `api-no-market-adapters` forbids
 * reaching a real provider adapter from here — so constructing the real bucket
 * in an `api` test would mean widening another package's public surface for a
 * test. Reported as a deviation rather than papered over. What is asserted
 * instead is stronger than "compiles": the fake counts the calls it receives,
 * and the response's own `discoveryCallsIssued` — computed independently by
 * `importer`'s budget — must agree with that count.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(
  here,
  "..",
  "..",
  "importer",
  "src",
  "__fixtures__",
  "portfolio-performance",
);

const encoder = new TextEncoder();
const BOM = "\uFEFF";
const CRLF = "\u000D\u000A";

const ASSETS_HEADER =
  "ISIN;WKN;Symbole boursier;Nom du titre;Devise;Note;Total Expense Ratio (TER);Assets under Management;Vendor;Acquisition Fee (percentage);Management Fee (percentage)";

/**
 * The committed assets fixture with the discovery port **unwired**, counted
 * by hand from its 27 rows: 12 created (eleven tickers whose suffix names an
 * exchange, plus Coca-Cola's `CCC3.DE`), 1 `INSTRUMENT_ALREADY_EXISTS`
 * (`SU.PA`, in the shipped catalogue) and 14
 * `EXCHANGE_MIC_LOOKUP_UNAVAILABLE` (seven unsuffixed US tickers, `NESM.F`,
 * `RHM.F`, four coins and the out-of-scope `SCPIDEMO01`). Re-derived by this
 * file's own unwired case rather than trusted, and used as the baseline the
 * wired case is compared against.
 */
const UNWIRED_ASSETS_UNAVAILABLE = 14;

/**
 * Fabricated, check-digit-valid ISINs that are deliberately absent from the
 * seeded reference catalogue, with tickers carrying no suffix `SYMBOL_SUFFIX_TO_MIC`
 * knows — so every one of them reaches discovery rather than being resolved
 * from the suffix table for free.
 */
const UNRESOLVED_ISINS = [
  "FR0090000011",
  "FR0090000029",
  "FR0090000037",
  "FR0090000045",
  "FR0090000052",
] as const;

function assetsFile(isins: readonly string[]): Buffer {
  const lines = isins.map(
    (isin, index) => `${isin};;TCK${String(index)};Company number ${String(index)};EUR;;;;;;`,
  );
  return Buffer.from(encoder.encode(BOM + [ASSETS_HEADER, ...lines].join(CRLF) + CRLF));
}

interface Lookup {
  readonly kind: string;
  readonly query: string;
}

/**
 * A `MarketRuntime` whose discovery records every lookup and answers with one
 * candidate carrying `providerExchangeCode`. `exchangeCodeFor` decides what —
 * `null` means "answered, with no exchange code", which is a different fact
 * from "no answer" and reaches a different reason code.
 */
function countingRuntime(
  calls: Lookup[],
  options: {
    readonly exchangeCodeFor?: (query: string) => string | null;
    /** `false` means "answered, and found nothing" — `resolve()`'s own port contract for an unknown query, not an error. */
    readonly respondsTo?: (kind: string, query: string) => boolean;
  } = {},
): MarketRuntime {
  const exchangeCodeFor = options.exchangeCodeFor ?? (() => "NMS");
  const respondsTo = options.respondsTo ?? (() => true);
  const search = async (params: {
    kind: string;
    query: string;
  }): Promise<ProviderSymbolMatch[]> => {
    calls.push({ kind: params.kind, query: params.query });
    if (!respondsTo(params.kind, params.query)) return Promise.resolve([]);
    const code = exchangeCodeFor(params.query);
    return Promise.resolve([
      {
        providerSymbol: `PS-${params.query}`,
        displayName: `Discovered ${params.query}`,
        currency: "EUR",
        matchQuality: "EXACT" as const,
        ...(code === null ? {} : { providerExchangeCode: code }),
      },
    ]);
  };
  return {
    discovery: { search },
    scheduler: null,
    enqueueBackfill: async () => {},
    async start() {},
    async stop() {},
  } as unknown as MarketRuntime;
}

/**
 * Rows in the shared catalogue. `instrument` carries no `tenant_id`, so this is
 * a count over every tenant's view of it — which is the point: the empty-resolutions bug's
 * write would have been visible to all of them.
 */
async function countInstruments(app: TestApp): Promise<number> {
  const rows = await app.ownerDb.select({ id: instrument.id }).from(instrument);
  return rows.length;
}

interface Harness {
  readonly app: TestApp;
  post: (
    file: Buffer,
    fields?: Readonly<Record<string, string>>,
  ) => ReturnType<ReturnType<typeof supertest>["post"]>;
}

describe("api — the import discovery binding (csv-import CI-16)", () => {
  const started: TestApp[] = [];

  async function startHarness(options: {
    readonly marketRuntime: MarketRuntime | null;
    readonly importLimits?: ImportLimits;
  }): Promise<Harness> {
    const app = await startTestApp({
      marketRuntime: options.marketRuntime,
      ...(options.importLimits === undefined ? {} : { importLimits: options.importLimits }),
    });
    started.push(app);
    const server = (): ReturnType<typeof supertest> => supertest(app.built.app.getHttpServer());
    const tenantId = randomUUID();
    const email = `discovery-${randomUUID()}@example.com`;
    const password = "correct horse battery staple discovery";
    await app.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(app.db, { id: randomUUID(), tenantId, email, password });
    const session: SessionCookies = await loginAs(server(), email, password);

    return {
      app,
      post: (file, fields = { mode: "DRY_RUN" }) => {
        let request = server()
          .post("/api/v1/imports/instruments")
          .set("Cookie", [
            `${SID_COOKIE_NAME}=${session.sid}`,
            `${CSRF_COOKIE_NAME}=${session.csrf}`,
          ])
          .set(CSRF_HEADER_NAME, session.csrf);
        for (const [name, value] of Object.entries(fields)) request = request.field(name, value);
        return request.attach("file", file, { filename: "assets.csv", contentType: "text/csv" });
      },
    };
  }

  afterAll(async () => {
    for (const app of started) await app.stop();
  }, 60_000);

  describe("a DRY_RUN reaches the bound runtime; the confirm reaches nothing", () => {
    const calls: Lookup[] = [];
    let harness: Harness;

    beforeAll(async () => {
      harness = await startHarness({ marketRuntime: countingRuntime(calls) });
    }, 120_000);

    it("issues one lookup per unresolvable row, through the real adapter, and maps the provider code through the curated table", async () => {
      const before = calls.length;
      const response = await harness.post(assetsFile(UNRESOLVED_ISINS));
      expect(response.status).toBe(200);

      // Two independently-derived counts of the same fact: the fake's own
      // tally, and `importer`'s budget counter carried in the response. A
      // binding that was merely compiled would leave both at zero; a binding
      // that reported without calling would leave them disagreeing.
      const issued = calls.length - before;
      expect(issued).toBe(UNRESOLVED_ISINS.length);
      expect(response.body.discoveryCallsIssued).toBe(UNRESOLVED_ISINS.length);
      expect(
        calls
          .slice(before)
          .map((call) => call.query)
          .sort(),
      ).toEqual([...UNRESOLVED_ISINS].sort());
      // The pipeline asks by ISIN for an identifier-carrying row, at rule K's
      // proposed kind — not by name, and not for a kind it invented.
      expect(new Set(calls.slice(before).map((call) => call.kind))).toEqual(new Set(["SHARE"]));

      // `"NMS"` is the *provider's* code; `XNAS` is the ISO 10383 MIC
      // `core/reference-data`'s curated table maps it to. The raw string must
      // never appear.
      expect(response.body.imported).toBe(UNRESOLVED_ISINS.length);
      const proposals = response.body.proposals as {
        index: number;
        exchangeMic: string;
        micSource: string;
        kind: string;
      }[];
      expect(proposals).toHaveLength(UNRESOLVED_ISINS.length);
      for (const proposal of proposals) {
        expect(proposal.exchangeMic).toBe("XNAS");
        expect(proposal.exchangeMic).not.toBe("NMS");
        expect(proposal.micSource).toBe("DISCOVERY");
        expect(proposal.kind).toBe("SHARE");
      }
    });

    it("APPLY with the dry run's resolutions echoed back issues exactly zero lookups", async () => {
      const dryRun = await harness.post(assetsFile(UNRESOLVED_ISINS));
      expect(dryRun.status).toBe(200);
      const proposals = dryRun.body.proposals as unknown[];
      expect(proposals.length).toBeGreaterThan(0);

      const before = calls.length;
      const apply = await harness.post(assetsFile(UNRESOLVED_ISINS), {
        mode: "APPLY",
        resolutions: JSON.stringify(proposals),
      });
      expect(apply.status).toBe(200);

      // The decisive property: zero, from both counters.
      expect(calls.length - before).toBe(0);
      expect(apply.body.discoveryCallsIssued).toBe(0);
      // And it was a real confirm, not a no-op: the instruments were created.
      expect(apply.body.imported).toBe(UNRESOLVED_ISINS.length);
      expect(apply.body.applyFailed).toBe(0);
    });

    it("an APPLY carrying `resolutions: []` issues ZERO lookups and creates nothing", async () => {
      // The finding's own reproduction, over real HTTP. `resolutions` is
      // *present* (so the schema's `APPLY` requirement is satisfied) and
      // *empty*, which used to select the dry-run branch inside a write pass:
      // live provider lookups, `CREATE` outcomes at `micSource: "DISCOVERY"`,
      // and `applyImport` persisting them into `instrument` — a table with no
      // `tenant_id` and no RLS.
      //
      // **The ISINs are this case's own, and that is load-bearing.** The
      // earlier cases in this describe already created `UNRESOLVED_ISINS` in
      // the catalogue, and `resolveOneAssetRow` checks the catalogue *before*
      // spending a lookup (the re-run economy) — so re-using them would
      // have let the buggy dry-run branch answer `INSTRUMENT_ALREADY_EXISTS`
      // with zero calls, and the counter assertion below could not have gone
      // red. Measured: it did not, until these two ISINs were separated out.
      const own = ["FR0090000086", "FR0090000094"] as const;
      const before = calls.length;
      const instrumentsBefore = await countInstruments(harness.app);

      const apply = await harness.post(assetsFile(own), {
        mode: "APPLY",
        resolutions: JSON.stringify([]),
      });
      expect(apply.status).toBe(200);

      // The acceptance criterion, on a counter — the fake's own tally and
      // `importer`'s independently-derived one.
      expect(calls.length - before).toBe(0);
      expect(apply.body.discoveryCallsIssued).toBe(0);
      // And it wrote nothing: not "no DISCOVERY-sourced row", no row at all.
      expect(apply.body.imported).toBe(0);
      expect(apply.body.byReason.RESOLUTION_NOT_CONFIRMED).toBe(own.length);
      expect(await countInstruments(harness.app)).toBe(instrumentsBefore);
    });

    it("POSITIVE COMPANION: the same file, same harness, still resolves on a DRY_RUN and still creates on a populated APPLY", async () => {
      // Without this, the case above would pass against a pipeline that had
      // simply stopped importing anything. Same fake, same file, both halves
      // measured on the same counter.
      const isins = ["FR0090000060", "FR0090000078"] as const;
      const beforeDryRun = calls.length;
      const dryRun = await harness.post(assetsFile(isins));
      expect(dryRun.status).toBe(200);
      expect(calls.length - beforeDryRun).toBe(isins.length);
      expect(dryRun.body.discoveryCallsIssued).toBe(isins.length);

      const instrumentsBefore = await countInstruments(harness.app);
      const beforeApply = calls.length;
      const apply = await harness.post(assetsFile(isins), {
        mode: "APPLY",
        resolutions: JSON.stringify(dryRun.body.proposals),
      });
      expect(apply.status).toBe(200);
      expect(calls.length - beforeApply).toBe(0);
      expect(apply.body.imported).toBe(isins.length);
      expect(await countInstruments(harness.app)).toBe(instrumentsBefore + isins.length);
    });

    it("rejects a row that is present in the file but absent from the confirmed resolutions", async () => {
      // **This case's ISINs are its own, for the reason the empty-resolutions
      // case's are** — and the reason now binds harder. Every `UNRESOLVED_ISINS` row
      // was created in the catalogue by the echoed-back `APPLY` above, and an
      // unlisted row is now re-decided against the catalogue before it is
      // refused, so re-using them here would assert `RESOLUTION_NOT_CONFIRMED`
      // against rows that are legitimately `INSTRUMENT_ALREADY_EXISTS` — the
      // assertion would be measuring the catalogue, not the confirmed list.
      // Measured: it did exactly that until these three were separated out.
      const own = ["FR0090000102", "FR0090000110", "FR0090000128"] as const;
      const before = calls.length;
      const response = await harness.post(assetsFile(own), {
        mode: "APPLY",
        resolutions: JSON.stringify([
          {
            index: 0,
            action: "CREATE",
            kind: "SHARE",
            kindSource: "USER",
            nameSuggestsFund: false,
            label: "AI.PA",
            exchangeMic: "XPAR",
            micSource: "USER",
            matchQuality: null,
          },
        ]),
      });
      expect(response.status).toBe(200);
      expect(response.body.byReason.RESOLUTION_NOT_CONFIRMED).toBe(own.length - 1);
      expect(calls.length - before).toBe(0);
      expect(response.body.discoveryCallsIssued).toBe(0);
      // The positive companion: the one row that *was* reviewed still got
      // created, so "refused" is a statement about the unlisted rows and not
      // about a confirm that now refuses everything.
      expect(response.body.imported).toBe(1);
    });

    it("a file whose rows are all already catalogued reports the SAME triple on the confirm as on its dry run", async () => {
      // `UNRESOLVED_ISINS` are in the catalogue by now — the echoed-back
      // `APPLY` above created all five, through this same pipeline. Re-posting
      // the identical file is the ordinary "I imported this once already"
      // journey, and `ImportWizard.tsx` posts `summary.proposals ?? []` for it,
      // which is `[]` because `proposals` carries only `CREATE` rows.
      //
      // Previously the confirm answered five `RESOLUTION_NOT_CONFIRMED`
      // rejects while its own dry run answered five `INSTRUMENT_ALREADY_EXISTS`
      // skips: one file, one server, two summaries, and no client-side
      // workaround, since the wizard never synthesises `action: "SKIP"`
      // resolutions for catalogued rows.
      const beforeDryRun = calls.length;
      const dryRun = await harness.post(assetsFile(UNRESOLVED_ISINS));
      expect(dryRun.status).toBe(200);
      expect(dryRun.body.byReason.INSTRUMENT_ALREADY_EXISTS).toBe(UNRESOLVED_ISINS.length);
      expect(dryRun.body.proposals ?? []).toEqual([]);

      const beforeApply = calls.length;
      const apply = await harness.post(assetsFile(UNRESOLVED_ISINS), {
        mode: "APPLY",
        resolutions: JSON.stringify(dryRun.body.proposals ?? []),
      });
      expect(apply.status).toBe(200);

      // IMP-AC-14, field by field over the whole summary rather than over one
      // reason code.
      for (const field of ["imported", "skipped", "rejected", "byReason"] as const) {
        expect(apply.body[field]).toEqual(dryRun.body[field]);
      }
      expect(apply.body.skipped).toBe(UNRESOLVED_ISINS.length);
      expect(apply.body.rejected).toBe(0);
      expect(apply.body.applyFailed).toBe(0);

      // The empty-resolutions invariant, on the fake's own tally and on `importer`'s counter,
      // for both halves. The same fake counted five calls earlier in this same
      // describe, so a zero here is a fact about the catalogue check and not
      // about a runtime that stopped being reachable.
      expect(beforeApply - beforeDryRun).toBe(0);
      expect(calls.length - beforeApply).toBe(0);
      expect(dryRun.body.discoveryCallsIssued).toBe(0);
      expect(apply.body.discoveryCallsIssued).toBe(0);
    });
  });

  describe("an answered lookup with no mappable exchange code is not a guess", () => {
    const calls: Lookup[] = [];
    let harness: Harness;

    beforeAll(async () => {
      // `"ZZZ"` is not in `PROVIDER_EXCHANGE_CODE_TO_MIC`, so the adapter maps
      // it to `null` rather than passing it through.
      harness = await startHarness({
        marketRuntime: countingRuntime(calls, { exchangeCodeFor: () => "ZZZ" }),
      });
    }, 120_000);

    it("reports EXCHANGE_MIC_NOT_RESOLVED — never the provider's own code", async () => {
      const response = await harness.post(assetsFile(UNRESOLVED_ISINS));
      expect(response.status).toBe(200);
      expect(response.body.discoveryCallsIssued).toBe(UNRESOLVED_ISINS.length);
      expect(response.body.byReason.EXCHANGE_MIC_NOT_RESOLVED).toBe(UNRESOLVED_ISINS.length);
      // The distinction that matters operationally: "the lookup answered and
      // gave nothing usable" (give up) is not "no lookup was available"
      // (re-run).
      expect(response.body.byReason.EXCHANGE_MIC_LOOKUP_UNAVAILABLE).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain("ZZZ");
    });
  });

  describe("with no MarketRuntime wired, the import still completes", () => {
    let harness: Harness;

    beforeAll(async () => {
      harness = await startHarness({ marketRuntime: null });
    }, 120_000);

    it("reports every unresolved row as EXCHANGE_MIC_LOOKUP_UNAVAILABLE and answers 200", async () => {
      const response = await harness.post(assetsFile(UNRESOLVED_ISINS));
      expect(response.status).toBe(200);
      expect(response.body.discoveryCallsIssued).toBe(0);
      expect(response.body.byReason.EXCHANGE_MIC_LOOKUP_UNAVAILABLE).toBe(UNRESOLVED_ISINS.length);
      expect(response.body.imported).toBe(0);
    });

    it("re-measures the committed assets fixture with discovery unwired — Batch C's own recorded figure", async () => {
      // This case pins the *unwired* half so the wired one below has
      // something to be compared against: 12 created, 1 already catalogued,
      // 14 left for a lookup that is not wired.
      const bytes = readFileSync(join(FIXTURE_DIR, "assets.csv"));
      const response = await harness.post(bytes);
      expect(response.status).toBe(200);
      expect(response.body.rowCount).toBe(27);
      expect(response.body.imported).toBe(12);
      expect(response.body.byReason.INSTRUMENT_ALREADY_EXISTS).toBe(1);
      expect(response.body.byReason.EXCHANGE_MIC_LOOKUP_UNAVAILABLE).toBe(
        UNWIRED_ASSETS_UNAVAILABLE,
      );
      expect(response.body.discoveryCallsIssued).toBe(0);
    });
  });

  describe("the committed assets fixture, with discovery bound (the re-measurement CI-16 owes)", () => {
    const calls: Lookup[] = [];
    let harness: Harness;

    beforeAll(async () => {
      // A crypto lane that knows coins and does not know an unlisted French
      // real-estate fund is the faithful stand-in here: a stub that answered
      // *every* query would resolve the fixture's out-of-scope row too, and
      // this case's numbers would then be a property of the stub rather than
      // of the pipeline. The four tickers are the fixture's own crypto rows;
      // their names ("Bitcoin", …) are deliberately not in the set, so each
      // coin answers only on its second (ticker) query.
      const coins = new Set(["BTC", "ETH", "ADA", "SOL"]);
      harness = await startHarness({
        marketRuntime: countingRuntime(calls, {
          respondsTo: (kind, query) => kind !== "CRYPTO" || coins.has(query),
        }),
      });
    }, 120_000);

    it("moves the EXCHANGE_MIC_LOOKUP_UNAVAILABLE count from 14 to 2, and spends the whole lookup budget doing it", async () => {
      const bytes = readFileSync(join(FIXTURE_DIR, "assets.csv"));
      const response = await harness.post(bytes);
      expect(response.status).toBe(200);
      expect(response.body.rowCount).toBe(27);

      // **Counted by hand, then confirmed on this run.** The fixture needs
      // more lookups than `IMPORT_DISCOVERY_LOOKUP_BUDGET` (16) allows one
      // request: an equity row costs one call and a row with no identifier
      // costs two (queried by name, then by ticker). In file order: the nine
      // equity rows (KO, JNJ, PG, DIS, HD, PEP, MCD, NESM.F, RHM.F) spend 9,
      // BTC, ETH and ADA 2 each (15), SOL's name query is the 16th — so SOL
      // and the out-of-scope row never get their turn and report the code
      // whose documented remedy is to run the file again, which the importer
      // allows for and whose re-run economy (the catalogue check runs before
      // any lookup) makes cheap. 12 + 9 + 3 = 24 created, 1 skipped, 2
      // rejected.
      expect(response.body.imported).toBe(24);
      expect(response.body.rejected).toBe(2);
      expect(response.body.byReason).toEqual({
        EXCHANGE_MIC_LOOKUP_UNAVAILABLE: 2,
        INSTRUMENT_ALREADY_EXISTS: 1,
      });
      expect(UNWIRED_ASSETS_UNAVAILABLE).toBe(14);
      expect(response.body.byReason.EXCHANGE_MIC_LOOKUP_UNAVAILABLE).toBeLessThan(
        UNWIRED_ASSETS_UNAVAILABLE,
      );

      // Both counters agree, and the budget is the binding constraint.
      expect(response.body.discoveryCallsIssued).toBe(calls.length);
      expect(response.body.discoveryCallsIssued).toBe(DEFAULT_IMPORT_LIMITS.discoveryLookupBudget);
    });
  });

  describe("IMPORT_DISCOVERY_LOOKUP_BUDGET binds through HTTP, at two values (CI-19)", () => {
    const tightCalls: Lookup[] = [];
    const looseCalls: Lookup[] = [];
    let tight: Harness;
    let loose: Harness;

    beforeAll(async () => {
      tight = await startHarness({
        marketRuntime: countingRuntime(tightCalls),
        importLimits: { ...DEFAULT_IMPORT_LIMITS, discoveryLookupBudget: 2 },
      });
      loose = await startHarness({
        marketRuntime: countingRuntime(looseCalls),
        importLimits: { ...DEFAULT_IMPORT_LIMITS, discoveryLookupBudget: 4 },
      });
    }, 240_000);

    it("spends exactly the budget, and the unavailable count falls by exactly the difference", async () => {
      const file = assetsFile(UNRESOLVED_ISINS);

      const atTwo = await tight.post(file);
      const atFour = await loose.post(file);
      expect(atTwo.status).toBe(200);
      expect(atFour.status).toBe(200);

      // The stub's own tally and the response's counter, at both values.
      expect(tightCalls).toHaveLength(2);
      expect(looseCalls).toHaveLength(4);
      expect(atTwo.body.discoveryCallsIssued).toBe(2);
      expect(atFour.body.discoveryCallsIssued).toBe(4);

      // The downstream effect, which is what proves the constant binds rather
      // than merely being read: two more lookups means two fewer rows that
      // could not be looked up.
      const unavailableAtTwo = atTwo.body.byReason.EXCHANGE_MIC_LOOKUP_UNAVAILABLE as number;
      const unavailableAtFour = atFour.body.byReason.EXCHANGE_MIC_LOOKUP_UNAVAILABLE as number;
      expect(unavailableAtTwo).toBe(UNRESOLVED_ISINS.length - 2);
      expect(unavailableAtFour).toBe(UNRESOLVED_ISINS.length - 4);
      expect(unavailableAtTwo - unavailableAtFour).toBe(2);
    });
  });
  /**
   * The empty-resolutions bug's **non-adversarial** trigger: nothing here is hand-crafted, the
   * request is the one `ImportWizard.tsx` itself builds.
   *
   * `ImportWizard.tsx:190` does `setResolutions(summary.proposals ?? [])` and
   * `:212` posts that array. `toImportSummaryResponse` omits `proposals`
   * entirely when it is empty, so a dry run whose discovery budget was spent
   * before any row resolved leaves the wizard holding `[]` — a review screen
   * with nothing to create, and a « Confirmer l'import » that posts
   * `resolutions: []`. On the shipped code the server then re-ran discovery
   * with a **fresh** budget and created instruments the review step never
   * displayed.
   */
  describe("the budget-exhausted wizard path, replayed exactly as the wizard builds it", () => {
    const calls: Lookup[] = [];
    let harness: Harness;

    beforeAll(async () => {
      harness = await startHarness({
        marketRuntime: countingRuntime(calls),
        // Zero, so the dry run cannot resolve a single row and `proposals` is
        // necessarily empty. The confirm then gets a budget of its own — which
        // is the half of the defect that made it exploitable rather than
        // merely wasteful.
        importLimits: { ...DEFAULT_IMPORT_LIMITS, discoveryLookupBudget: 0 },
      });
    }, 120_000);

    it("a dry run that resolved nothing, then the wizard's own confirm, writes nothing and calls nobody", async () => {
      const file = assetsFile(UNRESOLVED_ISINS);
      const dryRun = await harness.post(file);
      expect(dryRun.status).toBe(200);
      // The precondition this case exists for, asserted rather than assumed:
      // the wizard really is left with an empty list.
      expect(dryRun.body.proposals).toBeUndefined();
      expect(dryRun.body.byReason.EXCHANGE_MIC_LOOKUP_UNAVAILABLE).toBe(UNRESOLVED_ISINS.length);
      expect(dryRun.body.imported).toBe(0);

      // Verbatim `ImportWizard.tsx:190` + `:212`.
      const wizardResolutions = dryRun.body.proposals ?? [];
      expect(wizardResolutions).toEqual([]);

      // Red-confirm note, recorded because it is not obvious: with the
      // length-based inference restored, *this* case goes red on
      // `RESOLUTION_NOT_CONFIRMED` (the rows come back
      // `EXCHANGE_MIC_LOOKUP_UNAVAILABLE` from a second dry run) and **not** on
      // the call counter — a budget of zero bounds the wrongly-taken second
      // pass too. The counter half of the criterion is red-confirmed by the
      // `resolutions: []` case above, which runs with a live budget.
      const instrumentsBefore = await countInstruments(harness.app);
      const before = calls.length;
      const confirm = await harness.post(file, {
        mode: "APPLY",
        resolutions: JSON.stringify(wizardResolutions),
      });
      expect(confirm.status).toBe(200);
      expect(calls.length - before).toBe(0);
      expect(confirm.body.discoveryCallsIssued).toBe(0);
      expect(confirm.body.imported).toBe(0);
      expect(confirm.body.byReason.RESOLUTION_NOT_CONFIRMED).toBe(UNRESOLVED_ISINS.length);
      expect(await countInstruments(harness.app)).toBe(instrumentsBefore);
    });

    it("POSITIVE COMPANION: raising the budget on the same file makes the same wizard flow create rows", async () => {
      // Proves the case above is the *budget* being empty, not this harness
      // being incapable of importing anything.
      const generousCalls: Lookup[] = [];
      const generous = await startHarness({
        marketRuntime: countingRuntime(generousCalls),
        importLimits: { ...DEFAULT_IMPORT_LIMITS, discoveryLookupBudget: 5 },
      });
      const file = assetsFile(UNRESOLVED_ISINS);
      const dryRun = await generous.post(file);
      expect(dryRun.status).toBe(200);
      expect(generousCalls).toHaveLength(UNRESOLVED_ISINS.length);
      const wizardResolutions = dryRun.body.proposals ?? [];
      expect(wizardResolutions).toHaveLength(UNRESOLVED_ISINS.length);

      const instrumentsBefore = await countInstruments(generous.app);
      const confirm = await generous.post(file, {
        mode: "APPLY",
        resolutions: JSON.stringify(wizardResolutions),
      });
      expect(confirm.status).toBe(200);
      expect(confirm.body.imported).toBe(UNRESOLVED_ISINS.length);
      expect(confirm.body.discoveryCallsIssued).toBe(0);
      expect(await countInstruments(generous.app)).toBe(
        instrumentsBefore + UNRESOLVED_ISINS.length,
      );
    }, 240_000);
  });
});
