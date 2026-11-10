import { createHash } from "node:crypto";

import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";

import { occurrenceOrdinals } from "./fingerprint.js";
import {
  KERDIAL_FINGERPRINT_RECIPE,
  canonicalKerdialFingerprintString,
  computeKerdialFingerprint,
  kerdialFingerprintIdentityKey,
  type KerdialFingerprintFields,
} from "./kerdial-fingerprint.js";

/**
 * EI-4 — the `kd1` recipe.
 *
 * **Every expected hash below is a literal, hand-computed by a throwaway script
 * that built the 26-slot canonical string itself and never imported this
 * module.** A hash recomputed with the function under test agrees with itself
 * after any change, including a transposition of two slots; that is the failure
 * shape `fingerprint.ts`'s own suite exists to avoid, and the same rule is
 * applied here from the first commit rather than retro-fitted.
 */

const SEPARATOR = "\u001F";

const PORTFOLIO = "00000000-0000-7000-8000-0000000000f1";
const PORTFOLIO_B = "00000000-0000-7000-8000-0000000000f2";
const INSTRUMENT = "00000000-0000-7000-8000-0000000000c1";
const SETTLEMENT_INSTRUMENT = "00000000-0000-7000-8000-0000000000c2";
const ACCOUNT = "00000000-0000-7000-8000-0000000000a1";
const OTHER_ACCOUNT = "00000000-0000-7000-8000-0000000000a2";
const TARGET_ACCOUNT = "00000000-0000-7000-8000-0000000000a3";
const SOURCE_DIVIDEND = "00000000-0000-7000-8000-0000000000d1";

/** A fully-legged `BUY`; every other fixture is this with the legs its kind does not have removed. */
function fields(overrides: Partial<KerdialFingerprintFields> = {}): KerdialFingerprintFields {
  return {
    kindCode: "BUY",
    tradeDate: "2026-06-21",
    portfolioId: PORTFOLIO,
    instrumentId: INSTRUMENT,
    settlementInstrumentId: null,
    quantity: new Decimal("12"),
    unitPrice: new Decimal("43.11"),
    grossAmount: new Decimal("517.32"),
    currency: "EUR",
    cashAccountId: ACCOUNT,
    cashCurrency: null,
    cashAmount: null,
    targetCurrency: null,
    targetAmount: null,
    targetCashAccountId: null,
    feeAmount: new Decimal("5.66"),
    brokerFee: new Decimal("4.16"),
    fxFee: null,
    taxAmount: new Decimal("1.50"),
    otherCost: null,
    withholdingAmount: null,
    sourceDividendId: null,
    occurrence: 1,
    ...overrides,
  };
}

/** The legs a kind with no instrument and no cost has — spelled out so each fixture below reads as its kind. */
const NO_LEGS = {
  instrumentId: null,
  quantity: null,
  unitPrice: null,
  feeAmount: null,
  brokerFee: null,
  taxAmount: null,
} satisfies Partial<KerdialFingerprintFields>;

