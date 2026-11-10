// F4-style cross-package test-only import (precedent:
// `currency-scale.drift.test.ts`'s relative import of `platform/db`'s ISO
// 4217 seed source file). `.dependency-cruiser.cjs`'s
// `web-no-server-runtime-imports` rule excludes `*.test.ts(x)` from its
// `from` scope for exactly this pattern — no runtime dependency is added to
// `web/package.json`'s `dependencies` (only a devDependency, below, needed to
// make the *import itself* resolve — see that note).
//
// `import "reflect-metadata"` stays load-order-first defensively: the
// `api/src/...` imports below reach NestJS-adjacent modules, and any
// decorator evaluated at class-declaration time on that path needs the
// polyfill loaded before native `Reflect` (which has no `defineMetadata`) is
// consulted. `api/src/auth/public-decorator.test.ts` is this repo's
// precedent for the ordering requirement; `reflect-metadata` is a
// `web/package.json` devDependency purely so this test-only import path
// resolves — `vite build` never reaches `.test.ts` files, so no runtime
// dependency is added to the bundle.
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { MAX_PORTFOLIOS_PER_TENANT as sourceMaxPortfoliosPerTenant } from "../../../ledger/src/portfolio-service.js";
import { MAX_CASH_ACCOUNTS_PER_PORTFOLIO as sourceMaxCashAccountsPerPortfolio } from "../../../ledger/src/cash-account-service.js";
import {
  MANUAL_PRICE_POINT_TENANT_ROW_CAP as sourceManualPricePointTenantRowCap,
  MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES as sourceManualPricePointCloseMaxDecimalPlaces,
} from "../../../ledger/src/manual-price-service.js";
import {
  MAX_HOLDINGS_PER_VIEW as sourceMaxHoldingsPerView,
  MAX_REALIZED_GAINS_PER_HOLDING as sourceMaxRealizedGainsPerHolding,
} from "../../../valuation/src/holdings-valuation.js";
// `closed-positions`: the deep module path, exactly as
// `holdings-valuation.js` above is imported and deliberately **not** through
// `valuation/src/index.js`: the barrel would pull every valuation module into
// this test's graph (holdings, value-series, the DB loaders) to compare two
// integers, and the point of a drift guard is to name the file the constant
// actually lives in, so a failure says which source moved.
import {
  MAX_CLOSED_POSITIONS_PER_VIEW as sourceMaxClosedPositionsPerView,
  MAX_SALE_LOTS_PER_CLOSED_POSITION as sourceMaxSaleLotsPerClosedPosition,
} from "../../../valuation/src/closed-positions-valuation.js";
import { MAX_DIVIDEND_INSTRUMENTS_PER_VIEW as sourceMaxDividendInstrumentsPerView } from "../../../ledger/src/dividend-summary-service.js";
import { INSTRUMENT_ICON_TENANT_ROW_CAP as sourceInstrumentIconTenantRowCap } from "../../../ledger/src/instrument-icon-service.js";
import {
  MAX_WATCHLIST_ITEMS_PER_TENANT as sourceMaxWatchlistItemsPerTenant,
  WATCHLIST_NOTE_MAX_LENGTH as sourceWatchlistNoteMaxLength,
  WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES as sourceWatchlistTargetPriceMaxDecimalPlaces,
} from "../../../ledger/src/watchlist-service.js";
// The **declaring module**, not
// `valuation/src/index.js`, for the reason the `closed-positions` import above
// records: `WATCHLIST_SERIES_MAX_POINTS` is not on the barrel at all, and even
// if it were, a drift guard must name the file the constant lives in so a
// failure says which source moved.
import { WATCHLIST_SERIES_MAX_POINTS as sourceWatchlistSeriesMaxPoints } from "../../../valuation/src/watchlist-valuation.js";
import { NEW_PASSWORD_MIN_LENGTH as sourceNewPasswordMinLength } from "../../../api/src/auth/setup.schema.js";
// `portfolio-export-import` EI-34: the declaring module, not
// `@kerdial/importer`'s barrel — the same "name the file the constant lives
// in" rule every import above follows.
import { KERDIAL_JSON_LIMITS as sourceKerdialJsonLimits } from "../../../importer/src/limits.js";
import {
  MAX_PORTFOLIOS_PER_TENANT,
  MAX_CASH_ACCOUNTS_PER_PORTFOLIO,
  MANUAL_PRICE_POINT_TENANT_ROW_CAP,
  MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES,
  MAX_HOLDINGS_PER_VIEW,
  MAX_REALIZED_GAINS_PER_HOLDING,
  MAX_CLOSED_POSITIONS_PER_VIEW,
  MAX_SALE_LOTS_PER_CLOSED_POSITION,
  MAX_DIVIDEND_INSTRUMENTS_PER_VIEW,
  INSTRUMENT_ICON_TENANT_ROW_CAP,
  MAX_WATCHLIST_ITEMS_PER_TENANT,
  WATCHLIST_NOTE_MAX_LENGTH,
  WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES,
  WATCHLIST_SERIES_MAX_POINTS,
  NEW_PASSWORD_MIN_LENGTH,
  KERDIAL_JSON_MAX_FILE_BYTES,
} from "./api-limits.js";

