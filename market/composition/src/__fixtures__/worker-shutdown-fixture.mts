/**
 * SH-16 GATE-3 fixture — a **real worker process**, with a **real pg-boss**
 * against a **real Postgres**, whose job handler is genuinely still running
 * when the parent test sends a **real SIGTERM** (AC-11).
 *
 * This is deliberately not the SH-9 fixture's shape. That one stubs the whole
 * runtime, so it proves only that `worker-main.ts` passes
 * `{ graceful: true, timeoutSeconds: 25 }` at its own call site — a property
 * that would hold identically if pg-boss ignored the options entirely. AC-11
 * is about the *job*: "the in-flight job completing ... never an abandoned
 * 'active' row left inconsistent by an abrupt kill". So everything below the
 * entrypoint is real; only the HTTPS-bound provider is a port-typed fake,
 * because this environment intercepts outbound HTTPS.
 *
 * Contract with the parent (all on stdout, one token per line):
 *   READY <path>     the readiness marker exists — every queue is registered
 *   FETCH_STARTED    the quote-refresh handler is inside `provider.fetchLatest`
 *   FETCH_DONE       that fetch returned; the write follows immediately
 *
 * Env: `INGESTION_DATABASE_URL`, `WORKER_READY_FILE`, `SH16_FETCH_DELAY_MS`.
 */
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import type {
  InstrumentRef,
  IsoDate,
  PriceObservation,
  ProviderCapabilities,
  ProviderSymbol,
  ProviderSymbolMatch,
  QuoteObservation,
  QuoteProvider,
} from "@kerdial/market-ports";
import { createMarketRuntime } from "../market-runtime.js";
import { startWorker } from "../worker-main.js";

const FETCH_DELAY_MS = Number(process.env["SH16_FETCH_DELAY_MS"] ?? "6000");

/** The only fake in the process: a `QuoteProvider` whose `fetchLatest` takes a known, long time. */
const slowProvider: QuoteProvider = {
  capabilities(): ProviderCapabilities {
    return {
      key: YAHOO_PROVIDER_KEY,
      assetKinds: ["SHARE"],
      supportsLatestQuote: true,
      supportsDailyHistory: true,
      supportsCorporateActions: false,
      maxHistoryYears: "unbounded",
      quoteQuality: "DELAYED",
      delayMinutes: 0,
      batchSize: 5,
    };
  },
  async resolve(_ref: InstrumentRef): Promise<ProviderSymbolMatch[]> {
    return [];
  },
  async fetchLatest(symbols: ProviderSymbol[]): Promise<QuoteObservation[]> {
    console.log("FETCH_STARTED");
    await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
    console.log("FETCH_DONE");
    return symbols.map((symbol) => ({
      symbol,
      price: new Decimal("13.37"),
      currency: "EUR",
      asOf: new Date().toISOString(),
      quality: "DELAYED",
      sourceKey: YAHOO_PROVIDER_KEY,
    }));
  },
  async fetchDailyHistory(
    _symbol: ProviderSymbol,
    _from: IsoDate,
    _to: IsoDate,
  ): Promise<PriceObservation[]> {
    return [];
  },
};

const handle = await startWorker({
  // The real factory, the real registrations, the real pg-boss — only the
  // provider is swapped, through the seam `createMarketRuntime` already has.
  createRuntime: (config) =>
    createMarketRuntime({
      ...config,
      providerOverrides: { [YAHOO_PROVIDER_KEY]: slowProvider },
    }),
  log: (message) => console.log(message),
});

console.log(`READY ${handle.readyFilePath}`);
