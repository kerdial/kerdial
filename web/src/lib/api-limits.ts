/**
 * Local mirror of server-side numeric caps this feature's UI copy needs to
 * reference (OD-6) — never re-exported from a shared package
 * (that would drag `ledger`/`valuation`'s runtime into `web`'s bundle graph,
 * see this module's own drift test for the layering argument in full).
 * Each constant below names its source constant and file; `api-limits.drift.test.ts`
 * asserts strict equality against the real thing by relative filesystem
 * import, so any future edit to either side that isn't mirrored on the other
 * fails a test rather than silently drifting.
 *
 * No UI copy anywhere in the codebase may hardcode any of these numbers
 * as a literal — every consumer imports from here.
 */

/** ← `ledger/src/portfolio-service.ts`'s `MAX_PORTFOLIOS_PER_TENANT`. */
export const MAX_PORTFOLIOS_PER_TENANT = 500;

/** ← `ledger/src/cash-account-service.ts`'s `MAX_CASH_ACCOUNTS_PER_PORTFOLIO` (F2). */
export const MAX_CASH_ACCOUNTS_PER_PORTFOLIO = 200;

/** ← `ledger/src/manual-price-service.ts`'s `MANUAL_PRICE_POINT_TENANT_ROW_CAP`. */
export const MANUAL_PRICE_POINT_TENANT_ROW_CAP = 500_000;

/** ← `ledger/src/manual-price-service.ts`'s `MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES`. */
export const MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES = 18;

/**
 * ← `ledger/src/instrument-icon-service.ts`'s
 * `INSTRUMENT_ICON_TENANT_ROW_CAP` (IK6, SD-5, FR-302).
 *
 * Mirrored here, with its drift-test case, for exactly the reason
 * `MANUAL_PRICE_POINT_TENANT_ROW_CAP` above is: the cap is enforced by a
 * `ledger` service and `web` may not import `ledger` at runtime.
 *
 * **This feature's four *other* numbers are deliberately not here.**
 * `INSTRUMENT_ICON_MAX_BYTES`, `INSTRUMENT_ICON_MAX_PIXELS`,
 * `INSTRUMENT_ICON_CONTENT_TYPES` and `INSTRUMENT_ICON_MAX_BASE64_CHARS` live
 * in `@kerdial/core-reference-data`, which `web` imports directly — so they
 * need no mirror and no drift test at all. Two homes, two precedents; stated
 * here as well as at the source because a reader who finds one of the two
 * halves first will otherwise read the split as an inconsistency.
 */
export const INSTRUMENT_ICON_TENANT_ROW_CAP = 500;

/** ← `valuation/src/holdings-valuation.ts`'s `MAX_HOLDINGS_PER_VIEW`. */
export const MAX_HOLDINGS_PER_VIEW = 1_000;

/** ← `valuation/src/holdings-valuation.ts`'s `MAX_REALIZED_GAINS_PER_HOLDING`. */
export const MAX_REALIZED_GAINS_PER_HOLDING = 1_000;

/**
 * ← `valuation/src/closed-positions-valuation.ts`'s
 * `MAX_CLOSED_POSITIONS_PER_VIEW` (FR-333/OD-4).
 *
 * Mirrored by value, server to here, for the reason this file's header gives —
 * and note the two caps below are **separate constants that happen to share
 * the holdings caps' value**, not aliases of them: the closed view enforces its
 * own pair over its own (for the combined view, *merged*) array, so a future
 * move of either number must not silently drag the other along. The drift test
 * asserts each against its own source export.
 */
export const MAX_CLOSED_POSITIONS_PER_VIEW = 1_000;

/** ← `valuation/src/closed-positions-valuation.ts`'s `MAX_SALE_LOTS_PER_CLOSED_POSITION` — see {@link MAX_CLOSED_POSITIONS_PER_VIEW}. */
export const MAX_SALE_LOTS_PER_CLOSED_POSITION = 1_000;

/**
 * ← `ledger/src/dividend-summary-service.ts`'s
 * `MAX_DIVIDEND_INSTRUMENTS_PER_VIEW` (DS-6, DV6).
 *
 * Mirrored **by value, in one direction only** — server to here — exactly as
 * `MAX_HOLDINGS_PER_VIEW` above is, and for the same layering reason this
 * file's own header gives: importing the real constant at runtime would drag
 * `ledger`'s runtime into `web`'s bundle graph. `api-limits.drift.test.ts`
 * imports the real export by relative filesystem path (a test-only import
 * `.dependency-cruiser.cjs` sanctions) and asserts strict equality, so the two
 * cannot drift silently.
 *
 * Exceeding it is a `422 DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE`, **never a
 * truncated `instruments[]`**: a truncated array would make the footer total
 * disagree with the rows above it, which is the one thing FR-270 forbids.
 */
