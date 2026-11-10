/**
 * DI token for the `MarketRuntime | null` value `main.ts` constructs (via
 * `@kerdial/market-composition`'s `createMarketRuntime`) and
 * `AppModule.forRoot`/`MarketRuntimeModule.forRoot` inject — the same shape
 * `DB` (`../db/db.tokens.ts`) and `CSRF_SECRET` (`../auth/csrf-token.ts`) use
 * for an externally-constructed, non-class dependency.
 */
export const MARKET_RUNTIME = Symbol("MARKET_RUNTIME");
