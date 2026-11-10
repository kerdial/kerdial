import { createHash } from "node:crypto";

import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";

import {
  IMPORT_FINGERPRINT_RECIPE,
  canonicalFingerprintString,
  computeImportFingerprint,
  fingerprintIdentityKey,
  occurrenceOrdinals,
  type FingerprintFields,
} from "../index.js";

/**
 * CI-12, the pure half — ID7's fingerprint recipe and the collision rule
 * (the OD-7 amendment, which the user locked over
 * the analyst's recommendation to defer idempotency entirely).
 *
 * The database half — the batched existence check, the identical-pair
 * red-confirm, and the manually-entered row's invisibility — is
 * `plan.idempotency.integration.test.ts`, against a real Postgres. Everything
 * here needs neither.
 */

const ACCOUNT_A = "00000000-0000-7000-8000-0000000000a1";
const ACCOUNT_B = "00000000-0000-7000-8000-0000000000b1";
const INSTRUMENT = "00000000-0000-7000-8000-0000000000c1";

function fields(overrides: Partial<FingerprintFields> = {}): FingerprintFields {
  return {
    kindCode: "BUY",
    tradeDate: "2026-06-21",
    instrumentId: INSTRUMENT,
    quantity: new Decimal("12"),
    unitPrice: new Decimal("43.11"),
    amount: null,
    currency: "EUR",
    feeAmount: new Decimal("5.66"),
    brokerFee: null,
    taxAmount: null,
    withholdingAmount: null,
    cashAccountId: ACCOUNT_A,
    occurrence: 1,
    ...overrides,
  };
}

