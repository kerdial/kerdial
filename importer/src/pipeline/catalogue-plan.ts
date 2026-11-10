import { isValidIsinCheckDigit } from "@kerdial/api-contracts";
import type { Decimal } from "@kerdial/core-decimal";
import type { InstrumentIconContentType } from "@kerdial/core-reference-data";
import {
  MAX_CASH_ACCOUNTS_PER_PORTFOLIO,
  MAX_PORTFOLIOS_PER_TENANT,
  findInstrumentsByIdentity,
  getInstrumentById,
  getProviderMapping,
  listCashAccountsWithBalances,
  listCurrencies,
  listPortfolios,
  listUserFxRates,
  type InstrumentRecord,
} from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";

import { PARSE_REJECT_REASONS, type CurrencyCode, type IsoDate } from "../types.js";
import type {
  CatalogueCashAccountEntry,
  CatalogueDraft,
  CatalogueEntryProblem,
  CatalogueEntryRef,
  CatalogueFxRateEntry,
  CatalogueInstrumentEntry,
  CataloguePortfolioEntry,
} from "../formats/kerdial-json/index.js";
import { indexCatalogue } from "./instrument-resolution.js";
import type { CatalogueIconValidator } from "./catalogue-ports.js";

/**
 * `planCatalogue` — the read-and-decide half of the catalogue pipeline.
 *
 * **Everything in this directory is scanned by `pnpm import-vocabulary-gate`,
 * comments included; the gate strips nothing.** No source column name and no
 * type label from any export format may appear in this file, in code or in
 * prose.
 *
 * ## Why this is not `planImport`
 *
 * The catalogue gets its own plan stage, and the reason is structural rather than stylistic:
 * `planImport` is transaction-row machinery end to end — a per-row fingerprint,
 * a chronological apply order, a two-target planned write, a write batch. A
 * catalogue entry has **no trade date, no fingerprint, no recompute and no write
 * batch**, so forcing it through would mean a third planned-write target whose
 * every other field is `null` and an order that sorts on a date that does not
 * exist. The two stages are format-agnostic in exactly the same way the existing
 * ones are: they consume a {@link CatalogueDraft} and never JSON text, which is
 * why `catalogue-plan.neutral.test.ts` drives the whole of this file from a
 * hand-built literal with no document anywhere in it.
 *
 * The one import from `formats/` below is **type-only** and is the draft
 * vocabulary itself; no value, no schema and no parser crosses that line.
 *
 * ## What this stage reads, and why every read is here rather than in `apply`
 *
 * The bounded-transaction rule: no provider call, no queue
 * operation and no CPU-heavy work inside an RLS transaction. So the whole
 * read-and-decide half happens **before** any write is attempted —
 *
 *  1. one `listPortfolios`, indexed by name (L11's merge key);
 *  2. one `listCashAccountsWithBalances` per portfolio the draft names **and the
 *     destination already has** — a portfolio being created has no accounts to
 *     read;
 *  3. one batched `findInstrumentsByIdentity` over the draft's whole distinct
 *     identity set, indexed in memory by `indexCatalogue` — the same single
 *     round trip the transaction files already buy, reused rather than
 *     re-derived;
 *  4. one `getInstrumentById` per instrument that resolved, because the batched
 *     identity read returns identity columns only and SD-15's merge has to
 *     compare the fields it is about to write (a read of ~one row per resolved
 *     instrument, on the primary key, outside any transaction);
 *  5. one `listCurrencies`, so an unknown currency is a named per-entry reject
 *     rather than a foreign-key violation on the write path;
 *  6. one `listUserFxRates` over the currencies the draft names.
 *
 * **No provider call, ever.** Unlike the transaction files, a catalogue entry's
 * identity is **explicit** — the document carries the exchange code — so none of
 * `instrument-resolution.ts`'s suffix table, discovery budget or
 * proposal-confirmed-on-apply machinery is needed, and deliberately none of it
 * is used. `indexCatalogue` is: it is the format-neutral half, and re-deriving
 * an in-memory identity index beside it would be the parallel implementation
 * L12 exists to prevent. One consequence follows and is worth stating: a dry run
 * and a confirm of the same document compute the **same** plan, so this stage
 * takes no mode and echoes back no proposals.
 *
 * ## The merge rule (SD-15), and the one place this file reads it narrowly
 *
 * "The file wins on a user-editable attribute; provider-refreshable data is
 * never touched." Applied to every attribute the file **carries**. An attribute
 * the file does **not** carry is left alone rather than cleared, and that is a
 * decision with a measured reason rather than a softening: `instrument` is
 * **shared** reference data in phase 1 (one row, every tenant — `ledger`'s own
 * `updateInstrumentClassification` says so and calls it C27 territory), so
 * clearing a classification because *my* document omits it would delete another
 * tenant's correction. The format's "omitted when absent, never `null`" rule gives the
 * document no way to distinguish "not set" from "clear this", so the
 * non-destructive reading is the only safe one.
 */

/** The catalogue skip code. A skip is an entry that is well-formed and that the destination already agrees with. */
export const CATALOGUE_SKIP_REASONS = [
  /** Every field this entry carries is already the destination's value, so there is nothing to write. */
  "CATALOGUE_ENTRY_UNCHANGED",
] as const;

export type CatalogueSkipReason = (typeof CATALOGUE_SKIP_REASONS)[number];