const ROWS = {
  BUY: fields(),
  SELL: fields({ kindCode: "SELL" }),
  DEPOSIT: fields({ kindCode: "DEPOSIT", ...NO_LEGS, grossAmount: new Decimal("1000") }),
  WITHDRAWAL: fields({ kindCode: "WITHDRAWAL", ...NO_LEGS, grossAmount: new Decimal("1000") }),
  DIVIDEND: fields({
    kindCode: "DIVIDEND",
    ...NO_LEGS,
    instrumentId: INSTRUMENT,
    grossAmount: new Decimal("64"),
    withholdingAmount: new Decimal("9.6"),
  }),
  /** The no-withholding case: the row whose `kd1` value must not move. */
  DIVIDEND_NO_WITHHOLDING: fields({
    kindCode: "DIVIDEND",
    ...NO_LEGS,
    instrumentId: INSTRUMENT,
    grossAmount: new Decimal("64"),
  }),
  SHARE_DISTRIBUTION: fields({
    kindCode: "SHARE_DISTRIBUTION",
    ...NO_LEGS,
    instrumentId: INSTRUMENT,
    quantity: new Decimal("3"),
    grossAmount: new Decimal("503.40"),
    // The one kind that settles through no account at all.
    cashAccountId: null,
  }),
  DRIP: fields({
    kindCode: "DRIP",
    ...NO_LEGS,
    instrumentId: INSTRUMENT,
    quantity: new Decimal("1.0625"),
    // A real derived DRIP price at the column's full 18 dp (the same figure
    // `ledger`'s own DRIP integration test pins as surviving storage
    // untouched) — representable in the hash now that `unitPrice` is hashed at
    // its own column's scale.
    unitPrice: new Decimal("60.235294117647058823"),
    grossAmount: new Decimal("64"),
    sourceDividendId: SOURCE_DIVIDEND,
  }),
  CURRENCY_EXCHANGE: fields({
    kindCode: "CURRENCY_EXCHANGE",
    ...NO_LEGS,
    grossAmount: new Decimal("1000"),
    targetCurrency: "USD",
    targetAmount: new Decimal("1091.575"),
    targetCashAccountId: TARGET_ACCOUNT,
    feeAmount: new Decimal("3.5"),
    fxFee: new Decimal("3.5"),
  }),
  /** FR-66's asset-settled BUY: `currency` and `cashAccountId` are both absent, the settlement leg carries the money. */
  SETTLED_BUY: fields({
    settlementInstrumentId: SETTLEMENT_INSTRUMENT,
    quantity: new Decimal("2"),
    unitPrice: new Decimal("0.05"),
    grossAmount: new Decimal("0.1"),
    currency: null,
    cashAccountId: null,
    feeAmount: null,
    brokerFee: null,
    taxAmount: null,
  }),
} satisfies Record<string, KerdialFingerprintFields>;

/**
 * Hand-computed, never recomputed. See this file's header.
 *
 * Regenerated when the hash was amended to hash `unitPrice` at 18 dp rather
 * than 12. **Exactly the four fixtures that carry a `unitPrice` moved** — BUY,
 * SELL, DRIP and the settled BUY; the five whose `unitPrice` is `null` are
 * byte-identical to their pre-amendment values, because `q(null)` and `m(null)`
 * are both the empty string. That split is itself a check on the change: a
 * scale edit that had reached any other slot would have moved all nine.
 *
 * The net-dividend change dropped the withholding's own currency and account; their two slots
 * stay and hash as the empty string. **Only DIVIDEND moved** — the one fixture
 * that had filled them (`EUR` and an account id); it is re-pinned at its
 * new shape, a 9.6 withholding and nothing else. `DIVIDEND_NO_WITHHOLDING`'s
 * value was computed **before** the change, by the pre-change module and by a
 * hand-run sha256 of the 26-slot string, and must never move: a dividend
 * without withholding keeps its fingerprint.
 */
const KNOWN_ANSWERS: Record<keyof typeof ROWS, string> = {
  BUY: "kd1:98591d8cc9f231e98348622c9aefc8b27a4e861308b08dc6f1c3152269b66f8d",
  SELL: "kd1:989c94b577f5277ad86e26842eb6c20a78536a94de7dbe099bb122962c430bd3",
  DEPOSIT: "kd1:014033f1ee137f1a045b28f569a30b185cabb6cdaf7208e42266f24edcb95192",
  WITHDRAWAL: "kd1:6540d15aa3ec2208ebc0166b164e84b1d51df3f3a4306092fcdc5adbfcca3761",
  DIVIDEND: "kd1:3f5224c51ade0f694ccac598ae15dc8d94196e99a56107d47ec95b2e69c43299",
  DIVIDEND_NO_WITHHOLDING: "kd1:a8493fe41b7559a14e8fcd6bc4c5fa79c6ac3de0794bdf3bc5388cf7f4f91fcf",
  SHARE_DISTRIBUTION: "kd1:18c1f1ae03520a1cb0b25ba15ca03088db4e8c6b73b0fb60fe993ef3cfe5a6f5",
  DRIP: "kd1:5583f08b24accb8f8c8e60e6b66b5ed88b392f20bceff14dc1909b022043bf71",
  CURRENCY_EXCHANGE: "kd1:9d050a1c8f30e66702bd6f08d6747edd8beb2a4f667ad3a6e67892435b40041d",
  SETTLED_BUY: "kd1:2c944955ab27c04c6debb6e772ff310dcd21e489524746e80cd9d7904423e02b",
};

