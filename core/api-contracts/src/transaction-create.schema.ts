import { Decimal } from "@kerdial/core-decimal";
import { z } from "zod";
// Imported for the same declaration-emission reason `api/src/instruments/
// instruments.schema.ts`/`api/src/transactions/transactions.schema.ts`
// document on their own identical import: keeps `tsc`'s `.d.ts` output for
// `CreateTransactionBody` (a `z.infer` that structurally contains `Decimal`
// fields via `zDecimal`'s transform) resolved against `@kerdial/core-
// decimal`'s own re-exported `Decimal` type, not a bare `decimal.js`
// specifier `dependency-cruiser`'s `no-unresolvable` rule would then flag
// (this package has no direct dependency on `decimal.js` itself).
import type { Decimal as _Decimal } from "@kerdial/core-decimal";
import { zDecimal } from "./decimal-codec.js";
import { isBlankUnderDatabaseFloor } from "./portfolio-name.schema.js";

/**
 * `POST /transactions`'s request-validation core — T-44: one component using
 * React Hook Form + the **same** Zod schemas as the API (imported from a
 * shared package so client/server validation cannot drift).
 *
 * **Extraction note (T-44):** this is a pure move of the *create*-request
 * half of `api/src/transactions/transactions.schema.ts` — `createTransactionBodySchema`
 * and every helper it depends on (`TRANSACTION_KIND_VALUES`, `isoDateSchema`,
 * `currencyCodeSchema`, `positiveDecimal`, `feeBodySchema`,
 * `withholdingBodySchema`, `settlementBodySchema`). `api`'s own
 * `transactions.schema.ts` now imports these from here instead of defining
 * them locally, so this is genuinely the *same* schema object both sides
 * validate against, not a structurally-identical copy.
 *
 * Deliberately **not** moved here (stays server-only in `api`):
 * `editTransactionBodySchema`, `correctFxRateBodySchema`,
 * `listTransactionsQuerySchema`,
 * `TransactionResponse`/`toTransactionResponse` (these read/map a `ledger`
 * `TransactionRecord`, which is server-only and which `web` must not depend
 * on — see `Figure.tsx`'s own doc header on why `web` mirrors response
 * shapes locally instead of importing `api`), and `GUARDED_FX_EDIT_FIELDS`
 * (an edit-path concern; T-44's form is create-only, edit is out of its
 * scope). The create path itself needed no DB/session lookups
 * to validate structurally — it is pure input-shape validation, exactly the
 * "irreducibly server-entangled" seam this extraction was checked against.
 */

/**
 * The kinds of `transaction_kind`, in the database enum's own order.
 *
 * `SHARE_DISTRIBUTION` (migration `0056`) is the cashless one: a
 * share distribution — the French *attribution d'actions gratuites* — that
 * raises the share count, moves no money and leaves the total cost basis
 * unchanged. Its shape rules are the mirror image of every other kind's: what
 * it *forbids* (a price, a cash account, a settlement currency, a cost leg) is
 * what says it is cashless, and each of those `forbid(...)`s below has a
 * `CHECK` behind it.
 *
 * `INTEREST` (`cash-interest`, migration `0075`) is the eleventh: interest
 * earned on cash — DEPOSIT's shape plus DIVIDEND's optional withholding,
 * classified `INCOME`. Appended last, as the database enum appends it.
 *
 * `FEE` (`portfolio-cash`, migration `0077`) is the twelfth: a standalone
 * portfolio fee — WITHDRAWAL's shape, classified `FEE`, with an optional
 * `instrumentId` that is a reference only (no position effect). Appended last.
 */
export const TRANSACTION_KIND_VALUES = [
  "BUY",
  "SELL",
  "DEPOSIT",
  "WITHDRAWAL",
  "DIVIDEND",
  "DRIP",
  "CURRENCY_EXCHANGE",
  "SHARE_DISTRIBUTION",
  // `security-transfer` (migration `0070`): units leaving one portfolio for
  // another, or for outside Kerdial. Listed because the list/read schemas take
  // their `kind` vocabulary from here; `TRANSFER_IN` is **not creatable** —
  // see `transferInNotCreatable` below.
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "INTEREST",
  "FEE",
] as const;
export type TransactionKind = (typeof TRANSACTION_KIND_VALUES)[number];

/** Mirrors `instruments.schema.ts`'s identical helper — see that module for the Feb-31st rationale. */
function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO YYYY-MM-DD calendar date")
  .refine(isRealCalendarDate, "must be a real calendar date (e.g. not February 31st)");

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 currency code (uppercase)");

export const positiveDecimal = (label: string) =>
  zDecimal.refine((value) => value.greaterThan(0), `${label} must be a positive amount`);

/** An ISO instant string (e.g. `2024-03-12T10:00:00.000Z`) parsed to a `Date` — `transaction.trade_ts`'s own column type (no `{ mode: "string" }`, unlike `trade_date`). Exported: `api`'s `editTransactionBodySchema` (`transactions.schema.ts`) reuses this for its own, still-editable `tradeTs` field. */
export const isoInstantAsDate = z.iso.datetime().transform((value) => new Date(value));

