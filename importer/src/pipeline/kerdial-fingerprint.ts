import { createHash } from "node:crypto";

import type { Decimal } from "@kerdial/core-decimal";

import type { CurrencyCode, IsoDate } from "../types.js";
import type { ImportKindCode } from "./fingerprint.js";

/**
 * The Kerdial transactions package's per-row idempotency key.
 *
 * **A separate file from `fingerprint.ts`, and that is the decision, not the
 * tidiness.** `pp2`'s canonical string must not be one edit away from moving:
 * a recipe that changes silently re-imports every row of every previously
 * imported file (see `IMPORT_FINGERPRINT_RECIPE`'s own doc comment in
 * `fingerprint.ts` on the backfill obligation a recipe bump owes). Two files,
 * two recipes, and a mutation to one cannot reach the other.
 *
 * It sits under `pipeline/` for the same checked reason `fingerprint.ts` does:
 * `pnpm import-vocabulary-gate` scans `src/types.ts` and `src/pipeline/**`, so
 * "this module is format-agnostic — it reads resolved ids and `Decimal`s, never
 * a source cell" is a gate result rather than a claim.
 */

/**
 * The recipe version. Three lowercase alphanumerics, which is inside the live
 * `transaction_import_fingerprint_shape` CHECK — `^[a-z0-9]{1,8}:[0-9a-f]{64}$`
 * (MEASURED, `platform/db/src/schema/transaction.ts`, the check beside
 * `importFingerprint`) — so this cycle adds **no migration** (FR-553/SD-8).
 *
 * The obligation `pp2` records applies here identically and is not waived by
 * this being a first version: if the canonical string below ever changes, rows
 * written under `kd1` keep their old hashes, nothing collides, nothing dedupes,
 * and the first re-import after the change duplicates every row. A cycle that
 * changes it owes a backfill plan.
 */
export const KERDIAL_FINGERPRINT_RECIPE = "kd1";

/**
 * The field separator, `U+001F UNIT SEPARATOR`, written as an escape and never
 * as a literal control character (this repository's standing rule). No field
 * below can contain it, which is the whole requirement — with a separator any
 * field could produce, `("AB", "C")` and `("A", "BC")` would hash identically.
 */
const FIELD_SEPARATOR = "\u001F";

/**
 * **`kd1`'s scale rule, and it is one rule rather than two constants: every
 * field is hashed at its own column's stored scale.** Two rows collide exactly
 * when the database would have stored them as the same values — no earlier, no
 * later. Anything else is a choice about which real differences to discard, and
 * this recipe makes none.
 *
 * `transaction.quantity` and `transaction.unit_price` are both
 * `numeric(38,18)`, so both are hashed here (MEASURED,
 * `platform/db/src/schema/transaction.ts`).
 *
 * **This is where `kd1` departs from `pp2` deliberately.** `pp2` normalises
 * every figure at 12 and its own comment flags that as *"UNVERIFIED for any
 * other export"* — the Portfolio-Performance corpus measured zero fractional
 * quantities, so 12 was enough there. This *is* the other export, and a Kerdial
 * file is written by Kerdial's own serializer from those 18-dp columns: a DRIP
 * unit price of `60.235294117647058823` and a crypto buy of
 * `0.000000000000000001` are both ordinary here. The flag is answered by
 * widening, and because `kd1` is a different recipe there is no compatibility
 * question to answer.
 */
const QUANTITY_SCALE = 18;

/**
 * The scale of every **money** column of `transaction` — `numeric(38,12)` — so
 * normalising here is what makes `5.10` and `5.1` one economic value rather
 * than two fingerprints. The same "its own column's stored scale" rule
 * {@link QUANTITY_SCALE} states, applied to the other half of the field set.
 */
const MONEY_SCALE = 12;

/**
 * Everything `kd1` hashes. Every member is either **resolved** (`portfolioId`,
 * `instrumentId`, `cashAccountId` are uuids, never a name or an ISIN) or a
 * `Decimal`; nothing here is a source cell.
 *
 * The set covers **all eight kinds and every leg** — the target leg, the
 * settlement leg, the full cost itemisation and the withholding leg — so two
 * rows differing only in one of those hash differently by construction rather
 * than by a per-kind argument.
 */