/**
 * The catalogue reject codes: the six `parse`/`validate` can reach, plus the
 * ones that need a database or a write.
 *
 * **A separate closed set from `plan.ts`'s `IMPORT_REJECT_REASONS`, and
 * deliberately so.** That vocabulary is about *rows* of a transactions file —
 * every code in it describes something about a trade — and this one is about
 * *entities* of a catalogue. Where the two genuinely name the same remedy the
 * **same literal** is used (`PORTFOLIO_CAP_EXCEEDED`, `CASH_ACCOUNT_CAP_EXCEEDED`,
 * `APPLY_FAILED`, `APPLY_NOT_ATTEMPTED`, and the six parse codes), so the
 * user-facing copy table has one entry per remedy rather than one per stage.
 *
 * `PRIVATE_INSTRUMENT_UNSUPPORTED` is **not** in the original list and is this
 * task's own addition, on a measurement made at implementation time: `owner_tenant_id`
 * has **no writer anywhere in the repository** — no `ledger` service takes it,
 * `createInstrumentByIsin`/`createInstrumentBySymbol` do not carry it, and
 * `findInstrumentsByIdentity`/`listInstruments`/`getInstrumentById` all filter
 * `owner_tenant_id IS NULL`. So FR-530/SD-7's "recreated owned by the importing
 * tenant" has no code path to run through, and the honest answer for an entry
 * that asks for one is a named refusal rather than a silent write into the
 * shared catalogue, which is the one thing FR-530 forbids in as many words.
 * Closing it needs an additive `ownerTenantId` on the two create paths, which
 * is a `ledger` change outside this module.
 */
export const CATALOGUE_REJECT_REASONS = [
  ...PARSE_REJECT_REASONS,
  /** Two catalogue rows in the destination match this entry's identity — a human has to say which (never a guess). */
  "INSTRUMENT_AMBIGUOUS",
  /** The icon bytes were refused; the shipped validator's own code rides in the message. */
  "ICON_REJECTED",
  /** This tenant is at `INSTRUMENT_ICON_TENANT_ROW_CAP`. */
  "ICON_CAP_EXCEEDED",
  /** This tenant is at `MAX_WATCHLIST_ITEMS_PER_TENANT`. */
  "WATCHLIST_CAP_EXCEEDED",
  /** This tenant is at `MANUAL_PRICE_POINT_TENANT_ROW_CAP`. */
  "MANUAL_PRICE_CAP_EXCEEDED",
  /** A currency code the destination's own currency table does not carry. */
  "CURRENCY_UNKNOWN",
  /** The pinned provider symbol already belongs to a **different** instrument in the destination. */
  "PROVIDER_MAPPING_CONFLICT",
  /** This tenant is at `MAX_PORTFOLIOS_PER_TENANT`. */
  "PORTFOLIO_CAP_EXCEEDED",
  /** This portfolio is at `MAX_CASH_ACCOUNTS_PER_PORTFOLIO`. */
  "CASH_ACCOUNT_CAP_EXCEEDED",
  /** An existing account of this name in this portfolio holds a different currency, which is immutable (SD-14). */
  "CASH_ACCOUNT_CURRENCY_MISMATCH",
  /** The entry asks for a tenant-private instrument, for which no write path exists. See this constant's doc comment. */
  "PRIVATE_INSTRUMENT_UNSUPPORTED",
  /** The write was attempted and the ledger refused it — `apply`'s only two codes, as in `plan.ts`. */
  "APPLY_FAILED",
  /** The time budget ran out before this entry's turn. */
  "APPLY_NOT_ATTEMPTED",
] as const;

export type CatalogueRejectReason = (typeof CATALOGUE_REJECT_REASONS)[number];

/**
 * The catalogue's warning codes: something worth telling the
 * user about an entry that **is** written in full.
 *
 * A third closed set, beside skips and rejects, because a warning means the
 * opposite of both: `byReason`, `rejected` and `partsRefused` all count what
 * was *not* written, and a warned entry was. So a warning is never counted
 * there, and never turns an `IMPORT` into anything else.
 */
export const CATALOGUE_WARNING_CODES = [
  /**
   * The ISIN fails the ISO 6166 check digit. The store accepts any 12
   * characters (`char(12)`, no `CHECK`) and every export carries what the store
   * holds, so refusing it would make that export unrestorable.
   */
  "ISIN_CHECK_DIGIT_MISMATCH",
] as const;

type CatalogueWarningCode = (typeof CATALOGUE_WARNING_CODES)[number];

/** One warning on an entry that imports. See {@link CATALOGUE_WARNING_CODES}. */
export interface CatalogueWarning {
  readonly code: CatalogueWarningCode;
  readonly message: string;
}