/**
 * **The user's own reference for a transaction** (migration `0057`) — a
 * broker's order number, a statement line, whatever the person reconciling
 * this ledger against a document by hand actually quotes.
 *
 * What matters is what this schema *is not*: it is never
 * generated (a reference this product mints reconciles against nothing) and
 * it is never unique (two brokers' numbering schemes may collide, and a
 * uniqueness rule would reject the user's real data). What is left is free
 * text, trimmed and bounded.
 *
 * `120` is generous for every real numbering scheme — ISO 20022's
 * `EndToEndIdentification` is 35 characters — and short enough to stay one
 * line in the transaction drawer, which is where this value is read.
 *
 * The `.trim()` runs **before** `.max()`, so a padded value is bounded by
 * what is actually stored, and `transaction_reference_shape` bounds the raw
 * stored length by the same number (see that CHECK's own comment for why it
 * does not use `btrim`).
 */
const boundedReference = z.string().trim().max(120, `reference must be at most 120 characters`);

/**
 * The bound above, read back off the schema rather than restated — the
 * {@link INDUSTRY_LABEL_MAX_LENGTH} pattern, and for its reason: a constant
 * restating a `.max()` can drift from it silently. The both-directions guard
 * against the *database's* bound is
 * `platform/db/src/transaction-reference.integration.test.ts`, which reads
 * `transaction_reference_shape` out of `pg_get_constraintdef`.
 *
 * The non-null assertion is safe by construction: `ZodString.maxLength` is
 * `null` only for a string schema carrying no `.max()`.
 */
export const TRANSACTION_REFERENCE_MAX_LENGTH: number = boundedReference.maxLength!;

/**
 * The **create** side: trimmed, and blank means *absent* rather than stored.
 *
 * `isBlankUnderDatabaseFloor`, not `=== ""`, and the difference is the whole
 * point (the portfolio-name blank-floor finding, applied to a new column
 * before it can bite): JS's
 * own `.trim()` leaves U+00A0, U+200B, U+FEFF and seven other codepoints
 * standing, each of which renders as an *empty* reference row — data that is
 * not there, displayed as though it were — and which
 * `transaction_reference_shape` would then refuse as a `23514`, i.e. a 500
 * for input this boundary had just accepted. Mapping every database-blank
 * value to `undefined` closes both at once.
 *
 * A transform, not a `.refine()`, and deliberately unlike `portfolioNameSchema`
 * (which refuses a blank name): a name is required, so blank is an error to
 * report; a reference is optional, so blank is simply the user not supplying
 * one, and telling them off for clearing a field they never had to fill would
 * be the wrong sentence.
 */
export const transactionReferenceSchema = boundedReference.transform((value) =>
  isBlankUnderDatabaseFloor(value) ? undefined : value,
);

/**
 * The **edit** side, for `api`'s `editTransactionBodySchema` — same bound,
 * same trim, same blank predicate, and `null` instead of `undefined` because
 * on a PATCH the two mean different things: absent leaves the stored
 * reference alone, `null` clears it. Cleared is what a user emptying the
 * field means, and it is what `note` (the sibling free-text column) already
 * does on that path.
 *
 * Declared here beside its create twin rather than in `api`, unlike
 * `editTransactionBodySchema` itself: the two must share **one** bound and
 * **one** blank predicate, and a copy in the other package is exactly the
 * drift this package exists to prevent.
 */
export const transactionReferenceEditSchema = boundedReference.transform((value) =>
  isBlankUnderDatabaseFloor(value) ? null : value,
);

/**
 * **FR-213 (`fee-tax-breakdown` phase 2): the closed vocabulary of cost
 * components**, as a `strictObject` so a misspelled or invented component is a
 * per-field rejection rather than a key Zod silently strips.
 *
 * The vocabulary is this object plus the column set — **not** a Postgres enum
 * (A9). A fifth kind of cost is a migration, deliberately, so that adding one
 * is a decision rather than a string.
 */
export const costComponentsSchema = z
  .strictObject({
    brokerFee: positiveDecimal("fee.components.brokerFee").optional(),
    fxFee: positiveDecimal("fee.components.fxFee").optional(),
    tax: positiveDecimal("fee.components.tax").optional(),
    other: positiveDecimal("fee.components.other").optional(),
  })
  .superRefine((components, ctx) => {
    // An empty `components` object says nothing and would otherwise be a
    // silently-ignored key — FR-213's "absent, never zero" applies to the
    // object as well as to each amount.
    if (Object.values(components).every((amount) => amount === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message:
          "fee.components must name at least one component — omit the key entirely if no cost was itemised",
      });
    }
  });

