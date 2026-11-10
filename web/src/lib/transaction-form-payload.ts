import type { FieldErrors, Resolver } from "react-hook-form";
import { createTransactionBodySchema, type TransactionKind } from "@kerdial/api-contracts";

/**
 * The transaction entry form's pure half — extracted from
 * `components/TransactionForm.tsx` so the wire-payload
 * construction and the shared-Zod-schema resolver have a renderer-free home:
 * the form's values shape, its defaults, the per-kind request-body builder
 * (AC48/AC52) and the hand-written react-hook-form resolver that validates
 * against the exact schema `api` validates `POST /transactions` against
 * (`createTransactionBodySchema`). The form component
 * itself keeps the orchestration and the field JSX.
 */

export const BASE_CURRENCY = "EUR";

export interface TransactionFormValues {
  kind: TransactionKind;
  portfolioId: string;
  tradeDate: string;
  /**
   * FR-T1/locked D1 Option A: `<input type="time">`'s own value shape
   * (`HH:mm`), **form-only** — never a wire field. Empty string means "no
   * time supplied", and `buildTransactionRequestPayload` then omits `tradeTs`
   * entirely, so a form the user never touched here submits exactly what it
   * submitted before this field existed. `tradeDate` stays required and stays
   * the sole FX-relevant date either way (NG3).
   */
  tradeTime: string;
  note: string;
  /**
   * The user's own reference for this transaction — a broker's
   * order number, a statement line. Optional for every kind, so the empty
   * string means "not supplied" exactly as it does for `note`, and
   * `buildTransactionRequestPayload` maps it through `trimmedOrUndefined`
   * to an omitted key rather than an empty one.
   */
  reference: string;

  instrumentId: string;
  quantity: string;
  unitPrice: string;
  currency: string;
  amount: string;
  fxRateUserInput: string;
  /**
   * CA-11/CA-20: the
   * `cash_account` each cash-moving leg names (FR-156). One field per leg, not
   * one for the row, because a single transaction can move cash in up to four
   * currencies and an account holds exactly one (CD1).
   *
   * Empty string means "not supplied": `buildTransactionRequestPayload` maps
   * that to `undefined`, so the shared schema's own per-kind `require`/`forbid`
   * rules decide, exactly as they already do for `currency`.
   */
  cashAccountId: string;
  /**
   * FT-17 (FR-255):
   * the principal cash leg's own denomination, and how much of it moved.
   *
   * `cashCurrency` is **derived, not typed** — it is the chosen account's own
   * currency, read off the picker's already-loaded list (FR-257(3), FT-21) —
   * which is why an issue on it routes to `cashAccountId` in
   * {@link ISSUE_PATH_TO_FIELD} below rather than to a control of its own,
   * exactly as `tradeTs` routes to `tradeTime`.
   *
   * Both empty is the degenerate case: `buildTransactionRequestPayload` then
   * emits neither key, so a form nobody touched here submits byte-for-byte
   * what it submitted before these fields existed (AC-278).
   */
  cashCurrency: string;
  /** See {@link TransactionFormValues.cashCurrency} — the settled amount, in that currency. Typed by the user in D3/D5, derived and read-only in D4 (FT-21). */
  cashAmount: string;

  targetCurrency: string;
  exchangeRate: string;
  /** CURRENCY_EXCHANGE only, and independent of `cashAccountId` (AC-176). */
  targetCashAccountId: string;

  /**
   * The withholding of a DIVIDEND/INTEREST, one amount in the settling
   * cash account's currency — no currency, rate or account of its own.
   */
  withholdingAmount: string;

  sourceDividendId: string;

  feeAmount: string;
  /**
   * **FR-223: the four optional cost components.** On BUY/SELL/DRIP, Courtage
   * and Taxes are essential fields (with their rate chips) and Frais de change
   * and Autres frais sit under « Plus d'options »; the total shown beside them
   * is derived and never written to `feeAmount`, so the body carries the
   * components alone (`transaction-dialog-refresh` TDR-L11). On
   * CURRENCY_EXCHANGE all four are under « Plus d'options », beside its
   * editable total. Each empty string means "not supplied", and FR-213 makes
   * that a different statement from "supplied as zero" — a zero is rejected
   * by the shared schema rather than stored.
   *
   * `feeCurrency` and `feeCashAccountId` were fields here until the cost rework.
   * A cost is denominated by the settling account (L5) and leaves the account
   * that settled the trade, so there is nothing left for the user to choose —
   * which is why the two controls are gone rather than disabled, and root spec
   * The D2/D3/D4 locks go with them.
   */
  feeBrokerFee: string;
  feeFxFee: string;
  feeTax: string;
  feeOther: string;

