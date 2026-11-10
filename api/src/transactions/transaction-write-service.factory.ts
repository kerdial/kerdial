import { eq } from "drizzle-orm";
import { tenant, type Db } from "@kerdial/platform-db";
import { CryptoRateResolver, FxRateResolver, TransactionWriteService } from "@kerdial/ledger";
import type { MarketRuntime } from "@kerdial/market-composition";
import {
  NotConfiguredFxRateProvider,
  NotConfiguredQuoteProvider,
} from "./not-configured-providers.js";

/**
 * Composes a per-request {@link TransactionWriteService} for one tenant —
 * `transactions.controller.ts`'s only path to one, so every write handler
 * builds it the same way.
 *
 * **`instrumentBackfillScheduler` is supplied from `MARKET_RUNTIME`** —
 * IB8. It used to be omitted outright ("the accepted phase-1 state ... the
 * trigger is latent by design"), which meant every one of
 * `TransactionWriteService#triggerInstrumentBackfill`'s seven call sites
 * returned at its first line: buying a *seeded catalogue* instrument — one
 * nobody ever created through `POST /instruments`, so the creation-time
 * trigger never ran for it either — requested no history at all, which is the
 * bug live testing found. The producer/worker concern that argument
 * rested on no longer applies: the API already holds a
 * `MarketRuntime` (`market-runtime.module.ts`, `global: true`), whose
 * `scheduler` is exactly the pg-boss-backed `IngestionScheduler` the two
 * *other* trigger sites (`POST /instruments`, the reconcile sweep) already use.
 *
 * `marketRuntime === null` (every existing suite's default, and any deployment
 * with no `INGESTION_DATABASE_URL`) ⇒ the dependency is **absent**, not
 * `undefined`-valued, and behaviour is byte-for-byte what it was before IB8.
 * The spread-when-present shape below is what keeps that true under
 * `exactOptionalPropertyTypes`; `?? undefined` would not compile.
 *
 * `clock` stays at its default (`systemClock`): the runtime's own clock is not
 * exposed on `MarketRuntime`, and NG8 forbids widening this composition beyond
 * what the trigger needs. Consequence, stated rather than discovered later —
 * `computeBackfillRequestedFrom` reads the real clock on this path, exactly as
 * it already does for `POST /instruments`.
 *
 * **The `FxRateProvider`/`QuoteProvider` are phase-1 stubs** — see
 * `not-configured-providers.ts`'s doc comment for the full reasoning (in
 * short: a real adapter cannot be wired in here without violating the
 * `api-no-market-adapters`/`ledger-no-market-adapters` dependency-cruiser
 * rules, and no other package is yet the composition root for a live
 * per-request write path). This is a known gap, stated here rather than
 * silently reconciled.
 */
export async function createTransactionWriteServiceForTenant(
  db: Db,
  tenantId: string,
  marketRuntime: MarketRuntime | null,
): Promise<TransactionWriteService> {
  const [row] = await db
    .select({ baseCurrency: tenant.baseCurrency })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  // `tenant` rows are created once, out of band (seeding/provisioning), never
  // by this API — a session whose own `tenant_id` does not resolve to a row
  // here would be a data-integrity bug elsewhere, not a client error this
  // function should try to recover from.
  if (!row) {
    throw new Error(`createTransactionWriteServiceForTenant: no tenant row for ${tenantId}`);
  }

  const fxRateResolver = new FxRateResolver({
    db,
    provider: new NotConfiguredFxRateProvider(),
    tenantId,
    baseCurrency: row.baseCurrency,
  });

  // IB8: spread-when-present, never `?? undefined` —
  // `TransactionWriteServiceDeps.instrumentBackfillScheduler` is optional and
  // this repo compiles under `exactOptionalPropertyTypes`, so an explicit
  // `undefined` is a type error rather than an absent property. This is also
  // the shape every other conditional dependency in this codebase uses.
  const scheduler = marketRuntime?.scheduler ?? null;

  return new TransactionWriteService({
    db,
    fxRateResolver,
    cryptoRateResolver: new CryptoRateResolver({
      db,
      provider: new NotConfiguredQuoteProvider(),
      fxRateResolver,
    }),
    ...(scheduler === null ? {} : { instrumentBackfillScheduler: scheduler }),
  });
}