export const MAX_DIVIDEND_INSTRUMENTS_PER_VIEW = 1_000;

/**
 * ← `ledger/src/watchlist-service.ts`'s `MAX_WATCHLIST_ITEMS_PER_TENANT`
 * (FR-340/FR-368).
 *
 * Mirrored by value, server to here, for the reason this file's header gives:
 * the cap is enforced by a `ledger` service and `web` may not import `ledger`
 * at runtime. The 201st distinct instrument is refused `429
 * WATCHLIST_TENANT_CAP_EXCEEDED` — and that refusal carries **no cap figure on
 * the wire** (the controller's own note: a second copy there would be a number
 * two sources could disagree about), so this mirror is the *only* place the
 * client's copy can read it from.
 */
export const MAX_WATCHLIST_ITEMS_PER_TENANT = 200;

/**
 * ← `ledger/src/watchlist-service.ts`'s `WATCHLIST_NOTE_MAX_LENGTH` (FR-341),
 * which itself mirrors the table's `watchlist_item_note_length` CHECK.
 *
 * Here so the note editor can bound its own field instead of discovering the
 * limit as a `400` — the same reason `MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES`
 * is mirrored rather than learned from a rejection.
 */
export const WATCHLIST_NOTE_MAX_LENGTH = 500;

/**
 * ← `ledger/src/watchlist-service.ts`'s
 * `WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES` (WL-1), which
 * itself names `watchlist_item.target_price`'s own `numeric(38, 18)` scale.
 *
 * Here so the inline editor can refuse a 19th fractional digit before it is
 * sent — the same reason `MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES` above
 * is mirrored, on the identical column type. A target beyond this scale is
 * not merely rejected: below 5e-19 Postgres would round it to zero, which is
 * how the finding surfaced as a 500.
 */
export const WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES = 18;

/**
 * ← `valuation/src/watchlist-valuation.ts`'s `WATCHLIST_SERIES_MAX_POINTS`
 * (W-9, FR-357).
 *
 * The number of points a row's embedded, decimated series can carry — display
 * data only, never the input to any figure. Mirrored because the row sparkline
 * is fed from that array and nothing else: a client that assumed a different
 * bound would either draw a truncated shape or claim a resolution the wire
 * does not have.
 */
export const WATCHLIST_SERIES_MAX_POINTS = 120;

/**
 * ← `api/src/auth/setup.schema.ts`'s `NEW_PASSWORD_MIN_LENGTH`
 * (`account-setup` LD-5, FR-396/FR-415/FR-422).
 *
 * Mirrored here for this file's own standing reason: `<AccountForm>`'s
 * 8-character hint (UR-68) and its before-any-network-call refusal both
 * reference the server's floor, and no UI copy may hardcode the digit. The
 * source is an `api` schema rather than a `ledger`/`valuation` service —
 * an `api` module rather than a `ledger`/`valuation` service — because the
 * rule is a request-contract bound, enforced by Zod on three routes
 * (`POST /auth/setup`, `POST /auth/password`, `POST /admin/users`).
 *
 * Note this is the floor for a password being **chosen**, never for one being
 * presented: `login.schema.ts`'s own 1–256 bound is deliberately untouched,
 * so an account whose password predates LD-5 can still sign in.
 */
export const NEW_PASSWORD_MIN_LENGTH = 8;

/**
 * ← `importer/src/limits.ts`'s `KERDIAL_JSON_LIMITS.maxFileBytes`
 * (KD4/KD6).
 *
 * The one ceiling the `/import` screen has to *state out loud*, and the reason
 * is that the catalogue export is a plain `<a href download>`
 * navigation, and a plain navigation cannot render a `413 EXPORT_TOO_LARGE`
 * body as anything but raw JSON. The remedy (`?icons=omitted`) is therefore
 * printed beside the link before the click — and printing a ceiling means
 * naming a number, which under this file's own standing rule means mirroring
 * it here rather than typing « 32 Mio » into a French sentence.
 *
 * It is a single value serving both directions: the same number bounds the
 * export the user downloads and the upload the import route accepts, because
 * a document this application refuses to read is not one it should hand out.
 */
export const KERDIAL_JSON_MAX_FILE_BYTES = 33_554_432;

/**
 * ← `platform/auth/src/access-token.ts`'s `ACCESS_TOKEN_MAX_ACTIVE` (MCP-L3).
 *
 * The « Accès pour assistants IA » card names the cap when the server refuses
 * an eleventh active token (`409 ACCESS_TOKEN_LIMIT_REACHED`), and naming a
 * number means mirroring it here rather than typing it into the sentence.
 */
export const ACCESS_TOKEN_MAX_ACTIVE = 10;