  /** BUY only (FR-66/AC52): toggles the asset-settled leg on, replacing `unitPrice`/`currency`/`fxRateUserInput` with `settlementInstrumentId`/`settlementAmount`/`settlementFxRateUserInput`. */
  settlementEnabled: boolean;
  settlementInstrumentId: string;
  settlementAmount: string;
  /** `settlement.fxRateUserInput` — pins the settlement asset's *quote* to base currency (a `CryptoRateResolver` input, not an `FxRateResolver` one), never sent unless `settlementEnabled`. */
  settlementFxRateUserInput: string;
  /**
   * Display-only (never sent to the API): the selected settlement
   * instrument's own symbol/ISIN, captured off `InstrumentPicker`'s
   * `onChange` purely so `FxDirectionLabel` can label
   * `settlementFxRateUserInput`'s direction ("1 BTC = ___ EUR") — a
   * settlement asset is not a currency, so it cannot be read back out of
   * `settlementInstrumentId` (a UUID) the way `currency`/`targetCurrency`
   * are for the fiat legs.
   */
  settlementInstrumentSymbol: string;
  /**
   * TRANSFER_OUT only (`security-transfer` FR-575, OD-4 (a)): the portfolio the
   * units arrive in. Empty means none — the units leave Kerdial, and only the
   * source leg is recorded (FR-566).
   */
  destinationPortfolioId: string;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function defaultTransactionFormValues(): TransactionFormValues {
  // FR-T2/locked D2 Option A:
  // the fee currency is seeded from the form's *own* initial transaction
  // currency, once, here — read from this local rather than repeating
  // `BASE_CURRENCY`, so the two cannot drift into disagreeing about what "the
  // transaction currency at mount" was. Deliberately **not** live-synced: no
  // `onChange`/`watch` side effect re-mirrors it when the user later changes
  // `currency` (that is D2 Option B, which was not locked), so this is a plain
  // default the user can freely override (FR-T2.2). Per locked D4 the source
  // is the principal `currency` for every kind, CURRENCY_EXCHANGE included —
  // never `targetCurrency`.
  const initialCurrency = BASE_CURRENCY;
  return {
    kind: "BUY",
    portfolioId: "",
    tradeDate: todayIsoDate(),
    tradeTime: "",
    note: "",
    reference: "",
    instrumentId: "",
    quantity: "",
    unitPrice: "",
    currency: initialCurrency,
    amount: "",
    fxRateUserInput: "",
    cashAccountId: "",
    cashCurrency: "",
    cashAmount: "",
    targetCurrency: "",
    exchangeRate: "",
    targetCashAccountId: "",
    withholdingAmount: "",
    sourceDividendId: "",
    feeAmount: "",
    feeBrokerFee: "",
    feeFxFee: "",
    feeTax: "",
    feeOther: "",
    settlementEnabled: false,
    settlementInstrumentId: "",
    settlementAmount: "",
    settlementFxRateUserInput: "",
    settlementInstrumentSymbol: "",
    destinationPortfolioId: "",
  };
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * FR-T1/locked D1 Option A: the
 * optional `tradeTime` combined with the required `tradeDate` into the ISO
 * instant `createTransactionBodySchema.tradeTs` (`isoInstantAsDate`) accepts —
 * `undefined` whenever no time was supplied, so the payload of a form nobody
 * touched here is byte-for-byte what it was before this field existed
 * (AC-T1a).
 *
 * The conversion is deliberately the *same expression*
 * `TransactionEditForm.buildTransactionEditBody` already submits its own
 * `tradeTs` with (`new Date(<local date-time>).toISOString()`), not a new
 * convention: a date-*time* string carrying no offset is parsed as **local**
 * time by ECMAScript, so `.toISOString()` is exactly the local-to-UTC
 * conversion the edit form performs, and a time captured here round-trips
 * back into that form's `datetime-local` input unchanged (FR-T1.4/AC-T1d).
 *
 * The finiteness guard is the one thing this adds over the edit form's line,
 * and it is not defensive decoration: the create form's date and time are two
 * separate controls (D1 Option A), so `tradeDate` can be blank while
 * `tradeTime` is not — `new Date("T09:30")` is an Invalid Date and
 * `toISOString()` *throws* on one, which inside `transactionFormResolver`
 * would surface as a crashed submit rather than the schema's own "tradeDate
 * is required" message.
 *
 * Note what this does **not** do (NG3): it never touches `tradeDate`.
 * Whatever the user puts in the time field, the `tradeDate` in the payload is
 * the one they picked, so the `fx_rate_daily` row `FxRateResolver` pins is
 * unaffected (AC-T1c).
 */
function buildTradeTs(values: TransactionFormValues): string | undefined {
  const date = trimmedOrUndefined(values.tradeDate);
  const time = trimmedOrUndefined(values.tradeTime);
  if (date === undefined || time === undefined) return undefined;
  const instant = new Date(`${date}T${time}`);
  if (!Number.isFinite(instant.getTime())) return undefined;
  return instant.toISOString();
}

/** The four component fields, paired with the wire key each one carries. One list, so a fifth cannot be added to the form without appearing on the wire. */
const FEE_COMPONENT_FIELDS = [
  ["brokerFee", "feeBrokerFee"],
  ["fxFee", "feeFxFee"],
  ["tax", "feeTax"],
  ["other", "feeOther"],
] as const;

/**
 * **The `fee` object, after L5/L6** (FR-223).
 *
 * A leg exists when the user typed a total **or** at least one component.
 * `feeCurrency`/`feeCashAccountId` used to be part of that test and are gone
 * with their controls: nothing is left for the user to say about a cost except
 * how much it was and, optionally, what it was made of.
 *
 * **`components` is omitted entirely when nothing was typed into the
 * component fields — never `{}`.** `costComponentsSchema` rejects an all-absent
 * object by design ("at least one component when present"), so an empty object
 * would turn every unitemised entry into a 400. That is the assertion FR-223's
 * "an unitemised entry costs exactly what it costs today" rests on.
 *
 * Unchanged by `transaction-dialog-refresh` (C-2): on BUY, SELL
 * and DRIP the form holds `feeAmount` empty, so the body is
 * `{ components: { … } }` with no `amount`, and the server sums the
 * components into the stored `fee_amount`.
 */
function buildFeeBody(
  values: TransactionFormValues,
): { amount?: string; components?: Record<string, string> } | undefined {
  const amount = trimmedOrUndefined(values.feeAmount);
  const components: Record<string, string> = {};
  for (const [key, field] of FEE_COMPONENT_FIELDS) {
    const value = trimmedOrUndefined(values[field]);
    if (value !== undefined) components[key] = value;
  }
  const itemised = Object.keys(components).length > 0;
  if (amount === undefined && !itemised) return undefined;
  return {
    ...(amount === undefined ? {} : { amount }),
    ...(itemised ? { components } : {}),
  };
}

/** `{ amount }` — denominated by the settling account, so nothing else to send; omitted while blank (FR-668). */
function buildWithholdingBody(values: TransactionFormValues): { amount: string } | undefined {
  const amount = trimmedOrUndefined(values.withholdingAmount);
  return amount === undefined ? undefined : { amount };
}

/**
 * FT-17: the principal cash leg's settlement pair, on the six kinds whose
 * principal leg moves cash in an account that may be denominated differently
 * from the trade.
 *
 * Two things it deliberately does not do. It **omits both keys** when the
 * form carries neither, rather than setting them to `undefined` — the
 * degenerate case is an absent key (AC-278), and `createTransactionBodySchema`
 * treats the pair as supplied-together, so emitting one alone is a per-field
 * 400 the form renders rather than something to paper over here. And it is
 * **not called for a CURRENCY_EXCHANGE**: FR-235 pins that kind's figures to
 * the degenerate pair at the database, so the form has nothing to say about
 * them; nor for an asset-settled BUY, whose principal leg moves no cash at
 * all (FR-236) and whose branch above sets no `cashAccountId` either.
 */
function setCashLeg(body: Record<string, unknown>, values: TransactionFormValues): void {
  const currency = trimmedOrUndefined(values.cashCurrency);
  const amount = trimmedOrUndefined(values.cashAmount);
  if (currency === undefined && amount === undefined) return;
  body["cashCurrency"] = currency;
  body["cashAmount"] = amount;
}

/**
 * The raw, pre-`zDecimal`-transform request body (every decimal a JSON
 * string) — exported for its own unit tests. `kind`
 * (and, for `BUY`, `settlementEnabled`) decides which keys are even set,
 * which is what keeps a CURRENCY_EXCHANGE's payload free of any instrument
 * field (AC48) and a crypto-to-crypto BUY's payload a single object with
 * both the instrument and settlement legs (AC52) — never two payloads / two
 * calls.
 */
export function buildTransactionRequestPayload(
  values: TransactionFormValues,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kind: values.kind,
    portfolioId: trimmedOrUndefined(values.portfolioId),
    tradeDate: trimmedOrUndefined(values.tradeDate),
    tradeTs: buildTradeTs(values),
    note: trimmedOrUndefined(values.note),
    // Beside `note` and above the `switch`: the reference belongs to
    // every kind and takes part in no per-kind rule, so it is set once here
    // rather than in eight branches.
    reference: trimmedOrUndefined(values.reference),
  };

  switch (values.kind) {
    case "BUY": {
      body["instrumentId"] = trimmedOrUndefined(values.instrumentId);
      body["quantity"] = trimmedOrUndefined(values.quantity);
      if (values.settlementEnabled) {
        body["settlement"] = {
          instrumentId: trimmedOrUndefined(values.settlementInstrumentId) ?? "",
          amount: trimmedOrUndefined(values.settlementAmount) ?? "",
          fxRateUserInput: trimmedOrUndefined(values.settlementFxRateUserInput),
        };
      } else {
        body["unitPrice"] = trimmedOrUndefined(values.unitPrice);
        body["currency"] = trimmedOrUndefined(values.currency);
        // FR-157: an asset-settled principal leg moves no cash, so the
        // account is set only on the fiat branch — never both.
        body["cashAccountId"] = trimmedOrUndefined(values.cashAccountId);
        setCashLeg(body, values);
        body["fxRateUserInput"] = trimmedOrUndefined(values.fxRateUserInput);
      }
      body["fee"] = buildFeeBody(values);
      break;
    }
    case "SELL": {
      body["instrumentId"] = trimmedOrUndefined(values.instrumentId);
      body["quantity"] = trimmedOrUndefined(values.quantity);
      body["unitPrice"] = trimmedOrUndefined(values.unitPrice);
      body["currency"] = trimmedOrUndefined(values.currency);
      body["cashAccountId"] = trimmedOrUndefined(values.cashAccountId);
      setCashLeg(body, values);
      body["fxRateUserInput"] = trimmedOrUndefined(values.fxRateUserInput);
      body["fee"] = buildFeeBody(values);
      break;
    }
    case "DEPOSIT":
    case "WITHDRAWAL": {
      body["amount"] = trimmedOrUndefined(values.amount);
      body["currency"] = trimmedOrUndefined(values.currency);
      body["cashAccountId"] = trimmedOrUndefined(values.cashAccountId);
      setCashLeg(body, values);
      body["fxRateUserInput"] = trimmedOrUndefined(values.fxRateUserInput);
      break;
    }
    case "DIVIDEND": {
      body["instrumentId"] = trimmedOrUndefined(values.instrumentId);
      body["amount"] = trimmedOrUndefined(values.amount);
      body["currency"] = trimmedOrUndefined(values.currency);
      body["cashAccountId"] = trimmedOrUndefined(values.cashAccountId);
      setCashLeg(body, values);
      body["fxRateUserInput"] = trimmedOrUndefined(values.fxRateUserInput);
      body["withholding"] = buildWithholdingBody(values);
      break;
    }
    case "INTEREST": {
      // `cash-interest`: DEPOSIT's keys plus DIVIDEND's optional
      // withholding — interest earned on cash names no instrument.
      body["amount"] = trimmedOrUndefined(values.amount);
      body["currency"] = trimmedOrUndefined(values.currency);
      body["cashAccountId"] = trimmedOrUndefined(values.cashAccountId);
      setCashLeg(body, values);
      body["fxRateUserInput"] = trimmedOrUndefined(values.fxRateUserInput);
      body["withholding"] = buildWithholdingBody(values);
      break;
    }
    case "DRIP": {
      body["instrumentId"] = trimmedOrUndefined(values.instrumentId);
      body["sourceDividendId"] = trimmedOrUndefined(values.sourceDividendId);
      body["quantity"] = trimmedOrUndefined(values.quantity);
      body["unitPrice"] = trimmedOrUndefined(values.unitPrice);
      body["currency"] = trimmedOrUndefined(values.currency);
      body["cashAccountId"] = trimmedOrUndefined(values.cashAccountId);
      setCashLeg(body, values);
      body["fxRateUserInput"] = trimmedOrUndefined(values.fxRateUserInput);
      body["fee"] = buildFeeBody(values);
      break;
    }
    case "SHARE_DISTRIBUTION": {
      // Four keys and no fifth: `amount` is the distribution's
      // market value, and **no `cashAccountId` and no `setCashLeg`** — this
      // is the one kind whose principal leg moves no cash at all, so a body
      // carrying either is a per-field 400 the shared schema raises rather
      // than something to send and let the database refuse.
      body["instrumentId"] = trimmedOrUndefined(values.instrumentId);
      body["quantity"] = trimmedOrUndefined(values.quantity);
      body["amount"] = trimmedOrUndefined(values.amount);
      body["currency"] = trimmedOrUndefined(values.currency);
      body["fxRateUserInput"] = trimmedOrUndefined(values.fxRateUserInput);
      break;
    }
    case "TRANSFER_OUT": {
      // `security-transfer`: SHARE_DISTRIBUTION's four keys — `amount` is
      // the transferred units' market value — plus the optional destination.
      // No account and no `setCashLeg`: no money moves.
      body["instrumentId"] = trimmedOrUndefined(values.instrumentId);
      body["quantity"] = trimmedOrUndefined(values.quantity);
      body["amount"] = trimmedOrUndefined(values.amount);
      body["currency"] = trimmedOrUndefined(values.currency);
      body["fxRateUserInput"] = trimmedOrUndefined(values.fxRateUserInput);
      body["destinationPortfolioId"] = trimmedOrUndefined(values.destinationPortfolioId);
      break;
    }
    case "FEE": {
      // `portfolio-cash`: WITHDRAWAL's keys plus the optional instrument
      // reference — the key is set only when one was chosen.
      body["amount"] = trimmedOrUndefined(values.amount);
      body["currency"] = trimmedOrUndefined(values.currency);
      body["cashAccountId"] = trimmedOrUndefined(values.cashAccountId);
      setCashLeg(body, values);
      body["fxRateUserInput"] = trimmedOrUndefined(values.fxRateUserInput);
      const instrumentId = trimmedOrUndefined(values.instrumentId);
      if (instrumentId !== undefined) body["instrumentId"] = instrumentId;
      break;
    }
    case "CURRENCY_EXCHANGE": {
      body["amount"] = trimmedOrUndefined(values.amount);
      body["currency"] = trimmedOrUndefined(values.currency);
      body["cashAccountId"] = trimmedOrUndefined(values.cashAccountId);
      body["targetCurrency"] = trimmedOrUndefined(values.targetCurrency);
      body["targetCashAccountId"] = trimmedOrUndefined(values.targetCashAccountId);
      body["exchangeRate"] = trimmedOrUndefined(values.exchangeRate);
      body["fee"] = buildFeeBody(values);
      break;
    }
  }

  return body;
}

/** Maps a `createTransactionBodySchema` issue path (dotted, server-shaped) to the flat `TransactionFormValues` field it should attach its error to. */
const ISSUE_PATH_TO_FIELD: Record<string, keyof TransactionFormValues> = {
  // FR-T1: `tradeTs` is derived, so it has no control of its own — an issue
  // on it belongs on the time field the user can actually act on, not on a
  // `errors.tradeTs` slot no JSX renders (the F2 wrong-slot class below).
  tradeTs: "tradeTime",
  settlement: "settlementInstrumentId",
  "settlement.instrumentId": "settlementInstrumentId",
  "settlement.amount": "settlementAmount",
  // F2 (security review, T-44): was mis-routed to
  // "settlementAmount" — a schema-level rejection of `settlement.fxRateUserInput`
  // (e.g. a non-positive pinned rate) must land on its own field's error
  // slot, not silently show up under the amount field instead.
  "settlement.fxRateUserInput": "settlementFxRateUserInput",
  withholding: "withholdingAmount",
  "withholding.amount": "withholdingAmount",
  // `withholding.currency`, `.cashAccountId` and `.fxRateUserInput` are
  // gone with their controls; the block is a strict object, so a body still
  // carrying one is an `unrecognized_keys` issue on `withholding`, which the
  // entry above routes to the amount field (the F2 wrong-slot class).
  fee: "feeAmount",
  "fee.amount": "feeAmount",
  // `fee.currency`, `fee.cashAccountId` and `fee.fxRateUserInput` were mapped
  // here until the cost rework; their controls are gone, so a mapping to them
  // would route an issue to a slot no JSX renders — the F2 wrong-slot class
  // this table exists to prevent. `feeBodySchema` is a `z.strictObject` now, so
  // a body still carrying one is an `unrecognized_keys` issue on `fee`, which
  // the entry above routes to the amount field the user can act on.
  "fee.components": "feeBrokerFee",
  "fee.components.brokerFee": "feeBrokerFee",
  "fee.components.fxFee": "feeFxFee",
  "fee.components.tax": "feeTax",
  "fee.components.other": "feeOther",
  // FT-17. `cashCurrency`
  // is **derived** — it is the currency of the account chosen in the principal
  // picker (FR-257(3)), not a control the user can type into — so its issues
  // belong on `cashAccountId`, the field they can act on. Same reasoning, and
  // the same wrong-slot class (F2), as `tradeTs` -> `tradeTime` at the top of
  // this table.
  cashCurrency: "cashAccountId",
  // …and `cashAmount` keeps its own slot: it is the settled-amount input, and
  // routing it to the gross-amount field would report "the amount your broker
  // debited is wrong" under the figure the user priced the trade at.
  cashAmount: "cashAmount",
};

function fieldNameForIssuePath(path: string): keyof TransactionFormValues {
  const mapped = ISSUE_PATH_TO_FIELD[path];
  if (mapped !== undefined) return mapped;
  return path as keyof TransactionFormValues;
}

/**
 * A hand-written `Resolver`, not `@hookform/resolvers`'s `zodResolver` — that
 * resolver hands `handleSubmit`'s `onValid` the *parsed* (`z.infer`) output,
 * i.e. `Decimal` instances where the wire body needs plain JSON strings.
 * Validation still runs against the exact same
 * `createTransactionBodySchema` `api` validates `POST /transactions` against
 * (T-44's shared-Zod-schema requirement) — this
 * resolver only changes *which* value `handleSubmit` receives on success
 * (the original raw form values, ready for `buildTransactionRequestPayload`),
 * never *whether* validation passes.
 */
export function transactionFormResolver(): Resolver<TransactionFormValues> {
  return async (values) => {
    const payload = buildTransactionRequestPayload(values);
    const result = createTransactionBodySchema.safeParse(payload);
    if (result.success) {
      return { values, errors: {} };
    }
    const errors: FieldErrors<TransactionFormValues> = {};
    for (const issue of result.error.issues) {
      // **`unrecognized_keys` names the object, not the key** (RF8). A `z.strictObject` reports every unknown key of one
      // object in a single issue whose path is the object's — `fee` — with the
      // offending names in `keys`. Routed as-is it would land on the fee
      // *amount*'s slot and tell the user nothing about which field to remove,
      // which is exactly the F2 wrong-slot class the table above exists for.
      // `api/src/common/zod-validate.ts` expands it the same way, so the two
      // boundaries report the same fields.
      const keys = (issue as { readonly keys?: readonly string[] }).keys;
      const paths =
        issue.code === "unrecognized_keys" && keys !== undefined && keys.length > 0
          ? keys.map((key) => [...issue.path, key].join("."))
          : [issue.path.join(".")];
      for (const path of paths) {
        const fieldName = fieldNameForIssuePath(path);
        if (errors[fieldName] === undefined) {
          errors[fieldName] = { type: issue.code, message: issue.message };
        }
      }
    }
    return { values: {}, errors };
  };
}