describe("the canonical string and the stored value", () => {
  /**
   * FR-260 (shape change): this case asserted `pp1` until FT-40. The recipe is
   * now `pp2` — the canonical string gained `brokerFee` and `taxAmount` — and
   * the consequence the old comment described in the conditional ("*if* we ever
   * move to a pp2 recipe") has been incurred deliberately. It is carried as
   * RF7's own task, not as a discovery: no stored `pp1:` fingerprint is
   * rewritten (L8), the first re-import of a previously-imported file
   * duplicates its rows, and the import screen and release note say so.
   */
  it("is prefixed with the recipe version literally, over a 64-character lowercase hex digest", () => {
    const value = computeImportFingerprint(fields());
    expect(IMPORT_FINGERPRINT_RECIPE).toBe("pp2");
    expect(value.startsWith("pp2:")).toBe(true);
    expect(value.slice(4)).toMatch(/^[0-9a-f]{64}$/);
    // The shape migration `0042`'s CHECK enforces, restated here so the two
    // cannot drift apart silently.
    expect(value).toMatch(/^[a-z0-9]{1,8}:[0-9a-f]{64}$/);
  });

  /**
   * FT-40's first acceptance criterion, second half: **a stored `pp1:`
   * fingerprint is left untouched.** There is no backfill and no rewriter, so
   * the proof is that this package exports nothing that would perform one and
   * that a `pp1:` value still satisfies `0042`'s CHECK shape — a legacy row
   * stays legal, it simply never matches a newly computed key again.
   *
   * The database half (a `pp1:` row surviving an import verbatim, and the row
   * count that proves the duplication) is FT-43's, in
   * `plan.idempotency.integration.test.ts` against a real Postgres.
   */
  it("leaves a stored pp1: fingerprint untouched — the bump rewrites no history", () => {
    const legacy = "pp1:" + "a".repeat(64);
    expect(legacy).toMatch(/^[a-z0-9]{1,8}:[0-9a-f]{64}$/);
    expect(computeImportFingerprint(fields())).not.toBe(legacy);
    expect(computeImportFingerprint(fields()).startsWith("pp1:")).toBe(false);
  });

  /**
   * `portfolio-export-import` EI-3: `ImportKindCode` gained `DRIP` and
   * `CURRENCY_EXCHANGE`. The claim that this moves **no** `pp2` value is
   * pinned here as a literal rather than argued — a hash recomputed with the
   * same function it is testing would agree with itself after any change.
   *
   * The literal was hand-computed from the slot list by a throwaway
   * `sha256` over the fourteen fields joined by `\u001F`, with no import of the
   * production code, and is byte-identical to the value this same fixture
   * produced before the widening.
   */
  it("is unmoved by ImportKindCode gaining two codes — a BUY's pp2 value, pinned", () => {
    expect(computeImportFingerprint(fields())).toBe(
      "pp2:f378a9e849ae16faa090c27785a0b7aff5b56368f65c7b9ebd05e7bb410847bd",
    );
  });

  it("separates its fields with a codepoint no field can contain", () => {
    // Without a separator, `("AB", "C")` and `("A", "BC")` hash identically.
    // The separator is written `\u001F` in the source, never as a literal
    // control character — the assertion is on the escape, and on the fact that
    // the canonical string contains exactly one per field boundary.
    const canonical = canonicalFingerprintString(fields());
    const separator = "\u001F";
    // 14 under `pp2`, 12 under `pp1` — the two added slots (FR-260).
    expect(canonical.split(separator)).toHaveLength(14);
    expect(canonical.includes(separator)).toBe(true);
    // The discriminating case: two field sets whose concatenation is identical
    // but whose split differs.
    const left = computeImportFingerprint(fields({ currency: "EUR", cashAccountId: "X" }));
    const right = computeImportFingerprint(fields({ currency: "EU", cashAccountId: "RX" }));
    expect(left).not.toBe(right);
  });

  it("normalises to a fixed scale, so one economic value is one fingerprint", () => {
    // `numeric(38,12)` is the scale the money columns store; `5.10` and `5.1`
    // must not be two fingerprints. Asserted directly, not inferred from the
    // formula's description.
    expect(computeImportFingerprint(fields({ feeAmount: new Decimal("5.10") }))).toBe(
      computeImportFingerprint(fields({ feeAmount: new Decimal("5.1") })),
    );
    // Positive companion: the normalisation is not "everything is equal" — a
    // value that really differs, at the twelfth decimal place, still differs.
    expect(computeImportFingerprint(fields({ feeAmount: new Decimal("5.100000000001") }))).not.toBe(
      computeImportFingerprint(fields({ feeAmount: new Decimal("5.1") })),
    );
  });

  it("puts the destination cash account in the hash, not only in the index", () => {
    // Importing the same file into a different cash account of the same
    // portfolio is a different, legitimate intent; if the account were outside
    // the hash the second import would skip every row.
    expect(computeImportFingerprint(fields({ cashAccountId: ACCOUNT_A }))).not.toBe(
      computeImportFingerprint(fields({ cashAccountId: ACCOUNT_B })),
    );
  });

  it("distinguishes every field it is documented to cover", () => {
    // One mutation per field, so a field silently dropped from the recipe fails
    // here by name rather than by a count.
    const base = computeImportFingerprint(fields());
    const mutations: readonly [string, Partial<FingerprintFields>][] = [
      ["kindCode", { kindCode: "SELL" }],
      ["tradeDate", { tradeDate: "2026-06-22" }],
      ["instrumentId", { instrumentId: null }],
      ["quantity", { quantity: new Decimal("13") }],
      ["unitPrice", { unitPrice: new Decimal("43.12") }],
      ["amount", { amount: new Decimal("1") }],
      ["currency", { currency: "USD" }],
      ["feeAmount", { feeAmount: new Decimal("5.67") }],
      ["withholdingAmount", { withholdingAmount: new Decimal("1") }],
      ["cashAccountId", { cashAccountId: ACCOUNT_B }],
      ["occurrence", { occurrence: 2 }],
    ];
    expect(mutations).toHaveLength(11);
    for (const [label, mutation] of mutations) {
      expect([label, computeImportFingerprint(fields(mutation))]).not.toEqual([label, base]);
    }
  });
});

describe("cash-interest — a deposit and an interest credit of the same figures", () => {
  it("hash differently, so neither can skip the other as already imported", () => {
    const cash = { instrumentId: null, quantity: null, unitPrice: null, feeAmount: null };
    const deposit = fields({ ...cash, kindCode: "DEPOSIT", amount: new Decimal("12.34") });
    const interest = fields({ ...cash, kindCode: "INTEREST", amount: new Decimal("12.34") });
    expect(computeImportFingerprint(interest)).not.toBe(computeImportFingerprint(deposit));
  });
});

