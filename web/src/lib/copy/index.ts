import { ACCESS_TOKENS_COPY } from "./access-tokens.js";
import { ACCOUNT_COPY } from "./account.js";
import { ACTIVITY_COPY } from "./activity.js";
import { ADMIN_COPY } from "./admin.js";
import { AUTH_COPY } from "./auth.js";
import { CASH_COPY } from "./cash.js";
import { COMMON_COPY } from "./common.js";
import { CLOSED_POSITIONS_COPY } from "./closed-positions.js";
import { CONTROLS_COPY } from "./controls.js";
import { CURRENCIES_COPY } from "./currencies.js";
import { DIVIDEND_COPY } from "./dividends.js";
import { FIGURE_COPY } from "./figures.js";
import { FORM_COPY } from "./forms.js";
import { GLOSSARY_COPY, GLOSSARY_HINT_COPY } from "./glossary.js";
import { OVERVIEW_COPY } from "./overview.js";
import { PERFORMANCE_COPY } from "./performance.js";
import { PORTFOLIO_COPY } from "./portfolios.js";
import { PRICE_GAP_COPY } from "./price-gap.js";
import { RATE_PRESET_COPY } from "./rate-presets.js";
import { SHELL_COPY } from "./shell.js";
import { TRANSACTION_DETAIL_COPY } from "./transaction-detail.js";
import { HOLDINGS_COPY } from "./holdings.js";
import { IMPORT_COPY } from "./imports.js";
import { INSTRUMENT_COPY } from "./instruments.js";
import { PREVIEW_GAP_COPY, TRANSACTION_COPY } from "./transactions.js";
import { WATCHLIST_COPY } from "./watchlist.js";

/**
 * `web/src/lib/copy/` — the UI's copy catalogue.
 *
 * Decided 2026-08-21: Kerdial ships in French, and English follows later.
 * The spec keeps multi-language UI a phase-1 non-goal —
 * amended by this issue to *French-only **shipped**, copy layer extractable*,
 * which is a much smaller claim than a second locale. **There is no locale
 * switcher, no second table and no i18n dependency here, deliberately.** This
 * is scaffolding: the value it delivers today is that every string a user
 * reads has one home, one key and one audit, instead of being welded to a JSX
 * node in one of eighty-eight components.
 *
 * ## Shape
 *
 * One module per screen or domain, each exporting a single flat
 * `Readonly<Record<Key, string>>` written `as const satisfies`. That is
 * `empty-states.ts`'s shape and `Icon.tsx`'s REGISTRY argument: a union of
 * literal key types means **forgetting an entry is a type error, not a blank
 * space at runtime**, and `as const` keeps the literal string types for the
 * few call sites that compare against them.
 *
 * Not one flat 800-key map — the module boundary is what makes
 * `controls-copy-audit.test.ts` able to say "nothing *on the Contrôles screen*
 * implies an audit trail" while the Activity screen is free to call itself a
 * journal.
 *
 * Interpolation is a `{slot}` pattern filled by `fill.ts`, never a number or a
 * date formatted here — see that file's header.
 *
 * ## What is deliberately NOT in this directory
 *
 * The copy modules that already sit in `web/src/lib/`:
 * `problem-messages.ts` (server error codes → French), `import-copy.ts`,
 * `empty-states.ts`, `history-status-copy.ts`, `control-rows.ts`. They were
 * extracted, typed and audited before this issue existed, and moving them
 * would be churn that breaks their own citations for nothing. They are copy
 * catalogues; this is one more of them, for the strings that had no home.
 *
 * ## The gate
 *
 * `kerdial-copy/no-hardcoded-copy` (eslint-rules/no-hardcoded-copy.mjs) fails
 * on a user-facing literal in `components/` or `routes/`. It ran at `warn`
 * while the sweep was in flight, counted 787 → 0 by `copy-adoption.test.ts`
 * across nine slices, and became an `error` at zero — the token gate's own
 * ratchet, for the same reason and with the same ending (the adoption test is
 * deleted; `copy-lint.test.ts` keeps proving the rule still fires).
 *
 * **What the gate does not reach, stated so it is not mistaken for coverage.**
 * The rule flags copy at the *point of render*: JSX text, a literal rendered
 * as a child, and a literal in one of 27 named text-carrying attributes. A
 * handful of module-level keyed tables stay beside their single consumer —
 * `TRANSACTION_KIND_LABELS` (`LedgerFilterBar.tsx`), `KIND_LABELS`/`SUBTITLES`
 * (`InstrumentsView.tsx`), `STEP_LABELS` (`ImportWizard.tsx`),
 * `BUCKET_LABELS` (`control-rows.ts`) and a few composed `aria-label`
 * builders. Each is already typed, documented and keyed; they are catalogues
 * that happen to live next to their caller, not literals welded into JSX, and
 * moving them is a separate decision rather than this issue's.
 */
export const COPY_CATALOGUE = {
  accessTokens: ACCESS_TOKENS_COPY,
  account: ACCOUNT_COPY,
  activity: ACTIVITY_COPY,
  admin: ADMIN_COPY,
  auth: AUTH_COPY,
  cash: CASH_COPY,
  closedPositions: CLOSED_POSITIONS_COPY,
  common: COMMON_COPY,
  controls: CONTROLS_COPY,
  currencies: CURRENCIES_COPY,
  dividends: DIVIDEND_COPY,
  figures: FIGURE_COPY,
  forms: FORM_COPY,
  glossary: GLOSSARY_COPY,
  glossaryHint: GLOSSARY_HINT_COPY,
  holdings: HOLDINGS_COPY,
  imports: IMPORT_COPY,
  instruments: INSTRUMENT_COPY,
  overview: OVERVIEW_COPY,
  performance: PERFORMANCE_COPY,
  portfolios: PORTFOLIO_COPY,
  priceGap: PRICE_GAP_COPY,
  ratePresets: RATE_PRESET_COPY,
  shell: SHELL_COPY,
  transactions: TRANSACTION_COPY,
  transactionPreviewGaps: PREVIEW_GAP_COPY,
  transactionDetail: TRANSACTION_DETAIL_COPY,
  watchlist: WATCHLIST_COPY,
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Every catalogued string, flattened and labelled `domain.key`.
 *
 * The handle the copy audits scan. They audit *rendered strings*, so this
 * returns values rather than source text: a banned claim added as a catalogue
 * entry has to fail the same audit it would have failed inline.
 */
export function catalogueEntries(): readonly (readonly [string, string])[] {
  return Object.entries(COPY_CATALOGUE).flatMap(([domain, table]) =>
    Object.entries(table).map(([key, value]) => [`${domain}.${key}`, value] as const),
  );
}