describe("the kd1 known answers", () => {
  it("produces *this* hash for one row of each of the eight kinds, not merely *a* hash", () => {
    for (const [label, row] of Object.entries(ROWS)) {
      expect([label, computeKerdialFingerprint(row)]).toEqual([
        label,
        KNOWN_ANSWERS[label as keyof typeof ROWS],
      ]);
    }
    // Ten fixtures over eight kinds: a settled BUY is a `BUY` whose money leg
    // is an asset, and it must not collide with the fiat one; a DIVIDEND with
    // and without withholding.
    expect(Object.keys(ROWS)).toHaveLength(10);
    expect(new Set(Object.values(KNOWN_ANSWERS)).size).toBe(10);
  });

  it("is prefixed with the recipe literally, and fits the live CHECK shape", () => {
    expect(KERDIAL_FINGERPRINT_RECIPE).toBe("kd1");
    const value = computeKerdialFingerprint(ROWS.BUY);
    expect(value.startsWith("kd1:")).toBe(true);
    expect(value.slice("kd1:".length)).toMatch(/^[0-9a-f]{64}$/);
    // `transaction_import_fingerprint_shape`, restated here so the recipe and
    // the CHECK cannot drift apart silently (MEASURED,
    // `platform/db/src/schema/transaction.ts`). The *live* proof — this exact
    // shape inserted as the real `app_web` role — is
    // `ledger/src/transaction-write-service.integration.test.ts`'s
    // "import fingerprint" describe, which stores a `kd1:`-shaped value through
    // three `record*` methods against real Postgres.
    expect(value).toMatch(/^[a-z0-9]{1,8}:[0-9a-f]{64}$/);
  });

  it("places 26 slots, separated by a codepoint no field can contain", () => {
    const canonical = canonicalKerdialFingerprintString(ROWS.BUY);
    // Written as the escape, never as a literal control character.
    expect(canonical.split(SEPARATOR)).toHaveLength(26);
    expect(canonical.split(SEPARATOR)[0]).toBe("kd1");
    expect(canonical.split(SEPARATOR).at(-1)).toBe("1");
    // The discriminating case for the separator itself: two field sets whose
    // concatenation is identical but whose split differs.
    expect(computeKerdialFingerprint(fields({ currency: "EUR", cashAccountId: "X" }))).not.toBe(
      computeKerdialFingerprint(fields({ currency: "EU", cashAccountId: "RX" })),
    );
  });

  it("hashes exactly the canonical string, checked against a hand-run sha256", () => {
    const canonical = canonicalKerdialFingerprintString(ROWS.DIVIDEND);
    const byHand = createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(`kd1:${byHand}`).toBe(KNOWN_ANSWERS.DIVIDEND);
  });
});

describe("portfolioId is in the key, which is why pp2 cannot be reused", () => {
  it("gives the same row in two portfolios two different fingerprints", () => {
    expect(computeKerdialFingerprint(fields({ portfolioId: PORTFOLIO }))).not.toBe(
      computeKerdialFingerprint(fields({ portfolioId: PORTFOLIO_B })),
    );
  });

  it("makes the per-portfolio ordinals automatic rather than a second rule", () => {
    // Two identical rows in two portfolios: two identity keys, so each is its
    // own *first* occurrence and both import. Without `portfolioId` in the key
    // they would share one, the second would be numbered 2, and re-importing
    // the file into either portfolio alone would then skip a row it never wrote.
    const inA = kerdialFingerprintIdentityKey(fields({ portfolioId: PORTFOLIO }));
    const inB = kerdialFingerprintIdentityKey(fields({ portfolioId: PORTFOLIO_B }));
    expect(inA).not.toBe(inB);
    // `occurrenceOrdinals` is reused verbatim from `fingerprint.ts` — not
    // reimplemented here — so this is the same collision rule `pp2` uses.
    expect(occurrenceOrdinals([inA, inB, inA, inB])).toEqual([1, 1, 2, 2]);
  });
});

