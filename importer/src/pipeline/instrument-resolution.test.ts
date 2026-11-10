import { CURATED_EXCHANGE_MICS } from "@kerdial/core-reference-data";
import type { InstrumentIdentityMatch } from "@kerdial/ledger";
import { describe, expect, it } from "vitest";

import {
  SYMBOL_SUFFIX_TO_MIC,
  indexCatalogue,
  resolveAssetRows,
  splitSymbolSuffix,
  type AssetResolutionOutcome,
  type AssetRowInput,
  type Clock,
  type DiscoveryLookup,
  type DiscoveryMatch,
  type ImportDiscoveryPort,
  type ImportLimits,
  type InstrumentResolution,
  type NeutralInstrumentRow,
} from "../index.js";

/**
 * CI-10 — instrument resolution for an asset-catalogue file (ID6, OD-5(a)).
 *
 * **Everything here runs against a stub {@link ImportDiscoveryPort}**, which is
 * the port's whole point (ID1): the real binding to the provider runtime is
 * CI-16's, and every budget/deadline/retry rule below is a property of *this*
 * code, provable without a provider, a token bucket or a network.
 *
 * **No tunable below is asserted by reading its constant.** The budget and the
 * deadline are each run at two values and the *downstream* effect — how many
 * calls the stub received, how many rows resolved, how the reason-code counts
 * moved — is what is measured. A constant that is read but silently clamped
 * produces no error and no failing test, which is exactly the failure this
 * project's own rule exists to catch.
 */

/** A clock nothing real drives: `sleep` advances it, and the stub provider advances it per call. Makes every deadline assertion an exact number rather than a race. */
class TestClock implements Clock {
  #currentMs: number;

  constructor(startMs = 1_000_000) {
    this.#currentMs = startMs;
  }

