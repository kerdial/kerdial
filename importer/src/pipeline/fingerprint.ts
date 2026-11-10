import { createHash } from "node:crypto";

import type { Decimal } from "@kerdial/core-decimal";

import type { CurrencyCode, IsoDate } from "../types.js";

/**
 * ID7's per-row idempotency key (the OD-7
 * amendment, which the user locked over the analyst's recommendation to defer
 * it).
 *
 * **Placed under `pipeline/` rather than at `src/fingerprint.ts`, where it was
 * first planned.** One reason, and it is not tidiness: `pnpm
 * import-vocabulary-gate` scans `src/types.ts` and `src/pipeline/**` and
 * nothing else. This file is format-agnostic by construction — it reads a
 * resolved instrument id and a `Decimal`, never a source cell — and putting it
 * where the gate can see it makes that a checked property instead of a claim.
 * Recorded here rather than reconciled silently.
 */

/**
 * The recipe version, and **it is not decoration**. If the canonical
 * string below ever changes, rows written under the previous recipe keep their
 * old hashes and new computations produce new ones — so nothing collides, but
 * nothing dedupes either, and the first re-import after the change duplicates
 * every row. A cycle that changes the recipe therefore owes a backfill plan,
 * not a bug report. Stated here so it is a recorded obligation rather than a
 * discovery.
 *
 * **`pp1` → `pp2` (FT-40, LD-10).** The fee-tax-breakdown cycle added
 * `brokerFee` and `taxAmount` to the canonical string below, so the bump is
 * owed. The obligation above was **met, not waived**: the plan is *no backfill*
 * of stored `pp1:` fingerprints (L8 — the corpus is test data), and the
 * consequence RF7 names is carried as its own task rather than discovered in
 * production. The first import of a previously-imported file after this
 * release re-creates its rows; the import screen and the release note both say
 * so, and the second import dedupes normally with `pp2` on both sides.
 *
 * **Only two slots were added**, not five. A broker fee and a trade tax are the
 * only cost figures the source format can produce; a slot the importer can
 * never fill is dead weight in a hash and would still have to be separated,
 * ordered and documented.
 */
export const IMPORT_FINGERPRINT_RECIPE = "pp2";

/**
 * The field separator, `U+001F UNIT SEPARATOR`, written as an escape and never
 * as a literal control character (this repository's standing rule, and
 * `fixture-integrity.test.ts` is the technique). None of the fields below can
 * contain it, which is the whole requirement — with a separator any field
 * could produce, `("AB", "C")` and `("A", "BC")` would hash identically.
 */
const FIELD_SEPARATOR = "\u001F";

/**
 * `numeric(38,12)` is the scale `transaction`'s money columns store, so
 * normalising to 12 decimal places here is what makes `5.10` and `5.1` one
 * economic value rather than two fingerprints.
 *
 * `quantity` is `numeric(38,18)`; 12 dp is enough for this format because M7b
 * measured zero fractional quantities across every trade of the stock exports it
 * was checked against. **UNVERIFIED for any other export** — flagged, and cheap to widen.
 */
const FIXED_SCALE = 12;

/**
 * The transaction kinds this importer can produce. A closed set, and the same
 * strings `transaction.kind` uses.
 *
 * `SHARE_DISTRIBUTION` joined it with cashless-distribution support. It changes no hashed field
 * and no recipe: `kindCode` is already part of the canonical string, so a
 * distribution and a buy of the same instrument, date and quantity hash
 * differently by construction — and every fingerprint written before cashless-distribution support
 * keeps its value, because none of them carried this code.
 *
 * `DRIP` and `CURRENCY_EXCHANGE` joined it with the `portfolio-export-import`
 * cycle, completing the eight values of `transactionKindEnum`.
 * **Exactly the same argument applies, and is restated rather than assumed:**
 * the two codes are *appended*, the six above are untouched, `kindCode` is
 * already a slot of the canonical string, and no `pp2` value moves — a
 * Portfolio-Performance export can produce neither code, so no fingerprint
 * written before this cycle carried either.
 *
 * `TRANSFER_OUT` joined it with `security-transfer`, on the
 * same argument once more: appended, `kindCode` already hashed, and no stored
 * `pp2` value moves because no earlier row carried the code. The row's
 * **destination is not hashed** (ST-11) — the source leg is the same source row
 * whichever portfolio the user names for its units. A **linked** target leg is
 * created by its source's write and has no code of its own here.
 *
 * `TRANSFER_IN` joined it with `security-transfer` Batch E (ND-2 (a)): the one target leg this importer *does* write is a lone one — a
 * target whose source portfolio was deleted, carried back in by a
 * per-row-destination file. Appended, on the same argument: `kindCode` is
 * already hashed and no stored value carried the code before.
 *
 * `INTEREST` joined it with `cash-interest`, on the same
 * argument once more: appended, `kindCode` already hashed, and no stored `pp2`
 * or `kd1` value moves because no earlier row carried the code. An INTEREST
 * and a DEPOSIT with the same date, amount, currency and account therefore
 * hash differently by construction, in both recipes.
 *
 * `FEE` joined it with `portfolio-cash`, on the same
 * argument: appended, `kindCode` already hashed (`fingerprintIdentityKey`), no
 * stored `pp2` or `kd1` value moves. A FEE and a WITHDRAWAL with the same
 * date, amount, currency and account hash differently by construction.
 */