/**
 * Drift guard for `api-limits.ts` (OD-6): every mirrored
 * constant is asserted against the real source constant, imported by
 * relative filesystem path, not merely re-typed from memory. A future edit
 * to either side that isn't mirrored on the other fails one of the
 * assertions below.
 */
describe("api-limits.ts — drift guard against the real server-side constants", () => {
  it("MAX_PORTFOLIOS_PER_TENANT matches ledger/src/portfolio-service.ts", () => {
    expect(MAX_PORTFOLIOS_PER_TENANT).toBe(sourceMaxPortfoliosPerTenant);
  });

  it("MAX_CASH_ACCOUNTS_PER_PORTFOLIO matches ledger/src/cash-account-service.ts", () => {
    expect(MAX_CASH_ACCOUNTS_PER_PORTFOLIO).toBe(sourceMaxCashAccountsPerPortfolio);
  });

  it("MANUAL_PRICE_POINT_TENANT_ROW_CAP matches ledger/src/manual-price-service.ts", () => {
    expect(MANUAL_PRICE_POINT_TENANT_ROW_CAP).toBe(sourceManualPricePointTenantRowCap);
  });

  it("MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES matches ledger/src/manual-price-service.ts", () => {
    expect(MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES).toBe(
      sourceManualPricePointCloseMaxDecimalPlaces,
    );
  });

  it("MAX_HOLDINGS_PER_VIEW matches valuation/src/holdings-valuation.ts", () => {
    expect(MAX_HOLDINGS_PER_VIEW).toBe(sourceMaxHoldingsPerView);
  });

  it("MAX_REALIZED_GAINS_PER_HOLDING matches valuation/src/holdings-valuation.ts", () => {
    expect(MAX_REALIZED_GAINS_PER_HOLDING).toBe(sourceMaxRealizedGainsPerHolding);
  });

  it("MAX_CLOSED_POSITIONS_PER_VIEW matches valuation/src/closed-positions-valuation.ts", () => {
    // FR-333: the server refuses an over-sized closed view with a 422 rather
    // than truncating it, so a mirror that drifted would have
    // `problem-messages.ts` name a cap the server does not enforce — the same
    // one-value-one-direction argument as every case above.
    expect(MAX_CLOSED_POSITIONS_PER_VIEW).toBe(sourceMaxClosedPositionsPerView);
  });

  it("MAX_SALE_LOTS_PER_CLOSED_POSITION matches valuation/src/closed-positions-valuation.ts", () => {
    // Asserted against its **own** source export, not against
    // `MAX_REALIZED_GAINS_PER_HOLDING`, even though the two are equal today:
    // they are separate server constants enforced over separate arrays (the
    // closed one over the *merged* list, R6), so an assertion that compared
    // the two mirrors to each other would go green on a real divergence.
    expect(MAX_SALE_LOTS_PER_CLOSED_POSITION).toBe(sourceMaxSaleLotsPerClosedPosition);
  });

  it("MAX_DIVIDEND_INSTRUMENTS_PER_VIEW matches ledger/src/dividend-summary-service.ts", () => {
    // DS-6: one value, one
    // direction of truth. The server refuses a scope holding more than this
    // many dividend-paying instruments with a 422 rather than truncating, so a
    // mirror that drifted low would have this screen's copy describe a cap the
    // server does not enforce — and a mirror that drifted high would describe
    // one it enforces earlier than stated.
    expect(MAX_DIVIDEND_INSTRUMENTS_PER_VIEW).toBe(sourceMaxDividendInstrumentsPerView);
  });

  it("INSTRUMENT_ICON_TENANT_ROW_CAP matches ledger/src/instrument-icon-service.ts", () => {
    // IK6 (SD-5): the
    // 501st distinct instrument's icon is refused with a 429, so a mirror that
    // drifted would have `problem-messages.ts` name a cap the server does not
    // enforce — the same one-value-one-direction argument as every case above.
    expect(INSTRUMENT_ICON_TENANT_ROW_CAP).toBe(sourceInstrumentIconTenantRowCap);
  });

  it("MAX_WATCHLIST_ITEMS_PER_TENANT matches ledger/src/watchlist-service.ts", () => {
    // FR-340/FR-368: the 201st
    // distinct instrument is refused `429 WATCHLIST_TENANT_CAP_EXCEEDED`, and
    // that problem body deliberately carries **no cap figure** — so this
    // mirror is the only number the client's copy can name, and a drift here
    // would have it describe a cap the server does not enforce.
    expect(MAX_WATCHLIST_ITEMS_PER_TENANT).toBe(sourceMaxWatchlistItemsPerTenant);
  });

  it("WATCHLIST_NOTE_MAX_LENGTH matches ledger/src/watchlist-service.ts", () => {
    // FR-341. The server constant itself mirrors the table's
    // `watchlist_item_note_length` CHECK, so a client that bounded its field
    // higher would turn a typed note into a `400` the user cannot act on.
    expect(WATCHLIST_NOTE_MAX_LENGTH).toBe(sourceWatchlistNoteMaxLength);
  });

  it("WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES matches ledger/src/watchlist-service.ts", () => {
    // WL-1. The server constant names `watchlist_item.target_price`'s
    // own `numeric(38, 18)` scale, and the editor refuses a 19th fractional
    // digit against this mirror — a mirror that drifted high would let the
    // client send a figure Postgres rounds (to zero below 5e-19, which is the
    // 500 this finding recorded), and one that drifted low would refuse a
    // target the server stores exactly.
    expect(WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES).toBe(
      sourceWatchlistTargetPriceMaxDecimalPlaces,
    );
  });

  it("WATCHLIST_SERIES_MAX_POINTS matches valuation/src/watchlist-valuation.ts", () => {
    // W-9/FR-357: the row sparkline is fed from the embedded, decimated series
    // and from nothing else, so this bound is what the client may claim about
    // that shape's resolution.
    expect(WATCHLIST_SERIES_MAX_POINTS).toBe(sourceWatchlistSeriesMaxPoints);
  });

  it("NEW_PASSWORD_MIN_LENGTH matches api/src/auth/setup.schema.ts", () => {
    // `account-setup` LD-5: `<AccountForm>` refuses a 7-character password
    // before any network call and says so in the field's own hint — both
    // read this number, so a server-side change of the floor that did not
    // reach here would ship a form that lies about the rule.
    expect(NEW_PASSWORD_MIN_LENGTH).toBe(sourceNewPasswordMinLength);
  });

  it("KERDIAL_JSON_MAX_FILE_BYTES matches importer/src/limits.ts", () => {
    // `portfolio-export-import`: the `/import` screen prints this ceiling
    // in French, beside the two export links, because a plain `<a download>`
    // navigation cannot render the `413 EXPORT_TOO_LARGE` body it would
    // otherwise be the user's only warning of. A server-side change of the
    // ceiling that did not reach here would ship a screen quoting the old one.
    expect(KERDIAL_JSON_MAX_FILE_BYTES).toBe(sourceKerdialJsonLimits.maxFileBytes);
  });
});