describe("the occurrence ordinal", () => {
  it("numbers rows sharing every other field 1, 2, 3 in file order, and leaves distinct rows at 1", () => {
    const identical = fingerprintIdentityKey(fields());
    const other = fingerprintIdentityKey(fields({ tradeDate: "2026-06-22" }));
    expect(occurrenceOrdinals([identical, other, identical, identical, other])).toEqual([
      1, 1, 2, 3, 2,
    ]);
  });

  it("is the only field the identity key omits, which is what makes the rule work", () => {
    // Two rows that differ *only* in occurrence share an identity key (so the
    // ordinal is assigned across them) and produce different fingerprints (so
    // both import).
    const first = fields({ occurrence: 1 });
    const second = fields({ occurrence: 2 });
    expect(fingerprintIdentityKey(first)).toBe(fingerprintIdentityKey(second));
    expect(computeImportFingerprint(first)).not.toBe(computeImportFingerprint(second));
    // And the ordinal is genuinely in the canonical string, at its documented
    // position — the last field. Removing it from the recipe is the mutation
    // the collision rule demands be red-confirmed; this pins where it would have to be
    // removed from.
    expect(canonicalFingerprintString(second).split("\u001F").at(-1)).toBe("2");
  });

  it("gives a legitimately identical pair two fingerprints, so both can import", () => {
    // The whole point of the rule: two genuine same-day trades of the same
    // instrument, quantity and price are indistinguishable from one row
    // imported twice under any content-only key.
    const pair = [fields({ occurrence: 1 }), fields({ occurrence: 2 })];
    const hashes = pair.map(computeImportFingerprint);
    expect(new Set(hashes).size).toBe(2);
    // Recomputing the same file yields the same two — which is what makes the
    // second import skip both rather than write two more.
    expect(pair.map(computeImportFingerprint)).toEqual(hashes);
  });
});

/**
 * FT-40's own criteria. The recipe bump is the cheapest
 * change in the batch to make and the most expensive to get wrong: a
 * transposed slot changes every hash, and no other test in this repository
 * would notice, because every one of them computes its expected value with the
 * same function it is testing.
 */