export interface KerdialFingerprintFields {
  readonly kindCode: ImportKindCode;
  readonly tradeDate: IsoDate;
  /**
   * **In the key, and this is the reason `pp2` cannot simply be reused**.
   * One Portfolio-Performance request writes to one
   * destination, so `pp2` can leave the portfolio out and let the partial
   * unique index carry `portfolio_id`. One Kerdial file writes to **many**
   * portfolios in one request: without this field the same trade in two
   * portfolios of one tenant would share an identity key, and the occurrence
   * ordinal would silently make the second of them a "second occurrence" of the
   * first — one row imported, one skipped, and no error anywhere.
   */
  readonly portfolioId: string;
  /** The **resolved** instrument uuid; `null` for a cash movement or an exchange, which have no instrument leg. */
  readonly instrumentId: string | null;
  /** The asset an asset-settled BUY was paid with (FR-66); `null` on every other kind. */
  readonly settlementInstrumentId: string | null;
  readonly quantity: Decimal | null;
  /**
   * Hashed at **18** decimal places, not 12 — `transaction.unit_price` is
   * `numeric(38,18)` like `quantity`, and {@link QUANTITY_SCALE}'s rule is that
   * a field is hashed at its own column's stored scale.
   *
   * Recorded because the reader's expectation is that "price" means "money":
   * `unit_price` is the one figure on the row that is *derived* rather than
   * entered (a settled BUY's is `settlement.amount / quantity`), which is why
   * its column carries a quantity's precision rather than a money column's.
   * Hashing it at 12 would have made `60.235294117647058823` and
   * `60.235294117647058824` — two values Postgres stores distinctly — one
   * fingerprint, so a file containing both would import one and skip the other.
   */
  readonly unitPrice: Decimal | null;
  readonly grossAmount: Decimal | null;
  /** `null` on a settled BUY, whose gross amount is denominated in an asset rather than an ISO currency. */
  readonly currency: CurrencyCode | null;
  readonly cashAccountId: string | null;
  readonly cashCurrency: CurrencyCode | null;
  readonly cashAmount: Decimal | null;
  readonly targetCurrency: CurrencyCode | null;
  readonly targetAmount: Decimal | null;
  readonly targetCashAccountId: string | null;
  readonly feeAmount: Decimal | null;
  /**
   * The four cost components, each **verbatim from the file**: an absent one is
   * `null` and one that said `0` is a zero. {@link money} maps those to `""`
   * and `"0.000000000000"` respectively, and collapsing them would make "no
   * broker fee" and "a zero broker fee" one row, which FR-213 forbids.
   */
  readonly brokerFee: Decimal | null;
  readonly fxFee: Decimal | null;
  readonly taxAmount: Decimal | null;
  readonly otherCost: Decimal | null;
  /** One amount, in the settling account's currency. */
  readonly withholdingAmount: Decimal | null;
  /** The resolved id of the DIVIDEND a DRIP reinvests (AC6); `null` on every other kind. */
  readonly sourceDividendId: string | null;
  /** 1-based; see `occurrenceOrdinals` in `fingerprint.ts`, which this recipe reuses verbatim. */
  readonly occurrence: number;
}

/** The `q()` — the `numeric(38,18)` fields (`quantity`, `unitPrice`), at the scale their columns store. */
function quantity(value: Decimal | null): string {
  return value === null ? "" : value.toFixed(QUANTITY_SCALE);
}

/** The `m()` — every money figure, at the scale the money columns store. */
function money(value: Decimal | null): string {
  return value === null ? "" : value.toFixed(MONEY_SCALE);
}

/** An absent identifier or code is the empty string, never the literal `"null"`. */
function text(value: string | null): string {
  return value ?? "";
}

/**
 * Every field except `occurrence`, `\u001F`-joined in key order.
 * Two rows share an identity key exactly when they are the "legitimately
 * identical" pair the occurrence rule is about — which is why the ordinal is
 * assigned *per identity key*.
 *
 * Because {@link KerdialFingerprintFields.portfolioId} is one of the fields,
 * the "ordinals are computed per portfolio" is automatic rather than a
 * second rule: two identical rows in two portfolios have two identity keys and
 * are each their own first occurrence.
 */
export function kerdialFingerprintIdentityKey(fields: KerdialFingerprintFields): string {
  return [
    KERDIAL_FINGERPRINT_RECIPE,
    fields.kindCode,
    fields.tradeDate,
    fields.portfolioId,
    text(fields.instrumentId),
    text(fields.settlementInstrumentId),
    quantity(fields.quantity),
    quantity(fields.unitPrice),
    money(fields.grossAmount),
    text(fields.currency),
    text(fields.cashAccountId),
    text(fields.cashCurrency),
    money(fields.cashAmount),
    text(fields.targetCurrency),
    money(fields.targetAmount),
    text(fields.targetCashAccountId),
    money(fields.feeAmount),
    money(fields.brokerFee),
    money(fields.fxFee),
    money(fields.taxAmount),
    money(fields.otherCost),
    money(fields.withholdingAmount),
    // The net-dividend change dropped the withholding's own currency and account. Their two slots
    // stay, hashed as the empty string — the value every row without a
    // withholding always put there — so the canonical layout is unchanged,
    // no stored `kd1` value of such a row moves, and no recipe bump is owed.
    "",
    "",
    text(fields.sourceDividendId),
  ].join(FIELD_SEPARATOR);
}

/** The canonical string: the identity key with the 1-based occurrence ordinal appended. */
export function canonicalKerdialFingerprintString(fields: KerdialFingerprintFields): string {
  return `${kerdialFingerprintIdentityKey(fields)}${FIELD_SEPARATOR}${String(fields.occurrence)}`;
}

/**
 * `"kd1:" + sha256Hex(utf8(canonical))` — the value stored in
 * `transaction.import_fingerprint`, and the shape
 * `transaction_import_fingerprint_shape` enforces.
 */
export function computeKerdialFingerprint(fields: KerdialFingerprintFields): string {
  const digest = createHash("sha256")
    .update(canonicalKerdialFingerprintString(fields), "utf8")
    .digest("hex");
  return `${KERDIAL_FINGERPRINT_RECIPE}:${digest}`;
}