/** Validated icon bytes, as the port returned them — carried through the plan so no decode happens on the write path. */
interface PlannedCatalogueIcon {
  readonly bytes: Uint8Array;
  readonly contentType: InstrumentIconContentType;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** One cash account of a planned portfolio write. `cashAccountId` is `null` when it does not exist yet. */
interface PlannedCashAccountWrite {
  readonly cashAccountId: string | null;
  readonly name: string;
  readonly currency: CurrencyCode;
  /** The archived flag the file states, or `null` when the destination already agrees and no write is needed. */
  readonly archived: boolean | null;
  /** A rename this merge would apply; `null` when the name already matches (it always does — the name is the match key). */
  readonly rename: string | null;
}

/** The fields {@link PlannedCataloguePortfolioWrite} would change on a merge. Absent key ⇒ the destination already agrees. */
interface PortfolioFieldChanges {
  readonly broker?: string;
  readonly description?: string;
  readonly accentColor?: NonNullable<CataloguePortfolioEntry["accentColor"]>;
}

export interface PlannedCataloguePortfolioWrite {
  readonly target: "PORTFOLIO";
  /** `null` ⇒ create. */
  readonly portfolioId: string | null;
  readonly name: string;
  readonly changes: PortfolioFieldChanges;
  readonly icon: PlannedCatalogueIcon | null;
  /**
   * The archived flag to apply after the create/update, or `null` for no write:
   * the file carries no key (PA-L6 — absent is "no statement"), the destination
   * already agrees, or a create the file does not mark archived. Kept off
   * {@link PortfolioFieldChanges} on purpose: `...write.changes` feeds
   * `createPortfolio`, which takes no such field.
   */
  readonly archived: boolean | null;
  readonly cashAccounts: readonly PlannedCashAccountWrite[];
  /** Nested rows this entry cannot write, each already named. The entry itself still imports (FR-525 applied inside an entry). */
  readonly refusals: readonly CatalogueRefusal[];
}

/** What `createInstrumentByIsin`/`createInstrumentBySymbol`/`createInstrumentScpi` will be called with. `isin`/`exchangeMic` and `symbol` are exclusive by kind, except for an SCPI (no MIC, an ISIN or a symbol or both). */
interface InstrumentCreateSpec {
  readonly kind: InstrumentRecord["kind"];
  readonly isin: string | null;
  readonly exchangeMic: string | null;
  readonly symbol: string | null;
  readonly listingCurrency: CurrencyCode;
  readonly displayName: string;
  readonly figi?: string;
  readonly sectorCode?: NonNullable<InstrumentRecord["sectorCode"]>;
  readonly industryLabel?: string;
  /** SCPI only: `createInstrumentScpi` takes both attributes on the create itself. */
  readonly managementCompany?: string;
  readonly subscriptionFeePct?: Decimal;
}

/** The subset of an instrument's tenant-editable fields this entry would change. Absent key ⇒ nothing to write. */
interface InstrumentFieldChanges {
  readonly displayName?: string;
  readonly status?: NonNullable<InstrumentRecord["status"]>;
  /** Fill-once: only ever present when the destination's own value is absent (`setInstrumentFigi` refuses an overwrite, by design). */
  readonly figi?: string;
  readonly sectorCode?: NonNullable<InstrumentRecord["sectorCode"]>;
  readonly industryLabel?: string;
  readonly domicileCountry?: string;
  /** SCPI only; written by `updateInstrumentScpiAttributes`. Never cleared: an absent key is no statement. */
  readonly managementCompany?: string;
  readonly subscriptionFeePct?: Decimal;
}

interface PlannedProviderMappingWrite {
  readonly providerKey: string;
  readonly providerSymbol: string;
  /** `CREATE` when the instrument has no mapping for this provider; `CORRECT` when it has a different one. */
  readonly action: "CREATE" | "CORRECT";
}

interface PlannedManualPriceWrite {
  readonly priceDate: IsoDate;
  readonly close: Decimal;
  readonly currency: CurrencyCode;
}

interface PlannedWatchlistWrite {
  readonly targetPrice: Decimal | null;
  readonly note: string | null;
}

export interface PlannedCatalogueInstrumentWrite {
  readonly target: "INSTRUMENT";
  /** `null` ⇒ create, and {@link PlannedCatalogueInstrumentWrite.create} says how. */
  readonly instrumentId: string | null;
  readonly create: InstrumentCreateSpec | null;
  readonly changes: InstrumentFieldChanges;
  readonly providerMapping: PlannedProviderMappingWrite | null;
  readonly icon: PlannedCatalogueIcon | null;
  readonly manualPrices: readonly PlannedManualPriceWrite[];
  readonly watchlist: PlannedWatchlistWrite | null;
  readonly refusals: readonly CatalogueRefusal[];
}

export interface PlannedCatalogueFxRateWrite {
  readonly target: "FX_RATE_USER";
  readonly baseCurrency: CurrencyCode;
  readonly quoteCurrency: CurrencyCode;
  readonly rateDate: IsoDate;
  readonly rate: Decimal;
  readonly refusals: readonly CatalogueRefusal[];
}

export type PlannedCatalogueWrite =
  PlannedCataloguePortfolioWrite | PlannedCatalogueInstrumentWrite | PlannedCatalogueFxRateWrite;

/**
 * A **part** of an entry that will not be written, while the entry itself is.
 *
 * This is the shape the outcome vocabulary needed and the transaction files do
 * not: a row of a CSV is one thing, and either imports or does not, but a
 * catalogue entry is an entity *and* its icon *and* its prices *and* its
 * watchlist row. A watchlist row refused for the tenant cap must not turn the
 * instrument it hangs off into a rejected entry — the instrument imported — and
 * it must not vanish either. So it is reported here, counted in
 * {@link CatalogueSummary.byReason} exactly like a rejection, and named per
 * entry, which is what AC "each hit reported, never a failed whole-import"
 * asks for.
 */
export interface CatalogueRefusal {
  readonly reason: CatalogueRejectReason;
  readonly message: string;
}

/** The three outcomes, per catalogue entry. */
export type PlannedCatalogueOutcome =
  | {
      readonly at: CatalogueEntryRef;
      readonly outcome: "IMPORT";
      readonly write: PlannedCatalogueWrite;
      /** Never counted in {@link CatalogueSummary} — the entry is written in full. */
      readonly warnings: readonly CatalogueWarning[];
    }
  | {
      readonly at: CatalogueEntryRef;
      readonly outcome: "SKIP";
      readonly reason: CatalogueSkipReason;
      readonly message: string;
    }
  | {
      readonly at: CatalogueEntryRef;
      readonly outcome: "REJECT";
      readonly reason: CatalogueRejectReason;
      readonly message: string;
    };

export interface CatalogueSummary {
  readonly imported: number;
  readonly skipped: number;
  readonly rejected: number;
  /** How many pieces of otherwise-imported entries were refused — see {@link CatalogueRefusal}. */
  readonly partsRefused: number;
  /** Grouped counts by reason code, over rejections **and** refusals. What the review step renders. */
  readonly byReason: Readonly<Record<string, number>>;
}

export interface CataloguePlan {
  /** Exactly one entry per draft entry plus one per entry `parse`/`validate` already refused — the exhaustiveness invariant, preserved. */
  readonly outcomes: readonly PlannedCatalogueOutcome[];
  /** Indices into {@link outcomes} of the `IMPORT` entries, in the fixed write order the table states. */
  readonly applyOrder: readonly number[];
  readonly summary: CatalogueSummary;
  readonly sharedImpact: SharedCatalogueImpact;
}

/**
 * What an import does to the **shared** instrument catalogue,
 * counted over the entries that import. A matched instrument's rename,
 * classification, status, identifier fill or provider mapping is written onto
 * the shared row ("file wins", SD-15): the same per-row power as the PATCH
 * routes, but up to the document's whole instrument section at once. Icons,
 * manual prices and watchlist rows are the tenant's own and are not counted.
 */
interface SharedCatalogueImpact {
  /** Existing instruments this import changes. */
  readonly instrumentsModified: number;
  /** Of those, how many get a corrected provider mapping — which discards their automated price series. */
  readonly priceHistoriesDiscarded: number;
}

export interface CataloguePlanContext {
  readonly db: Db;
  readonly tenantId: string;
  readonly draft: CatalogueDraft;
  /** Carried straight from `parse`/`validate`: an entry already refused there keeps that reason and is never re-decided here. */
  readonly problems: readonly CatalogueEntryProblem[];
  /** The icon-validation port. Called here, in the plan, so a dry run reports the same icon verdicts the confirm applies and no decode happens on the write path. */
  readonly icons: CatalogueIconValidator;
  /**
   * The provider keys a mapping can still be used under (`api` passes
   * `market/composition`'s `routedProviderKeys()`). A pinned mapping under any
   * other key — `coingecko` in an export made before CoinGecko was retired — is not planned at
   * all: nothing would read it, and the export would otherwise keep carrying
   * it forward. Absent ⇒ every key is accepted (the importer's own tests).
   */
  readonly servedProviderKeys?: ReadonlySet<string>;
}

/** The identity an instrument entry is matched by, normalised the way `indexCatalogue` normalises its keys. */
function identityKey(value: string): string {
  return value.trim().toUpperCase();
}

export async function planCatalogue(ctx: CataloguePlanContext): Promise<CataloguePlan> {
  const outcomes: PlannedCatalogueOutcome[] = [];

  // Every entry `parse`/`validate` already refused, carried through with its
  // own reason — this stage never re-decides one.
  for (const problem of ctx.problems) {
    outcomes.push({
      at: problem.at,
      outcome: "REJECT",
      reason: problem.problem.code,
      message: problem.problem.message,
    });
  }

  const currencies = new Set((await listCurrencies(ctx.db)).map((row) => row.code));
  const portfolioOutcomes = await planPortfolios(ctx, currencies);
  const instrumentOutcomes = await planInstruments(ctx, currencies);
  const fxOutcomes = await planFxRates(ctx, currencies);

  // The fixed order: portfolios (and their cash accounts) first, then
  // instruments (and their icons, prices and watchlist rows), then user FX
  // rates. Nothing in the catalogue points at anything from a later section, so
  // this order is about being stated and stable rather than about referential
  // integrity — a stable order is what makes a partial run's remainder
  // predictable.
  const ordered = [...portfolioOutcomes, ...instrumentOutcomes, ...fxOutcomes];
  outcomes.push(...ordered);

  const applyOrder = outcomes.flatMap((outcome, index) =>
    outcome.outcome === "IMPORT" ? [index] : [],
  );

  return {
    outcomes,
    applyOrder,
    summary: summarize(outcomes.map(countable)),
    sharedImpact: sharedImpactOf(outcomes),
  };
}

function sharedImpactOf(outcomes: readonly PlannedCatalogueOutcome[]): SharedCatalogueImpact {
  let instrumentsModified = 0;
  let priceHistoriesDiscarded = 0;
  for (const outcome of outcomes) {
    if (outcome.outcome !== "IMPORT" || outcome.write.target !== "INSTRUMENT") continue;
    const write = outcome.write;
    if (write.instrumentId === null) continue;
    if (Object.keys(write.changes).length === 0 && write.providerMapping === null) continue;
    instrumentsModified += 1;
    if (write.providerMapping?.action === "CORRECT") priceHistoriesDiscarded += 1;
  }
  return { instrumentsModified, priceHistoriesDiscarded };
}

/**
 * The minimum an outcome has to carry to be counted. **Both stages project into
 * it** — `plan`'s outcomes and `apply`'s — so there is exactly one place that
 * knows how a catalogue run is counted, rather than a second copy in
 * `catalogue-apply.ts` that could drift on the day a fourth outcome appears.
 */
export type CountableCatalogueOutcome =
  | { readonly outcome: "IMPORT"; readonly refusals: readonly CatalogueRefusal[] }
  | { readonly outcome: "SKIP"; readonly reason: CatalogueSkipReason }
  | { readonly outcome: "REJECT"; readonly reason: CatalogueRejectReason };

/** Exhaustiveness: one walk over a three-member union, closed by a `never` check. */
export function summarize(outcomes: readonly CountableCatalogueOutcome[]): CatalogueSummary {
  let imported = 0;
  let skipped = 0;
  let rejected = 0;
  let partsRefused = 0;
  const byReason: Record<string, number> = {};
  const count = (reason: string): void => {
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  };

  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case "IMPORT": {
        imported += 1;
        for (const refusal of outcome.refusals) {
          partsRefused += 1;
          count(refusal.reason);
        }
        break;
      }
      case "SKIP": {
        skipped += 1;
        count(outcome.reason);
        break;
      }
      case "REJECT": {
        rejected += 1;
        count(outcome.reason);
        break;
      }
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }
  return { imported, skipped, rejected, partsRefused, byReason };
}

