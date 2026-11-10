import { industryLabelSchema } from "@kerdial/api-contracts";
import { sectorCodeForProviderLabel, type SectorCode } from "@kerdial/core-reference-data";
import {
  applyProviderClassification,
  createProviderMapping,
  getProviderMapping,
} from "@kerdial/ledger";
import type {
  InstrumentRef,
  ProviderKey,
  ProviderSymbolMatch,
  QuoteProvider,
} from "@kerdial/market-ports";
import { extractPostgresError, type Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";

/**
 * The shared "which provider symbol is this instrument?" step, extracted from
 * `history-backfill-handler.ts` unchanged (SH-12) so the gap-repair handler
 * resolves symbols exactly the way the backfill handler already does, rather
 * than growing a second, subtly different copy. No behaviour change: this is
 * the same function, in its own module, with the same doc comment.
 */

export interface InstrumentRowForResolution {
  readonly id: string;
  readonly kind: InstrumentRef["kind"];
  readonly isin: string | null;
  readonly symbol: string | null;
  readonly exchangeMic: string | null;
  readonly listingCurrency: string;
}

/**
 * Looks up
 * `(instrumentId, providerKey)` in `instrument_provider_map` first (whatever
 * its `confidence` — a `CONFIRMED` mapping is used exactly like a `HEURISTIC`
 * one here, this never re-resolves an existing mapping); otherwise calls
 * `provider.resolve(ref)` with a ref built from the **stored instrument
 * row**, picks the first `EXACT`-quality candidate else the first candidate,
 * and persists it as a new `HEURISTIC` mapping. Returns `null` when
 * `resolve()` yields no candidates at all.
 */
export async function resolveProviderSymbol(
  db: Db,
  provider: QuoteProvider,
  providerKey: ProviderKey,
  instrumentRow: InstrumentRowForResolution,
): Promise<string | null> {
  const existingMapping = await getProviderMapping(db, instrumentRow.id, providerKey);
  if (existingMapping) return existingMapping.providerSymbol;

  const ref: InstrumentRef = {
    instrumentId: instrumentRow.id,
    kind: instrumentRow.kind,
    listingCurrency: instrumentRow.listingCurrency,
    ...(instrumentRow.isin !== null ? { isin: instrumentRow.isin } : {}),
    ...(instrumentRow.symbol !== null ? { symbol: instrumentRow.symbol } : {}),
    ...(instrumentRow.exchangeMic !== null ? { exchangeMic: instrumentRow.exchangeMic } : {}),
  };

  const candidates = await provider.resolve(ref);
  if (candidates.length === 0) return null;

  // **Currency first, then match quality.** `resolve()` matches the *issuer*,
  // not the listing: an ISIN-level `EXACT` hit returns whichever line the
  // provider considers primary, which for a cross-listed company is usually its
  // home venue. Taking the first `EXACT` therefore silently mapped a Xetra
  // instrument to its Copenhagen line — `DK0062498333` / `NOV.DE` /
  // `exchange_mic XETR` / `listing_currency EUR` resolved to `NOVO-B.CO`, and
  // 4 993 days of **DKK** prices were then stored against an instrument that
  // declares EUR.
  //
  // The ref already carries `listingCurrency` and `exchangeMic`; only the
  // *selection* ignored them. Preferring a candidate that agrees with the
  // instrument's own declared currency picks the Xetra line, which is what the
  // source file said in the first place.
  //
  // Falls back to the whole candidate list rather than returning `null` when
  // nothing agrees: a mapping in an unexpected currency still yields correct
  // figures once the rate exists, whereas no mapping yields no prices at all.
  // What must not happen is that disagreement going *unnoticed* — see
  // `fetchHeldCurrencies`, which now derives the FX shopping list from the
  // currencies prices are actually stored in rather than from this declared
  // one, so a mapping that lands here can no longer make its own rate
  // unfetchable.
  const declared = instrumentRow.listingCurrency.toUpperCase();
  const sameCurrency = candidates.filter(
    (candidate) => candidate.currency.toUpperCase() === declared,
  );
  const pool = sameCurrency.length > 0 ? sameCurrency : candidates;
  const chosen = pool.find((candidate) => candidate.matchQuality === "EXACT") ?? pool[0]!;

  if (sameCurrency.length === 0) {
    rootLogger().warn(
      "provider-symbol: no candidate quotes in the instrument's declared currency — mapping anyway, in the provider's currency",
      {
        component: "market-composition",
        instrument_id: instrumentRow.id,
        provider_key: providerKey,
        declared_currency: declared,
        chosen_symbol: chosen.providerSymbol,
        chosen_currency: chosen.currency,
      },
    );
  }

  await createProviderMapping(db, {
    instrumentId: instrumentRow.id,
    providerKey,
    providerSymbol: chosen.providerSymbol,
    confidence: "HEURISTIC",
  });

  // FR-7: SHARE only this cycle. ETF/FUND/CRYPTO/INDEX reach this line and
  // write nothing at all — no call, not a call that happens to write NULLs
  // (NG14).
  if (instrumentRow.kind === "SHARE") {
    await captureProviderClassification(db, instrumentRow.id, chosen);
  }

  return chosen.providerSymbol;
}

/**
 * The single classification capture site — DD25/DD26; FR-3..FR-7,
 * AC-3..AC-6.
 *
 * **Why here and nowhere else.** It is called from the branch of
 * {@link resolveProviderSymbol} that has *just* awaited `provider.resolve()`
 * and chosen a candidate, immediately after `createProviderMapping`:
 *
 *   - that is the one place both remaining `resolve()` call sites converge on
 *     — the history-backfill handler and the gap-repair handler (SH-12
 *     extracted `resolveProviderSymbol` precisely so they could not diverge);
 *     one write site, two lanes, zero duplication;
 *   - it sits **past** the `if (existingMapping) return …` early guard, so it
 *     is reached only on a path where a provider response is already in hand.
 *     "Classification costs no additional provider request" (FR-4, AC-6) is
 *     therefore **structural** here, not a promise a reviewer has to check;
 *   - the interactive discovery lane never reaches it — that lane's own
 *     classification flows through the DTO into the create payload, so
 *     discovery still performs no DB write and, deliberately, emits **no**
 *     log record: it runs per keystroke and would be a log flood.
 *
 * **Consequence, stated because it is a real product limitation (RD3):** an
 * instrument that *already* has an `instrument_provider_map`
 * row — every instrument created before this cycle — never re-resolves, so it
 * stays unclassified until a user sets a sector by hand. No classification
 * sweep is built: that would be new provider traffic, which FR-4/NFR-1
 * forbid.
 *
 * **Failure isolation.** Only the write is wrapped: a classification
 * failure is logged and swallowed, mirroring the shipped
 * `triggerInstrumentBackfill` shape, so it can never fail a backfill job. The
 * record is `warn` for a transient failure and `error` carrying the
 * `sqlstate` for the two that mean the deployment itself is wrong — see
 * {@link DEPLOYMENT_FAULT_SQLSTATES}. The swallow is identical either way; only
 * what an operator can see about it differs.
 * `createProviderMapping` is deliberately **outside** that `try` — the
 * mapping row is what the whole job depends on, and its failure must keep
 * propagating exactly as it does today.
 */
/**
 * Bounds `provider_sector_label` in the `warn` below. Unlike the
 * industry label just underneath, the raw string genuinely needs to reach
 * the log — FR-3's whole point is naming the unmapped value — so it cannot
 * switch to a length-only field the way `provider_industry_label_length`
 * did. A provider is not a trusted input source, so "log the raw string" and
 * "log an unbounded string" still have to be two different decisions:
 * truncating bounds the field without losing what identifies the value.
 */
export const PROVIDER_SECTOR_LABEL_LOG_MAX_LENGTH = 64;

/**
 * The two SQLSTATEs at the classification write that are **not**
 * transient, and are not this deployment's data either: they are its
 * configuration.
 *
 *  - `42501 insufficient_privilege` — `permission denied for table instrument`:
 *    `app_ingest`'s column grant from migration `0036` was revoked, or `0036`
 *    itself never ran.
 *  - `42703 undefined_column` — the other shape of "the migration did not run".
 *
 * **Why they need their own record.** The `catch` below is correctly scoped
 * (a classification failure must never fail a backfill job) but it cannot
 * distinguish what it swallows, and one member of that set is permanent: in
 * either state classification silently never lands, for any instrument, forever.
 * A mis-deployed grant then looks *identical* to a healthy catalogue nobody has
 * classified yet — no sector values, one `warn` per resolve, everything else
 * green — and `warn` is rotation-bounded (FR-31), so the only trace ages out.
 *
 * Raising the level to `error` with the `sqlstate` attached is the minimum that
 * makes the two distinguishable at the moment they diverge. It is deliberately
 * not an `ops_indicator` write from here: this site runs inside a backfill job
 * and owns no sweep, and an indicator whose condition is "a write failed once,
 * some time ago" would have no way to clear itself. The durable-signal half is
 * `ingestionStaleness`' business, which already reports the observable
 * consequence.
 *
 * The transient set — a lock timeout, a dropped connection, a serialization
 * failure — keeps exactly the behaviour it had: swallowed, `warn`, backfill
 * unaffected.
 */
const DEPLOYMENT_FAULT_SQLSTATES: ReadonlySet<string> = new Set([
  /** insufficient_privilege */
  "42501",
  /** undefined_column */
  "42703",
]);

async function captureProviderClassification(
  db: Db,
  instrumentId: string,
  chosen: ProviderSymbolMatch,
): Promise<void> {
  let sectorCode: SectorCode | null = null;
  if (chosen.providerSectorLabel !== undefined) {
    sectorCode = sectorCodeForProviderLabel(chosen.providerSectorLabel) ?? null;
    if (sectorCode === null) {
      // FR-3: unmapped ⇒ NULL, never a fallback code, never the raw string in
      // a column — plus **exactly one** structured record per resolve naming
      // the raw string and the instrument, so `PROVIDER_SECTOR_TO_CODE` can
      // be extended deliberately rather than by guesswork. One `warn` call on
      // a non-looping path is what makes "exactly one" true.
      rootLogger().warn("provider-symbol: unmapped provider sector label — sector_code left NULL", {
        component: "market-composition",
        instrument_id: instrumentId,
        provider_sector_label: chosen.providerSectorLabel.slice(
          0,
          PROVIDER_SECTOR_LABEL_LOG_MAX_LENGTH,
        ),
      });
    }
  }

  // What a *stored* industry label is, is authored exactly once:
  // `industryLabelSchema` — `z.string().trim().min(1).max(120)` — mirrored one
  // layer down by migration `0035`'s `instrument_industry_label_length` CHECK.
  // This site therefore applies **the schema**, not a bound read off it: the
  // shipped version of this check compared `length` against
  // `INDUSTRY_LABEL_MAX_LENGTH` and so applied `.max()` while silently dropping
  // `.trim()` and `.min(1)` (security review, LOW). The CHECK is
  // `char_length(…) <= 120` only and tolerates a blank, so a provider
  // `"industry": ""` or `"   "` persisted as a **non-NULL blank** —
  // `applyProviderClassification`'s `coalesce(industry_label, $1)` then treats
  // it as present forever, so DD25's fill-if-absent can never correct it, and
  // every read surface renders an empty cell. `safeParse` also makes this
  // writer trim exactly as `web`'s own `buildClassificationPatch` does, so a
  // provider-sourced and a user-sourced label cannot differ by surrounding
  // whitespace.
  //
  // Anything the schema refuses is **dropped, and the sector still lands**: the
  // two columns are set in one UPDATE, so an over-long label would fail the
  // whole statement, the `catch` below would swallow it, and `sector_code` — the
  // aggregatable field this cycle exists for — would be lost with a display-only
  // one. An absent industry label already renders as absent everywhere. **Never
  // truncated**: storing a silently altered provider string is worse than
  // storing nothing, the same reasoning FR-3 applies to an unmapped sector
  // becoming NULL rather than a guess. One `warn` on a non-looping path,
  // carrying the length and not the label (long, and `LOG_FIELD_ALLOWLIST` gates
  // fields deliberately) — the length is also what distinguishes the refusal
  // reason: `0`/whitespace-only for the blank cases, `> 120` for the bound.
  let industryLabel: string | null = null;
  if (chosen.providerIndustryLabel !== undefined) {
    const parsed = industryLabelSchema.safeParse(chosen.providerIndustryLabel);
    if (parsed.success) {
      industryLabel = parsed.data;
    } else {
      rootLogger().warn(
        "provider-symbol: provider industry label is not a storable label — industry_label left NULL, sector_code still written",
        {
          component: "market-composition",
          instrument_id: instrumentId,
          provider_industry_label_length: chosen.providerIndustryLabel.length,
        },
      );
    }
  }

  try {
    await applyProviderClassification(db, instrumentId, {
      sectorCode,
      industryLabel,
    });
  } catch (err) {
    const sqlstate = extractPostgresError(err)?.sqlstate;
    if (sqlstate !== undefined && DEPLOYMENT_FAULT_SQLSTATES.has(sqlstate)) {
      // A deployment fault. Same swallow — the isolation property below is not negotiable —
      // but a different record, because this is a different kind of failure.
      rootLogger().error(
        "provider-symbol: classification cannot be written at all — the grant or the column is missing, and no instrument will ever be classified until it is fixed",
        {
          component: "market-composition",
          instrument_id: instrumentId,
          sqlstate,
        },
      );
      return;
    }
    rootLogger().warn(
      "provider-symbol: best-effort classification write failed — the backfill job is unaffected",
      {
        component: "market-composition",
        instrument_id: instrumentId,
        err: err instanceof Error ? err.message : String(err),
      },
    );
  }
}
