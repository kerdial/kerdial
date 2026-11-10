import { CURATED_EXCHANGE_MICS } from "@kerdial/core-reference-data";
import type { InstrumentIdentityMatch, InstrumentKind } from "@kerdial/ledger";

import type { ImportLimits } from "../limits.js";
import type { CurrencyCode, NeutralInstrumentRow, SourceRowRef } from "../types.js";
import {
  classifyDiscoveryError,
  type Clock,
  type DiscoveryKind,
  type DiscoveryMatch,
  type ImportDiscoveryPort,
} from "./ports.js";

/**
 * ID6's instrument resolution for an asset-catalogue file.
 *
 * Three separable things live here because they are one decision per row: which
 * exchange the row is listed on (the suffix table, then discovery), what kind
 * of instrument it is (rule K), and whether the catalogue already has it
 * (IMP-14). The output is a *proposal* the user confirms, never a write — see
 * {@link InstrumentResolution}.
 */

/**
 * The suffix table. Every target is **VERIFIED present** in
 * `CURATED_EXCHANGE_MICS` (`core/reference-data/src/exchange-mic.ts`), and
 * {@link assertCuratedSuffixTargets} below re-checks that at module load rather
 * than trusting this comment.
 *
 * `.DE` → `XETR` is **a convention this module asserts, not something the
 * codebase states** (M15): a `.DE` ticker is conventionally Xetra. Flagged here
 * and not only in a document.
 *
 * Deliberately **absent**: `.DU` (Düsseldorf) and `.F` (Frankfurt floor) have no
 * curated MIC, so no honest entry exists for them. They are not hand-waved into
 * `XETR`; they go to discovery like any other unrecognised suffix.
 */
export const SYMBOL_SUFFIX_TO_MIC: Readonly<Record<string, string>> = {
  ".PA": "XPAR",
  ".AS": "XAMS",
  ".MI": "XMIL",
  ".DE": "XETR",
};

/**
 * A load-time check, not a comment: every MIC the table above can propose is one
 * `CURATED_EXCHANGE_MICS` actually offers. A MIC absent from the curated list is
 * one the user's own exchange dropdown cannot display, so proposing it would
 * produce a confirmation step with an unselectable value in it.
 */
function assertCuratedSuffixTargets(): void {
  const curated = new Set(CURATED_EXCHANGE_MICS.map((exchange) => exchange.mic));
  const uncurated = Object.values(SYMBOL_SUFFIX_TO_MIC).filter((mic) => !curated.has(mic));
  if (uncurated.length > 0) {
    throw new Error(`suffix table proposes uncurated exchange code(s): ${uncurated.join(", ")}`);
  }
}
assertCuratedSuffixTargets();

/** A ticker split into the part that is stored and the exchange the suffix named, if the table knows it. */
export interface SplitSymbol {
  /** The suffix is **stripped** when it resolved: `instrument.symbol` gets the local ticker, and the exchange is carried by `exchange_mic`. */
  readonly symbol: string;
  readonly exchangeMic: string | null;
}

/**
 * Splits a source ticker on the table. An unrecognised suffix is left
 * attached, because nothing has decided yet what it means — stripping `.DU`
 * would silently turn a Düsseldorf listing into a bare ticker and lose the one
 * hint discovery has to work with.
 */
export function splitSymbolSuffix(symbol: string): SplitSymbol {
  const normalized = symbol.trim().toUpperCase();
  for (const [suffix, mic] of Object.entries(SYMBOL_SUFFIX_TO_MIC)) {
    if (normalized.endsWith(suffix)) {
      return { symbol: normalized.slice(0, -suffix.length), exchangeMic: mic };
    }
  }
  return { symbol: normalized, exchangeMic: null };
}

/**
 * The proposal: what the dry-run offers for one asset row and what an
 * `APPLY` echoes back. **This is the confirmation `market/ports` demands** — its
 * own rule for a provider-derived exchange code is that it "is only ever offered
 * to the user as a pre-selection they must confirm, never silently persisted",
 * and a value that has made this round trip has been confirmed.
 */
