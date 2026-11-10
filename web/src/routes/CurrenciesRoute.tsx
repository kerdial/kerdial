import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, refreshFxRates, trackFxPair, untrackFxPair } from "../lib/api-client.js";
import { FX_OVERVIEW_QUERY_KEY, fxOverviewQueryOptions } from "../lib/queries.js";
import { CURRENCIES_COPY } from "../lib/copy/currencies.js";
import { fill } from "../lib/copy/fill.js";
import { messageForError } from "../lib/problem-messages.js";
import { tryFormatAmount } from "../lib/figure-format.js";
import { PageHeader } from "../components/PageHeader.js";
import {
  Badge,
  Banner,
  Button,
  Card,
  IconButton,
  JargonTerm,
  Select,
  Skeleton,
  StatTile,
} from "../components/ui/index.js";
import type { FxOverview, FxPairStatus } from "../lib/api-client.js";

/**
 * `CurrenciesRoute.tsx` — the **Devises** screen (it was once
 * dropped as "no read exists that it could show"; `GET
 * /market-data/fx` is that read).
 *
 * Three things the owner asked for, and nothing else: see the FX rates this
 * deployment manages, retrigger the retrieval, and add a pair.
 *
 * **No router-bound/router-agnostic split** (like `HoldingsRoute`/
 * `ControlsRoute`, unlike `InstrumentsRoute`/`InstrumentsView`): this screen has
 * no search params, so it never calls `useSearch()`/`useParams()` and never
 * imports `router.js` — which is what keeps it directly testable under plain
 * `vitest`.
 *
 * ## Every figure is read, none is derived twice
 *
 * The server answers the pair list, each pair's coverage, and the provider's
 * published set in one response, so there is one query key for the whole screen
 * (`fxOverviewQueryOptions`) and no fan-out to bound. The *managed set* itself
 * is computed server-side by the same `resolveFxDailyPairs` the ingestion
 * worker uses, so this screen lists the pairs the next run will actually fetch
 * rather than a client-side guess at them.
 *
 * ## What is deliberately not claimed
 *
 * - **No rate is invented.** A pair with no `fx_rate_daily` rows renders an em
 *   dash in every coverage cell, never `0` and never a placeholder date. The
 *   server omits the fields; this file's `orDash` is the only thing that turns
 *   absence into text.
 * - **No refresh time.** Nothing on the wire says when a job ran or when the
 *   next one will; the only timestamps here are `rate_date`s the provider
 *   published, labelled as such.
 * - **No promise that the refresh has finished.** `POST fx/refresh` answers
 *   `202` — the job is queued, nothing is fetched yet — and the confirmation
 *   says exactly that. A pair count comes back from the server, so "how many
 *   pairs" is a fact, not an estimate.
 * - **The tracked list is deployment-wide.** `fx_tracked_pair` is shared
 *   reference data with no `tenant_id`; the note under the table says so rather
 *   than letting « suivie » imply a per-user setting.
 *
 * ## Rate direction
 *
 * `fx_rate_daily` stores `amount_base = amount_native × rate` for a
 * `(base, quote)` pair, i.e. `base` is what you report in and `quote` is what
 * you hold. Rendering that as the bare number `0,8712` next to "EUR/USD" is
 * exactly how a rate gets read upside down, so the cell spells the equation
 * out: « 1 USD = 0,8712 EUR ».
 */

/** The em dash every absent figure renders as — one constant, so "unavailable" cannot drift into "0" at one call site. */
const DASH = "—";

function orDash(value: string | undefined): string {
  return value ?? DASH;
}

/**
 * The rate as the equation it is, not as a bare number.
 *
 * Formatted through `tryFormatAmount("fxRate", …)` — the app's own decimal
 * display path (`figure-format.ts`, itself the only module allowed to import
 * `@kerdial/core-decimal`'s formatters). Never `Number(...)`/`parseFloat`:
 * the repo's `no-restricted-syntax` rule bans float conversion in `web/` for
 * the same reason the server never does it, and a rate is exactly the value a
 * silent binary rounding would corrupt invisibly.
 *
 * `scale` is `0` because it is ignored for every kind but `monetary`
 * (`assertValidScale`/`formatAmount`); `fxRate` has its own fixed display
 * precision. A malformed value degrades to the em dash rather than throwing —
 * `tryFormatAmount`'s F2 contract — so one bad rate cannot blank the screen.
 */
function formatRate(pair: FxPairStatus): string {
  if (pair.latestRate === undefined) return DASH;
  const formatted = tryFormatAmount("fxRate", pair.latestRate, 0);
  if (formatted === undefined) return DASH;
  return `1 ${pair.quote} = ${formatted} ${pair.base}`;
}

/** `points` and the first date together — the honest depth of the series a valuation can draw on. */
function coverageText(pair: FxPairStatus): string {
  if (pair.points === 0) return "Aucun historique";
  const suffix = pair.firstRateDate === undefined ? "" : ` depuis le ${pair.firstRateDate}`;
  return `${pair.points} taux${suffix}`;
}