/** Projects a planned outcome into the shape {@link summarize} counts. */
export function countable(outcome: PlannedCatalogueOutcome): CountableCatalogueOutcome {
  return outcome.outcome === "IMPORT"
    ? { outcome: "IMPORT", refusals: outcome.write.refusals }
    : outcome;
}

/** How many entities one planned write commits — the unit {@link CataloguePlan}'s caller chunks by (`KerdialJsonLimits.applyChunkEntities`). */
export function entityCountOf(write: PlannedCatalogueWrite): number {
  switch (write.target) {
    case "PORTFOLIO": {
      return 1 + write.cashAccounts.length + (write.icon === null ? 0 : 1);
    }
    case "INSTRUMENT": {
      return (
        1 +
        write.manualPrices.length +
        (write.icon === null ? 0 : 1) +
        (write.watchlist === null ? 0 : 1) +
        (write.providerMapping === null ? 0 : 1)
      );
    }
    case "FX_RATE_USER": {
      return 1;
    }
    default: {
      const exhaustive: never = write;
      return exhaustive;
    }
  }
}

function reject(
  at: CatalogueEntryRef,
  reason: CatalogueRejectReason,
  message: string,
): PlannedCatalogueOutcome {
  return { at, outcome: "REJECT", reason, message };
}

function unchanged(at: CatalogueEntryRef, what: string): PlannedCatalogueOutcome {
  return {
    at,
    outcome: "SKIP",
    reason: "CATALOGUE_ENTRY_UNCHANGED",
    message: `the destination already holds this ${what} with every value this entry carries`,
  };
}