export interface InstrumentResolution {
  /** {@link SourceRowRef.index} — the stable key the UI and the echo-back address rows by. */
  readonly index: number;
  readonly action: "CREATE" | "SKIP";
  /** Rule K's proposal, user-overridable in the review step (a wrong kind is a one-way door, so it is never silently applied). Never `SCPI` (SCD-14): the review echo refuses it. */
  readonly kind: DiscoveryKind;
  /**
   * Where {@link kind} came from. Shown in the UI; **never a decision
   * input on apply**, exactly like {@link micSource}.
   *
   * It was already stated that rule K under-classifies and relied on the review
   * step to catch it. What the review step could not do was say *which* rows
   * were guesses: a kind derived from a TER and a kind defaulted because the
   * source file said nothing rendered identically, so on a file of a few dozen
   * rows the defaults were accepted wholesale — and `instrument.kind` is granted to
   * `app_owner` only, so the write is a one-way door neither the UI nor the API
   * can correct afterwards. This field is the missing half of that mitigation.
   */
  readonly kindSource: "EXPENSE_RATIO" | "DISCOVERY" | "DEFAULT" | "USER";
  /**
   * Independent evidence that a `DEFAULT` kind is probably wrong: the row's own
   * display name carries a fund marker ({@link FUND_NAME_MARKERS}).
   *
   * **Why a second field rather than a fourth `kindSource` value.** It is not
   * provenance — the proposal is *still* the SHARE default, because a name is a
   * heuristic and the rule is that a heuristic feeds the flag rather than
   * writing silently. It is what turns the flag from "most rows are defaults"
   * (true, and useless) into "these few disagree with their own name", which
   * is a list a person actually reads.
   */
  readonly nameSuggestsFund: boolean;
  /** `null` for a symbol-based kind, which has no exchange. */
  readonly exchangeMic: string | null;
  /** Where the MIC came from. Shown in the UI; **never a decision input on apply**. */
  readonly micSource: "SUFFIX_TABLE" | "DISCOVERY" | "USER";
  readonly matchQuality: "EXACT" | "PROBABLE" | null;
}

/** What rule K decided, and how sure it is about it — {@link InstrumentResolution.kindSource}. */
interface KindProposal {
  readonly kind: DiscoveryKind;
  readonly kindSource: InstrumentResolution["kindSource"];
  readonly nameSuggestsFund: boolean;
}

/**
 * The tokens that make a display name fund-shaped.
 *
 * **Matched as whole tokens, never as substrings**, so `ETC` cannot fire on
 * "FLETCHER" and `FCP` cannot fire inside a longer word. Validated against a
 * real-world asset file: it marked exactly its TER-less funds — names such as
 * "… S&P 500 **UCITS ETF** - EUR (C)", a money-market fund whose exporter
 * truncated UCITS to "**UCI**", and a "PHYSICAL GOLD **ETC**" (the committed
 * fixture's `PPFB.DE`, "iShares Physical Gold **ETC**", is that case) — and no
 * equity row.
 *
 * **It under-marks, and that is the honest boundary of a name heuristic**: a
 * real asset file also carries funds whose names say nothing at all (a plain
 * "<manager> Europe Small" or "<manager> Global Markets"). Those rows still arrive at the
 * review step flagged `kindSource: "DEFAULT"` — the weaker signal, which is the
 * one that is always true when it is true. A marker is a reason to look
 * *first*, never the only reason to look.
 */
const FUND_NAME_MARKERS: readonly string[] = [
  "UCITS",
  "UCI",
  "ETF",
  "ETC",
  "ETN",
  "SICAV",
  "FCP",
  "OPCVM",
  "TRACKER",
  "FUND",
  "FONDS",
];

const FUND_NAME_MARKER_SET = new Set(FUND_NAME_MARKERS);

/** Splits on anything that is not a letter or a digit — `"AMUNDI S&P 500 UCITS ETF - EUR (C)"` tokenises to include `UCITS` and `ETF`. */
function nameSuggestsFund(displayName: string): boolean {
  return displayName
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .some((token) => FUND_NAME_MARKER_SET.has(token));
}

/**
 * The rule K branches 2 and 3, and the one place a kind is proposed for an
 * ISIN-carrying row.
 *
 * The proposal itself is unchanged — a TER means `ETF`, its absence means
 * `SHARE` — because changing it is what is forbidden: `instrument.kind` has no
 * edit path, so anything this function decides on a guess is unrecoverable. All
 * that is added is the provenance the review step needs to point at the guesses.
 */