/**
 * **L5/L6, made visible to callers** (FR-221).
 *
 * Two keys, and `z.strictObject` is the mechanism rather than a tidiness
 * preference. `currency`, `cashAccountId` and `fxRateUserInput` were all
 * **required or accepted here until this release**, and a cost is now
 * denominated by the settling account — so a client still sending them is
 * describing a capability that no longer exists. Zod's default is to *strip*
 * unknown keys, which would drop them in silence and make L6's retirement of
 * shipped behaviour invisible to the caller; `z.strictObject` turns each into an
 * `unrecognized_keys` issue, mapped to a per-field `400` whose path names the
 * field (RF8).
 *
 * **This is an intentional breaking change, user-locked (L6).** The pre-cycle
 * shapes that now fail are, exhaustively: *every* request carrying a `fee` at
 * all, because `fee.currency` and `fee.cashAccountId` were both required.
 * `web/src/lib/tester-schema-parity.test.ts` asserts the list.
 */
export const feeBodySchema = z
  .strictObject({
    /**
     * Optional since phase 2: when `components` are supplied the total **is**
     * their exact sum, so a caller need not restate it — and cannot restate it
     * wrongly. Supplied together, the two must agree exactly (below).
     */
    amount: positiveDecimal("fee.amount").optional(),
    /**
     * FR-208/FR-213: the itemisation. Absent means the total is unitemised,
     * which stays valid permanently under L8.
     */
    components: costComponentsSchema.optional(),
  })
  .superRefine((fee, ctx) => {
    // One of the two must carry the cost. Without this an empty `fee: {}`
    // (after `amount` became optional) would be a leg with no figure at all.
    if (fee.amount === undefined && fee.components === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: "fee requires either an amount or components",
      });
    }
    if (fee.amount === undefined || fee.components === undefined) return;
    // **The database's own rule, mirrored** so `web` and `api` cannot disagree
    // with each other or with `transaction_cost_components_sum_to_fee_amount`:
    // exact equality at `numeric(38,12)`, no tolerance.
    const sum = Object.values(fee.components).reduce(
      (total: Decimal, amount) => (amount === undefined ? total : total.plus(amount)),
      new Decimal(0),
    );
    if (!sum.equals(fee.amount)) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: `fee.amount must equal the sum of fee.components (${sum.toFixed()}) exactly — omit it and the sum is used`,
      });
    }
  });

/**
 * A withholding is **one amount**, denominated by the settling cash
 * account's currency. No currency, no account, no rate: `strictObject` so a
 * client still sending the old trio gets a per-field `unrecognized_keys` 400
 * rather than a silent strip.
 */
export const withholdingBodySchema = z.strictObject({
  amount: positiveDecimal("withholding.amount"),
});

/** FR-66/AC52's asset-settled leg — `settlement` present on a `BUY` body routes to `recordSettledBuy` instead of `recordBuy` (see `api`'s `transactions.controller.ts`). */
export const settlementBodySchema = z.object({
  instrumentId: z.uuid(),
  amount: positiveDecimal("settlement.amount"),
  fxRateUserInput: positiveDecimal("settlement.fxRateUserInput").optional(),
});

/**
 * **A `TRANSFER_IN` is created only through its source** (`security-transfer`):
 * `recordTransferOut` writes the receiving leg when the
 * `TRANSFER_OUT` names a `destinationPortfolioId`. A field-level refinement
 * rather than a `superRefine` rule, so the issue on `kind` is raised whatever
 * else the body gets wrong — an object-level rule only runs once every field
 * has parsed.
 */
const transferInNotCreatable = z
  .enum(TRANSACTION_KIND_VALUES)
  .refine(
    (kind) => kind !== "TRANSFER_IN",
    "a TRANSFER_IN cannot be created directly — record the TRANSFER_OUT with a destinationPortfolioId and its receiving leg is written with it",
  );

/**
 * `POST /transactions` body — the eight original kinds (the eighth being
 * `SHARE_DISTRIBUTION`), `TRANSFER_OUT`, and
 * `INTEREST` (`cash-interest`, the eleventh), `FEE` (`portfolio-cash`, the
 * twelfth),
 * plus the asset-settled `BUY` (FR-66/AC52), unified into one schema the way
 * `instruments.schema.ts`'s `createInstrumentBodySchema` unifies the
 * ISIN/symbol creation paths: one shape, `kind` (and, for `BUY`, whether
 * `settlement` is present) decides which fields are required, with a
 * per-field error for the wrong ones given the `kind` — mirroring
 * `transaction`'s own per-kind `CHECK` constraints
 * (`platform/db/src/schema/transaction.ts`), not duplicating a different rule
 * from them.
 */