async function planPortfolios(
  ctx: CataloguePlanContext,
  currencies: ReadonlySet<string>,
): Promise<PlannedCatalogueOutcome[]> {
  if (ctx.draft.portfolios.length === 0) return [];

  const existing = await listPortfolios(ctx.db, ctx.tenantId);
  const byName = new Map(existing.map((row) => [row.name, row]));
  // The cap is consulted here so a dry run reports the refusal rather than
  // promising a create the apply would take a `PortfolioTenantCapExceededError`
  // on. `createPortfolio` remains the arbiter — this is the earlier, better
  // message, never the only check (the same two-stage relationship
  // `plan.ts`'s header records between `validate` and `plan`).
  let headroom = MAX_PORTFOLIOS_PER_TENANT - existing.length;

  const outcomes: PlannedCatalogueOutcome[] = [];
  for (const entry of ctx.draft.portfolios) {
    const match = byName.get(entry.name);

    const unknownCurrency = entry.cashAccounts.find((account) => !currencies.has(account.currency));
    if (unknownCurrency !== undefined) {
      outcomes.push(
        reject(
          entry.at,
          "CURRENCY_UNKNOWN",
          `this entry opens an account in ${unknownCurrency.currency}, which this installation does not know`,
        ),
      );
      continue;
    }

    if (match === undefined && headroom <= 0) {
      outcomes.push(
        reject(
          entry.at,
          "PORTFOLIO_CAP_EXCEEDED",
          `this tenant already holds ${String(MAX_PORTFOLIOS_PER_TENANT)} portfolios, which is the limit`,
        ),
      );
      continue;
    }

    const refusals: CatalogueRefusal[] = [];
    const icon = planIcon(ctx, entry.icon, "portfolio", refusals);
    const accounts =
      match === undefined
        ? planNewCashAccounts(entry.cashAccounts, refusals)
        : await planExistingCashAccounts(ctx, match.id, entry.cashAccounts, refusals);

    if (match === undefined) {
      headroom -= 1;
      outcomes.push({
        at: entry.at,
        outcome: "IMPORT",
        write: {
          target: "PORTFOLIO",
          portfolioId: null,
          name: entry.name,
          changes: portfolioChanges(entry, null),
          icon,
          archived: entry.archived === true ? true : null,
          cashAccounts: accounts,
          refusals,
        },
        warnings: [],
      });
      continue;
    }

    const changes = portfolioChanges(entry, match);
    // PA-L6: an absent key leaves the matched portfolio's state untouched; a
    // present one is written only when it differs.
    const archived =
      entry.archived === undefined || entry.archived === (match.archivedAt !== null)
        ? null
        : entry.archived;
    const nothingToDo =
      Object.keys(changes).length === 0 &&
      icon === null &&
      archived === null &&
      accounts.every((account) => account.cashAccountId !== null && account.archived === null);
    if (nothingToDo && refusals.length === 0) {
      outcomes.push(unchanged(entry.at, "portfolio"));
      continue;
    }

    outcomes.push({
      at: entry.at,
      outcome: "IMPORT",
      write: {
        target: "PORTFOLIO",
        portfolioId: match.id,
        name: entry.name,
        changes,
        icon,
        archived,
        cashAccounts: accounts,
        refusals,
      },
      warnings: [],
    });
  }
  return outcomes;
}

/**
 * SD-15 over a portfolio's three presentation fields. A field the file does not
 * carry is **not** a clear — see this module's header.
 */
function portfolioChanges(
  entry: CataloguePortfolioEntry,
  existing: {
    broker: string | null;
    description: string | null;
    accentColor: string | null;
  } | null,
): PortfolioFieldChanges {
  return {
    ...(entry.broker !== undefined &&
      entry.broker !== existing?.broker && { broker: entry.broker }),
    ...(entry.description !== undefined &&
      entry.description !== existing?.description && { description: entry.description }),
    ...(entry.accentColor !== undefined &&
      entry.accentColor !== existing?.accentColor && { accentColor: entry.accentColor }),
  };
}

function planNewCashAccounts(
  entries: readonly CatalogueCashAccountEntry[],
  refusals: CatalogueRefusal[],
): PlannedCashAccountWrite[] {
  if (entries.length > MAX_CASH_ACCOUNTS_PER_PORTFOLIO) {
    refusals.push({
      reason: "CASH_ACCOUNT_CAP_EXCEEDED",
      message:
        `this entry opens ${String(entries.length)} accounts; a portfolio holds at most ` +
        `${String(MAX_CASH_ACCOUNTS_PER_PORTFOLIO)}`,
    });
  }
  return entries.slice(0, MAX_CASH_ACCOUNTS_PER_PORTFOLIO).map((account) => ({
    cashAccountId: null,
    name: account.name,
    currency: account.currency,
    archived: account.archived ? true : null,
    rename: null,
  }));
}

/**
 * FR-532/SD-14 over an existing portfolio's accounts: matched by `(portfolio,
 * name)`, created when absent, and **rejected** — never coerced — when the
 * file's currency disagrees with the stored one. The account's currency is
 * immutable by grant (`app_web` holds no `UPDATE` on that column at all), so
 * this path must not even try.
 */