describe("pp2's canonical string, slot by slot", () => {
  const SEPARATOR = "\u001F";

  /**
   * The literal from the acceptance criterion, written out here as **data** rather than
   * derived, so the assertion below compares the implementation against the
   * specification instead of against itself.
   */
  const PP2_SLOTS = [
    "recipe",
    "kindCode",
    "tradeDate",
    "instrumentId",
    "quantity",
    "unitPrice",
    "amount",
    "currency",
    "feeAmount",
    "brokerFee",
    "taxAmount",
    "withholdingAmount",
    "cashAccountId",
    "occurrence",
  ] as const;

  const slotAt = (name: (typeof PP2_SLOTS)[number]): number => PP2_SLOTS.indexOf(name);

  it("places every field at the position the slot list names, checked one slot at a time", () => {
    // Every slot given a value distinguishable from every other, so a
    // transposition cannot be masked by two slots happening to agree.
    const distinct = fields({
      kindCode: "SELL",
      tradeDate: "2026-06-21",
      instrumentId: INSTRUMENT,
      quantity: new Decimal("11"),
      unitPrice: new Decimal("22"),
      amount: new Decimal("33"),
      currency: "USD",
      feeAmount: new Decimal("44"),
      brokerFee: new Decimal("55"),
      taxAmount: new Decimal("66"),
      withholdingAmount: new Decimal("77"),
      cashAccountId: ACCOUNT_B,
      occurrence: 3,
    });
    const slots = canonicalFingerprintString(distinct).split(SEPARATOR);

    expect(slots).toHaveLength(PP2_SLOTS.length);
    expect(slots[slotAt("recipe")]).toBe("pp2");
    expect(slots[slotAt("kindCode")]).toBe("SELL");
    expect(slots[slotAt("tradeDate")]).toBe("2026-06-21");
    expect(slots[slotAt("instrumentId")]).toBe(INSTRUMENT);
    expect(slots[slotAt("quantity")]).toBe("11.000000000000");
    expect(slots[slotAt("unitPrice")]).toBe("22.000000000000");
    expect(slots[slotAt("amount")]).toBe("33.000000000000");
    expect(slots[slotAt("currency")]).toBe("USD");
    expect(slots[slotAt("feeAmount")]).toBe("44.000000000000");
    expect(slots[slotAt("brokerFee")]).toBe("55.000000000000");
    expect(slots[slotAt("taxAmount")]).toBe("66.000000000000");
    expect(slots[slotAt("withholdingAmount")]).toBe("77.000000000000");
    expect(slots[slotAt("cashAccountId")]).toBe(ACCOUNT_B);
    expect(slots[slotAt("occurrence")]).toBe("3");

    // The two added slots are adjacent, and sit *after* the total they
    // decompose. That ordering is what is fixed.
    expect(slotAt("brokerFee")).toBe(slotAt("feeAmount") + 1);
    expect(slotAt("taxAmount")).toBe(slotAt("brokerFee") + 1);
  });

  /**
   * FR-213's "absent, never zero", at the hash. `fixed(null)` must be the empty
   * string and not `"0.000000000000"`: collapsing them would make "this row
   * carried no trade-tax figure" and "this row's trade-tax figure said 0,00"
   * one row, so a file containing both would import one and silently skip the
   * other.
   */
  it("normalises an absent component to the empty string, never to a zero", () => {
    const absent = canonicalFingerprintString(fields({ brokerFee: null, taxAmount: null })).split(
      SEPARATOR,
    );
    expect(absent[slotAt("brokerFee")]).toBe("");
    expect(absent[slotAt("taxAmount")]).toBe("");

    const zero = canonicalFingerprintString(
      fields({ brokerFee: new Decimal("0"), taxAmount: new Decimal("0") }),
    ).split(SEPARATOR);
    expect(zero[slotAt("brokerFee")]).toBe("0.000000000000");
    expect(zero[slotAt("taxAmount")]).toBe("0.000000000000");

    // And therefore the two rows are distinguishable, which is the point.
    expect(computeImportFingerprint(fields({ brokerFee: null }))).not.toBe(
      computeImportFingerprint(fields({ brokerFee: new Decimal("0") })),
    );
  });

  /**
   * FT-40's mutation proof, both halves. A hash that is stable under reordering
   * is not hashing what the canonical string says it hashes — and only a
   * hand-built comparison string can show that, because recomputing with the
   * production function would reorder the expectation along with the
   * implementation.
   */
  it("changes when an added slot's value changes, and when two slots swap position", () => {
    const base = fields({ brokerFee: new Decimal("5"), taxAmount: new Decimal("9") });
    const baseHash = computeImportFingerprint(base);
    const digestOf = (canonical: string): string =>
      createHash("sha256").update(canonical, "utf8").digest("hex");

    // (a) value: one added slot moved, everything else held.
    expect(computeImportFingerprint({ ...base, brokerFee: new Decimal("6") })).not.toBe(baseHash);
    expect(computeImportFingerprint({ ...base, taxAmount: new Decimal("10") })).not.toBe(baseHash);

    // (b) position: the two added slots transposed, by hand. Their *values*
    // differ (5 and 9), so a swap is observable — with equal values it would
    // not be, which is why the fixture uses two distinct figures.
    const canonical = canonicalFingerprintString(base);
    const slots = canonical.split(SEPARATOR);
    const swapped = [...slots];
    [swapped[slotAt("brokerFee")], swapped[slotAt("taxAmount")]] = [
      slots[slotAt("taxAmount")]!,
      slots[slotAt("brokerFee")]!,
    ];
    expect(swapped.join(SEPARATOR)).not.toBe(canonical);
    expect(digestOf(swapped.join(SEPARATOR))).not.toBe(baseHash.slice("pp2:".length));

    // The control: hashing the *un*-swapped string by hand reproduces the
    // production value exactly, so the comparison above is a real one and not
    // an artefact of hashing differently.
    expect(digestOf(canonical)).toBe(baseHash.slice("pp2:".length));
  });
});
