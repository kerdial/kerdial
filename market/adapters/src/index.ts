/**
 * `market/adapters` — provider identity lives *only* in this module, never
 * in `ledger`/`valuation`/`api`. T-15 adds the
 * first real adapter, `ecb` (FX); `yahoo` (equities, then crypto too) lands in
 * T-31. The `coingecko` crypto adapter T-32 added has since been retired: its
 * free tier capped history at 365 days, and Yahoo serves the same coins with
 * no cap.
 *
 * No module outside this package may import it — enforced by the root
 * dependency-cruiser config, `.dependency-cruiser.cjs` (`ledger`,
 * `valuation`, and `api` are all forbidden from importing `market/adapters`;
 * `valuation` may not import `market/ports` at all).
 */
export * from "./ecb/index.js";
export * from "./yahoo/index.js";