function proposeKind(row: NeutralInstrumentRow): KindProposal {
  return {
    kind: row.hasExpenseRatio ? "ETF" : "SHARE",
    kindSource: row.hasExpenseRatio ? "EXPENSE_RATIO" : "DEFAULT",
    nameSuggestsFund: nameSuggestsFund(row.displayName),
  };
}

/** What `apply` (CI-13) will create for a resolved asset row. */
export interface PlannedInstrumentWrite {
  readonly target: "INSTRUMENT";
  readonly kind: InstrumentKind;
  readonly isin: string | null;
  /** Suffix-stripped. */
  readonly symbol: string | null;
  readonly exchangeMic: string | null;
  readonly displayName: string;
  readonly listingCurrency: CurrencyCode;
  readonly note: string | null;
}

/** The reason codes the table assigns to asset-row resolution. */
type AssetRejectReason =
  | "EXCHANGE_MIC_NOT_RESOLVED"
  | "EXCHANGE_MIC_LOOKUP_UNAVAILABLE"
  | "UNSUPPORTED_ASSET_CLASS"
  | "RESOLUTION_NOT_CONFIRMED";

export type AssetResolutionOutcome =
  | {
      readonly kind: "CREATE";
      readonly resolution: InstrumentResolution;
      readonly write: PlannedInstrumentWrite;
    }
  | { readonly kind: "SKIP"; readonly message: string }
  | { readonly kind: "REJECT"; readonly reason: AssetRejectReason; readonly message: string };

/** One asset row and where it came from. */
export interface AssetRowInput {
  readonly at: SourceRowRef;
  readonly row: NeutralInstrumentRow;
}

/**
 * The catalogue snapshot every resolution decision reads, built once from
 * `findInstrumentsByIdentity`'s single batched result and then queried in
 * memory. No resolution path below issues a query of its own.
 */
export interface CatalogueIndex {
  byIsin(isin: string): readonly InstrumentIdentityMatch[];
  bySymbol(symbol: string): readonly InstrumentIdentityMatch[];
}

export function indexCatalogue(matches: readonly InstrumentIdentityMatch[]): CatalogueIndex {
  const byIsin = new Map<string, InstrumentIdentityMatch[]>();
  const bySymbol = new Map<string, InstrumentIdentityMatch[]>();
  for (const match of matches) {
    if (match.isin !== null) {
      const key = match.isin.trim().toUpperCase();
      byIsin.set(key, [...(byIsin.get(key) ?? []), match]);
    }
    if (match.symbol !== null) {
      const key = match.symbol.trim().toUpperCase();
      bySymbol.set(key, [...(bySymbol.get(key) ?? []), match]);
    }
  }
  return {
    byIsin: (isin) => byIsin.get(isin.trim().toUpperCase()) ?? [],
    bySymbol: (symbol) => bySymbol.get(symbol.trim().toUpperCase()) ?? [],
  };
}

/**
 * Backoff used when a rate limit gave no `retryAfterSeconds` of its own. Two
 * seconds is the shipped bucket's own refill period (`refillPerSecond: 0.5`),
 * so it is the shortest wait that can actually produce a token rather than a
 * second immediate rejection.
 */
const DEFAULT_RETRY_BACKOFF_MS = 2_000;

/** `"UNAVAILABLE"` means "the lookup did not happen or could not complete", which is a different remedy from "it happened and found nothing". */
type LookupResult = readonly DiscoveryMatch[] | "UNAVAILABLE";

/**
 * The bounded discovery caller. A naive per-row fan-out is not merely
 * slow, it is structurally impossible against the shipped lane: the bucket is
 * `capacity: 2, refillPerSecond: 0.5`, constructed **non-blocking**, so the
 * third call inside two seconds throws rather than waiting — and one upstream
 * `resolve()` is up to six HTTP calls.
 *
 * So three bounds, all of them observable from outside: a call budget, a
 * wall-clock deadline, and a retry rule that retries only the one failure that
 * can clear on its own.
 */
class DiscoveryBudget {
  #callsIssued = 0;