function pairKey(pair: { readonly base: string; readonly quote: string }): string {
  return `${pair.base}/${pair.quote}`;
}

/** The picker's options: every published pair the table does not already list. */
function addablePairs(overview: FxOverview): readonly { base: string; quote: string }[] {
  const listed = new Set(overview.pairs.map(pairKey));
  return overview.supportedPairs.filter((pair) => !listed.has(pairKey(pair)));
}

/** The most recent `rate_date` across every listed pair, or `undefined` when nothing has ever been fetched. */
function latestRateDate(pairs: readonly FxPairStatus[]): string | undefined {
  return pairs
    .map((pair) => pair.latestRateDate)
    .filter((date): date is string => date !== undefined)
    .sort()
    .at(-1);
}

export function CurrenciesRoute() {
  const queryClient = useQueryClient();
  const [selectedPair, setSelectedPair] = useState<string>("");
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const overviewQuery = useQuery(fxOverviewQueryOptions());
  const overview = overviewQuery.data;

  async function reload(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: FX_OVERVIEW_QUERY_KEY });
  }

  // Three one-shot, user-initiated writes. `networkMode: "always"` on each, the
  // same convention every other write in this app follows: a write is never
  // paused and replayed later from an offline queue.
  const addMutation = useMutation({
    mutationFn: async (key: string) => {
      const [base, quote] = key.split("/");
      if (base === undefined || quote === undefined) {
        throw new Error(`CurrenciesRoute: malformed pair key ${key}`);
      }
      return trackFxPair({ base, quote });
    },
    networkMode: "always",
    onSuccess: async (result) => {
      setSelectedPair("");
      setNotice(
        result.created
          ? `${result.base}/${result.quote} sera récupérée à la prochaine mise à jour.`
          : `${result.base}/${result.quote} était déjà suivie.`,
      );
      await reload();
    },
  });

  const removeMutation = useMutation({
    mutationFn: (pair: { base: string; quote: string }) => untrackFxPair(pair),
    networkMode: "always",
    onSuccess: async (_result, pair) => {
      // Says what untracking actually does — the rates already fetched stay, and
      // a pair that is *held* keeps being fetched regardless.
      setNotice(
        `${pair.base}/${pair.quote} n'est plus suivie. Les taux déjà récupérés sont conservés.`,
      );
      await reload();
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshFxRates(),
    networkMode: "always",
    onSuccess: async (result) => {
      setNotice(
        result.enqueued
          ? `Récupération demandée pour ${result.pairs} paire${result.pairs === 1 ? "" : "s"}. Les taux arriveront d'ici quelques instants.`
          : "Une récupération est déjà en cours — celle-ci a été fusionnée avec elle.",
      );
      await reload();
    },
  });

  const options = overview === undefined ? [] : addablePairs(overview);
  const pairs = overview?.pairs ?? [];
  const trackedCount = pairs.filter((pair) => pair.tracked).length;
  const withoutHistory = pairs.filter((pair) => pair.points === 0).length;
  const mutationError =
    addMutation.error ?? removeMutation.error ?? refreshMutation.error ?? undefined;

  return (
    <section data-testid="fx-screen" className="fx-screen">
      <PageHeader
        title={CURRENCIES_COPY.screenTitle}
        subtitle={CURRENCIES_COPY.screenSubtitle}
        actions={
          <Button
            variant="secondary"
            iconLeft="refresh-cw"
            loading={refreshMutation.isPending}
            disabled={overview !== undefined && !overview.ingestionConfigured}
            data-testid="fx-refresh"
            onClick={() => refreshMutation.mutate()}
          >
            {CURRENCIES_COPY.refetch}
          </Button>
        }
      />

      <Card padding="none" data-testid="fx-strip">
        <div className="fx-strip">
          <div className="fx-strip-item">
            <StatTile
              data-testid="fx-pair-count"
              label={CURRENCIES_COPY.pairsFetched}
              icon="coins"
              value={<span className="k-num">{pairs.length}</span>}
              delta={
                <span className="fx-strip-sub">
                  {fill(CURRENCIES_COPY.pairsTracked, { count: String(trackedCount) })}
                </span>
              }
            />
          </div>
          <div className="fx-strip-item">
            <StatTile
              data-testid="fx-latest-date"
              label={CURRENCIES_COPY.latestRate}
              icon="clock"
              value={
                <span className="k-num">
                  {/* "…" while the read is in flight, an em dash only once it
                      has settled without a value: loading and unavailable are
                      different states, and this is the tile where confusing
                      them reads as "no rate exists". */}
                  {overviewQuery.isPending ? "…" : orDash(latestRateDate(pairs))}
                </span>
              }
            />
          </div>
          <div className="fx-strip-item">
            <StatTile
              data-testid="fx-source"
              label={CURRENCIES_COPY.source}
              value={
                <span className="k-mono">
                  {overview === undefined ? DASH : overview.provider.key.toUpperCase()}
                </span>
              }
              delta={
                <span className="fx-strip-sub">
                  {overview === undefined
                    ? ""
                    : fill(CURRENCIES_COPY.ratesExpressedIn, {
                        currency: overview.provider.baseCurrency,
                      })}
                </span>
              }
            />
          </div>
          <div className="fx-strip-item">
            <StatTile
              data-testid="fx-without-history"
              label={CURRENCIES_COPY.pairsWithoutHistory}
              icon="circle-alert"
              value={<span className="k-num">{withoutHistory}</span>}
            />
          </div>
        </div>
      </Card>

      {overview !== undefined && !overview.ingestionConfigured && (
        <Banner tone="warn" icon="alert-triangle" testId="fx-ingestion-off">
          {CURRENCIES_COPY.ingestionNotConfigured}
        </Banner>
      )}

      {overviewQuery.isError && (
        <Banner tone="loss" icon="circle-alert" testId="fx-read-error">
          {messageForError(overviewQuery.error).text}
        </Banner>
      )}

      {mutationError !== undefined && (
        <Banner tone="loss" icon="circle-alert" testId="fx-write-error">
          {messageForError(mutationError).text}
          {mutationError instanceof ApiError && mutationError.code === "FX_PAIR_NOT_SUPPORTED"
            ? CURRENCIES_COPY.pairNotPublished
            : ""}
        </Banner>
      )}

      {notice !== undefined && (
        <Banner tone="neutral" icon="info" testId="fx-notice">
          {notice}
        </Banner>
      )}

      <Card data-testid="fx-add-card">
        <div className="fx-add">
          <Select
            label={CURRENCIES_COPY.addPair}
            data-testid="fx-add-select"
            hint={CURRENCIES_COPY.addPairHint}
            value={selectedPair}
            disabled={options.length === 0}
            onChange={(event) => setSelectedPair(event.target.value)}
            options={[
              { value: "", label: CURRENCIES_COPY.choosePair },
              ...options.map((pair) => ({
                value: pairKey(pair),
                label: `${pair.quote} → ${pair.base}`,
              })),
            ]}
          />
          <Button
            iconLeft="plus"
            loading={addMutation.isPending}
            disabled={selectedPair === ""}
            data-testid="fx-add-submit"
            onClick={() => addMutation.mutate(selectedPair)}
          >
            {CURRENCIES_COPY.add}
          </Button>
        </div>
      </Card>

      {overviewQuery.isPending && (
        <Card padding="none" data-testid="fx-loading">
          <Skeleton rows={4} size="compact" label={CURRENCIES_COPY.loadingRates} />
        </Card>
      )}

      {!overviewQuery.isPending && pairs.length === 0 && (
        <Card data-testid="fx-empty">
          <div className="fx-empty">
            <p>{CURRENCIES_COPY.noPairs}</p>
          </div>
        </Card>
      )}

      {pairs.length > 0 && (
        <Card padding="none" data-testid="fx-list-card">
          <div className="fx-scroll">
            <table className="fx-table" data-testid="fx-table">
              <thead>
                <tr>
                  <th scope="col">{CURRENCIES_COPY.columnPair}</th>
                  <th scope="col">
                    <JargonTerm term="fxRate">{CURRENCIES_COPY.columnLatestRate}</JargonTerm>
                  </th>
                  <th scope="col">{CURRENCIES_COPY.columnDate}</th>
                  <th scope="col">{CURRENCIES_COPY.columnSource}</th>
                  <th scope="col">
                    <JargonTerm term="coverage">{CURRENCIES_COPY.columnHistory}</JargonTerm>
                  </th>
                  <th scope="col">{CURRENCIES_COPY.columnOrigin}</th>
                  <th scope="col" className="fx-cell-right">
                    {CURRENCIES_COPY.columnAction}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((pair) => (
                  <tr key={pairKey(pair)} data-testid="fx-row">
                    <td className="k-mono">{pairKey(pair)}</td>
                    <td className="fx-cell-rate k-num" data-testid="fx-row-rate">
                      {formatRate(pair)}
                    </td>
                    <td className="k-num">{orDash(pair.latestRateDate)}</td>
                    <td className="fx-cell-muted">{orDash(pair.latestSourceKey)}</td>
                    <td className="fx-cell-muted">{coverageText(pair)}</td>
                    <td>
                      <div className="fx-flags">
                        {pair.held && <Badge tone="neutral">{CURRENCIES_COPY.flagHeld}</Badge>}
                        {pair.tracked && <Badge tone="accent">{CURRENCIES_COPY.flagTracked}</Badge>}
                        {!pair.supported && (
                          <Badge tone="warn" data-testid="fx-row-unsupported">
                            {CURRENCIES_COPY.flagUnsupported}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="fx-cell-right">
                      {pair.tracked ? (
                        <IconButton
                          icon="trash"
                          label={fill(CURRENCIES_COPY.stopTracking, { pair: pairKey(pair) })}
                          variant="plain"
                          data-testid="fx-row-remove"
                          onClick={() =>
                            removeMutation.mutate({ base: pair.base, quote: pair.quote })
                          }
                        />
                      ) : (
                        <span className="fx-cell-muted">{DASH}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fx-note fx-foot">{CURRENCIES_COPY.installationWideNote}</div>
        </Card>
      )}
    </section>
  );
}