export type ImportKindCode =
  | "BUY"
  | "SELL"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "DIVIDEND"
  | "SHARE_DISTRIBUTION"
  | "DRIP"
  | "CURRENCY_EXCHANGE"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "INTEREST"
  | "FEE";

/**
 * Everything the hash is taken over. Every member is either already resolved
 * (`instrumentId` is the uuid, never the source ISIN) or chosen by the user
 * (`cashAccountId`) — nothing here is a source cell.
 */
export interface FingerprintFields {
  readonly kindCode: ImportKindCode;
  readonly tradeDate: IsoDate;
  /** The **resolved** instrument uuid; `null` for a cash movement, which has no instrument leg. */
  readonly instrumentId: string | null;
  readonly quantity: Decimal | null;
  readonly unitPrice: Decimal | null;
  readonly amount: Decimal | null;
  readonly currency: CurrencyCode;
  readonly feeAmount: Decimal | null;
  /**
   * The broker-fee component of {@link FingerprintFields.feeAmount} (FT-40).
   * **Verbatim from the source figure**, so an absent one is `null` and one
   * that said `0` is a zero — `fixed()` maps those to `""` and
   * `"0.000000000000"` respectively, and collapsing them would make "no broker
   * fee" and "a zero broker fee" one row, which FR-213 forbids.
   */
  readonly brokerFee: Decimal | null;
  /** The trade-tax component, on the same verbatim rule as {@link FingerprintFields.brokerFee}. */
  readonly taxAmount: Decimal | null;
  readonly withholdingAmount: Decimal | null;
  /**
   * The user-chosen destination. **In the hash, not only in the unique
   * index**: importing the same file into a different cash account of the same
   * portfolio is a different, legitimate intent, and it must produce different
   * fingerprints or the second import would skip every row.
   */
  readonly cashAccountId: string;
  /** 1-based; see {@link occurrenceOrdinals}. Excluded from {@link fingerprintIdentityKey}, and that is the mechanism. */
  readonly occurrence: number;
}

function fixed(value: Decimal | null): string {
  return value === null ? "" : value.toFixed(FIXED_SCALE);
}

/**
 * Every field except `occurrence`, joined. Two rows share an identity key
 * exactly when they are the "legitimately identical" pair — which
 * is why the ordinal is assigned *per identity key* and why removing it from
 * the canonical string collapses such a pair to one fingerprint.
 */
export function fingerprintIdentityKey(fields: FingerprintFields): string {
  return [
    IMPORT_FINGERPRINT_RECIPE,
    fields.kindCode,
    fields.tradeDate,
    fields.instrumentId ?? "",
    fixed(fields.quantity),
    fixed(fields.unitPrice),
    fixed(fields.amount),
    fields.currency,
    fixed(fields.feeAmount),
    fixed(fields.brokerFee),
    fixed(fields.taxAmount),
    fixed(fields.withholdingAmount),
    fields.cashAccountId,
  ].join(FIELD_SEPARATOR);
}

/** The canonical string, verbatim: the identity key with the 1-based occurrence ordinal appended. */
export function canonicalFingerprintString(fields: FingerprintFields): string {
  return `${fingerprintIdentityKey(fields)}${FIELD_SEPARATOR}${String(fields.occurrence)}`;
}

/** `"pp2:" + sha256Hex(utf8(canonical))` — the value stored in `transaction.import_fingerprint`, and the shape `0042`'s CHECK enforces. */
export function computeImportFingerprint(fields: FingerprintFields): string {
  const digest = createHash("sha256")
    .update(canonicalFingerprintString(fields), "utf8")
    .digest("hex");
  return `${IMPORT_FINGERPRINT_RECIPE}:${digest}`;
}

/**
 * The collision rule: `occurrence` is the 1-based ordinal of a row among the
 * rows **of this same file** that share every other fingerprint field, in file
 * order.
 *
 * Two genuinely identical same-day trades are indistinguishable from one row
 * imported twice by any content-derived key — this is the answer. A file with
 * two identical rows yields ordinals 1 and 2, two distinct fingerprints, and
 * both import. Re-importing recomputes the same two and both skip. A later
 * export with three of them yields 1, 2, 3: the first two skip, the third
 * imports. Deterministic, computed from the file plus the destination alone,
 * and needing no server-side state.
 *
 * Its one honest limitation, stated rather than discovered: import a file,
 * delete *one* of two identical rows, re-import — the survivor's stored hash is
 * the ordinal-1 or the ordinal-2 one depending on which was deleted, so exactly
 * one of the two file rows imports. The count is right; which of two
 * indistinguishable rows is "the" survivor is not a question the data can
 * answer.
 *
 * @param keys the identity key of each importable row, **in file order**
 * @returns the 1-based ordinal for each, positionally aligned with `keys`
 */
export function occurrenceOrdinals(keys: readonly string[]): number[] {
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const next = (seen.get(key) ?? 0) + 1;
    seen.set(key, next);
    return next;
  });
}