  constructor(
    private readonly port: ImportDiscoveryPort | null,
    private readonly limits: ImportLimits,
    private readonly clock: Clock,
    private readonly deadlineAt: number,
  ) {}

  /** Provider calls actually issued. `ImportPlan.discoveryCallsIssued` is this, and the decisive property is that it is 0 on a confirm. */
  get callsIssued(): number {
    return this.#callsIssued;
  }

  async search(kind: DiscoveryKind, query: string): Promise<LookupResult> {
    if (this.port === null) return "UNAVAILABLE";
    for (;;) {
      if (this.#callsIssued >= this.limits.discoveryLookupBudget) return "UNAVAILABLE";
      if (this.clock.now().getTime() >= this.deadlineAt) return "UNAVAILABLE";
      this.#callsIssued += 1;
      try {
        return await this.port.search({ kind, query });
      } catch (error) {
        const classification = classifyDiscoveryError(error);
        if (!classification.retryable) return "UNAVAILABLE";
        const waitMs =
          classification.retryAfterSeconds === null
            ? DEFAULT_RETRY_BACKOFF_MS
            : classification.retryAfterSeconds * 1_000;
        // Sleeping past the deadline would spend the whole remaining budget on
        // one row and then report every other row unavailable anyway.
        if (this.clock.now().getTime() + waitMs >= this.deadlineAt) return "UNAVAILABLE";
        await this.clock.sleep(waitMs);
      }
    }
  }
}

/**
 * The product's non-goals, named in the one reason code that exists to name
 * them (branch 4).
 *
 * **It states the boundary positively and paraphrases one excluded class, and
 * that is deliberate.** The product's own wording for that class is a
 * two-word phrase that is also a key of `core/reference-data`'s provider sector
 * table, and `classification-vocabulary-containment.test.ts` enforces —
 * case-insensitively, repo-wide — that the provider's classification vocabulary
 * appears in exactly one file. Quoting that wording verbatim here would put a second
 * copy of that vocabulary in the tree and turn a real containment gate red for a
 * purely cosmetic reason. The claim the message makes is unchanged; only one
 * noun is.
 */
const UNSUPPORTED_ASSET_CLASS_MESSAGE =
  "the row carries no ISIN and no symbol this catalogue can match, so it is outside the asset classes this product models: " +
  "shares, exchange-traded funds, funds and crypto, and nothing else (not property, private equity, collectibles, bonds as a class, options or futures)";

/**
 * The confirm path: on a confirm, no lookup runs at all.
 *
 * **Confirm mode is the request's own `mode === "APPLY"`, carried through
 * `PlanContext.mode`, and never the length of `resolutions[]`**. The
 * length-based inference this function used to be documented against was
 * wrong, and the reasoning that dismissed its one edge was wrong in a way
 * worth recording so it is not re-derived: it argued that a confirm whose
 * dry-run produced zero proposals "cannot produce a wrong write", because
 * every row that had no proposal had no `CREATE` either. That assumes this
 * stage can see the prior dry run. It cannot — nothing correlates a submitted
 * `resolutions[]` with any earlier request — so an `APPLY` carrying `[]` took
 * the dry-run branch *inside a write pass*: it re-derived every MIC from the
 * provider with a fresh budget and `apply` persisted the results, at
 * `micSource: "DISCOVERY"`, into the tenant-less shared `instrument`
 * catalogue. `market/ports`' rule (a provider-derived MIC "is only ever
 * offered to the user as a pre-selection they must confirm, never silently
 * persisted") and the rule "the apply pass issues zero provider calls" both
 * broke on it, and the shipped wizard reaches it without any adversary:
 * `ImportWizard.tsx` posts `summary.proposals ?? []`, which is `[]` whenever
 * the dry run's discovery budget was spent before any row resolved.
 *
 * **What an `APPLY` with an empty (or merely incomplete) list does instead:
 * nothing is created that the user did not confirm, and every unlisted row is
 * re-decided from the catalogue snapshot alone.** A row the catalogue already
 * covers is the `SKIP` its own dry run reported; anything else is
 * `RESOLUTION_NOT_CONFIRMED`. The catalogue branch issues no lookup and
 * proposes no write — it is a read of the batch `plan` had already performed
 * — so the zero-provider-call property is untouched by it, and
 * nothing an unlisted row can do results in a create.
 *
 * **The `400` this used to be weighed against, and the reason first given for
 * rejecting it, are both corrected here**. The original reasoning
 * was that `proposals` carries only `CREATE` rows, so a file whose every row is
 * already catalogued legitimately posts `[]`, and a `400` "would both fail a
 * correct import and throw away the per-row report FR-53 requires". The first
 * half of that is a true statement about `proposals` and a false argument for
 * the no-op, which failed that same correct import just as completely — with
 * `200` and N rejects instead of a `400`, and with a per-row report that told
 * the user every row "was never reviewed" while its own dry run had called the
 * identical rows skips. Consulting the catalogue is what actually makes that
 * file import correctly, and it makes IMP-AC-14's dry-run/confirm identity hold
 * for a *mixed* file too — the same asymmetry, which was recorded as still
 * open and which the empty case was only the whole-file instance of.
 */
function fromConfirmedResolution(
  input: AssetRowInput,
  confirmed: InstrumentResolution | undefined,
  catalogue: CatalogueIndex,
): AssetResolutionOutcome {
  if (confirmed === undefined) {
    const split = input.row.symbol === null ? null : splitSymbolSuffix(input.row.symbol);
    return (
      catalogueSkip(input.row, split, catalogue) ?? {
        kind: "REJECT",
        reason: "RESOLUTION_NOT_CONFIRMED",
        message: `row ${String(input.at.index)} is present in the file but absent from the confirmed resolutions, so it was never reviewed`,
      }
    );
  }
  if (confirmed.action === "SKIP") {
    return {
      kind: "SKIP",
      message: "the review step marked this row as already covered by the catalogue",
    };
  }
  const split = input.row.symbol === null ? null : splitSymbolSuffix(input.row.symbol);
  return {
    kind: "CREATE",
    resolution: confirmed,
    write: {
      target: "INSTRUMENT",
      kind: confirmed.kind,
      isin: input.row.isin,
      symbol: split?.symbol ?? null,
      exchangeMic: confirmed.exchangeMic,
      displayName: input.row.displayName,
      listingCurrency: input.row.listingCurrency,
      note: input.row.note,
    },
  };
}

export interface ResolveAssetRowsParams {
  readonly rows: readonly AssetRowInput[];
  readonly catalogue: CatalogueIndex;
  readonly discovery: ImportDiscoveryPort | null;
  /** `true` on an `APPLY` (`PlanContext.mode`), and the only thing that decides it — see {@link fromConfirmedResolution}. */
  readonly confirm: boolean;
  readonly resolutions: readonly InstrumentResolution[];
  readonly limits: ImportLimits;
  readonly clock: Clock;
}

export interface ResolveAssetRowsResult {
  /** Positionally aligned with `params.rows`. */
  readonly outcomes: readonly AssetResolutionOutcome[];
  readonly proposals: readonly InstrumentResolution[];
  readonly discoveryCallsIssued: number;
}

/**
 * Resolves every asset row of one file, in file order, inside one shared budget
 * and one shared deadline.
 *
 * **Order of operations is the re-run economy, not an implementation
 * detail.** The catalogue check runs *before* any lookup, so a re-run — which
 * is the designed remedy for a partially-resolved import — spends its
 * whole budget on rows still unresolved rather than re-resolving rows the
 * previous run already created.
 */
export async function resolveAssetRows(
  params: ResolveAssetRowsParams,
): Promise<ResolveAssetRowsResult> {
  const confirmMode = params.confirm;
  const confirmedByIndex = new Map(params.resolutions.map((one) => [one.index, one]));
  const budget = new DiscoveryBudget(
    params.discovery,
    params.limits,
    params.clock,
    params.clock.now().getTime() + params.limits.discoveryDeadlineMs,
  );

  const outcomes: AssetResolutionOutcome[] = [];
  const proposals: InstrumentResolution[] = [];

  for (const input of params.rows) {
    const outcome = confirmMode
      ? fromConfirmedResolution(input, confirmedByIndex.get(input.at.index), params.catalogue)
      : await resolveOneAssetRow(input, params.catalogue, budget);
    outcomes.push(outcome);
    if (outcome.kind === "CREATE") proposals.push(outcome.resolution);
  }

  return { outcomes, proposals, discoveryCallsIssued: budget.callsIssued };
}

/**
 * IMP-14, and the **one** place the three "already in the catalogue" decisions
 * are made.
 *
 * It is one function rather than three inline checks because two callers now
 * need the identical answer and must not be able to drift: the dry run reaches
 * it through {@link resolveOneAssetRow}, and a confirm reaches it for every row
 * the user's echoed list does not mention. If those two ever
 * disagreed, the disagreement would surface as a dry run and its own confirm
 * reporting different counts for one unchanged file — which is precisely the
 * defect this function was extracted to close, so leaving two copies would be
 * leaving the bug's own mechanism in place.
 *
 * It reads {@link CatalogueIndex} and nothing else: no lookup, no write, no
 * proposal. `null` means "the catalogue has nothing to say", never "create it".
 */
function catalogueSkip(
  row: NeutralInstrumentRow,
  split: SplitSymbol | null,
  catalogue: CatalogueIndex,
): AssetResolutionOutcome | null {
  if (row.isin === null) {
    if (split !== null && catalogue.bySymbol(split.symbol).length > 0) {
      return {
        kind: "SKIP",
        message: "this instrument is already in the catalogue under this symbol",
      };
    }
    return null;
  }
  // A known suffix names one listing, so only *that* listing counts as covered:
  // the same identifier at a different exchange is a different row to create.
  if (split?.exchangeMic != null) {
    return catalogue.byIsin(row.isin).some((match) => match.exchangeMic === split.exchangeMic)
      ? { kind: "SKIP", message: "this listing is already in the instrument catalogue" }
      : null;
  }
  return catalogue.byIsin(row.isin).length > 0
    ? {
        kind: "SKIP",
        message: "this instrument is already in the catalogue under a resolved exchange",
      }
    : null;
}

async function resolveOneAssetRow(
  input: AssetRowInput,
  catalogue: CatalogueIndex,
  budget: DiscoveryBudget,
): Promise<AssetResolutionOutcome> {
  const { row, at } = input;
  const split = row.symbol === null ? null : splitSymbolSuffix(row.symbol);

  // The catalogue check comes first (the re-run economy): if this row is
  // already listed, a lookup would spend budget only to propose something that
  // already exists.
  const alreadyCatalogued = catalogueSkip(row, split, catalogue);
  if (alreadyCatalogued !== null) return alreadyCatalogued;

  if (row.isin === null) {
    return resolveSymbolBasedRow(input, budget, split);
  }

  // Rule K branches 2 and 3. Branch 2 **under-classifies and it is
  // stated rather than hidden**: a real fund whose source row carries no
  // expense ratio is proposed `SHARE`. `instrument.kind` has no edit path, so a
  // wrong kind is a one-way door — which is precisely why this is a *proposal*
  // the review step lets the user override, not a silent write, and why
  // {@link proposeKind} records whether the value is evidence or a default.
  const kindProposal = proposeKind(row);

  if (split?.exchangeMic != null) {
    return created(at, kindProposal, row, split.symbol, split.exchangeMic, "SUFFIX_TABLE", null);
  }

  // **The known circularity, left as it is and named rather than papered over**:
  // the discovery search is filtered by the very kind it would be in a
  // position to inform — `YAHOO_QUOTE_TYPES_BY_KIND` maps `SHARE` to `EQUITY`,
  // so a defaulted `SHARE` on a real fund discards the fund's own listings
  // before anything else runs. Breaking it means either searching twice or
  // proposing a kind from the provider's `quoteType`, and both are changes to
  // what gets *written* on a guess — the thing that is forbidden. What this fix does
  // instead is make the guess visible before it is written.
  const matches = await budget.search(kindProposal.kind, row.isin);
  if (matches === "UNAVAILABLE") {
    return {
      kind: "REJECT",
      reason: "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
      message:
        "the exchange could not be looked up (no lookups were available within this request's budget and deadline); re-running the import retries only the rows still unresolved",
    };
  }
  const mics = [
    ...new Set(matches.map((match) => match.exchangeMic).filter((mic) => mic !== null)),
  ];
  if (mics.length !== 1) {
    return {
      kind: "REJECT",
      reason: "EXCHANGE_MIC_NOT_RESOLVED",
      message:
        mics.length === 0
          ? "the lookup answered, and no exchange could be derived from its result"
          : `the lookup answered with more than one exchange (${mics.join(", ")}), which is ambiguous`,
    };
  }
  const mic = mics[0]!;
  const quality = matches.find((match) => match.exchangeMic === mic)?.matchQuality ?? null;
  if (catalogue.byIsin(row.isin).some((match) => match.exchangeMic === mic)) {
    return { kind: "SKIP", message: "this listing is already in the instrument catalogue" };
  }
  return created(at, kindProposal, row, split?.symbol ?? null, mic, "DISCOVERY", quality);
}

/**
 * Rule K branch 1 and branch 4: a row with no ISIN is a symbol-based
 * instrument if the crypto lane can match it, and otherwise falls out of the
 * asset classes this product models.
 *
 * **Queried by name first**, then by symbol: a coin's ticker is often not its
 * name, so a symbol-first query can miss it. Both
 * attempts spend budget.
 */
async function resolveSymbolBasedRow(
  input: AssetRowInput,
  budget: DiscoveryBudget,
  split: SplitSymbol | null,
): Promise<AssetResolutionOutcome> {
  const { row, at } = input;
  // The catalogue's own answer for this row was already taken by
  // {@link catalogueSkip}, before this function is reached.
  let anyLookupUnavailable = false;
  const queries: string[] = [row.displayName, split?.symbol ?? ""].filter((one) => one !== "");
  for (const query of queries) {
    const matches = await budget.search("CRYPTO", query);
    if (matches === "UNAVAILABLE") {
      anyLookupUnavailable = true;
      continue;
    }
    const match = matches[0];
    if (match !== undefined) {
      return created(
        at,
        // Not rule K's default: the crypto lane matched this row, so the kind is
        // as evidenced as the MIC on a discovery hit is.
        { kind: "CRYPTO", kindSource: "DISCOVERY", nameSuggestsFund: false },
        row,
        split?.symbol ?? null,
        null,
        "DISCOVERY",
        match.matchQuality,
      );
    }
  }

  // "Not attempted / cut short" outranks "answered with nothing" when both
  // happened: the remedies differ (re-run versus give up) and only the first is
  // recoverable, so reporting the recoverable one is what makes the re-run
  // actually try this row again.
  if (anyLookupUnavailable) {
    return {
      kind: "REJECT",
      reason: "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
      message:
        "this row carries no ISIN, so only a lookup could identify it, and none was available within this request's budget and deadline",
    };
  }
  // Branch 4. **The mechanism named here is rule K branch 4 — no ISIN and no
  // symbol-based match**. Nothing in this pipeline classifies an asset
  // as a property holding, or as anything else; the reason code names the
  // boundary the row falls outside of, which is a different claim. (On why the
  // message paraphrases one of the product's nouns, see
  // {@link UNSUPPORTED_ASSET_CLASS_MESSAGE}.)
  return {
    kind: "REJECT",
    reason: "UNSUPPORTED_ASSET_CLASS",
    message: UNSUPPORTED_ASSET_CLASS_MESSAGE,
  };
}

function created(
  at: SourceRowRef,
  kindProposal: KindProposal,
  row: NeutralInstrumentRow,
  symbol: string | null,
  exchangeMic: string | null,
  micSource: InstrumentResolution["micSource"],
  matchQuality: InstrumentResolution["matchQuality"],
): AssetResolutionOutcome {
  const { kind } = kindProposal;
  return {
    kind: "CREATE",
    resolution: {
      index: at.index,
      action: "CREATE",
      kind,
      kindSource: kindProposal.kindSource,
      nameSuggestsFund: kindProposal.nameSuggestsFund,
      exchangeMic,
      micSource,
      matchQuality,
    },
    write: {
      target: "INSTRUMENT",
      kind,
      isin: row.isin,
      symbol,
      exchangeMic,
      displayName: row.displayName,
      listingCurrency: row.listingCurrency,
      note: row.note,
    },
  };
}