export const createTransactionBodySchema = z
  .object({
    kind: transferInNotCreatable,
    portfolioId: z.uuid(),
    tradeDate: isoDateSchema,
    tradeTs: isoInstantAsDate.optional(),
    note: z.string().max(2000).optional(),
    /** The user's own reference for this transaction — optional for every kind, and part of no per-kind rule below. See {@link transactionReferenceSchema}. */
    reference: transactionReferenceSchema.optional(),

    // BUY / SELL / DIVIDEND / DRIP / SHARE_DISTRIBUTION; optional on a FEE,
    // where it is a reference only (`portfolio-cash` PC-L14).
    instrumentId: z.uuid().optional(),

    // BUY / SELL / DRIP / SHARE_DISTRIBUTION (quantity), fiat-settled trade
    // leg (unitPrice + currency), or a BUY's asset-settled leg (settlement)
    // instead.
    quantity: positiveDecimal("quantity").optional(),
    unitPrice: positiveDecimal("unitPrice").optional(),
    settlement: settlementBodySchema.optional(),

    // The principal cash leg — trade currency (BUY/SELL/DRIP), the moved
    // amount (DEPOSIT/WITHDRAWAL/DIVIDEND/CURRENCY_EXCHANGE)'s currency, or
    // the source currency of a CURRENCY_EXCHANGE.
    currency: currencyCodeSchema.optional(),
    /** DEPOSIT/WITHDRAWAL/DIVIDEND/CURRENCY_EXCHANGE's moved amount, in `currency` — or a SHARE_DISTRIBUTION's market value, which moves nothing. */
    amount: positiveDecimal("amount").optional(),
    /**
     * The `cash_account` the principal leg's money moved through (CA-11,
     * FR-156). Optional *in the object shape only* — the `superRefine` below
     * requires it for every kind with a fiat principal leg and forbids it
     * when `settlement` is present (FR-157), which is a per-kind rule
     * `z.object` cannot express.
     */
    cashAccountId: z.uuid().optional(),
    /**
     * The settling account's **own denomination** for the principal cash leg
     * (FR-230/FR-255).
     * **Omitted is the degenerate case** — settlement currency = `currency`,
     * settled amount = the gross — which is why every pre-cycle caller (the
     * importer's `apply.ts`, every e2e fixture, `load/src/seed-fixture.ts`'s
     * HTTP paths) keeps working unchanged and produces a byte-identical row
     * (AC-278). Supplied, it is what makes a USD trade settled from the
     * portfolio's only account — a EUR one — expressible at all.
     */
    cashCurrency: currencyCodeSchema.optional(),
    /**
     * How much of `cashCurrency` actually moved. Omitted is the degenerate
     * case; **derived by the server in D4** (the account is denominated in
     * the tenant's base currency, so the figure is `gross x fx_rate` and the
     * row already carries both factors — L11), which is why supplying it
     * there is a `CASH_AMOUNT_NOT_ACCEPTED`, not a silent overwrite. The
     * shape rule this schema *can* express is the pairing one below; which
     * of D1–D5 applies needs the tenant's base currency, which lives on
     * another table (P22) and never reaches this layer.
     */
    cashAmount: positiveDecimal("cashAmount").optional(),

    /** The principal leg's user-pinned rate (FR-56/FR-57) — never how `PATCH /transactions/:id/fx-rate`'s *correction* is issued (that is a distinct endpoint, over an existing row). */
    fxRateUserInput: positiveDecimal("fxRateUserInput").optional(),

    // CURRENCY_EXCHANGE only.
    targetCurrency: currencyCodeSchema.optional(),
    exchangeRate: positiveDecimal("exchangeRate").optional(),
    /** The `cash_account` the target currency arrived in — CURRENCY_EXCHANGE only, and independent of `cashAccountId` (AC-176). */
    targetCashAccountId: z.uuid().optional(),

    // DIVIDEND and INTEREST.
    withholding: withholdingBodySchema.optional(),

    // DRIP only (AC6).
    sourceDividendId: z.uuid().optional(),

    // BUY / SELL / DRIP / CURRENCY_EXCHANGE.
    fee: feeBodySchema.optional(),

    /**
     * TRANSFER_OUT only (`security-transfer` FR-575, OD-4 (a)): the portfolio
     * the units arrive in. Absent is a transfer out of Kerdial altogether
     * (FR-566) — the source leg is written alone. Never the source portfolio
     * itself (FR-577), which is a rule on this field below, so the web form and
     * the server refuse it with this one schema object.
     */
    destinationPortfolioId: z.uuid().optional(),
  })
  .superRefine((data, ctx) => {
    const require = (condition: boolean, field: string, message: string) => {
      if (!condition) ctx.addIssue({ code: "custom", path: [field], message });
    };
    const forbid = (value: unknown, field: string, reason: string) => {
      if (value !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is not allowed ${reason}`,
        });
      }
    };

    // Already refused on `kind` by `transferInNotCreatable`. Every rule below
    // is about a body this endpoint could write; running them for a kind it
    // never writes would bury that one issue under several that do not apply.
    //
    // The widening cast is load-bearing: the refinement's inferred type
    // predicate removes `TRANSFER_IN` from `data.kind`'s static type, but a
    // failed refinement does not abort, so this rule still sees one at runtime.
    if ((data.kind as TransactionKind) === "TRANSFER_IN") return;

    if (data.kind === "BUY" || data.kind === "SELL") {
      require(data.instrumentId !==
        undefined, "instrumentId", `instrumentId is required for a ${data.kind}`);
      require(data.quantity !== undefined, "quantity", `quantity is required for a ${data.kind}`);
      forbid(data.amount, "amount", "for a BUY/SELL (quantity x unitPrice derives the money leg)");
      forbid(data.targetCurrency, "targetCurrency", "for a BUY/SELL");
      forbid(data.exchangeRate, "exchangeRate", "for a BUY/SELL");
      forbid(data.withholding, "withholding", "for a BUY/SELL");
      forbid(
        data.sourceDividendId,
        "sourceDividendId",
        "for a BUY/SELL (that is a DRIP field, AC6)",
      );

      if (data.settlement !== undefined) {
        require(data.kind ===
          "BUY", "settlement", "an asset-settled trade is only representable as a BUY (FR-66/AC52) — record the other side as a settled BUY of the asset received, not a settled SELL");
        forbid(
          data.unitPrice,
          "unitPrice",
          "when settlement is present (unitPrice is derived: settlement.amount / quantity)",
        );
        forbid(
          data.currency,
          "currency",
          "when settlement is present (the trade settles in an asset, not a fiat currency)",
        );
        forbid(
          data.fxRateUserInput,
          "fxRateUserInput",
          "when settlement is present (pin the rate on settlement.fxRateUserInput instead)",
        );
      } else {
        require(data.unitPrice !==
          undefined, "unitPrice", "unitPrice is required unless settlement is present");
        require(data.currency !==
          undefined, "currency", "currency is required unless settlement is present");
      }
    } else {
      // DIVIDEND, DRIP and SHARE_DISTRIBUTION all carry an `instrumentId` leg
      // (validated in their own per-kind blocks below); only DEPOSIT/
      // WITHDRAWAL/CURRENCY_EXCHANGE/INTEREST have no instrument leg at all.
      // A TRANSFER_OUT moves units of one instrument too (`security-transfer`),
      // and so is excluded from the first two refusals below. A FEE
      // has no instrument *leg* but may name one as a reference
      // (`portfolio-cash` PC-L14) — excluded from the first
      // refusal only; without that exclusion every FEE with an instrument
      // would be a 400.
      const movesUnits = data.kind === "SHARE_DISTRIBUTION" || data.kind === "TRANSFER_OUT";
      if (data.kind !== "DIVIDEND" && data.kind !== "DRIP" && data.kind !== "FEE" && !movesUnits) {
        forbid(data.instrumentId, "instrumentId", `for a ${data.kind}`);
      }
      // A DRIP and a SHARE_DISTRIBUTION both move units; only the DRIP has a
      // price for them, which is the whole difference between reinvesting a
      // dividend and receiving free shares.
      if (data.kind !== "DRIP" && !movesUnits) {
        forbid(data.quantity, "quantity", `for a ${data.kind}`);
      }
      // SHARE_DISTRIBUTION and TRANSFER_OUT are excluded here and refused in
      // their own blocks below, with a message that says what to do instead —
      // two `forbid`s on one path would raise the same rejection twice, and a
      // duplicated issue renders as a duplicated error under the same control.
      if (data.kind !== "DRIP" && !movesUnits) {
        forbid(data.unitPrice, "unitPrice", `for a ${data.kind}`);
      }
      forbid(data.settlement, "settlement", `for a ${data.kind} (only a BUY may be asset-settled)`);
      if (data.kind !== "DRIP") {
        forbid(
          data.sourceDividendId,
          "sourceDividendId",
          `for a ${data.kind} (that is a DRIP field, AC6)`,
        );
      }
    }

    if (data.kind === "DEPOSIT" || data.kind === "WITHDRAWAL") {
      require(data.amount !== undefined, "amount", `amount is required for a ${data.kind}`);
      require(data.currency !== undefined, "currency", `currency is required for a ${data.kind}`);
      forbid(data.targetCurrency, "targetCurrency", `for a ${data.kind}`);
      forbid(data.exchangeRate, "exchangeRate", `for a ${data.kind}`);
      forbid(data.withholding, "withholding", `for a ${data.kind}`);
      forbid(data.fee, "fee", `for a ${data.kind} (not a supported leg for cash movements)`);
    }

    if (data.kind === "DIVIDEND") {
      require(data.instrumentId !==
        undefined, "instrumentId", "instrumentId is required for a DIVIDEND");
      require(data.amount !==
        undefined, "amount", "amount is required for a DIVIDEND (the gross amount)");
      require(data.currency !== undefined, "currency", "currency is required for a DIVIDEND");
      forbid(data.targetCurrency, "targetCurrency", "for a DIVIDEND");
      forbid(data.exchangeRate, "exchangeRate", "for a DIVIDEND");
      forbid(data.fee, "fee", "for a DIVIDEND (not a supported leg for a dividend receipt)");
    }

    /**
     * **Interest earned on cash** (`cash-interest`). DEPOSIT's
     * shape — the instrument, quantity, price, settlement, DRIP link, target
     * account and destination are refused by the shared rules, and the cash
     * account is required by the attribution block — plus DIVIDEND's
     * optional `withholding` (one amount). Whether it stays below the
     * principal cash amount is decided by `TransactionWriteService`, which
     * knows the settling account's currency.
     */
    if (data.kind === "INTEREST") {
      require(data.amount !==
        undefined, "amount", "amount is required for an INTEREST (the gross interest)");
      require(data.currency !== undefined, "currency", "currency is required for an INTEREST");
      forbid(data.targetCurrency, "targetCurrency", "for an INTEREST");
      forbid(data.exchangeRate, "exchangeRate", "for an INTEREST");
      forbid(
        data.fee,
        "fee",
        "for an INTEREST (a fee is not a supported leg for interest received)",
      );
    }

    /**
     * **A standalone portfolio fee** (`portfolio-cash`).
     * WITHDRAWAL's shape — the quantity, price, settlement, DRIP link, target
     * account and destination are refused by the shared rules, and the cash
     * account is required by the attribution block. `instrumentId` is
     * optional (a reference only). No `fee` and no `withholding`: the FEE
     * amount *is* the fee.
     */
    if (data.kind === "FEE") {
      require(data.amount !==
        undefined, "amount", "amount is required for a FEE (the amount debited)");
      require(data.currency !== undefined, "currency", "currency is required for a FEE");
      forbid(data.targetCurrency, "targetCurrency", "for a FEE");
      forbid(data.exchangeRate, "exchangeRate", "for a FEE");
      forbid(data.withholding, "withholding", "for a FEE");
      forbid(
        data.fee,
        "fee",
        "for a FEE (a fee is not a supported leg for a portfolio fee — the FEE amount is the fee)",
      );
    }

    if (data.kind === "DRIP") {
      require(data.instrumentId !==
        undefined, "instrumentId", "instrumentId is required for a DRIP");
      require(data.sourceDividendId !==
        undefined, "sourceDividendId", "sourceDividendId is required for a DRIP (AC6)");
      require(data.quantity !== undefined, "quantity", "quantity is required for a DRIP");
      require(data.unitPrice !== undefined, "unitPrice", "unitPrice is required for a DRIP");
      require(data.currency !== undefined, "currency", "currency is required for a DRIP");
      forbid(data.amount, "amount", "for a DRIP (quantity x unitPrice derives the money leg)");
      forbid(data.targetCurrency, "targetCurrency", "for a DRIP");
      forbid(data.exchangeRate, "exchangeRate", "for a DRIP");
      forbid(data.withholding, "withholding", "for a DRIP");
    }

    /**
     * **The cashless kind.** Two required figures — the units
     * and what they were worth — and a list of refusals that is the whole
     * point of the kind: it has no price, no settling account and no cost.
     *
     * `amount` carries the **market value** here, the same field a DIVIDEND
     * uses for its gross: it is stored as `gross_amount`, satisfying its
     * `> 0` CHECK honestly, and contributes nothing to the cost basis. The
     * account rules live with the other cash-attribution rules below, where
     * that pair belongs.
     */
    if (data.kind === "SHARE_DISTRIBUTION") {
      require(data.instrumentId !==
        undefined, "instrumentId", "instrumentId is required for a SHARE_DISTRIBUTION");
      require(data.quantity !==
        undefined, "quantity", "quantity is required for a SHARE_DISTRIBUTION (the number of shares distributed)");
      require(data.amount !==
        undefined, "amount", "amount is required for a SHARE_DISTRIBUTION (what the distributed shares were worth on the trade date)");
      require(data.currency !==
        undefined, "currency", "currency is required for a SHARE_DISTRIBUTION (what the market value is denominated in)");
      forbid(
        data.unitPrice,
        "unitPrice",
        "for a SHARE_DISTRIBUTION (free shares have no price per unit — supply the distribution's market value as amount)",
      );
      forbid(data.targetCurrency, "targetCurrency", "for a SHARE_DISTRIBUTION");
      forbid(data.exchangeRate, "exchangeRate", "for a SHARE_DISTRIBUTION");
      forbid(data.withholding, "withholding", "for a SHARE_DISTRIBUTION");
      forbid(
        data.fee,
        "fee",
        "for a SHARE_DISTRIBUTION (a cost is denominated by the settling account, and this kind has none)",
      );
    }

    /**
     * **A security transfer's source leg** (`security-transfer`).
     * The `SHARE_DISTRIBUTION` shape — units and what they were worth, no
     * price, no account, no cost — and every refusal here is backed by
     * `transaction_transfer_out_shape` (migration `0070`), so a forbidden
     * field is a per-field 400 rather than a bare `23514`. `settlement`,
     * `sourceDividendId` and `targetCashAccountId` are refused by the shared
     * rules above and below; the cash-account trio by the attribution block.
     *
     * `amount` is the **market value** (FR-576, L3): the flow each portfolio's
     * performance sees, never the cost that moves — the replay computes that.
     */
    if (data.kind === "TRANSFER_OUT") {
      require(data.instrumentId !==
        undefined, "instrumentId", "instrumentId is required for a TRANSFER_OUT");
      require(data.quantity !==
        undefined, "quantity", "quantity is required for a TRANSFER_OUT (the number of units transferred)");
      require(data.amount !==
        undefined, "amount", "amount is required for a TRANSFER_OUT (what the transferred units were worth on the trade date)");
      require(data.currency !==
        undefined, "currency", "currency is required for a TRANSFER_OUT (what the market value is denominated in)");
      forbid(
        data.unitPrice,
        "unitPrice",
        "for a TRANSFER_OUT (a transfer has no price per unit — supply the transferred units' market value as amount)",
      );
      forbid(data.targetCurrency, "targetCurrency", "for a TRANSFER_OUT");
      forbid(data.exchangeRate, "exchangeRate", "for a TRANSFER_OUT");
      forbid(data.withholding, "withholding", "for a TRANSFER_OUT");
      forbid(data.fee, "fee", "for a TRANSFER_OUT (no money moves, so no account bears a cost)");
      // FR-577 / AC-459: on the destination field, so the form shows it under
      // the control the user has to change. Lowercased: `z.uuid()`
      // keeps an uppercase id as sent, and Postgres reads both spellings as
      // one portfolio.
      if (
        data.destinationPortfolioId !== undefined &&
        data.destinationPortfolioId.toLowerCase() === data.portfolioId.toLowerCase()
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["destinationPortfolioId"],
          message:
            "destinationPortfolioId must differ from portfolioId (a transfer moves units between two portfolios — FR-577)",
        });
      }
    } else {
      forbid(
        data.destinationPortfolioId,
        "destinationPortfolioId",
        `for a ${data.kind} (only a TRANSFER_OUT names a destination portfolio)`,
      );
    }

    if (data.kind === "CURRENCY_EXCHANGE") {
      require(data.amount !== undefined, "amount", "amount is required for a CURRENCY_EXCHANGE");
      require(data.currency !==
        undefined, "currency", "currency is required for a CURRENCY_EXCHANGE");
      require(data.targetCurrency !==
        undefined, "targetCurrency", "targetCurrency is required for a CURRENCY_EXCHANGE (FR-59)");
      require(data.exchangeRate !==
        undefined, "exchangeRate", "exchangeRate is required for a CURRENCY_EXCHANGE (FR-59)");
      if (
        data.currency !== undefined &&
        data.targetCurrency !== undefined &&
        data.currency === data.targetCurrency
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["targetCurrency"],
          message:
            "targetCurrency must differ from currency (a CURRENCY_EXCHANGE converts between two different currencies)",
        });
      }
      forbid(data.withholding, "withholding", "for a CURRENCY_EXCHANGE");
    }

    // ---------------------------------------------------------------------
    // Cash-account attribution (CA-11; FR-156/FR-157, AC-176). Stated once here, after the per-kind blocks
    // above, rather than a `require` scattered into each of them: the rule is
    // "every leg that moves cash names the account it moved it in", and the
    // one exception is structural (`settlement`), not per-kind.
    if (data.kind === "BUY" && data.settlement !== undefined) {
      // FR-157: the principal leg settles in an asset, so it moves no cash.
      // `transaction_settled_principal_has_no_cash_account` (migration
      // `0038`) is the database backstop; this is the 400 that keeps the
      // request from ever reaching it. A fee on the same row still carries
      // one — `feeBodySchema.cashAccountId` is unconditionally required.
      forbid(
        data.cashAccountId,
        "cashAccountId",
        "when settlement is present (an asset-settled principal leg moves no cash — FR-157/AC-177; attach the account to the fee leg if a fee was paid)",
      );
    } else if (data.kind === "SHARE_DISTRIBUTION" || data.kind === "TRANSFER_OUT") {
      // A SHARE_DISTRIBUTION is the one kind with a fiat denomination and **no money leg
      // at all**. `transaction_share_distribution_shape` forbids all three cash
      // columns at the database, and `0056` exempts this kind from
      // `transaction_fiat_principal_has_cash_account` for the same reason —
      // these are the per-field 400s that keep a body from reaching either as
      // a bare `23514`. A TRANSFER_OUT is the same shape for the same reason
      // (`transaction_transfer_out_shape`, migration `0070`).
      forbid(
        data.cashAccountId,
        "cashAccountId",
        `for a ${data.kind} (no money moves, so no account settles it)`,
      );
      forbid(
        data.cashCurrency,
        "cashCurrency",
        `for a ${data.kind} (no money moves, so there is no settlement currency)`,
      );
      forbid(
        data.cashAmount,
        "cashAmount",
        `for a ${data.kind} (no money moves, so there is no settled amount)`,
      );
    } else {
      require(data.cashAccountId !==
        undefined, "cashAccountId", `cashAccountId is required for a ${data.kind} (FR-156: the leg that moves cash names the account it moved it in)`);
    }

    if (data.kind === "CURRENCY_EXCHANGE") {
      require(data.targetCashAccountId !==
        undefined, "targetCashAccountId", "targetCashAccountId is required for a CURRENCY_EXCHANGE (AC-176: the target leg's account is independent of the source's)");
    } else {
      forbid(
        data.targetCashAccountId,
        "targetCashAccountId",
        `for a ${data.kind} (only a CURRENCY_EXCHANGE has a target cash leg)`,
      );
    }

    // ---------------------------------------------------------------------
    // The principal cash leg's own denomination (FR-255). Three rules, and
    // **not** a fourth one deciding which of D1–D5 applies: that needs the
    // tenant's base currency, which lives on `tenant` (P22) and never
    // reaches this layer — `TransactionWriteService.#resolveCashLeg` owns
    // it, and the database is the guarantee.
    //
    // Stated here, after the per-kind blocks and beside the cash-account
    // rule the pair belongs to, for the same reason that one is: the rule is
    // about the leg, not about the kind.

    // (1) The pairing rule, and it runs in **one** direction only.
    //
    // An amount with no currency names no movement: it is the pairing
    // violation migration `0045`'s `transaction_cash_amount_currency_pairing`
    // refuses, and `#resolveCashLeg`'s own first row refuses before any DB
    // round trip (`UNPAIRED_WITHOUT_CURRENCY`). The issue goes on
    // `cashCurrency`, the missing half, because
    // `web/src/lib/transaction-form-payload.ts`'s `ISSUE_PATH_TO_FIELD`
    // routes it from there onto the account picker — the control that
    // *determines* the settlement currency (FR-257(1)).
    //
    // **A currency with no amount is not a violation, and requiring one here
    // would make the feature's own case unreachable.** In D4 — the settling
    // account denominated in the tenant's base currency — the settled amount
    // *is* `gross x fx_rate`, the server derives it, and a supplied one is
    // rejected outright (L11, `CashAmountNotAcceptedError` /
    // `DERIVED_IN_BASE_CURRENCY`). That is AC-257's own write: a EUR account,
    // a USD trade, an EUR-base tenant. Which of D1–D5 applies is decidable
    // only where `tenant.base_currency` is readable (P22) — not here — so
    // this layer accepts the currency alone and `#resolveCashLeg` either
    // derives the amount (D4) or demands it (D3/D5, `CashAmountRequiredError`
    // -> `400 CASH_AMOUNT_REQUIRED`).
    if (data.cashAmount !== undefined) {
      require(data.cashCurrency !==
        undefined, "cashCurrency", "cashCurrency is required when cashAmount is supplied (an amount with no currency names no movement — FR-255)");
    }

    // (2) FR-236: an asset-settled principal leg moves no cash, so it has no
    // settlement currency and no settled amount — the same sentence, and the
    // same `forbid(...)` idiom, as `cashAccountId` just above.
    if (data.kind === "BUY" && data.settlement !== undefined) {
      forbid(
        data.cashCurrency,
        "cashCurrency",
        "when settlement is present (an asset-settled principal leg moves no cash — FR-236)",
      );
      forbid(
        data.cashAmount,
        "cashAmount",
        "when settlement is present (an asset-settled principal leg moves no cash — FR-236)",
      );
    }

    // (3) FR-235's client-side twin. A CURRENCY_EXCHANGE's settlement figures
    // are pinned to the degenerate pair by
    // `transaction_currency_exchange_cash_leg_pinned` (migration `0045`) —
    // the database is the guarantee, and this is the per-field 400 that keeps
    // a contradicting body from reaching it as a bare `23514`. The degenerate
    // pair itself is accepted, so a client that fills both fields uniformly
    // is not forced to special-case this kind.
    if (data.kind === "CURRENCY_EXCHANGE") {
      if (
        data.cashCurrency !== undefined &&
        data.currency !== undefined &&
        data.cashCurrency !== data.currency
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["cashCurrency"],
          message:
            "cashCurrency must equal currency for a CURRENCY_EXCHANGE (its source leg is settled in its own currency — FR-235)",
        });
      }
      if (
        data.cashAmount !== undefined &&
        data.amount !== undefined &&
        !data.cashAmount.equals(data.amount)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["cashAmount"],
          message:
            "cashAmount must equal amount for a CURRENCY_EXCHANGE (its source leg moves exactly the amount it converts — FR-235)",
        });
      }
    }
  });

export type CreateTransactionBody = z.infer<typeof createTransactionBodySchema>;