async function planExistingCashAccounts(
  ctx: CataloguePlanContext,
  portfolioId: string,
  entries: readonly CatalogueCashAccountEntry[],
  refusals: CatalogueRefusal[],
): Promise<PlannedCashAccountWrite[]> {
  if (entries.length === 0) return [];

  const snapshot = await listCashAccountsWithBalances(ctx.db, {
    tenantId: ctx.tenantId,
    portfolioId,
  });
  const existing = snapshot?.accounts ?? [];
  const byName = new Map(existing.map((account) => [account.name, account]));
  let headroom = MAX_CASH_ACCOUNTS_PER_PORTFOLIO - existing.length;

  const planned: PlannedCashAccountWrite[] = [];
  for (const entry of entries) {
    const match = byName.get(entry.name);
    if (match === undefined) {
      if (headroom <= 0) {
        refusals.push({
          reason: "CASH_ACCOUNT_CAP_EXCEEDED",
          message:
            `this portfolio already holds ${String(MAX_CASH_ACCOUNTS_PER_PORTFOLIO)} accounts, ` +
            `so the one this entry names cannot be opened`,
        });
        continue;
      }
      headroom -= 1;
      planned.push({
        cashAccountId: null,
        name: entry.name,
        currency: entry.currency,
        archived: entry.archived ? true : null,
        rename: null,
      });
      continue;
    }
    if (match.currency !== entry.currency) {
      refusals.push({
        reason: "CASH_ACCOUNT_CURRENCY_MISMATCH",
        message:
          `the account named in this entry already exists holding ${match.currency}, and an ` +
          `account's currency cannot be changed`,
      });
      continue;
    }
    planned.push({
      cashAccountId: match.id,
      name: entry.name,
      currency: entry.currency,
      archived: match.archived === entry.archived ? null : entry.archived,
      rename: null,
    });
  }
  return planned;
}

/** The icon port, called at plan time. A refused icon is a refusal on the entry, never a failed entry — the instrument or portfolio still imports without it. */
function planIcon(
  ctx: CataloguePlanContext,
  icon: { readonly base64: string; readonly contentType: string } | undefined,
  what: string,
  refusals: CatalogueRefusal[],
): PlannedCatalogueIcon | null {
  if (icon === undefined) return null;
  const verdict = ctx.icons.validate({
    base64: icon.base64,
    declaredContentType: icon.contentType,
  });
  if (!verdict.ok) {
    refusals.push({
      reason: "ICON_REJECTED",
      message: `this ${what}'s icon was refused: ${verdict.code}`,
    });
    return null;
  }
  return {
    bytes: verdict.bytes,
    contentType: verdict.contentType,
    widthPx: verdict.widthPx,
    heightPx: verdict.heightPx,
  };
}

async function planInstruments(
  ctx: CataloguePlanContext,
  currencies: ReadonlySet<string>,
): Promise<PlannedCatalogueOutcome[]> {
  if (ctx.draft.instruments.length === 0) return [];

  // The one batched identity read for the whole document, indexed in memory
  // by `indexCatalogue` — reused, not re-derived (L12).
  const matches = await findInstrumentsByIdentity(ctx.db, {
    isins: ctx.draft.instruments.flatMap((entry) =>
      entry.identity.isin === undefined ? [] : [entry.identity.isin],
    ),
    symbols: ctx.draft.instruments.flatMap((entry) =>
      entry.identity.symbol === undefined ? [] : [entry.identity.symbol],
    ),
  });
  const index = indexCatalogue(matches);

  const outcomes: PlannedCatalogueOutcome[] = [];
  for (const entry of ctx.draft.instruments) {
    outcomes.push(await planOneInstrument(ctx, entry, index, currencies));
  }
  return outcomes;
}

async function planOneInstrument(
  ctx: CataloguePlanContext,
  entry: CatalogueInstrumentEntry,
  index: ReturnType<typeof indexCatalogue>,
  currencies: ReadonlySet<string>,
): Promise<PlannedCatalogueOutcome> {
  if (entry.private) {
    return reject(
      entry.at,
      "PRIVATE_INSTRUMENT_UNSUPPORTED",
      "this entry asks for a tenant-private instrument, and this installation has no write path " +
        "for one; importing it into the shared catalogue instead is exactly what FR-530 forbids",
    );
  }
  if (!currencies.has(entry.listingCurrency)) {
    return reject(
      entry.at,
      "CURRENCY_UNKNOWN",
      `this entry is listed in ${entry.listingCurrency}, which this installation does not know`,
    );
  }
  const unknownPriceCurrency = entry.manualPrices.find((price) => !currencies.has(price.currency));
  if (unknownPriceCurrency !== undefined) {
    return reject(
      entry.at,
      "CURRENCY_UNKNOWN",
      `this entry carries a price in ${unknownPriceCurrency.currency}, which this installation does not know`,
    );
  }

  const resolved = resolveIdentity(entry, index);
  if (resolved === "AMBIGUOUS") {
    return reject(
      entry.at,
      "INSTRUMENT_AMBIGUOUS",
      "more than one catalogue row in the destination matches this entry's identity",
    );
  }

  const refusals: CatalogueRefusal[] = [];
  const icon = planIcon(ctx, entry.icon, "instrument", refusals);
  const existing = resolved === null ? null : ((await getInstrumentById(ctx.db, resolved)) ?? null);

  const create = existing === null ? createSpecOf(entry) : null;
  // The comparison baseline: the row that exists, or the row the create above
  // is about to produce. Computing the *residual* edits either way is what
  // keeps one merge rule instead of two — a symbol-keyed create cannot carry a
  // classification (its parameter type has no such field, MEASURED), so the
  // very same code that merges into an existing row is what fills it in
  // afterwards.
  const baseline = existing ?? projectedRowAfterCreate(entry, create!);
  const changes = instrumentChanges(entry, baseline);

  const write: PlannedCatalogueInstrumentWrite = {
    target: "INSTRUMENT",
    instrumentId: existing?.id ?? null,
    create,
    changes,
    providerMapping: await planProviderMapping(ctx, entry, existing?.id ?? null),
    icon,
    manualPrices: entry.manualPrices.map((price) => ({
      priceDate: price.priceDate,
      close: price.close,
      currency: price.currency,
    })),
    watchlist:
      entry.watchlist === undefined
        ? null
        : {
            targetPrice: entry.watchlist.targetPrice ?? null,
            note: entry.watchlist.note ?? null,
          },
    refusals,
  };

  const nothingToDo =
    create === null &&
    Object.keys(changes).length === 0 &&
    write.providerMapping === null &&
    icon === null &&
    write.manualPrices.length === 0 &&
    write.watchlist === null;
  if (nothingToDo && refusals.length === 0) return unchanged(entry.at, "instrument");

  return { at: entry.at, outcome: "IMPORT", write, warnings: instrumentWarnings(entry) };
}

