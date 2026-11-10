import { sql } from "drizzle-orm";
import {
  EOD_CLOSE_DEAD_LETTER_QUEUE,
  EQUITY_LIKE_KINDS,
  QUOTE_CADENCE_KINDS,
  FX_DAILY_DEAD_LETTER_QUEUE,
  HISTORY_BACKFILL_DEAD_LETTER_QUEUE,
  HISTORY_GAP_REPAIR_DEAD_LETTER_QUEUE,
  QUOTE_REFRESH_DEAD_LETTER_QUEUE,
  TARGET_CALENDAR_KEY,
  countAbandonedInstrumentBackfills,
  countAttemptedUnresolvableBackfills,
  countPriceCurrencyMismatchedInstruments,
  createDbMarketCalendarLookup,
  fetchHeldInstruments,
  listHeldInstrumentQuoteStaleness,
  maxFxRateDate,
  maxPriceDateForHeldInstrumentsOnExchange,
  mostRecentCompletedEodSessionDay,
  mostRecentTargetPublicationDay,
  nthPreviousSessionDay,
  type Clock,
  type MarketCalendarLookup,
} from "@kerdial/market-ingestion";
import type { Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";

/**
 * SH-35 (FR-48/FR-49) — **the ops-indicator sweep**.
 *
 * Three conditions, computed in the worker because that is the only process
 * that can see them, written to the shared `ops_indicator` table (migration
 * `0033`, SH-34), and delivered through FR-49's **two** channels and only
 * those:
 *
 *  - **pull** — `GET /health` reads the table (`api/src/health.ts`, SH-32);
 *  - **push** — an **ERROR-level line at the `OK → BREACHED` transition**,
 *    driven by `first_breached_at` and therefore emitted **once**, not once per
 *    sweep interval. That is not a nicety: FR-31 caps the Docker `json-file`
 *    driver at 10 MB × 5, so a breach that re-emitted every five minutes would
 *    rotate out the very evidence the channel exists to preserve.
 *
 * No notification service, no webhook, no email sender — FR-49 forbids all
 * three this cycle, and there is nothing here that could grow into one.
 *
 * ## Two of FR-48's five conditions are not here, for two different reasons
 *
 * The proxy-trust anomaly (item 5) is observable **only** inside the API process
 * and is reported from `api/src/proxy-trust-monitor.ts`'s in-process state —
 * the one stated exception to "indicators come from `ops_indicator`". Routing it through this table would mean granting `app_web`
 * INSERT/UPDATE for a single diagnostic.
 *
 * Backup staleness (item 4) has **no observable subject any more**: the backup
 * sidecar, its volume and the completion marker this sweep read were retired
 * with the pipeline, and an indicator whose source cannot exist would
 * report `BREACHED` forever on every deployment. It comes back with a
 * scheduled export, against whatever artifact that produces — not before.
 *
 * There is likewise **no certificate-related condition**: this project
 * terminates no TLS and runs no ACME client, so there is
 * nothing to observe.
 *
 * ## Thresholds are cadence-relative, and that is a reading of the intent
 *
 * FR-48 item 1 says "breaching NFR-1/NFR-2's budgets" — 20 minutes for
 * equities, 10 for crypto. At the **twice-daily** quote cadence
 * every quote exceeds those essentially always, so an indicator thresholded on
 * them would sit `BREACHED` from the first hour of the first day and never
 * move: informationally identical to having no alert at all, while looking
 * like the loudest one in the system. NFR-1/NFR-2 govern the staleness of a
 * price **displayed to a user**, and nothing displays `instrument_quote_latest`
 * — they are currently *inapplicable*, not violated.
 *
 * **Weakened, not overturned, by the refresh-button fix.** The quote's *value* does now
 * reach a screen: the same observation is written to `instrument_price_daily`
 * as well, and valuation reads that. So "no displayed price is derived from a
 * quote" is no longer the reason NFR-1/NFR-2 do not bind here — the reason is
 * the one below it, which never depended on visibility: at a twice-daily
 * cadence a 20-minute budget is exceeded essentially always, so thresholding
 * on it yields a permanently-`BREACHED` indicator and no information. Whether
 * those budgets should be amended is still an open question, and the refresh-button
 * fix makes it a live one rather than a theoretical one.
 *
 * So each condition thresholds on **"did this series get the update its own
 * cadence promises?"**: {@link QUOTE_STALENESS_THRESHOLD_MS} (one missed
 * 12-hour slot plus margin), {@link EOD_STALENESS_SESSION_DAYS} in the
 * exchange's own trading calendar, {@link FX_STALENESS_PUBLICATION_DAYS} in
 * TARGET's. Whether NFR-1/NFR-2 should be *amended* at the root-spec level is not this
 * module's call and is recorded as a deferred item with an owner and a trigger.
 *
 * ## `detail` is a closed vocabulary, allow-listed at the writer
 *
 * `/health` is designed as if public: no tenant data, no
 * per-instrument identity, no tenant-derived counts, allow-listed `detail`
 * strings. The reader can only bound the length (200 chars, `health.ts`), so
 * the allow-list has to live here. It is a **literal** allow-list —
 * {@link OPS_INDICATOR_DETAILS}, a fixed set of constant strings with no
 * interpolation anywhere — rather than a filter over generated text, because
 * a filter fails open on the first field someone adds later. The count of
 * affected instruments, the exchange MIC, the queue name and every other
 * specific goes into the **ERROR log line**, which is operator-only, and never
 * into the table an unauthenticated endpoint echoes.
 */

type OpsIndicatorKey = "ingestionStaleness" | "deadLetterDepth" | "circuitBreaker";

/** `ops_indicator.state`'s CHECK vocabulary. `UNKNOWN` exists only in `/health`'s payload, and means "no row". */
type OpsIndicatorState = "OK" | "BREACHED";

/**
 * How often the worker re-evaluates every condition.
 *
 * Five minutes is chosen against the *push* channel, not the pull one:
 * `/health` already caches its payload for 5 s, so a probe never waits on this,
 * and what the interval really bounds is how long a fresh breach stays
 * unannounced. The conditions themselves move on scales of hours (a 12-hour
 * quote slot, a session day), so a shorter interval would buy
 * nothing and would multiply the sweep's own database reads for no signal.
 */
export const OPS_INDICATOR_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * One missed 12-hour quote-refresh slot plus margin. Not
 * NFR-1/NFR-2's 20/10 minutes; see this module's header.
 */
const QUOTE_STALENESS_THRESHOLD_MS = 14 * 60 * 60 * 1000;

/** "Newest `price_date` for a held instrument older than 3 session days", counted in the exchange's own calendar. */
const EOD_STALENESS_SESSION_DAYS = 3;

/** "Newest `rate_date` older than 3 TARGET publication days". */
const FX_STALENESS_PUBLICATION_DAYS = 3;

/**
 * The per-queue dead-letter depth that counts as a breach: **any job at all**.
 *
 * FR-48 item 2 says "exceeding a configured threshold, per queue", and this is
 * the configuration. It is deliberately the tightest possible value, because
 * of what a dead-letter queue *is* here: nothing registers a `work()` handler
 * against any of {@link DEAD_LETTER_QUEUES}, so a job that lands in one has
 * already exhausted `IngestionScheduler`'s five retries and will never leave on
 * its own. There is no "transiently elevated" state to tolerate — the depth
 * only ever goes up until a human looks.
 */
const DEAD_LETTER_DEPTH_THRESHOLD = 0;

/** Every dead-letter queue `IngestionScheduler.start()` creates (`market/ingestion`'s `scheduler.ts`). */
const DEAD_LETTER_QUEUES: readonly string[] = [
  QUOTE_REFRESH_DEAD_LETTER_QUEUE,
  HISTORY_BACKFILL_DEAD_LETTER_QUEUE,
  HISTORY_GAP_REPAIR_DEAD_LETTER_QUEUE,
  EOD_CLOSE_DEAD_LETTER_QUEUE,
  FX_DAILY_DEAD_LETTER_QUEUE,
];

/**
 * The **entire** vocabulary of `ops_indicator.detail`. Constants only, no
 * interpolation — see this module's header for why an allow-list and not a
 * filter.
 */
const OPS_INDICATOR_DETAILS = {
  quoteNeverFetched: "quote refresh: a held instrument has never been fetched",
  quoteStale: "quote refresh: newest quote older than the twice-daily cadence budget",
  eodBehind: "eod close: a held exchange is more than 3 session days behind",
  eodNever: "eod close: a held exchange has no closing price at all",
  fxBehind: "fx daily: newest ECB rate is more than 3 TARGET publication days old",
  fxNever: "fx daily: no ECB rate has ever been ingested",
  deadLetter: "a dead-letter queue is not empty",
  circuitOpen: "a provider circuit breaker is open",
  backfillUnresolvable:
    "history backfill: an instrument has been attempted and no provider symbol resolves",
  priceCurrencyMismatch:
    "price history: an instrument is priced in a currency it does not declare — its mapping names another venue",
  backfillAbandoned:
    "history backfill: an instrument has failed repeatedly and is no longer retried automatically",
} as const;

/** Joined with `"; "` when more than one cause holds — each segment still a member of the allow-list. */
const DETAIL_SEPARATOR = "; ";

/**
 * What the sweep observed for one condition. `detail` is `null` for `OK` — a
 * healthy condition has nothing to say, and a leftover explanation of a
 * *previous* breach on an `OK` row is worse than none.
 */
interface OpsIndicatorVerdict {
  readonly key: OpsIndicatorKey;
  readonly state: OpsIndicatorState;
  readonly detail: string | null;
  /**
   * The operator-only specifics for the ERROR line: counts, lane names, queue
   * names. **Never written to `ops_indicator`** and never reachable from
   * `/health` — see this module's header on the allow-list split.
   */
  readonly diagnostics: Readonly<Record<string, string | number>>;
}

/** One condition's outcome after it was written — `transitioned` is what drove the push channel. */
interface OpsIndicatorWrite {
  readonly key: OpsIndicatorKey;
  readonly state: OpsIndicatorState;
  readonly detail: string | null;
  /** `true` exactly when this sweep moved the row from not-`BREACHED` to `BREACHED`. */
  readonly transitioned: boolean;
  readonly firstBreachedAt: Date | null;
  readonly lastOkAt: Date | null;
}

export interface OpsIndicatorSweepResult {
  readonly observedAt: Date;
  readonly writes: readonly OpsIndicatorWrite[];
}

/** The slice of `CircuitBreaker` this sweep needs — a view, so a test needs no real breaker and no clock. */
interface CircuitBreakerView {
  openCircuits(): readonly string[];
}

export interface OpsIndicatorSweepDeps {
  /** The `app_ingest`-scoped ingest pool — the writer role (migration `0033`). */
  readonly db: Db;
  readonly clock: Clock;
  /** The worker's own breaker instance (the worker's, not the API's; see `market-runtime.ts`). */
  readonly breaker: CircuitBreakerView;
  /** Test seam; defaults to a real `market_calendar` read. */
  readonly marketCalendarLookup?: MarketCalendarLookup;
  /** FR-49 channel 2. Defaults to SH-38's structured ERROR line; overridable so a test can capture it directly. */
  readonly error?: (message: string, fields: Readonly<Record<string, string | number>>) => void;
}

function detailFor(causes: readonly string[]): string | null {
  return causes.length === 0 ? null : causes.join(DETAIL_SEPARATOR);
}

/**
 * FR-48 item 1, all three series at once: the quote cadence (via SH-36's
 * left-joined, fan-out-set read), the EOD close per held exchange, and
 * the daily FX pull.
 *
 * They share one indicator because they share one question — "is the ingestion
 * this deployment promises actually arriving?" — and because one indicator that
 * names its cause is more useful on a home deployment than three the owner has
 * to correlate.
 *
 * **A deployment holding nothing is `OK`, not breached.** With an empty
 * fan-out set no cadence promises anything, and an alert that fires on an empty
 * portfolio would be the first thing a new owner learns to ignore.
 */
async function sweepIngestionStaleness(
  deps: OpsIndicatorSweepDeps,
  now: Date,
  lookup: MarketCalendarLookup,
): Promise<OpsIndicatorVerdict> {
  const causes: string[] = [];
  const diagnostics: Record<string, string | number> = {};

  // `kinds`: since ADR-0018 a held FUND is polled, but its quote `as_of` is its
  // last NAV date (one or two days behind by nature), so judging it against
  // an intraday budget would breach this indicator for every fund holder,
  // permanently. Its freshness is the EOD-lane question below.
  const quotes = await listHeldInstrumentQuoteStaleness(
    deps.db,
    now,
    QUOTE_STALENESS_THRESHOLD_MS,
    {
      kinds: QUOTE_CADENCE_KINDS,
    },
  );
  const neverFetched = quotes.filter((quote) => quote.neverFetched);
  const agedOut = quotes.filter((quote) => quote.stale && !quote.neverFetched);
  if (neverFetched.length > 0) {
    causes.push(OPS_INDICATOR_DETAILS.quoteNeverFetched);
    diagnostics["quote_never_fetched_count"] = neverFetched.length;
  }
  if (agedOut.length > 0) {
    causes.push(OPS_INDICATOR_DETAILS.quoteStale);
    diagnostics["quote_stale_count"] = agedOut.length;
  }

  // The EOD lanes are the held MICs, exactly as `startup-catch-up.ts` derives
  // them — an exchange nobody holds anything on is not a lane and cannot be
  // behind.
  const held = await fetchHeldInstruments(deps.db, { kinds: EQUITY_LIKE_KINDS });
  const heldMics = [
    ...new Set(held.map((instrument) => instrument.exchangeMic).filter((mic) => mic !== null)),
  ].sort();
  const behindMics: string[] = [];
  const silentMics: string[] = [];
  for (const exchangeMic of heldMics) {
    const owedDate = await mostRecentCompletedEodSessionDay({ exchangeMic, now, lookup });
    // `null` means "I cannot say what day was owed" (the lookback was
    // exhausted, e.g. a calendar seeded closed). It must not become "today was
    // owed", and it equally must not become a breach.
    if (owedDate === null) continue;
    const cutoff = await nthPreviousSessionDay({
      isoDate: owedDate,
      sessionDays: EOD_STALENESS_SESSION_DAYS,
      calendarKey: exchangeMic,
      lookup,
    });
    if (cutoff === null) continue;
    const lastWritten = await maxPriceDateForHeldInstrumentsOnExchange(deps.db, exchangeMic);
    if (lastWritten === null) silentMics.push(exchangeMic);
    else if (lastWritten < cutoff) behindMics.push(exchangeMic);
  }
  if (silentMics.length > 0) {
    causes.push(OPS_INDICATOR_DETAILS.eodNever);
    diagnostics["eod_silent_exchanges"] = silentMics.join(",");
  }
  if (behindMics.length > 0) {
    causes.push(OPS_INDICATOR_DETAILS.eodBehind);
    diagnostics["eod_behind_exchanges"] = behindMics.join(",");
  }

  // FX is one lane for every pair — the daily pull is one job, so "the last day
  // it succeeded" is one date (`catch-up-window.ts`'s own reasoning).
  const fxHeld = held.length > 0 || quotes.length > 0;
  if (fxHeld) {
    const fxOwed = await mostRecentTargetPublicationDay({ now, lookup });
    const fxCutoff =
      fxOwed === null
        ? null
        : await nthPreviousSessionDay({
            isoDate: fxOwed,
            sessionDays: FX_STALENESS_PUBLICATION_DAYS,
            calendarKey: TARGET_CALENDAR_KEY,
            lookup,
          });
    if (fxCutoff !== null) {
      const fxLastWritten = await maxFxRateDate(deps.db);
      if (fxLastWritten === null) {
        causes.push(OPS_INDICATOR_DETAILS.fxNever);
      } else if (fxLastWritten < fxCutoff) {
        causes.push(OPS_INDICATOR_DETAILS.fxBehind);
        diagnostics["fx_last_rate_date"] = fxLastWritten;
      }
    }
  }

  // A `PENDING` backfill row that carries a `last_attempted_at` was
  // dispatched and produced no provider symbol; the hourly sweep will try it
  // again, and again, and it will keep failing. Before the stamp existed this
  // was invisible — `status` still read `PENDING`, exactly like a row waiting
  // its turn — so the only trace was a log line nobody greps, and the cost was
  // one provider search per instrument per hour indefinitely.
  //
  // It belongs on this indicator rather than a new one for the reason stated in
  // this function's own header: the question is the same, "is the ingestion this
  // deployment promises actually arriving?", and a home deployment is better
  // served by one indicator naming its cause than by four to correlate.
  const unresolvable = await countAttemptedUnresolvableBackfills(deps.db);
  if (unresolvable > 0) {
    causes.push(OPS_INDICATOR_DETAILS.backfillUnresolvable);
    diagnostics["backfill_unresolvable_count"] = unresolvable;
  }

  // The other end of the same question. A `FAILED`
  // backfill is now retried, with a bound — and a row that spends that bound is
  // one nothing will attempt again on its own. Reporting it is what keeps the
  // bound from being the original bug wearing a counter: before the bound a `FAILED`
  // row was retried by nothing and reported by nothing, and three crypto
  // instruments sat that way for five days on the live deployment. A reload
  // (`POST /instruments/:id/history-reload`) is the recovery, and this is how an
  // operator learns one is owed.
  const abandoned = await countAbandonedInstrumentBackfills(deps.db);
  if (abandoned > 0) {
    causes.push(OPS_INDICATOR_DETAILS.backfillAbandoned);
    diagnostics["backfill_abandoned_count"] = abandoned;
  }

  // Not a staleness condition in the strict sense — the prices are
  // arriving, and valuation converts them correctly from whatever currency they
  // carry. What is wrong is *which listing* they are: an ISIN-level provider
  // match can return another venue's line, and `resolveProviderSymbol` never
  // re-resolves an existing mapping, so the substitution is permanent and
  // silent. It sits on this indicator because an operator asking "is the
  // ingestion I promised actually arriving?" would want to know the answer is
  // "yes, from the wrong exchange".
  const mismatched = await countPriceCurrencyMismatchedInstruments(deps.db);
  if (mismatched > 0) {
    causes.push(OPS_INDICATOR_DETAILS.priceCurrencyMismatch);
    diagnostics["price_currency_mismatch_count"] = mismatched;
  }

  return {
    key: "ingestionStaleness",
    state: causes.length > 0 ? "BREACHED" : "OK",
    detail: detailFor(causes),
    diagnostics,
  };
}

/**
 * FR-48 item 2. Counted straight out of `pgboss.job`, which the worker's
 * `app_ingest` role owns (migration `0031`) — `app_web` has no grant there at
 * all, which is one of the reasons this sweep exists in the worker rather than
 * in `/health`.
 *
 * `completed`/`cancelled` are excluded: a dead-letter job someone has
 * deliberately drained is not depth. Everything else counts, including
 * `failed` — nothing works these queues, so a failed job in one is not
 * mid-retry, it is stuck.
 */
async function sweepDeadLetterDepth(deps: OpsIndicatorSweepDeps): Promise<OpsIndicatorVerdict> {
  const rows = (await deps.db.execute(
    sql`select name, count(*)::int as depth from pgboss.job
        where name = any(${sql.raw(`array[${DEAD_LETTER_QUEUES.map((queue) => `'${queue}'`).join(",")}]`)})
          and state not in ('completed', 'cancelled')
        group by name`,
  )) as unknown as readonly { name: string; depth: number }[];

  const overThreshold = rows.filter((row) => Number(row.depth) > DEAD_LETTER_DEPTH_THRESHOLD);
  // Allow-listed field names, not one key per queue: `depth.<queue>` would be
  // a field nobody could have put in the logger's allow-list ahead of time, so
  // it would be dropped — the allow-list failing closed, correctly, on a
  // diagnostic that was meant to be emitted.
  const diagnostics: Record<string, string | number> =
    overThreshold.length === 0
      ? {}
      : {
          dead_letter_queues: overThreshold.map((row) => row.name).join(","),
          dead_letter_depth: Math.max(...overThreshold.map((row) => Number(row.depth))),
        };

  return {
    key: "deadLetterDepth",
    state: overThreshold.length > 0 ? "BREACHED" : "OK",
    detail: overThreshold.length > 0 ? OPS_INDICATOR_DETAILS.deadLetter : null,
    diagnostics,
  };
}

/**
 * FR-48 item 3 — **the worker's** breaker, and only the worker's.
 *
 * After the producer/worker split there are two
 * `createMarketRuntime()` calls and therefore two `CircuitBreaker` instances,
 * so "one shared breaker across both lanes" stopped being true. Accepted for
 * phase 1 (SH-37); publishing *this* one is what makes the ingestion lane's
 * breaker visible at all, since `/health` runs in the other process and could
 * otherwise never see it.
 */
function sweepCircuitBreaker(deps: OpsIndicatorSweepDeps): OpsIndicatorVerdict {
  const open = deps.breaker.openCircuits();
  return {
    key: "circuitBreaker",
    state: open.length > 0 ? "BREACHED" : "OK",
    detail: open.length > 0 ? OPS_INDICATOR_DETAILS.circuitOpen : null,
    diagnostics: open.length > 0 ? { open_providers: open.join(",") } : {},
  };
}

/**
 * The upsert **and** the transition detection, in one statement.
 *
 * `previous` is a CTE that snapshots the row's state *before* the upsert in the
 * same statement that replaces it, so "was this already breached?" is answered
 * against exactly the row being overwritten — not by a read-then-write this
 * sweep could lose a race on, and not by comparing the new row's own columns
 * (which is where an earlier cut of this got it wrong: in a `RETURNING` clause
 * on `ON CONFLICT DO UPDATE`, an unqualified reference is the *new* row, so
 * `first_breached_at = observed_at` was trivially true on every sweep and the
 * push channel fired every interval — the exact behaviour the push channel
 * must never have, and the reason the "exactly one ERROR line across five sweeps"
 * assertion is worth more than any amount of reading this code).
 *
 * `first_breached_at` is carried forward across consecutive breached sweeps and
 * cleared on the way back to `OK`; `last_ok_at` is only ever advanced by an
 * `OK`, so a cleared breach can still be told from one that never happened.
 */
async function writeIndicator(
  db: Db,
  verdict: OpsIndicatorVerdict,
  observedAt: Date,
): Promise<OpsIndicatorWrite> {
  // Bound as an ISO string with an explicit cast rather than as a `Date`:
  // drizzle's raw-`sql` parameter encoder hands `postgres.js` the value
  // untouched, and a `Date` is not something that path accepts.
  const observedAtIso = observedAt.toISOString();
  const rows = (await db.execute(sql`
    with previous as (
      select state from ops_indicator where indicator_key = ${verdict.key}
    ), upserted as (
      insert into ops_indicator (indicator_key, state, observed_at, first_breached_at, last_ok_at, detail)
      values (
        ${verdict.key},
        ${verdict.state},
        ${observedAtIso}::timestamptz,
        ${verdict.state === "BREACHED" ? observedAtIso : null}::timestamptz,
        ${verdict.state === "OK" ? observedAtIso : null}::timestamptz,
        ${verdict.detail}
      )
      on conflict (indicator_key) do update set
        state = excluded.state,
        observed_at = excluded.observed_at,
        first_breached_at = case
          when excluded.state = 'BREACHED' and ops_indicator.state = 'BREACHED'
            then ops_indicator.first_breached_at
          when excluded.state = 'BREACHED' then excluded.observed_at
          else null
        end,
        last_ok_at = case when excluded.state = 'OK' then excluded.observed_at else ops_indicator.last_ok_at end,
        detail = excluded.detail
      returning first_breached_at, last_ok_at
    )
    select
      (select state from previous) as previous_state,
      upserted.first_breached_at,
      upserted.last_ok_at
    from upserted
  `)) as unknown as readonly {
    previous_state: string | null;
    first_breached_at: Date | null;
    last_ok_at: Date | null;
  }[];

  const row = rows[0];
  return {
    key: verdict.key,
    state: verdict.state,
    detail: verdict.detail,
    transitioned: verdict.state === "BREACHED" && row?.previous_state !== "BREACHED",
    firstBreachedAt: row?.first_breached_at ?? null,
    lastOkAt: row?.last_ok_at ?? null,
  };
}

/**
 * One pass over every condition. Called on a timer by the worker
 * (`market-runtime.ts`), never by the API.
 *
 * Deliberately **not** a pg-boss job: a sweep that ran as a queued job would,
 * when it started failing, land in a dead-letter queue that this very sweep is
 * the thing that reports on — the alerting path failing silently through the
 * mechanism it monitors. A plain timer has no such loop.
 */
export async function runOpsIndicatorSweep(
  deps: OpsIndicatorSweepDeps,
): Promise<OpsIndicatorSweepResult> {
  const error =
    deps.error ??
    ((message, fields) => {
      // FR-49 channel 2, through SH-38's allow-list serializers: the fields
      // below are diagnostics (indicator key, counts, provider/exchange names),
      // never a figure — and anything not allow-listed is dropped rather than
      // emitted, which is what keeps this line safe as the alert channel it is.
      rootLogger().error(message, { component: "market-composition", ...fields });
    });
  const lookup = deps.marketCalendarLookup ?? createDbMarketCalendarLookup(deps.db);
  const observedAt = deps.clock.now();

  const verdicts: OpsIndicatorVerdict[] = [
    await sweepIngestionStaleness(deps, observedAt, lookup),
    await sweepDeadLetterDepth(deps),
    sweepCircuitBreaker(deps),
  ];

  const writes: OpsIndicatorWrite[] = [];
  for (const verdict of verdicts) {
    const write = await writeIndicator(deps.db, verdict, observedAt);
    writes.push(write);
    if (write.transitioned) {
      // FR-49 channel 2, at the transition and nowhere else. The specifics live
      // here, in an operator-only line — never in `ops_indicator.detail`, which
      // an unauthenticated `/health` echoes.
      error(`[ops-indicator] ${verdict.key} BREACHED — ${verdict.detail ?? "no detail"}`, {
        indicator: verdict.key,
        ...verdict.diagnostics,
      });
    }
  }

  return { observedAt, writes };
}