describe("per-field scale: each field at its own column's stored scale", () => {
  it("normalises a quantity at 18 decimal places, the scale its column stores", () => {
    expect(computeKerdialFingerprint(fields({ quantity: new Decimal("1.1") }))).toBe(
      computeKerdialFingerprint(fields({ quantity: new Decimal("1.100000000000000000") })),
    );
    // And the widening is real, not decorative: a quantity differing at the
    // *eighteenth* place is a different fingerprint, where pp2's 12 dp would
    // have collapsed it. This is the case `fingerprint.ts`'s own comment flags
    // as "UNVERIFIED for any other export".
    expect(computeKerdialFingerprint(fields({ quantity: new Decimal("1.1") }))).not.toBe(
      computeKerdialFingerprint(fields({ quantity: new Decimal("1.100000000000000001") })),
    );
    expect(canonicalKerdialFingerprintString(fields()).split(SEPARATOR)[6]).toBe(
      "12.000000000000000000",
    );
  });

  /**
   * The amendment to the `kd1` recipe: `unit_price` is `numeric(38,18)`, not a money
   * column, so it is hashed at 18 dp. Under the original `m(unitPrice)` the two
   * prices below — which Postgres stores as two distinct values — produced one
   * fingerprint, so a file containing both rows would have imported one and
   * silently skipped the other.
   */
  it("distinguishes two unit prices differing only at the eighteenth decimal place", () => {
    const lower = fields({ unitPrice: new Decimal("60.235294117647058823") });
    const upper = fields({ unitPrice: new Decimal("60.235294117647058824") });
    expect(computeKerdialFingerprint(lower)).not.toBe(computeKerdialFingerprint(upper));
    // The slot itself, so a future scale change fails here by value and not
    // only as a moved digest: 18 dp, in `unitPrice`'s position.
    expect(canonicalKerdialFingerprintString(lower).split(SEPARATOR)[7]).toBe(
      "60.235294117647058823",
    );
    expect(canonicalKerdialFingerprintString(fields()).split(SEPARATOR)[7]).toBe(
      "43.110000000000000000",
    );
    // The companion that keeps this from being "everything differs": two
    // spellings of one stored value are still one fingerprint.
    expect(computeKerdialFingerprint(fields({ unitPrice: new Decimal("43.11") }))).toBe(
      computeKerdialFingerprint(fields({ unitPrice: new Decimal("43.110000000000000000") })),
    );
  });

  it("normalises every money figure at 12 decimal places", () => {
    expect(computeKerdialFingerprint(fields({ feeAmount: new Decimal("5.10") }))).toBe(
      computeKerdialFingerprint(fields({ feeAmount: new Decimal("5.1") })),
    );
    // A money field differing only past the twelfth place collapses to the same
    // value — that is the stored scale, so the two are one economic figure.
    expect(computeKerdialFingerprint(fields({ grossAmount: new Decimal("517.32") }))).toBe(
      computeKerdialFingerprint(fields({ grossAmount: new Decimal("517.3200000000000001") })),
    );
    // The positive companion: a real difference *at* the twelfth place survives.
    expect(computeKerdialFingerprint(fields({ grossAmount: new Decimal("517.32") }))).not.toBe(
      computeKerdialFingerprint(fields({ grossAmount: new Decimal("517.320000000001") })),
    );
  });

  it("writes an absent figure as the empty string, never as a zero", () => {
    const absent = canonicalKerdialFingerprintString(fields({ brokerFee: null })).split(SEPARATOR);
    const zero = canonicalKerdialFingerprintString(fields({ brokerFee: new Decimal("0") })).split(
      SEPARATOR,
    );
    expect(absent[17]).toBe("");
    expect(zero[17]).toBe("0.000000000000");
    // FR-213's "absent, never zero", at the hash: collapsing the two would make
    // "this row carried no broker fee" and "its broker fee said 0" one row.
    expect(computeKerdialFingerprint(fields({ brokerFee: null }))).not.toBe(
      computeKerdialFingerprint(fields({ brokerFee: new Decimal("0") })),
    );
  });
});