/** The ISO 6166 check digit, verified and reported — never a refusal. */
function instrumentWarnings(entry: CatalogueInstrumentEntry): CatalogueWarning[] {
  const { isin } = entry.identity;
  if (isin === undefined || isValidIsinCheckDigit(isin)) return [];
  return [
    {
      code: "ISIN_CHECK_DIGIT_MISMATCH",
      message: `the ISIN ${isin} does not pass the ISO 6166 check digit; the entry is imported as it is`,
    },
  ];
}

/**
 * Which of the two mapping calls this entry needs, or `null` for "the pinned
 * mapping is already the stored one".
 *
 * **The point read is not optional, and the reason is destructive.**
 * `correctProviderMapping` deletes the instrument's **whole**
 * `instrument_price_daily` series (MEASURED, `instrument-provider-map-service.ts`:
 * `discardAutomatedPriceSeries`, unconditional) — correctly, because a corrected
 * mapping orphans the series the wrong one wrote. Planning a "correct" for every
 * merged instrument without checking would therefore discard every price series
 * in the destination on **every** re-import of the same document, which is both
 * the opposite of idempotent and exactly the kind of silent data loss a restore
 * must not cause. So the stored mapping is read, and a mapping that already
 * agrees is planned as nothing at all.
 */
async function planProviderMapping(
  ctx: CataloguePlanContext,
  entry: CatalogueInstrumentEntry,
  instrumentId: string | null,
): Promise<PlannedProviderMappingWrite | null> {
  const pinned = entry.providerMapping;
  if (pinned === undefined) return null;
  if (ctx.servedProviderKeys !== undefined && !ctx.servedProviderKeys.has(pinned.providerKey)) {
    return null;
  }
  if (instrumentId === null) {
    return {
      providerKey: pinned.providerKey,
      providerSymbol: pinned.providerSymbol,
      action: "CREATE",
    };
  }
  const stored = await getProviderMapping(ctx.db, instrumentId, pinned.providerKey);
  if (stored === undefined) {
    return {
      providerKey: pinned.providerKey,
      providerSymbol: pinned.providerSymbol,
      action: "CREATE",
    };
  }
  if (stored.providerSymbol === pinned.providerSymbol) return null;
  return {
    providerKey: pinned.providerKey,
    providerSymbol: pinned.providerSymbol,
    action: "CORRECT",
  };
}

/**
 * The destination row this entry names, `null` for "not there", or
 * `"AMBIGUOUS"`.
 *
 * The catalogue's identity is **explicit**, which is the whole difference from
 * the transaction files: a symbol-keyed kind is matched on symbol and kind, and
 * an identifier-keyed one on the identifier **and** the exchange code together —
 * so a dual listing (the same identifier on another exchange) resolves to
 * neither of the other's row, which is the property FR-3 exists for. No suffix
 * inference and no provider lookup is reachable from here.
 *
 * An ISIN with **no** exchange code is an SCPI's identity (`scpi`,
 * SCD-13 — `validate` refuses it for every other kind): it matches only a row
 * that has no exchange code either, the row `instrument_isin_no_mic_key`
 * keeps unique. Without this arm a re-import of an SCPI found nothing, planned
 * a create, and failed on that index. A listed row sharing the ISIN is not a
 * match: the entry plans a create, which the ledger refuses at apply.
 */
function resolveIdentity(
  entry: CatalogueInstrumentEntry,
  index: ReturnType<typeof indexCatalogue>,
): string | null | "AMBIGUOUS" {
  const { identity } = entry;
  if (identity.isin !== undefined && identity.exchangeMic !== undefined) {
    const exchangeMic = identityKey(identity.exchangeMic);
    const candidates = index
      .byIsin(identity.isin)
      .filter(
        (match) => match.exchangeMic !== null && identityKey(match.exchangeMic) === exchangeMic,
      );
    if (candidates.length > 1) return "AMBIGUOUS";
    return candidates[0]?.id ?? null;
  }
  if (identity.isin !== undefined) {
    const candidates = index.byIsin(identity.isin).filter((match) => match.exchangeMic === null);
    if (candidates.length > 1) return "AMBIGUOUS";
    return candidates[0]?.id ?? null;
  }
  if (identity.symbol === undefined) return null;
  const candidates = index
    .bySymbol(identity.symbol)
    .filter((match) => match.kind === identity.kind);
  if (candidates.length > 1) return "AMBIGUOUS";
  return candidates[0]?.id ?? null;
}

function createSpecOf(entry: CatalogueInstrumentEntry): InstrumentCreateSpec {
  const { identity } = entry;
  return {
    kind: identity.kind,
    isin: identity.isin ?? null,
    exchangeMic: identity.exchangeMic ?? null,
    symbol: identity.symbol ?? null,
    listingCurrency: entry.listingCurrency,
    displayName: entry.displayName,
    ...(entry.figi !== undefined && { figi: entry.figi }),
    // Carried on the create itself **only** where the create path takes them:
    // `createInstrumentByIsin` does (MEASURED, its own parameter type),
    // `createInstrumentBySymbol` does not. The residual is filled by
    // {@link instrumentChanges} against {@link projectedRowAfterCreate}.
    ...(identity.isin !== undefined &&
      entry.sectorCode !== undefined && { sectorCode: entry.sectorCode }),
    ...(identity.isin !== undefined &&
      entry.industryLabel !== undefined && { industryLabel: entry.industryLabel }),
    // `createInstrumentScpi` takes both SCPI attributes; `validate` refuses
    // them on every other kind, so this is SCPI-only in practice too.
    ...(identity.kind === "SCPI" &&
      entry.managementCompany !== undefined && { managementCompany: entry.managementCompany }),
    ...(identity.kind === "SCPI" &&
      entry.subscriptionFeePct !== undefined && { subscriptionFeePct: entry.subscriptionFeePct }),
  };
}