  now(): Date {
    return new Date(this.#currentMs);
  }

  async sleep(milliseconds: number): Promise<void> {
    this.advance(milliseconds);
    await Promise.resolve();
  }

  advance(milliseconds: number): void {
    this.#currentMs += milliseconds;
  }

  get elapsedSince(): number {
    return this.#currentMs;
  }
}

interface StubPort extends ImportDiscoveryPort {
  readonly calls: DiscoveryLookup[];
}

interface StubOptions {
  /** Returned for every query that has no explicit answer. */
  readonly fallback?: readonly DiscoveryMatch[];
  readonly answers?: Readonly<Record<string, readonly DiscoveryMatch[]>>;
  /** Wall-clock cost of one call, charged to `clock`. */
  readonly costMs?: number;
  readonly clock?: TestClock;
  /** Thrown on the call at each listed 1-based ordinal. */
  readonly throwsOnCall?: Readonly<Record<number, unknown>>;
}

function stubDiscovery(options: StubOptions = {}): StubPort {
  const calls: DiscoveryLookup[] = [];
  return {
    calls,
    async search(lookup) {
      calls.push(lookup);
      options.clock?.advance(options.costMs ?? 0);
      const thrown = options.throwsOnCall?.[calls.length];
      if (thrown !== undefined) throw thrown;
      await Promise.resolve();
      return options.answers?.[lookup.query] ?? options.fallback ?? [];
    },
  };
}

/** The stub that proves a path made no provider call at all: any call is a failed test, not a different count. */
const forbiddenDiscovery: ImportDiscoveryPort = {
  search() {
    throw new Error("discovery must not be called on this path");
  },
};

const EXACT_XPAR: DiscoveryMatch = {
  displayName: "resolved by lookup",
  currency: "EUR",
  exchangeMic: "XPAR",
  matchQuality: "EXACT",
};

const PROBABLE_COIN: DiscoveryMatch = {
  displayName: "resolved coin",
  currency: "EUR",
  exchangeMic: null,
  matchQuality: "PROBABLE",
};

function assetRow(
  overrides: Partial<NeutralInstrumentRow> & { readonly index: number },
): AssetRowInput {
  const { index, ...rest } = overrides;
  return {
    at: { line: index + 2, index },
    row: {
      shape: "INSTRUMENT",
      isin: "FR0130000013",
      symbol: "AAA.PA",
      displayName: "A listed company",
      listingCurrency: "EUR",
      hasExpenseRatio: false,
      note: null,
      ...rest,
    },
  };
}

const EMPTY_CATALOGUE = indexCatalogue([]);

function limits(overrides: Partial<ImportLimits> = {}): ImportLimits {
  // Only the two discovery tunables are read by anything this file exercises —
  // resolution is a `plan`-stage concern. The rest are supplied because
  // `ImportLimits` is one closed object for the whole pipeline (CI-13 added the
  // apply deadline to it, CI-19 the three HTTP-level caps), and they are
  // spelled out here rather than spread from `DEFAULT_IMPORT_LIMITS` so a
  // change to a shipped value cannot silently move what these cases measure.
  return {
    discoveryLookupBudget: 16,
    discoveryDeadlineMs: 10_000,
    applyDeadlineMs: 25_000,
    applyChunkRows: 50,
    maxFileBytes: 1024 * 1024,
    maxRows: 5_000,
    maxRowDetails: 1_000,
    ...overrides,
  };
}

const reasonOf = (outcome: AssetResolutionOutcome): string =>
  outcome.kind === "REJECT" ? outcome.reason : outcome.kind;

describe("the suffix table resolves the majority with zero provider calls", () => {
  it("maps each of the four suffixes to its documented MIC, calling no provider at all", async () => {
    const rows = [
      assetRow({ index: 0, symbol: "AI.PA" }),
      assetRow({ index: 1, symbol: "ASML.AS", isin: "NL0000000107" }),
      assetRow({ index: 2, symbol: "ENI.MI", isin: "IT0003000012" }),
      assetRow({ index: 3, symbol: "SAP.DE", isin: "DE0007000073" }),
    ];
    const resolved = await resolveAssetRows({
      rows,
      catalogue: EMPTY_CATALOGUE,
      // Not "0 calls counted afterwards" — a stub that throws makes a single
      // stray call a failure at the moment it happens.
      discovery: forbiddenDiscovery,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });

    expect(resolved.discoveryCallsIssued).toBe(0);
    expect(resolved.proposals.map((one) => [one.exchangeMic, one.micSource])).toEqual([
      ["XPAR", "SUFFIX_TABLE"],
      ["XAMS", "SUFFIX_TABLE"],
      ["XMIL", "SUFFIX_TABLE"],
      ["XETR", "SUFFIX_TABLE"],
    ]);
    // Positive companion: the suffix is stripped from the stored ticker, so the
    // exchange is carried once, by `exchange_mic`, and not twice.
    expect(
      resolved.outcomes.map((outcome) => (outcome.kind === "CREATE" ? outcome.write.symbol : null)),
    ).toEqual(["AI", "ASML", "ENI", "SAP"]);
  });

  it("proposes only MICs the curated exchange list actually offers", () => {
    const curated = new Set(CURATED_EXCHANGE_MICS.map((exchange) => exchange.mic));
    const targets = Object.values(SYMBOL_SUFFIX_TO_MIC);
    // The positive companion to "none is uncurated": there are four of them.
    expect(targets).toHaveLength(4);
    expect(targets.filter((mic) => !curated.has(mic))).toEqual([]);
  });

  it("leaves an unrecognised suffix attached, rather than guessing an exchange for it", () => {
    // The two deliberately omitted: neither has a curated MIC, so no
    // honest entry exists and they are not hand-waved into the Xetra one.
    expect(splitSymbolSuffix("FA7X.DU")).toEqual({ symbol: "FA7X.DU", exchangeMic: null });
    expect(splitSymbolSuffix("NVSD.F")).toEqual({ symbol: "NVSD.F", exchangeMic: null });
    expect(splitSymbolSuffix("MSTX")).toEqual({ symbol: "MSTX", exchangeMic: null });
  });
});

describe("rule K's four branches", () => {
  it("branch 2: an identified row carrying an expense ratio proposes an exchange-traded fund kind", async () => {
    const resolved = await resolveAssetRows({
      rows: [assetRow({ index: 0, hasExpenseRatio: true })],
      catalogue: EMPTY_CATALOGUE,
      discovery: forbiddenDiscovery,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    expect(resolved.proposals[0]!.kind).toBe("ETF");
  });

  it("branch 3: an identified row with no expense ratio proposes a single-security kind", async () => {
    const resolved = await resolveAssetRows({
      rows: [assetRow({ index: 0, hasExpenseRatio: false })],
      catalogue: EMPTY_CATALOGUE,
      discovery: forbiddenDiscovery,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    expect(resolved.proposals[0]!.kind).toBe("SHARE");
  });

  it("branch 3 under-classifies a real fund with no expense ratio, and that is the stated limitation", async () => {
    // Rule K names this explicitly rather than hiding it: a genuine fund whose
    // source row carries no expense ratio is proposed as a single security.
    // Pinned here so the gap stays characterised — and it is why the kind is a
    // *proposal* the review step lets the user override rather than a silent
    // write, since `instrument.kind` has no edit path.
    const resolved = await resolveAssetRows({
      rows: [
        assetRow({ index: 0, symbol: "AUMX.DE", isin: "LU0000000006", hasExpenseRatio: false }),
      ],
      catalogue: EMPTY_CATALOGUE,
      discovery: forbiddenDiscovery,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    expect(resolved.proposals[0]!.kind).toBe("SHARE");
    expect(resolved.proposals[0]!.exchangeMic).toBe("XETR");
  });

  /**
   * The proposal now says *how sure* it is, because the review step had
   * no way to tell a TER-derived kind from a defaulted one and `instrument.kind`
   * is `app_owner`-only, so an accepted default is unrecoverable.
   */
  describe("a defaulted kind is distinguishable from an evidenced one", () => {
    async function proposalFor(row: Partial<NeutralInstrumentRow>): Promise<InstrumentResolution> {
      const resolved = await resolveAssetRows({
        rows: [assetRow({ index: 0, ...row })],
        catalogue: EMPTY_CATALOGUE,
        discovery: forbiddenDiscovery,
        confirm: false,
        resolutions: [],
        limits: limits(),
        clock: new TestClock(),
      });
      return resolved.proposals[0]!;
    }

    it("records the TER as the evidence when the source row carries one", async () => {
      const proposal = await proposalFor({ hasExpenseRatio: true, displayName: "Some ETF" });
      expect([proposal.kind, proposal.kindSource]).toEqual(["ETF", "EXPENSE_RATIO"]);
    });

    it("records the SHARE proposal as defaulted when the source row says nothing", async () => {
      const proposal = await proposalFor({
        hasExpenseRatio: false,
        displayName: "A listed company",
      });
      expect([proposal.kind, proposal.kindSource]).toEqual(["SHARE", "DEFAULT"]);
      // The weak signal on its own: nothing about this name contradicts SHARE,
      // so the row is unconfirmed rather than suspect.
      expect(proposal.nameSuggestsFund).toBe(false);
    });

    /** The three live rows, by the marker each one actually carries. */
    it.each([
      { displayName: "Amundi S&P 500 UCITS ETF - EUR (C)", marker: "UCITS/ETF" },
      {
        displayName: "AMUNDI PEA EURO COURT TERME UCI",
        marker: "UCI, as the exporter truncated it",
      },
      { displayName: "AMUNDI PHYSICAL GOLD ETC", marker: "ETC" },
    ])(
      "marks a TER-less row whose name says fund ($marker) as needing confirmation, without changing the proposal",
      async ({ displayName }) => {
        const proposal = await proposalFor({ hasExpenseRatio: false, displayName });
        // **The proposal is untouched.** A name is a heuristic, and the rule
        // is that a heuristic feeds the flag rather than writing a kind on a
        // guess — the write is the one-way door.
        expect(proposal.kind).toBe("SHARE");
        expect(proposal.kindSource).toBe("DEFAULT");
        expect(proposal.nameSuggestsFund).toBe(true);
      },
    );

    /** Whole tokens only: the markers must not fire from inside a longer word. */
    it.each(["FLETCHER SA", "Fondsboerse AG", "Etchells Marine", "UCITSX Holding"])(
      "does not mark %s, whose name only contains a marker as a substring",
      async (displayName) => {
        expect((await proposalFor({ hasExpenseRatio: false, displayName })).nameSuggestsFund).toBe(
          false,
        );
      },
    );

    it("attributes a crypto row's kind to the lookup that matched it, not to rule K's default", async () => {
      const resolved = await resolveAssetRows({
        rows: [assetRow({ index: 0, isin: null, symbol: "AAVX", displayName: "AVX" })],
        catalogue: EMPTY_CATALOGUE,
        discovery: stubDiscovery({ answers: { AVX: [PROBABLE_COIN] } }),
        confirm: false,
        resolutions: [],
        limits: limits(),
        clock: new TestClock(),
      });
      expect([resolved.proposals[0]!.kind, resolved.proposals[0]!.kindSource]).toEqual([
        "CRYPTO",
        "DISCOVERY",
      ]);
    });

    it("carries the provenance through a discovery-resolved MIC too, where the kind also filtered the search", async () => {
      // The circularity: the search is filtered by the very kind it
      // could have informed. Pinned rather than fixed — breaking it means
      // writing a kind on a guess — so the row arrives flagged instead.
      const stub = stubDiscovery({ fallback: [EXACT_XPAR] });
      const resolved = await resolveAssetRows({
        rows: [
          assetRow({
            index: 0,
            symbol: "AUMX.DU",
            isin: "LU0000000006",
            hasExpenseRatio: false,
            displayName: "Amundix S&P 500 UCITS ETF",
          }),
        ],
        catalogue: EMPTY_CATALOGUE,
        discovery: stub,
        confirm: false,
        resolutions: [],
        limits: limits(),
        clock: new TestClock(),
      });
      expect(stub.calls).toEqual([{ kind: "SHARE", query: "LU0000000006" }]);
      const proposal = resolved.proposals[0]!;
      expect([proposal.kindSource, proposal.nameSuggestsFund, proposal.micSource]).toEqual([
        "DEFAULT",
        true,
        "DISCOVERY",
      ]);
    });
  });

  it("branch 1: an unidentified row the coin lane matches proposes a symbol-based kind, queried by name first", async () => {
    // The corpus's own trap: one coin's ticker is not its name, so a
    // symbol-first query misses it. Name first, symbol second.
    const stub = stubDiscovery({ answers: { AVX: [PROBABLE_COIN] } });
    const resolved = await resolveAssetRows({
      rows: [assetRow({ index: 0, isin: null, symbol: "AAVX", displayName: "AVX" })],
      catalogue: EMPTY_CATALOGUE,
      discovery: stub,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    expect(stub.calls).toEqual([{ kind: "CRYPTO", query: "AVX" }]);
    expect(resolved.proposals[0]!.kind).toBe("CRYPTO");
    expect(resolved.proposals[0]!.exchangeMic).toBeNull();
    expect(resolved.proposals[0]!.matchQuality).toBe("PROBABLE");
  });

  it("branch 4: an unidentified row nothing matches is refused, and the refusal names the mechanism that fired", async () => {
    // The AC's own wording, honoured: **nothing here classified the row as a
    // property holding.** Rule K branch 4 fired — no identifier, and no
    // symbol-based match — and the message names the boundary the row falls
    // outside of. Those are different claims and only the second is being made.
    const stub = stubDiscovery({ fallback: [] });
    const resolved = await resolveAssetRows({
      rows: [
        assetRow({ index: 0, isin: null, symbol: "SCPI00007321", displayName: "A property fund" }),
      ],
      catalogue: EMPTY_CATALOGUE,
      discovery: stub,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    const outcome = resolved.outcomes[0]!;
    expect(outcome.kind).toBe("REJECT");
    expect(outcome.kind === "REJECT" && outcome.reason).toBe("UNSUPPORTED_ASSET_CLASS");
    expect(outcome.kind === "REJECT" && outcome.message).toContain(
      "shares, exchange-traded funds, funds and crypto",
    );
    // Positive companion: the branch is reached only after both lookups
    // actually happened and answered with nothing — not by skipping them.
    expect(stub.calls.map((call) => call.query)).toEqual(["A property fund", "SCPI00007321"]);
  });
});

describe("the budget binds, measured at two values", () => {
  /** Six rows the suffix table cannot resolve, so each needs exactly one lookup. */
  const unresolvableRows = Array.from({ length: 6 }, (_, index) =>
    assetRow({
      index,
      symbol: `AB${String(index)}.DU`,
      isin: `FRTEST00033${String(index)}`,
    }),
  );

  async function runAtBudget(budget: number): Promise<{
    calls: number;
    created: number;
    unavailable: number;
  }> {
    const stub = stubDiscovery({ fallback: [EXACT_XPAR] });
    const resolved = await resolveAssetRows({
      rows: unresolvableRows,
      catalogue: EMPTY_CATALOGUE,
      discovery: stub,
      confirm: false,
      resolutions: [],
      limits: limits({ discoveryLookupBudget: budget }),
      clock: new TestClock(),
    });
    return {
      calls: stub.calls.length,
      created: resolved.outcomes.filter((one) => one.kind === "CREATE").length,
      unavailable: resolved.outcomes.filter(
        (one) => reasonOf(one) === "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
      ).length,
    };
  }

  it("spends exactly the budget, and the unavailable count falls by exactly the difference", async () => {
    const atTwo = await runAtBudget(2);
    const atFour = await runAtBudget(4);

    expect(atTwo).toEqual({ calls: 2, created: 2, unavailable: 4 });
    expect(atFour).toEqual({ calls: 4, created: 4, unavailable: 2 });
    // The measurement the rule actually demands: a downstream effect moved by
    // exactly the amount the tunable moved.
    expect(atTwo.unavailable - atFour.unavailable).toBe(2);
    expect(atFour.calls - atTwo.calls).toBe(2);
  });

  it("calls a row cut short by the budget unavailable, never answered-and-empty", async () => {
    // The two codes exist because their remedies differ — re-run versus give up
    // — so conflating them would make the designed remedy unreachable. The
    // discriminating pair, in one run: row 0 gets the only lookup and answers
    // with nothing, row 1 never gets one at all.
    const stub = stubDiscovery({ fallback: [] });
    const resolved = await resolveAssetRows({
      rows: [unresolvableRows[0]!, unresolvableRows[1]!],
      catalogue: EMPTY_CATALOGUE,
      discovery: stub,
      confirm: false,
      resolutions: [],
      limits: limits({ discoveryLookupBudget: 1 }),
      clock: new TestClock(),
    });
    expect(stub.calls).toHaveLength(1);
    expect(resolved.outcomes.map(reasonOf)).toEqual([
      "EXCHANGE_MIC_NOT_RESOLVED",
      "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
    ]);
  });
});

describe("the deadline binds, measured at two values", () => {
  const rows = Array.from({ length: 6 }, (_, index) =>
    assetRow({ index, symbol: `CD${String(index)}.DU`, isin: `FRTEST00034${String(index)}` }),
  );

  async function runAtDeadline(deadlineMs: number): Promise<number> {
    const clock = new TestClock();
    const stub = stubDiscovery({ fallback: [EXACT_XPAR], costMs: 20, clock });
    const resolved = await resolveAssetRows({
      rows,
      catalogue: EMPTY_CATALOGUE,
      discovery: stub,
      confirm: false,
      resolutions: [],
      // A budget far above the row count, so the deadline is the only thing
      // that can bind and the measurement is not attributing one bound's effect
      // to the other.
      limits: limits({ discoveryLookupBudget: 1_000, discoveryDeadlineMs: deadlineMs }),
      clock,
    });
    return resolved.outcomes.filter((one) => one.kind === "CREATE").length;
  }

  it("resolves strictly more rows as the deadline rises", async () => {
    // Each lookup costs 20 ms of the injected clock, and the deadline is
    // checked before each one: 50 ms admits the calls starting at 0/20/40, then
    // stops. 130 ms admits all six (the last starts at 100).
    expect(await runAtDeadline(50)).toBe(3);
    expect(await runAtDeadline(130)).toBe(6);
  });
});

describe("which failures are retried, and which are not", () => {
  const rateLimited = Object.assign(new Error("rate limited"), {
    name: "ProviderRateLimited",
    retryAfterSeconds: 2,
  });
  const circuitOpen = Object.assign(new Error("circuit open"), {
    name: "ProviderCircuitOpenError",
  });
  const unavailable = Object.assign(new Error("provider unavailable"), {
    name: "ProviderUnavailable",
  });

  it("retries a rate limit, honouring its own retry hint, and resolves on the retry", async () => {
    const clock = new TestClock();
    const stub = stubDiscovery({ fallback: [EXACT_XPAR], throwsOnCall: { 1: rateLimited }, clock });
    const before = clock.elapsedSince;
    const resolved = await resolveAssetRows({
      rows: [assetRow({ index: 0, symbol: "EF.DU", isin: "FRTEST000347" })],
      catalogue: EMPTY_CATALOGUE,
      discovery: stub,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock,
    });
    expect(stub.calls).toHaveLength(2);
    expect(resolved.outcomes[0]!.kind).toBe("CREATE");
    // The hint was honoured, not a fixed backoff: 2 s, exactly as the error said.
    expect(clock.elapsedSince - before).toBe(2_000);
  });

  it("does not retry an open circuit, and does not retry an unavailable provider", async () => {
    for (const thrown of [circuitOpen, unavailable]) {
      const clock = new TestClock();
      const before = clock.elapsedSince;
      const stub = stubDiscovery({ fallback: [EXACT_XPAR], throwsOnCall: { 1: thrown }, clock });
      const resolved = await resolveAssetRows({
        rows: [assetRow({ index: 0, symbol: "GH.DU", isin: "FRTEST000348" })],
        catalogue: EMPTY_CATALOGUE,
        discovery: stub,
        confirm: false,
        resolutions: [],
        limits: limits(),
        clock,
      });
      // Exactly one call: the failure was terminal, so no budget went into
      // retrying something that cannot clear inside the deadline.
      expect(stub.calls).toHaveLength(1);
      expect(reasonOf(resolved.outcomes[0]!)).toBe("EXCHANGE_MIC_LOOKUP_UNAVAILABLE");
      // No backoff was waited either: retrying is what spends time, and neither
      // of these is retried.
      expect(clock.elapsedSince - before).toBe(0);
    }
  });

  it("stops retrying a rate limit once the wait would cross the deadline", async () => {
    const clock = new TestClock();
    const stub = stubDiscovery({
      fallback: [EXACT_XPAR],
      throwsOnCall: { 1: rateLimited, 2: rateLimited, 3: rateLimited },
      clock,
    });
    const resolved = await resolveAssetRows({
      rows: [assetRow({ index: 0, symbol: "IJ.DU", isin: "FRTEST000349" })],
      catalogue: EMPTY_CATALOGUE,
      discovery: stub,
      confirm: false,
      resolutions: [],
      limits: limits({ discoveryDeadlineMs: 3_000 }),
      clock,
    });
    // One call, then a 2 s wait, then a second call, then the next 2 s wait
    // would land past the 3 s line — so it stops rather than overrunning.
    expect(stub.calls).toHaveLength(2);
    expect(reasonOf(resolved.outcomes[0]!)).toBe("EXCHANGE_MIC_LOOKUP_UNAVAILABLE");
  });
});

describe("the confirm makes zero provider calls (the decisive property)", () => {
  const rows = [
    assetRow({ index: 0, symbol: "KL.DU", isin: "FRTEST000350" }),
    assetRow({ index: 1, symbol: "MN.DU", isin: "FRTEST000351" }),
    assetRow({ index: 2, symbol: "OP.DU", isin: "FRTEST000352" }),
  ];

  it("a dry run issues one call per unresolved row; the confirm that echoes its proposals issues none", async () => {
    const dryRunStub = stubDiscovery({ fallback: [EXACT_XPAR] });
    const dryRun = await resolveAssetRows({
      rows,
      catalogue: EMPTY_CATALOGUE,
      discovery: dryRunStub,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    // The positive half: N > 0, and N is the row count, not "some".
    expect(dryRun.discoveryCallsIssued).toBe(3);
    expect(dryRunStub.calls).toHaveLength(3);
    expect(dryRun.proposals).toHaveLength(3);

    const confirm = await resolveAssetRows({
      rows,
      catalogue: EMPTY_CATALOGUE,
      // Any call at all on this path throws, so "zero" is enforced rather than
      // counted after the fact.
      discovery: forbiddenDiscovery,
      confirm: true,
      resolutions: dryRun.proposals,
      limits: limits(),
      clock: new TestClock(),
    });
    expect(confirm.discoveryCallsIssued).toBe(0);
    expect(confirm.outcomes.map((one) => one.kind)).toEqual(["CREATE", "CREATE", "CREATE"]);
    // The confirmed values are what get written — the same MICs the user saw.
    expect(
      confirm.outcomes.map((one) => (one.kind === "CREATE" ? one.write.exchangeMic : null)),
    ).toEqual(["XPAR", "XPAR", "XPAR"]);
  });

  it("a row present in the file but absent from the echoed resolutions is refused, not silently resolved", async () => {
    const partial: InstrumentResolution[] = [
      {
        index: 0,
        action: "CREATE",
        kind: "SHARE",
        kindSource: "USER",
        nameSuggestsFund: false,
        exchangeMic: "XPAR",
        micSource: "USER",
        matchQuality: "EXACT",
      },
    ];
    const confirm = await resolveAssetRows({
      rows,
      catalogue: EMPTY_CATALOGUE,
      discovery: forbiddenDiscovery,
      confirm: true,
      resolutions: partial,
      limits: limits(),
      clock: new TestClock(),
    });
    expect(confirm.outcomes.map(reasonOf)).toEqual([
      "CREATE",
      "RESOLUTION_NOT_CONFIRMED",
      "RESOLUTION_NOT_CONFIRMED",
    ]);
    expect(confirm.discoveryCallsIssued).toBe(0);
  });

  it("an EMPTY confirmed list is still a confirm: every row refused, no lookup", async () => {
    // `confirm` is the caller's mode, not `resolutions.length`. An empty list
    // is the *same* case as the partial list above with nothing in it, and it
    // is reached without any adversary: `ImportWizard.tsx` posts
    // `summary.proposals ?? []`, and `proposals` is empty whenever the dry
    // run's discovery budget was spent before a row resolved.
    const stub = stubDiscovery({ fallback: [EXACT_XPAR] });
    const confirm = await resolveAssetRows({
      rows,
      catalogue: EMPTY_CATALOGUE,
      // A port that would happily answer — so "zero calls" is a fact about the
      // pipeline, not about a port that refuses.
      discovery: stub,
      confirm: true,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    expect(stub.calls).toHaveLength(0);
    expect(confirm.discoveryCallsIssued).toBe(0);
    expect(confirm.outcomes.map(reasonOf)).toEqual([
      "RESOLUTION_NOT_CONFIRMED",
      "RESOLUTION_NOT_CONFIRMED",
      "RESOLUTION_NOT_CONFIRMED",
    ]);
    expect(confirm.proposals).toEqual([]);

    // The positive companion on the same rows and the same *kind* of port: a
    // dry run does call it, three times, and does produce writes.
    const dryRunStub = stubDiscovery({ fallback: [EXACT_XPAR] });
    const dryRun = await resolveAssetRows({
      rows,
      catalogue: EMPTY_CATALOGUE,
      discovery: dryRunStub,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    expect(dryRunStub.calls).toHaveLength(3);
    expect(dryRun.outcomes.map((one) => one.kind)).toEqual(["CREATE", "CREATE", "CREATE"]);
  });
});

describe("no provider runtime wired at all", () => {
  it("refuses every otherwise-unresolved row and still completes, rather than throwing", async () => {
    const resolved = await resolveAssetRows({
      rows: [
        assetRow({ index: 0, symbol: "QR.DU", isin: "FRTEST000353" }),
        assetRow({ index: 1, isin: null, symbol: "COIN", displayName: "A coin" }),
        // The positive companion: a suffix-resolvable row in the *same* run is
        // unaffected, so "everything failed" cannot pass this test.
        assetRow({ index: 2, symbol: "ST.PA", isin: "FRTEST000354" }),
      ],
      catalogue: EMPTY_CATALOGUE,
      discovery: null,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    expect(resolved.outcomes.map(reasonOf)).toEqual([
      "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
      "EXCHANGE_MIC_LOOKUP_UNAVAILABLE",
      "CREATE",
    ]);
    expect(resolved.discoveryCallsIssued).toBe(0);
  });
});

describe("IMP-14 — a catalogue hit costs no budget", () => {
  const existing: InstrumentIdentityMatch[] = [
    {
      id: "00000000-0000-7000-8000-0000000000a1",
      kind: "SHARE",
      isin: "FRTEST000355",
      exchangeMic: "XPAR",
      symbol: "UV",
      primaryIdentifier: "ISIN",
      displayName: "Already catalogued",
    },
  ];

  it("skips a row the catalogue already has, before spending a lookup on it", async () => {
    const resolved = await resolveAssetRows({
      rows: [
        assetRow({ index: 0, symbol: "UV.PA", isin: "FRTEST000355" }),
        // Same identifier, no usable suffix: the re-run economy — a lookup
        // here could only propose a listing that is already there.
        assetRow({ index: 1, symbol: "UV.DU", isin: "FRTEST000355" }),
      ],
      catalogue: indexCatalogue(existing),
      discovery: forbiddenDiscovery,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });
    expect(resolved.outcomes.map((one) => one.kind)).toEqual(["SKIP", "SKIP"]);
    expect(resolved.discoveryCallsIssued).toBe(0);
    expect(resolved.proposals).toEqual([]);
  });
});

/**
 * `scpi` cycle — AC-511 / FR-622 (SCD-14). Rule K proposes only
 * `ETF` / `SHARE` for an identified row, and the ISIN-less lane searches only
 * the coin kind — so no Portfolio Performance row, however it is labelled,
 * yields an SCPI proposal or an SCPI search. The type half is `DiscoveryKind`
 * (no `SCPI` member); this is the run-time half, over rows dressed as an SCPI.
 */
describe("AC-511 — no row, however labelled, proposes or searches an SCPI", () => {
  const SCPI_LOOKING_ROWS: AssetRowInput[] = [
    assetRow({
      index: 0,
      displayName: "SCPI Corum Origin",
      isin: "FR0014SCPIA6",
      symbol: "CORUMO",
    }),
    assetRow({
      index: 1,
      displayName: "Société Civile de Placement Immobilier Primopierre",
      isin: "FR0014SCPIB4",
      symbol: "PRIMO.PA",
      hasExpenseRatio: true,
    }),
    assetRow({
      index: 2,
      displayName: "SCPI Epargne Pierre",
      isin: "FR0014SCPIC2",
      symbol: "SCPI",
    }),
    // ISIN-less: the coin lane's only kind is searched, never an SCPI.
    assetRow({ index: 3, displayName: "SCPI Iroko Zen", isin: null, symbol: "IROKO" }),
  ];

  it("proposes only ETF or SHARE for an identified row, and searches no SCPI for any row", async () => {
    const discovery = stubDiscovery({ fallback: [EXACT_XPAR] });
    const resolved = await resolveAssetRows({
      rows: SCPI_LOOKING_ROWS,
      catalogue: EMPTY_CATALOGUE,
      discovery,
      confirm: false,
      resolutions: [],
      limits: limits(),
      clock: new TestClock(),
    });

    const identified = resolved.proposals.filter((p) => p.index !== 3).map((p) => p.kind);
    expect(identified).toEqual(["SHARE", "ETF", "SHARE"]);
    expect(resolved.proposals.map((p) => p.kind)).not.toContain("SCPI");
    expect(discovery.calls.map((call) => call.kind)).not.toContain("SCPI");
  });
});