describe("every field and every leg is distinguishable", () => {
  it("changes when any one of the twenty-three fields changes, one mutation at a time", () => {
    const base = computeKerdialFingerprint(fields());
    const mutations: readonly [string, Partial<KerdialFingerprintFields>][] = [
      ["kindCode", { kindCode: "SELL" }],
      ["tradeDate", { tradeDate: "2026-06-22" }],
      ["portfolioId", { portfolioId: PORTFOLIO_B }],
      ["instrumentId", { instrumentId: null }],
      ["settlementInstrumentId", { settlementInstrumentId: SETTLEMENT_INSTRUMENT }],
      ["quantity", { quantity: new Decimal("13") }],
      ["unitPrice", { unitPrice: new Decimal("43.12") }],
      ["grossAmount", { grossAmount: new Decimal("517.33") }],
      ["currency", { currency: "USD" }],
      ["cashAccountId", { cashAccountId: OTHER_ACCOUNT }],
      ["cashCurrency", { cashCurrency: "USD" }],
      ["cashAmount", { cashAmount: new Decimal("517.32") }],
      ["targetCurrency", { targetCurrency: "USD" }],
      ["targetAmount", { targetAmount: new Decimal("1") }],
      ["targetCashAccountId", { targetCashAccountId: TARGET_ACCOUNT }],
      ["feeAmount", { feeAmount: new Decimal("5.67") }],
      ["brokerFee", { brokerFee: new Decimal("4.17") }],
      ["fxFee", { fxFee: new Decimal("1") }],
      ["taxAmount", { taxAmount: new Decimal("1.51") }],
      ["otherCost", { otherCost: new Decimal("1") }],
      ["withholdingAmount", { withholdingAmount: new Decimal("1") }],
      ["sourceDividendId", { sourceDividendId: SOURCE_DIVIDEND }],
      ["occurrence", { occurrence: 2 }],
    ];
    // A field silently dropped from the recipe fails here by name, and the
    // count fails if a field is dropped from this list instead.
    expect(mutations).toHaveLength(23);
    for (const [label, mutation] of mutations) {
      expect([label, computeKerdialFingerprint(fields(mutation))]).not.toEqual([label, base]);
    }
  });

  it("gives all eight kinds different fingerprints with every other field held", () => {
    const kinds = [
      "BUY",
      "SELL",
      "DEPOSIT",
      "WITHDRAWAL",
      "DIVIDEND",
      "SHARE_DISTRIBUTION",
      "DRIP",
      "CURRENCY_EXCHANGE",
    ] as const;
    const hashes = kinds.map((kindCode) => computeKerdialFingerprint(fields({ kindCode })));
    expect(new Set(hashes).size).toBe(8);
  });

  it("gives a DEPOSIT and an INTEREST with the same date, amount, currency and account different values (cash-interest)", () => {
    const deposit = ROWS.DEPOSIT;
    const interest = fields({ ...deposit, kindCode: "INTEREST" });
    expect(computeKerdialFingerprint(interest)).not.toBe(computeKerdialFingerprint(deposit));
  });

  it("does not collide with a pp2 value computed over the same row", () => {
    // The two recipes share a separator and a digest, so the prefix is not the
    // only thing keeping them apart — the canonical strings differ in their
    // first slot, their field count and their per-field scales. Asserted over
    // the *digest*, with the prefixes stripped, so "they differ" is not merely
    // "kd1" ≠ "pp2".
    const kd1 = computeKerdialFingerprint(fields());
    const pp2Canonical = [
      "pp2",
      "BUY",
      "2026-06-21",
      INSTRUMENT,
      "12.000000000000",
      "43.110000000000",
      "",
      "EUR",
      "5.660000000000",
      "4.160000000000",
      "1.500000000000",
      "",
      ACCOUNT,
      "1",
    ].join(SEPARATOR);
    const pp2Digest = createHash("sha256").update(pp2Canonical, "utf8").digest("hex");
    expect(kd1.slice("kd1:".length)).not.toBe(pp2Digest);
    // And the stored values differ in their prefix too, which is what lets a
    // carried-forward value be recognised as belonging to the other recipe.
    expect(kd1.startsWith("pp2:")).toBe(false);
  });
});