/** The instrument columns {@link instrumentChanges} compares an entry against. */
type InstrumentBaselineField =
  | "displayName"
  | "status"
  | "figi"
  | "sectorCode"
  | "industryLabel"
  | "domicileCountry"
  | "managementCompany"
  | "subscriptionFeePct";

/** What the row will look like the instant the create returns — the baseline the residual edits are computed against. */
function projectedRowAfterCreate(
  entry: CatalogueInstrumentEntry,
  create: InstrumentCreateSpec,
): Pick<InstrumentRecord, InstrumentBaselineField> {
  return {
    displayName: entry.displayName,
    // Both create paths write `ACTIVE`; nothing in their parameter types can
    // say otherwise (MEASURED). A file stating another status therefore needs
    // the residual `updateInstrumentDetails` call below.
    status: "ACTIVE",
    figi: create.figi ?? null,
    sectorCode: create.sectorCode ?? null,
    industryLabel: create.industryLabel ?? null,
    domicileCountry: null,
    managementCompany: create.managementCompany ?? null,
    subscriptionFeePct: create.subscriptionFeePct ?? null,
  };
}

/**
 * SD-15's merge, field by field, against the destination row (or the row a
 * create is about to produce).
 *
 * **`figi` is fill-once and that is not this function's choice**:
 * `setInstrumentFigi` writes only where the column is `NULL` and raises
 * `InstrumentFigiAlreadySetError` otherwise (MEASURED), because correcting a
 * wrong identifier is a bigger claim than any import makes. So a file whose
 * value disagrees with a stored one is **not** planned as a change — the entry
 * imports, and the stored identifier stands.
 *
 * **Two fields the file carries and no code path can write, stated rather than
 * silently dropped**: `quotePolicy` and `primaryIdentifier`. A repository-wide
 * grep finds **no** writer for either outside the two create paths' own
 * defaults (`defaultQuotePolicy(kind)` and the path's own fixed value) — there
 * is no service function, and no HTTP route, that sets them. They are therefore
 * carried in the document (so a future writer inherits a complete file) and
 * applied by nothing.
 */
function instrumentChanges(
  entry: CatalogueInstrumentEntry,
  baseline: Pick<InstrumentRecord, InstrumentBaselineField>,
): InstrumentFieldChanges {
  return {
    ...(entry.displayName !== baseline.displayName && { displayName: entry.displayName }),
    ...(entry.status !== baseline.status && { status: entry.status }),
    ...(entry.figi !== undefined && baseline.figi === null && { figi: entry.figi }),
    ...(entry.sectorCode !== undefined &&
      entry.sectorCode !== baseline.sectorCode && { sectorCode: entry.sectorCode }),
    ...(entry.industryLabel !== undefined &&
      entry.industryLabel !== baseline.industryLabel && { industryLabel: entry.industryLabel }),
    ...(entry.domicileCountry !== undefined &&
      entry.domicileCountry !== baseline.domicileCountry && {
        domicileCountry: entry.domicileCountry,
      }),
    ...(entry.managementCompany !== undefined &&
      entry.managementCompany !== baseline.managementCompany && {
        managementCompany: entry.managementCompany,
      }),
    // Compared as decimals, never as text: a stored 8.50 and a file's "8.5" are
    // one fee.
    ...(entry.subscriptionFeePct !== undefined &&
      (baseline.subscriptionFeePct === null ||
        !entry.subscriptionFeePct.equals(baseline.subscriptionFeePct)) && {
        subscriptionFeePct: entry.subscriptionFeePct,
      }),
  };
}

async function planFxRates(
  ctx: CataloguePlanContext,
  currencies: ReadonlySet<string>,
): Promise<PlannedCatalogueOutcome[]> {
  if (ctx.draft.fxRatesUser.length === 0) return [];

  const stored = await listUserFxRates(ctx.db, {
    tenantId: ctx.tenantId,
    baseCurrencies: ctx.draft.fxRatesUser.map((entry) => entry.baseCurrency),
    quoteCurrencies: ctx.draft.fxRatesUser.map((entry) => entry.quoteCurrency),
  });
  const byKey = new Map(
    stored.map((row) => [`${row.baseCurrency}/${row.quoteCurrency}/${row.rateDate}`, row] as const),
  );

  return ctx.draft.fxRatesUser.map((entry) => planOneFxRate(entry, byKey, currencies));
}

function planOneFxRate(
  entry: CatalogueFxRateEntry,
  byKey: ReadonlyMap<string, { readonly rate: Decimal }>,
  currencies: ReadonlySet<string>,
): PlannedCatalogueOutcome {
  const unknown = !currencies.has(entry.baseCurrency)
    ? entry.baseCurrency
    : !currencies.has(entry.quoteCurrency)
      ? entry.quoteCurrency
      : null;
  if (unknown !== null) {
    return reject(
      entry.at,
      "CURRENCY_UNKNOWN",
      `this entry quotes ${unknown}, which this installation does not know`,
    );
  }

  const stored = byKey.get(`${entry.baseCurrency}/${entry.quoteCurrency}/${entry.rateDate}`);
  if (stored !== undefined && stored.rate.equals(entry.rate)) {
    return unchanged(entry.at, "rate");
  }

  return {
    at: entry.at,
    outcome: "IMPORT",
    write: {
      target: "FX_RATE_USER",
      baseCurrency: entry.baseCurrency,
      quoteCurrency: entry.quoteCurrency,
      rateDate: entry.rateDate,
      rate: entry.rate,
      refusals: [],
    },
    warnings: [],
  };
}
