import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import {
  Controller,
  useForm,
  type Control,
  type FieldErrors,
  type RefCallBack,
  type UseFormRegisterReturn,
} from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { TRANSACTION_COPY } from "../lib/copy/transactions.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { portfolioSelectOptions } from "../lib/portfolio-options.js";
import { Decimal, ROUNDING_MODE, parseDecimalString, toDecimalString } from "@kerdial/core-decimal";
import { createTransaction } from "../lib/api-client.js";
import {
  portfolioCashQueryOptions,
  portfolioHoldingsQueryOptions,
  portfoliosQueryOptions,
  ratePresetsQueryOptions,
} from "../lib/queries.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { invalidatePortfolioDerivedFigures } from "../lib/invalidate-derived.js";
import {
  BASE_CURRENCY,
  buildTransactionRequestPayload,
  defaultTransactionFormValues,
  transactionFormResolver,
  type TransactionFormValues,
} from "../lib/transaction-form-payload.js";
import { Button, Icon, Input, Select } from "./ui/index.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { MESSAGE_TABLE, messageForError } from "../lib/problem-messages.js";
import { CashAccountPicker } from "./CashAccountPicker.js";
import { CurrencySelect } from "./CurrencySelect.js";
import { FxDirectionLabel } from "./FxDirectionLabel.js";
import { TransactionKindTabs } from "./TransactionKindTabs.js";
import { readRememberedKind, rememberKind } from "../lib/transaction-kind-family.js";
import {
  FEE_TOTAL_TESTID,
  MORE_OPTIONS_FIELDS,
  fieldsHiddenBy,
} from "../lib/transaction-form-layout.js";
import { TransactionMoreOptions } from "./TransactionMoreOptions.js";
import { InstrumentPicker } from "./InstrumentPicker.js";
import { TransactionPreviewBlock } from "./TransactionPreviewBlock.js";
import { RateChips } from "./RateChips.js";
import { RATE_PRESET_COPY } from "../lib/copy/rate-presets.js";
import {
  chipAvailability,
  chipBase,
  type ChipAvailability,
  type RatePresetRubrique,
} from "../lib/rate-preset-math.js";

/**
 * The transaction entry form — T-44: **one** component handling all seven transaction kinds (plus the
 * crypto-settled BUY, FR-66/AC52), validated with the exact same Zod schema
 * `api` validates `POST /transactions` against (`createTransactionBodySchema`,
 * `@kerdial/api-contracts` — T-44's shared-Zod-schema package, so client and
 * server validation cannot drift). Presentation (modal
 * vs full-screen sheet) is `TransactionFormDialog.tsx`'s job, purely via CSS
 * breakpoints on the *same* rendered tree — this component itself has no
 * viewport branching at all.
 *
 * Split by domain: the values shape, defaults, per-kind payload
 * builder and shared-Zod resolver live in `lib/transaction-form-payload.ts`;
 * the instrument search/create picker in `InstrumentPicker.tsx`; the FX
 * direction hint in `FxDirectionLabel.tsx`. This file keeps the field JSX
 * and the submit/invalidation orchestration.
 *
 * Create-only: T-44 explicitly scopes editing out (a
 * separate, later concern) — there is no `mode="edit"` prop and no attempt to
 * grow toward one here.
 *
 * ## The four cash-account slots (CA-20, CD12)
 *
 * CA-11 makes the cash account a **required** part of every cash-moving leg
 * of `createTransactionBodySchema` (FR-156), so this form cannot produce a
 * valid payload without one. Batch B shipped four plain uuid `<Input>`s under
 * protest as an interim control; CA-20 replaced all four with
 * `CashAccountPicker`, which is **the same component `TransactionEditForm`
 * mounts** — this is one of the two entry points RC6 names, and neither is
 * assumed to cover the other.
 *
 * Each slot binds through a `<Controller>` rather than `register(...)`,
 * because the picker is a controlled select that also writes its own CD12
 * prefill back into form state: `field.value`/`field.onChange` is what makes
 * a prefilled selection genuinely *in the payload* rather than merely on
 * screen.
 *
 * ## The settlement pair (FT-20/FT-21, FR-257)
 *
 * The **principal** slot passes `filterByCurrency: false`; the fee, the
 * withholding and `CURRENCY_EXCHANGE`'s two slots do not. From that one prop
 * everything else here follows:
 *
 * - the chosen account's currency **is** the settlement currency, read off the
 *   picker's own already-loaded list — `portfolioCashQueryOptions` is read here
 *   under the same query key the picker uses, so it is a cache hit and **not a
 *   second request** (FR-257(3));
 * - it is written into `cashCurrency` as form state rather than assembled at
 *   submit, because the resolver validates the *values*, so a payload key the
 *   values did not carry would be validated against a body the user never had;
 * - in **D4** (the account is in the base currency) the settled amount is
 *   derived and read-only and **no** `cashAmount` is submitted (L11: the rate
 *   is what is submitted); in **D3/D5** it is a required input and is
 *   submitted;
 * - both fields are cleared the moment the settlement stops differing, so the
 *   degenerate payload is byte-for-byte the pre-cycle one (AC-278).
 *
 * `CURRENCY_EXCHANGE` is excluded outright: FR-235 pins its cash legs to the
 * degenerate pair at the database, so the form has nothing to say about them.
 * So is an asset-settled BUY, whose principal leg moves no cash at all
 * (FR-236).
 *
 * `portfolioId` comes from this form's own portfolio `<select>`
 * (`watch("portfolioId")`), not from a prop — this component is mounted by
 * `TransactionFormDialog` with no portfolio context of its own, and the user
 * picks one here. **That is why `TransactionFormDialog` needs no new prop**,
 * contrary to what one might expect: adding a
 * `portfolioId` prop it could only ever pass as `undefined` would be dead
 * weight. `TransactionEditDialog` likewise passes the whole `transaction`,
 * whose `portfolioId` the edit form reads directly.
 */

// Re-exported so existing consumers (`TransactionFxCorrectDialog.tsx`, the
// unit suite) keep their import path while the definitions live in
// `lib/transaction-form-payload.ts`.
export {
  BASE_CURRENCY,
  buildTransactionRequestPayload,
  defaultTransactionFormValues,
  type TransactionFormValues,
} from "../lib/transaction-form-payload.js";

export interface TransactionFormProps {
  onSubmitted: () => void;
  onCancel: () => void;
}

/** The currency-bearing fields FR-T3/D3 converts — named as a union so another one cannot be wired to `CurrencyField` by accident. */
type CurrencyFieldName = "currency" | "targetCurrency";

interface CurrencyFieldProps {
  readonly label: string;
  readonly name: CurrencyFieldName;
  readonly control: Control<TransactionFormValues>;
  readonly testId: string;
  readonly error?: string;
}

/**
 * FR-T3 / locked D3:
 * every currency field of the create form is the shared `CurrencySelect` —
 * the canonical `GET /currencies` list (`currenciesQueryOptions`, one query
 * key for all four, so their option lists cannot drift from each other) and
 * the same component `InstrumentCreateForm`/`CashAccountFormDialog`/
 * `ManualPriceForm` already mount — never a free-text `<input maxLength={3}>`
 * accepting any three letters.
 *
 * One local wrapper rather than four inline `<Controller>`s: it keeps the
 * kit's label/error shell identical across the four slots (the shared select
 * owns its own markup, so the shell is the call site's job — the same
 * arrangement `InstrumentCreateForm` documents), and each slot keeps the
 * `data-testid` its RTL/Playwright selectors already use, since
 * `CurrencySelect` puts `testId` on the `<select>` itself.
 */
function CurrencyField({ label, name, control, testId, error }: CurrencyFieldProps) {
  return (
    <div className="k-field k-field-md">
      <span className="k-field-label">{label}</span>
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <FocusTarget register={field.ref}>
            <CurrencySelect value={field.value} onChange={field.onChange} testId={testId} />
          </FocusTarget>
        )}
      />
      {error !== undefined && (
        <p role="alert" className="k-field-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Gives RHF's `setFocus` something to focus on a `<Controller>` field whose
 * control (`CurrencySelect`, `CashAccountPicker`, `InstrumentPicker`) takes no
 * ref: the first focusable control inside, looked up when focus is asked for,
 * since a picker swaps its search input for a « change » button once chosen.
 * `display: contents`, so the wrapper adds no box to the form's layout.
 *
 * `transaction-dialog-refresh` AC-538: without it, a failed submit on a
 * picker inside « Plus d'options » (the « Réglé en actif » instrument) would
 * open it and leave the focus where it was.
 */
function FocusTarget({
  register,
  children,
}: {
  readonly register: RefCallBack;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="k-ov-focus-target"
      ref={(element) => {
        if (element === null) return;
        register({
          focus: () =>
            element.querySelector<HTMLElement>("input, select, textarea, button")?.focus(),
        });
      }}
    >
      {children}
    </div>
  );
}

/** A user-typed decimal, or `null` while it is half-typed, blank or unparseable — the same "not available yet, not an error" reading `transaction-preview.ts` takes. */
function typedDecimal(raw: string): Decimal | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    return parseDecimalString(trimmed);
  } catch {
    return null;
  }
}

/**
 * `transaction-dialog-refresh` FR-653 / C-2: « Total des frais » on BUY, SELL
 * and DRIP — the `Decimal` sum of the four typed components, blank counting as
 * zero. `null` (the total is hidden) when nothing is typed, or when a component
 * does not parse: a total over a half-typed figure would be a wrong figure.
 *
 * **Display only.** It is never written to `feeAmount`: the body carries the
 * components and the server sums them (decision TDR-D1).
 */
function feeComponentsTotal(components: readonly string[]): Decimal | null {
  const typed = components.filter((raw) => raw.trim() !== "");
  if (typed.length === 0) return null;
  let total = new Decimal(0);
  for (const raw of typed) {
    const value = typedDecimal(raw);
    if (value === null) return null;
    total = total.plus(value);
  }
  return total;
}

/** The hint a disabled chip row points at — one per `chipAvailability` reason. */
const CHIP_HINT: Readonly<Record<Exclude<ChipAvailability, "enabled">, string>> = {
  "presets-unavailable": RATE_PRESET_COPY.presetsUnavailableHint,
  "settled-in-asset": RATE_PRESET_COPY.chipsSettledInAssetHint,
  "no-base": RATE_PRESET_COPY.chipsNoBaseHint,
  "currency-mismatch": RATE_PRESET_COPY.chipsCurrencyMismatchHint,
};

/** TDR-L11 / I-7: the kinds whose cost is typed as components (Courtage and Taxes essential, a read-only total); CURRENCY_EXCHANGE keeps its single editable « Frais ». */
function showsCostComponentsFor(kind: TransactionFormValues["kind"]): boolean {
  return kind === "BUY" || kind === "SELL" || kind === "DRIP";
}

type ChipMarks = Partial<Record<RatePresetRubrique, string>>;

/** `marks` without the given rubriques' entries — the same object when none was set, so a no-op clear does not re-render. */
function withoutMarks(marks: ChipMarks, rubriques: readonly RatePresetRubrique[]): ChipMarks {
  if (rubriques.every((rubrique) => marks[rubrique] === undefined)) return marks;
  const next: ChipMarks = { ...marks };
  for (const rubrique of rubriques) delete next[rubrique];
  return next;
}

/**
 * **FR-576 / AC-460: a security transfer's market-value prefill** —
 * `quantity × currentPrice`, in the price's own currency, or `null` when there
 * is nothing honest to prefill with (no quantity yet, the source portfolio
 * does not hold the instrument, or its price is unreadable).
 *
 * `Decimal` throughout, never `Number` (`positions.ts`'s house rule), and
 * bounded at twelve decimals because `gross_amount` is `numeric(38,12)`: a
 * longer product would be a figure the stored row could not hold.
 * `toDecimalString`, never `toString`, so the field never receives exponential
 * notation (`zDecimal` rejects it).
 */
export function transferMarketValuePrefill(
  quantity: string,
  currentPrice: { readonly amount: string; readonly currency: string } | undefined,
): { readonly amount: string; readonly currency: string } | null {
  const units = typedDecimal(quantity);
  if (units === null || currentPrice === undefined) return null;
  const price = typedDecimal(currentPrice.amount);
  if (price === null) return null;
  return {
    amount: toDecimalString(units.times(price).toDecimalPlaces(12, ROUNDING_MODE)),
    currency: currentPrice.currency,
  };
}

interface SettlementFieldsProps {
  /** The chosen account's currency — the settlement currency, by FR-257(1). */
  readonly accountCurrency: string;
  readonly txnCurrency: string;
  /** The trade-currency gross this kind is priced at, or `null` while it is incomplete. */
  readonly gross: Decimal | null;
  /** D4 (`accountCurrency === BASE_CURRENCY`): the server derives the settled amount, so the form shows it and submits none. */
  readonly derivedInBase: boolean;
  /** The user's own pinned `txn_currency → base` rate, if typed. D4's derivation needs it and says so when it is absent. */
  readonly pinnedRate: Decimal | null;
  /** What the user typed in D3/D5. Ignored in D4, where the field is not an input. */
  readonly typedAmount: string;
  /** True when this kind takes money *out* of the account — the label is otherwise about money in. */
  readonly debit: boolean;
  readonly error?: string;
  /** `register("cashAmount")`, spread onto the D3/D5 input. Passed in rather than re-derived so the field this component renders is the same one the resolver routes `cashAmount` issues to. */
  readonly registration: UseFormRegisterReturn;
  /** L11's own affordance: the user types the figure their broker debited and the *rate* field is back-solved from it, client-side. Never writes `cashAmount`. */
  readonly onBackSolveRate: (rate: string) => void;
}

/**
 * FR-257(3)/(4): the settled amount, the implied settlement rate, and the
 * disclosure of which figure was typed and which was derived.
 *
 * Rendered only when the settlement genuinely differs, so this component never
 * has to draw an empty conversion block — the caller's condition is the same
 * one `cashCurrency` is written under.
 */
function SettlementFields({
  accountCurrency,
  txnCurrency,
  gross,
  derivedInBase,
  pinnedRate,
  typedAmount,
  debit,
  error,
  registration,
  onBackSolveRate,
}: SettlementFieldsProps) {
  // D4: `cash_amount = gross_amount × fx_rate` — the server's own rule,
  // shown here only with the rate the user actually pinned. Without one there
  // is no rate to derive from, and the form says so rather than guessing:
  // the server will resolve one, and it is the server's figure that lands.
  const derived =
    derivedInBase && gross !== null && pinnedRate !== null ? gross.times(pinnedRate) : null;
  const settled = derivedInBase ? derived : typedDecimal(typedAmount);
  // FR-239: `cash_amount / gross_amount`, from the two figures on this screen.
  const impliedRate =
    settled === null || gross === null || gross.isZero() ? null : settled.dividedBy(gross);

  const amountLabel = debit
    ? TRANSACTION_COPY.cashAmountDebited
    : TRANSACTION_COPY.cashAmountCredited;

  return (
    <div className="k-ov-group" data-testid="settlement-fields">
      {derivedInBase ? (
        <>
          <Input
            label={fill(TRANSACTION_COPY.cashAmountDerived, { amount: amountLabel })}
            hint={TRANSACTION_COPY.cashAmountDerivedHint}
            numeric
            readOnly
            suffix={accountCurrency}
            data-testid="cash-amount-derived"
            // `toDecimalString`, never `toString`: the latter may render
            // exponential notation, which `zDecimal` rejects outright and
            // which no figure on this form is allowed to show.
            value={derived === null ? "" : toDecimalString(derived)}
            // A read-only field still needs an onChange for React not to warn
            // about an uncontrolled/controlled value; there is nothing to
            // write, which is the point.
            onChange={() => {}}
          />
          {/* L11's affordance, and deliberately *not* a second settled-amount
              field: what the user types here back-solves the rate above, which
              is the figure the server actually stores. Nothing here reaches
              `cashAmount`: a supplied one is rejected in D4 by name. */}
          <Input
            label={fill(TRANSACTION_COPY.cashAmountBackSolve, { amount: amountLabel })}
            hint={TRANSACTION_COPY.cashAmountBackSolveHint}
            numeric
            suffix={accountCurrency}
            data-testid="cash-amount-back-solve"
            onChange={(event) => {
              const stated = typedDecimal(event.target.value);
              if (stated === null || gross === null || gross.isZero()) return;
              // Twelve decimals: `fx_rate` is `numeric(28,12)`, so a rate with
              // more digits than the column holds would be a figure the stored
              // row could not reproduce. `toDecimalString` rather than
              // `toFixed`, so the field never receives exponential notation
              // (`zDecimal` rejects it).
              onBackSolveRate(
                toDecimalString(stated.dividedBy(gross).toDecimalPlaces(12, ROUNDING_MODE)),
              );
            }}
          />
        </>
      ) : (
        <Input
          label={amountLabel}
          hint={TRANSACTION_COPY.cashAmountHint}
          numeric
          suffix={accountCurrency}
          data-testid="cash-amount-input"
          error={error}
          {...registration}
        />
      )}

      {/* FR-257(4): the *second* rate on this screen. Its label says
          « règlement »; the FX field's says « devise de référence ». The two
          are different rates between different pairs and the copy is what
          keeps them apart. */}
      <p className="k-field-hint" data-testid="implied-settlement-rate">
        {impliedRate === null ? (
          <>{TRANSACTION_COPY.impliedSettlementRateUnknown}</>
        ) : (
          <>
            {fill(TRANSACTION_COPY.impliedSettlementRatePrefix, { currency: txnCurrency })}{" "}
            <LedgerAmount amount={toDecimalString(impliedRate)} currency={null} kind="fxRate" />{" "}
            {fill(TRANSACTION_COPY.impliedSettlementRateSuffix, { currency: accountCurrency })}
          </>
        )}
      </p>
    </div>
  );
}

export function TransactionForm({ onSubmitted, onCancel }: TransactionFormProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const portfoliosQuery = useQuery(portfoliosQueryOptions());
  // TDR-D13: the chips' presets, read on
  // every opening and every kind. Not a derived key — no transaction write
  // refetches it — and a failure only hides the chips (FR-666, AC-557).
  const presetsQuery = useQuery(ratePresetsQueryOptions());
  // F2 (security review, T-45, MEDIUM): set once `invalidateAndVerifyCalcEpoch`
  // exhausts its retry budget without ever confirming the overview/holdings
  // caches actually advanced past their pre-write `calcEpoch`. The write
  // itself still succeeded (this is never treated as a submission error) —
  // only the *display* could not be proven caught up — so the dialog stays
  // open with an honest notice instead of silently closing as if nothing
  // were amiss, and the user acknowledges before it closes.
  const [calcEpochNotVerified, setCalcEpochNotVerified] = useState(false);
  /**
   * `security-transfer` FR-576: set once the user types a market value or picks
   * its currency — from then on the pair is theirs, and the prefill never writes
   * over it ("what the user types is what gets stored"). A prefill is a
   * `setValue`, never an input event, so it cannot set this itself.
   */
  const [marketValueEdited, setMarketValueEdited] = useState(false);
  // `transaction-dialog-refresh` FR-645: the dialog opens on the kind last
  // selected. Read once per mount (a lazy initialiser, not per render) —
  // `Dialog` mounts its content only while open, so every opening is a fresh
  // read.
  const [openingKind] = useState(readRememberedKind);
  // FR-647: « Plus d'options » — closed on every opening, never remembered.
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  // AC-538: the field to focus once a failed submit has opened the expander.
  const [pendingFocus, setPendingFocus] = useState<keyof TransactionFormValues | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    control,
    reset,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<TransactionFormValues>({
    resolver: transactionFormResolver(),
    // Layered over the defaults here rather than inside
    // `defaultTransactionFormValues`, which the payload builder's tests and the
    // post-submit `reset` keep meaning "BUY".
    defaultValues: { ...defaultTransactionFormValues(), kind: openingKind },
  });

  const mutation = useMutation({
    mutationFn: createTransaction,
    // F1 (security review, T-44): TanStack Query mutations
    // default to `networkMode: "online"` — if `mutate()` is ever invoked
    // while `onlineManager` reports offline (the exact race
    // `use-online-status.ts`'s own F1 fix closes: an offline event landing
    // between this form's first render and its effect attaching listeners
    // could otherwise leave the submit button briefly still enabled), the
    // mutation would be silently *paused* rather than attempted, then
    // automatically *replayed* the instant the browser reconnects — exactly
    // the "queued transaction writes against a recomputed PMP" hazard
    // forbid, and the same fix `AppShell.tsx`'s
    // logout mutation already carries (security review, F6).
    // `networkMode: "always"` ignores `onlineManager` entirely: offline, the
    // real `fetch()` is attempted immediately and rejects immediately
    // (a genuine network error, surfaced via the existing `mutation.isError`
    // alert below) — never paused, so there is nothing left to replay.
    networkMode: "always",
    // T-45: completes AC23's client half. Awaited
    // (not fire-and-forget) so the dialog only closes once every derived
    // figure has been invalidated, refetched, and (for overview/holdings)
    // *verified* to carry a `calcEpoch` past what it was before this write —
    // `invalidate-derived.ts`'s own doc comment explains why a bare
    // `invalidateQueries` is not itself a strong enough guarantee.
    onSuccess: async () => {
      // `cash-interest` AC-524: the ledger and the calendar live under the
      // bare `["transactions"]` prefix, which the edit, delete and FX-correct
      // dialogs already invalidate — a create left the Journal showing the
      // pre-write page until something else refetched it.
      const [result] = await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      ]);
      // F2 (security review, T-45, MEDIUM): the write succeeded — only the
      // read side could not be *proven* fresh within the retry budget. Do
      // not reset/close as if this were a clean, fully-confirmed success;
      // the notice's own acknowledgment button does both once the user has
      // seen it.
      if (result.status !== "verified") {
        setCalcEpochNotVerified(true);
        return;
      }
      reset(defaultTransactionFormValues());
      setMarketValueEdited(false);
      onSubmitted();
    },
  });

  const kind = watch("kind");
  // Watched so the preview recomputes as the user types. Pure
  // arithmetic downstream, so this costs a render and nothing else.
  const previewQuantity = watch("quantity");
  const previewUnitPrice = watch("unitPrice");
  const previewFeeAmount = watch("feeAmount");
  const previewFxRate = watch("fxRateUserInput");
  const currency = watch("currency");
  const targetCurrency = watch("targetCurrency");
  const settlementEnabled = watch("settlementEnabled");
  const settlementInstrumentSymbol = watch("settlementInstrumentSymbol");
  // CA-20: every picker slot is scoped to the portfolio chosen above, and to
  // its own leg's currency — watched, so changing either re-filters the
  // offer list rather than leaving a stale, now-invalid selection behind.
  const selectedPortfolioId = watch("portfolioId");
  // FT-21: the principal leg's chosen account, its derived settlement currency,
  // and the settled amount — all watched for the same reason the preview's
  // fields are: changing the account changes what is submitted.
  const cashAccountId = watch("cashAccountId");
  const cashCurrency = watch("cashCurrency");
  const cashAmount = watch("cashAmount");
  const previewAmount = watch("amount");
  const instrumentId = watch("instrumentId");
  const destinationPortfolioId = watch("destinationPortfolioId");
  const sourcePortfolioOptions = portfolioSelectOptions(
    portfoliosQuery.data ?? [],
    selectedPortfolioId ?? "",
  );

  /**
   * **FR-576's prefill read** — the source portfolio's own holdings, whose
   * `currentPrice` is "the last known price" the requirement names. Enabled on
   * the transfer tab only, so no other kind's form issues it (and no spec that
   * submits another kind has to mock it).
   */
  const isTransfer = kind === "TRANSFER_OUT";
  const sourceHoldingsQuery = useQuery({
    ...portfolioHoldingsQueryOptions(selectedPortfolioId),
    enabled: isTransfer && selectedPortfolioId !== "",
  });
  const heldPrice = sourceHoldingsQuery.data?.holdings.find(
    (holding) => holding.instrumentId === instrumentId,
  )?.currentPrice;
  const prefill = isTransfer ? transferMarketValuePrefill(previewQuantity, heldPrice) : null;
  useEffect(() => {
    if (!isTransfer || marketValueEdited) return;
    // No holding or no price: the field is emptied rather than left showing a
    // figure computed from a quantity that is no longer on screen.
    const nextAmount = prefill?.amount ?? "";
    if (previewAmount !== nextAmount) setValue("amount", nextAmount);
    if (prefill !== null && currency !== prefill.currency) setValue("currency", prefill.currency);
  }, [isTransfer, marketValueEdited, prefill, previewAmount, currency, setValue]);

  // The picker's **own** read, under the picker's own query key: a cache hit,
  // never a second request (FR-257(3)). `enabled` mirrors the picker's
  // behaviour 1 so this cannot be the call that fetches an unscoped list.
  const cashQuery = useQuery({
    ...portfolioCashQueryOptions(selectedPortfolioId),
    enabled: selectedPortfolioId !== "",
  });
  const principalAccountCurrency =
    cashQuery.data?.accounts.find((account) => account.id === cashAccountId)?.currency ?? "";

  // FR-235: `CURRENCY_EXCHANGE`'s legs are pinned to the degenerate pair at the
  // database. FR-236: an asset-settled BUY's principal leg moves no cash.
  // Neither has a settlement pair to express, and both keep a filtered picker.
  // The cashless kind joins the list for a third reason: a SHARE_DISTRIBUTION has
  // no cash leg whatsoever, so there is no account whose denomination could
  // differ from the trade's.
  const principalLegCarriesSettlement =
    kind !== "CURRENCY_EXCHANGE" &&
    kind !== "SHARE_DISTRIBUTION" &&
    !(kind === "BUY" && settlementEnabled);
  const settlementDiffers =
    principalLegCarriesSettlement &&
    principalAccountCurrency !== "" &&
    currency !== "" &&
    principalAccountCurrency.trim() !== currency.trim();
  // Case D4 (`A = B ≠ T`, the user's own): the account is in the base currency,
  // so the server derives the settled amount from the rate and **rejects** a
  // supplied one (`CashAmountNotAcceptedError`). D3/D5 collect it.
  const settlementDerivedInBase =
    settlementDiffers && principalAccountCurrency.trim() === BASE_CURRENCY;

  /**
   * The settlement pair, mirrored into form state.
   *
   * Written here rather than assembled in `onValid` because the resolver
   * validates `buildTransactionRequestPayload(values)` — a key added after
   * validation would be a payload the shared schema never saw. Cleared on the
   * same condition it is written under, so a form whose settlement stops
   * differing (a currency change, a different account, a kind switch) submits
   * neither key and is byte-identical to the pre-cycle body (AC-278).
   */
  useEffect(() => {
    const nextCurrency = settlementDiffers ? principalAccountCurrency : "";
    if (cashCurrency !== nextCurrency) setValue("cashCurrency", nextCurrency);
    // D4 submits no `cashAmount` at all (L11), and neither does the degenerate
    // case — so anything typed while the form was briefly in D3/D5 is cleared
    // rather than carried into a body the server refuses by name.
    if ((nextCurrency === "" || settlementDerivedInBase) && cashAmount !== "") {
      setValue("cashAmount", "");
    }
  }, [
    settlementDiffers,
    settlementDerivedInBase,
    principalAccountCurrency,
    cashCurrency,
    cashAmount,
    setValue,
  ]);

  // The trade-currency gross this kind is priced at — the same two expressions
  // the ledger uses (`quantity × unitPrice`, or the stated amount).
  const grossForSettlement =
    kind === "BUY" || kind === "SELL" || kind === "DRIP"
      ? (() => {
          const quantity = typedDecimal(previewQuantity);
          const unitPrice = typedDecimal(previewUnitPrice);
          return quantity === null || unitPrice === null ? null : quantity.times(unitPrice);
        })()
      : typedDecimal(previewAmount);
  const pinnedRate = typedDecimal(previewFxRate);
  // What the preview must report the movement in (F5/FT-23). In D4 the figure
  // is the one this form derived from the user's *own* pinned rate — the same
  // figure it displays — so the preview and the field cannot disagree.
  const previewSettledAmount = settlementDerivedInBase
    ? grossForSettlement !== null && pinnedRate !== null
      ? toDecimalString(grossForSettlement.times(pinnedRate))
      : ""
    : cashAmount;

  // ---- « Total des frais » and the rate chips (TDR-T10) ----

  const feeBrokerFee = watch("feeBrokerFee");
  const feeFxFee = watch("feeFxFee");
  const feeTax = watch("feeTax");
  const feeOther = watch("feeOther");
  const feeTotal = showsCostComponentsFor(kind)
    ? feeComponentsTotal([feeBrokerFee, feeFxFee, feeTax, feeOther])
    : null;

  /**
   * O-2: on the component kinds `feeAmount` has no control, so it is held
   * empty. A total typed on CURRENCY_EXCHANGE and carried over by a kind switch
   * would otherwise travel invisibly beside the components — the one value
   * this cycle stops carrying across a switch.
   */
  useEffect(() => {
    if (showsCostComponentsFor(kind) && previewFeeAmount !== "") setValue("feeAmount", "");
  }, [kind, previewFeeAmount, setValue]);

  /**
   * The chip marks: which preset's amount each field holds, by label. Local
   * state, never a form value, so it cannot reach the payload (FR-659). A
   * keystroke in the field clears its mark (`register`'s `onChange`, a user
   * event only); a change of the base clears every mark on it and leaves the
   * amounts (FR-655/656).
   */
  const [chipMarks, setChipMarks] = useState<ChipMarks>({});
  const tradeBaseKey = `${kind}|${previewQuantity}|${previewUnitPrice}|${String(settlementEnabled)}`;
  // The Retenue is in the settling account's currency, so where that
  // differs from the gross's its chip base is the settled amount (the derived
  // D4 figure or the typed D3/D5 one), not the gross.
  const withholdingSettledBase = settlementDiffers ? previewSettledAmount : undefined;
  const incomeBaseKey = `${kind}|${previewAmount}|${withholdingSettledBase ?? ""}`;
  useEffect(() => {
    setChipMarks((marks) => withoutMarks(marks, ["BROKERAGE", "TAX"]));
  }, [tradeBaseKey]);
  useEffect(() => {
    setChipMarks((marks) => withoutMarks(marks, ["WITHHOLDING"]));
  }, [incomeBaseKey]);
  const clearMark = (rubrique: RatePresetRubrique) => () =>
    setChipMarks((marks) => withoutMarks(marks, [rubrique]));

  const chipBaseValue = chipBase(kind, {
    quantity: previewQuantity,
    unitPrice: previewUnitPrice,
    amount: previewAmount,
    settledAmount: withholdingSettledBase,
  });
  const presets = presetsQuery.data?.items;
  const availabilityOf = (rubrique: RatePresetRubrique): ChipAvailability =>
    chipAvailability({
      rubrique,
      kind,
      presetsFailed: presetsQuery.isError,
      settledInAsset: settlementEnabled,
      base: chipBaseValue,
      settlementDiffers,
    });
  /** The field hint naming why its chips are disabled — only once there are chips to disable (or the read failed). */
  const chipHintOf = (
    rubrique: RatePresetRubrique,
    availability: ChipAvailability,
  ): string | undefined => {
    if (availability === "enabled") return undefined;
    if (availability === "presets-unavailable") return CHIP_HINT[availability];
    const hasChips = (presets ?? []).some((preset) => preset.rubrique === rubrique);
    return hasChips ? CHIP_HINT[availability] : undefined;
  };

  /** A component field with its chip row under it (Courtage, Taxes, Retenue). */
  const chipField = (spec: {
    readonly rubrique: RatePresetRubrique;
    readonly name: "feeBrokerFee" | "feeTax" | "withholdingAmount";
    readonly label: string;
    readonly testId: string;
    readonly fieldCurrency: string;
  }) => {
    const availability = availabilityOf(spec.rubrique);
    const hint = chipHintOf(spec.rubrique, availability);
    const fieldId = `${spec.testId}-field`;
    return (
      <div className="k-ov-chip-field">
        <Input
          id={fieldId}
          label={spec.label}
          hint={hint}
          numeric
          data-testid={spec.testId}
          error={errors[spec.name]?.message}
          {...register(spec.name, { onChange: clearMark(spec.rubrique) })}
        />
        <RateChips
          rubrique={spec.rubrique}
          fieldLabel={spec.label}
          presets={presets}
          availability={availability}
          base={chipBaseValue}
          fieldCurrency={spec.fieldCurrency}
          selectedLabel={chipMarks[spec.rubrique] ?? null}
          hintId={hint === undefined ? undefined : `${fieldId}-message`}
          onApply={(label, value) => {
            setValue(spec.name, value, { shouldDirty: true, shouldValidate: false });
            setChipMarks((marks) =>
              label === null
                ? withoutMarks(marks, [spec.rubrique])
                : { ...marks, [spec.rubrique]: label },
            );
          }}
        />
      </div>
    );
  };

  const onValid = (values: TransactionFormValues) => {
    mutation.mutate(buildTransactionRequestPayload(values));
  };

  /**
   * FR-647 (b), AC-538: a failed submit whose errors include a field inside
   * the collapsed expander opens it and focuses the first such field. Only when
   * no essential field failed — a visible error outranks a hidden one, and RHF's
   * own `shouldFocusError` already focuses that. RHF cannot do this half: it
   * focuses while the field is still inside a closed `<details>`, where a
   * browser refuses focus, so the focus is deferred to after the open commits.
   */
  const onInvalid = (invalid: FieldErrors<TransactionFormValues>) => {
    const hidden = MORE_OPTIONS_FIELDS[kind];
    const erroredKeys = Object.keys(invalid) as (keyof TransactionFormValues)[];
    const firstHidden = hidden.find((field) => invalid[field] !== undefined);
    if (firstHidden === undefined) return;
    if (erroredKeys.some((field) => !hidden.includes(field))) return;
    setMoreOptionsOpen(true);
    setPendingFocus(firstHidden);
  };
  useEffect(() => {
    if (pendingFocus === null || !moreOptionsOpen) return;
    setFocus(pendingFocus);
    setPendingFocus(null);
  }, [pendingFocus, moreOptionsOpen, setFocus]);

  const showsCostComponents = showsCostComponentsFor(kind);
  const showsInstrumentField =
    kind === "BUY" ||
    kind === "SELL" ||
    kind === "DIVIDEND" ||
    kind === "DRIP" ||
    kind === "SHARE_DISTRIBUTION" ||
    kind === "TRANSFER_OUT";
  const showsTradePricing =
    (kind === "BUY" && !settlementEnabled) || kind === "SELL" || kind === "DRIP";
  // `portfolio-cash` FR-691: FEE takes WITHDRAWAL's block — amount, currency
  // and the unfiltered principal picker — and its settlement/FX slots below.
  const showsCashAmountBlock =
    kind === "DEPOSIT" ||
    kind === "WITHDRAWAL" ||
    kind === "DIVIDEND" ||
    kind === "INTEREST" ||
    kind === "CURRENCY_EXCHANGE" ||
    kind === "FEE";
  const showsWithholding = kind === "DIVIDEND" || kind === "INTEREST";
  // The kinds that render the settlement block today (FR-648: none gains or
  // loses it). TRANSFER_OUT has no principal picker, so it never differs.
  const showsSettlementFields =
    settlementDiffers &&
    (showsTradePricing ||
      kind === "DEPOSIT" ||
      kind === "WITHDRAWAL" ||
      kind === "DIVIDEND" ||
      kind === "INTEREST" ||
      kind === "FEE");

  // FR-647 (a) / FR-648 / AC-537: the settlement block's appearance opens the
  // expander. It never closes it — closing is the user's.
  useEffect(() => {
    if (showsSettlementFields) setMoreOptionsOpen(true);
  }, [showsSettlementFields]);

  /** One element, rendered from both principal-leg branches — the fields are the same, the surrounding kind-specific inputs are not. */
  const settlementFields = showsSettlementFields ? (
    <SettlementFields
      accountCurrency={principalAccountCurrency}
      txnCurrency={currency}
      gross={grossForSettlement}
      derivedInBase={settlementDerivedInBase}
      pinnedRate={pinnedRate}
      typedAmount={cashAmount}
      // BUY/DRIP/WITHDRAWAL/FEE take money out of the account; SELL, DEPOSIT,
      // DIVIDEND and INTEREST put it in.
      debit={kind === "BUY" || kind === "DRIP" || kind === "WITHDRAWAL" || kind === "FEE"}
      {...(errors.cashAmount?.message === undefined ? {} : { error: errors.cashAmount.message })}
      registration={register("cashAmount")}
      onBackSolveRate={(rate) => setValue("fxRateUserInput", rate, { shouldDirty: true })}
    />
  ) : null;

  const instrumentField = (
    <Controller
      name="instrumentId"
      control={control}
      render={({ field }) => (
        <InstrumentPicker
          label={TRANSACTION_COPY.instrument}
          value={field.value}
          onChange={(id) => field.onChange(id)}
          error={errors.instrumentId?.message}
          testId="instrument-picker"
        />
      )}
    />
  );

  const quantityField = (
    <Input
      label={TRANSACTION_COPY.quantity}
      numeric
      data-testid="quantity-input"
      error={errors.quantity?.message}
      {...register("quantity")}
    />
  );

  const currencyField = (
    <CurrencyField
      label={TRANSACTION_COPY.currency}
      name="currency"
      control={control}
      testId="currency-input"
      error={errors.currency?.message}
    />
  );

  /** « Taux de change vers la devise de référence » — in the expander on every kind that has it (FR-650). */
  const fxRateField = (
    <div className="k-field">
      <Input
        label={TRANSACTION_COPY.fxRateToBase}
        hint={TRANSACTION_COPY.optional}
        numeric
        data-testid="fx-rate-user-input"
        error={errors.fxRateUserInput?.message}
        {...register("fxRateUserInput")}
      />
      <FxDirectionLabel from={currency} to={BASE_CURRENCY} />
    </div>
  );

  const feeFxField = (
    <Input
      label={TRANSACTION_COPY.feeFx}
      numeric
      data-testid="fee-fx-input"
      error={errors.feeFxFee?.message}
      {...register("feeFxFee")}
    />
  );
  const feeOtherField = (
    <Input
      label={TRANSACTION_COPY.feeOther}
      numeric
      data-testid="fee-other-input"
      error={errors.feeOther?.message}
      {...register("feeOther")}
    />
  );
  const feeBrokerField = (
    <Input
      label={TRANSACTION_COPY.feeBroker}
      numeric
      data-testid="fee-broker-input"
      error={errors.feeBrokerFee?.message}
      {...register("feeBrokerFee")}
    />
  );
  const feeTaxField = (
    <Input
      label={TRANSACTION_COPY.feeTax}
      numeric
      data-testid="fee-tax-input"
      error={errors.feeTax?.message}
      {...register("feeTax")}
    />
  );
  const feeAmountField = (
    <Input
      label={TRANSACTION_COPY.feeAmount}
      numeric
      data-testid="fee-amount-input"
      error={errors.feeAmount?.message}
      {...register("feeAmount")}
    />
  );

  return (
    <form
      data-testid="transaction-form"
      className="k-ov-form"
      onSubmit={(event) => void handleSubmit(onValid, onInvalid)(event)}
    >
      <TransactionKindTabs
        kind={kind}
        onSelect={(next) => {
          // A value the new kind's layout does not show is
          // reset before the switch, so « Aperçu » and the body read visible
          // inputs only (a BUY's quantity × price never prices a DIVIDEND).
          if (next !== kind) {
            const defaults = defaultTransactionFormValues();
            const hidden = fieldsHiddenBy(next);
            for (const field of hidden) setValue(field, defaults[field]);
            if (hidden.includes("amount")) setMarketValueEdited(false);
          }
          // FR-644: the one writer of `kind`, for a pill and a family alike.
          setValue("kind", next, { shouldDirty: true });
          rememberKind(next);
        }}
      />

      {/* Deleting the tenant's last
          portfolio is a permitted, newly-reachable state (FR-P7) — an empty
          `<select>` with only the placeholder option would silently look
          like "no portfolio picked yet" rather than "there is nothing to
          pick", the exact kind of dishonest empty state this codebase's
          conventions forbid elsewhere (`HoldingsRoute`/`PortfoliosRoute`
          both render an explicit message instead). Shown only once the
          query has actually resolved to zero
          rows — never while still loading. */}
      {!portfoliosQuery.isLoading && (portfoliosQuery.data ?? []).length === 0 ? (
        <div role="status" data-testid="portfolio-select-empty" className="k-banner k-banner-warn">
          <Icon name="alert-triangle" size="sm" />
          <p>{TRANSACTION_COPY.noPortfolios}</p>
        </div>
      ) : (
        <Select
          label={TRANSACTION_COPY.portfolio}
          data-testid="portfolio-select"
          disabled={portfoliosQuery.isLoading}
          error={errors.portfolioId?.message}
          // portfolio-archive FR-596: an archived portfolio is not offered
          // unless it is already the value; when every portfolio is archived
          // the offer is empty, and says so (the banner above stays keyed on
          // the full list — portfolios do exist).
          hint={
            (portfoliosQuery.data ?? []).length > 0 && sourcePortfolioOptions.length === 0
              ? PORTFOLIO_COPY.allArchived
              : undefined
          }
          options={[{ value: "", label: TRANSACTION_COPY.chooseOption }, ...sourcePortfolioOptions]}
          {...register("portfolioId")}
        />
      )}

      {/* Date and Heure share a row from 420px (`.k-ov-pair`). */}
      <div className="k-ov-pair">
        <Input
          type="date"
          label={TRANSACTION_COPY.tradeDate}
          data-testid="trade-date-input"
          error={errors.tradeDate?.message}
          {...register("tradeDate")}
        />

        {/* FR-T1 / locked D1 Option A: a
          *second, optional* control beside the date — not a `datetime-local`
          replacing it (that is Option B, which was not locked). The date
          above stays exactly what it was, keeping it visually and
          semantically primary: it is the required field and the only
          FX-relevant one (NG3), while the time is "optional intraday
          ordering" the schema's own `trade_ts` comment describes. Left
          blank, nothing is sent for it —
          `buildTransactionRequestPayload`/`buildTradeTs` omit `tradeTs`
          altogether, so a form filled the way it always was submits the
          payload it always did. */}
        <Input
          type="time"
          label={TRANSACTION_COPY.tradeTime}
          hint={TRANSACTION_COPY.tradeTimeHint}
          data-testid="trade-time-input"
          error={errors.tradeTime?.message}
          {...register("tradeTime")}
        />
      </div>

      {/* AC48: CURRENCY_EXCHANGE structurally has no instrument field at all — this block is simply never rendered for that kind, not merely left empty on submit. */}
      {showsInstrumentField && instrumentField}

      {/* TDR-L14: « Réglé en actif » lives in the expander, but ticking it
          still swaps this price/currency/account block out of the essentials,
          exactly as it did when the checkbox stood here. Quantité and Prix
          unitaire share a row from 420px (`.k-ov-pair`). */}
      {showsTradePricing ? (
        <div className="k-ov-pair">
          {quantityField}
          <Input
            label={TRANSACTION_COPY.unitPrice}
            numeric
            data-testid="unit-price-input"
            error={errors.unitPrice?.message}
            {...register("unitPrice")}
          />
        </div>
      ) : (
        (kind === "BUY" || kind === "SHARE_DISTRIBUTION" || kind === "TRANSFER_OUT") &&
        quantityField
      )}

      {showsTradePricing && (
        <>
          {currencyField}
          <Controller
            name="cashAccountId"
            control={control}
            render={({ field }) => (
              <CashAccountPicker
                label={TRANSACTION_COPY.cashAccount}
                hint={TRANSACTION_COPY.cashAccountHint}
                portfolioId={selectedPortfolioId}
                currency={currency}
                value={field.value}
                onChange={field.onChange}
                error={errors.cashAccountId?.message}
                testId="cash-account-input"
                // FR-257(1): the principal leg, and only the principal leg.
                filterByCurrency={false}
              />
            )}
          />
        </>
      )}

      {/* The cashless kind's own block, and it is a separate
          one on purpose: it needs the amount and the currency, and it must
          **not** render the cash-account picker the four kinds below share.
          A distribution settles through no account (the create schema refuses
          a `cashAccountId` on it outright), so offering the control would be
          exactly the "field that looks like it applies but doesn't" this
          codebase forbids elsewhere. */}
      {kind === "SHARE_DISTRIBUTION" && (
        <>
          <Input
            label={TRANSACTION_COPY.marketValue}
            hint={TRANSACTION_COPY.marketValueHint}
            numeric
            data-testid="amount-input"
            error={errors.amount?.message}
            {...register("amount")}
          />
          {currencyField}
        </>
      )}

      {/* `security-transfer` (OD-4 (a)): one « units out » form.
          SHARE_DISTRIBUTION's cashless field set — market value, its currency,
          an optional pinned rate, and no cash-account picker — plus the one
          field only this kind has, the optional destination. */}
      {isTransfer && (
        <>
          <Input
            label={TRANSACTION_COPY.marketValue}
            hint={TRANSACTION_COPY.transferMarketValueHint}
            numeric
            data-testid="amount-input"
            error={errors.amount?.message}
            {...register("amount", { onChange: () => setMarketValueEdited(true) })}
          />
          <div className="k-field k-field-md">
            <span className="k-field-label">{TRANSACTION_COPY.currency}</span>
            <Controller
              name="currency"
              control={control}
              render={({ field }) => (
                <CurrencySelect
                  value={field.value}
                  onChange={(value) => {
                    setMarketValueEdited(true);
                    field.onChange(value);
                  }}
                  testId="currency-input"
                />
              )}
            />
            {errors.currency?.message !== undefined && (
              <p role="alert" className="k-field-error">
                {errors.currency.message}
              </p>
            )}
          </div>
          <Select
            label={TRANSACTION_COPY.destinationPortfolio}
            hint={TRANSACTION_COPY.destinationHint}
            data-testid="destination-portfolio-select"
            // FR-577: the one refusal on this control is "the source itself",
            // and its sentence is the server's own for the same refusal — the
            // schema's English issue text is never what the user reads here.
            error={
              errors.destinationPortfolioId === undefined
                ? undefined
                : MESSAGE_TABLE["TRANSFER_DESTINATION_IS_SOURCE"]?.text
            }
            options={[
              { value: "", label: TRANSACTION_COPY.destinationNone },
              // FR-577, client half: the source portfolio is not offered. It is
              // listed only if it is *already* the value — chosen first, then
              // picked as the source — so the control shows the truth and the
              // shared schema's refusal has something visible to point at.
              // Then portfolio-archive FR-596: archived ones are hidden unless
              // they are the current destination.
              ...portfolioSelectOptions(
                (portfoliosQuery.data ?? []).filter(
                  (portfolio) =>
                    portfolio.id !== selectedPortfolioId || portfolio.id === destinationPortfolioId,
                ),
                destinationPortfolioId ?? "",
              ),
            ]}
            {...register("destinationPortfolioId")}
          />
        </>
      )}

      {showsCashAmountBlock && (
        <>
          <Input
            label={TRANSACTION_COPY.amount}
            numeric
            data-testid="amount-input"
            error={errors.amount?.message}
            {...register("amount")}
          />
          {currencyField}
          <Controller
            name="cashAccountId"
            control={control}
            render={({ field }) => (
              <CashAccountPicker
                label={TRANSACTION_COPY.cashAccount}
                hint={
                  kind === "CURRENCY_EXCHANGE"
                    ? TRANSACTION_COPY.cashAccountSourceHint
                    : TRANSACTION_COPY.cashAccountHint
                }
                portfolioId={selectedPortfolioId}
                currency={currency}
                value={field.value}
                onChange={field.onChange}
                error={errors.cashAccountId?.message}
                testId="cash-account-input"
                // FR-235 pins CURRENCY_EXCHANGE's cash legs to the degenerate
                // pair at the database, so that kind keeps the filter — the one
                // place this block's five kinds part company.
                filterByCurrency={kind === "CURRENCY_EXCHANGE"}
              />
            )}
          />
        </>
      )}

      {/* `portfolio-cash` FR-691: on a FEE the `note` is « Libellé », an
          essential — it is what the charge was. Every other kind keeps it in
          the expander as « Note (optionnel) ». */}
      {kind === "FEE" && (
        <Input
          label={TRANSACTION_COPY.feeLabel}
          placeholder={TRANSACTION_COPY.feeLabelPlaceholder}
          data-testid="note-input"
          error={errors.note?.message}
          {...register("note")}
        />
      )}

      {/* cash-interest FR-637: INTEREST reuses DIVIDEND's withholding fieldset
          and copy (C-10). FR-649: the amount is essential. It is the
          whole withholding — in the settling account's currency, with no
          currency, rate or account of its own. */}
      {showsWithholding && (
        <fieldset className="k-ov-group">
          <legend className="k-ov-group-title">{TRANSACTION_COPY.withholdingSection}</legend>
          {/* FR-652: the WITHHOLDING chips, on the gross as base (the settled
              amount when the account's currency differs); a minimum
              reads in the account's currency, or the gross's while none. */}
          {chipField({
            rubrique: "WITHHOLDING",
            name: "withholdingAmount",
            label: TRANSACTION_COPY.withholdingAmount,
            testId: "withholding-amount-input",
            fieldCurrency: principalAccountCurrency === "" ? currency : principalAccountCurrency,
          })}
        </fieldset>
      )}

      {kind === "CURRENCY_EXCHANGE" && (
        <>
          <CurrencyField
            label={TRANSACTION_COPY.targetCurrency}
            name="targetCurrency"
            control={control}
            testId="target-currency-input"
            error={errors.targetCurrency?.message}
          />
          <Controller
            name="targetCashAccountId"
            control={control}
            render={({ field }) => (
              <CashAccountPicker
                label={TRANSACTION_COPY.targetCashAccount}
                hint={TRANSACTION_COPY.targetCashAccountHint}
                portfolioId={selectedPortfolioId}
                currency={targetCurrency}
                value={field.value}
                onChange={field.onChange}
                error={errors.targetCashAccountId?.message}
                testId="target-cash-account-input"
              />
            )}
          />
          <div className="k-field">
            <Input
              label={TRANSACTION_COPY.exchangeRate}
              numeric
              data-testid="exchange-rate-input"
              error={errors.exchangeRate?.message}
              {...register("exchangeRate")}
            />
            <FxDirectionLabel from={currency} to={targetCurrency} />
          </div>
          <fieldset className="k-ov-group">
            <legend className="k-ov-group-title">{TRANSACTION_COPY.feesSection}</legend>
            {feeAmountField}
          </fieldset>
        </>
      )}

      {/* TDR-L11 (C-2): Courtage and Taxes, each with its chips,
          and « Total des frais » — an `<output>`, never an input, derived from
          the four components and never sent: the body carries the components
          and the server sums them. « Frais de change » and « Autres
          frais » are in « Plus d'options ». */}
      {showsCostComponents && (
        <fieldset className="k-ov-group">
          <legend className="k-ov-group-title">{TRANSACTION_COPY.feesSection}</legend>
          {chipField({
            rubrique: "BROKERAGE",
            name: "feeBrokerFee",
            label: TRANSACTION_COPY.feeBroker,
            testId: "fee-broker-input",
            fieldCurrency: currency,
          })}
          {chipField({
            rubrique: "TAX",
            name: "feeTax",
            label: TRANSACTION_COPY.feeTax,
            testId: "fee-tax-input",
            fieldCurrency: currency,
          })}
          {feeTotal !== null && (
            <div className="k-ov-fee-total">
              <span className="k-field-label" id="fee-total-label">
                {TRANSACTION_COPY.feeTotal}
              </span>
              <output data-testid={FEE_TOTAL_TESTID} aria-labelledby="fee-total-label">
                <LedgerAmount
                  amount={toDecimalString(feeTotal)}
                  currency={principalAccountCurrency !== "" ? principalAccountCurrency : currency}
                />
              </output>
            </div>
          )}
        </fieldset>
      )}

      {/* FR-647/FR-650 (C-1): everything the essentials above do
          not list, per kind. The JSX order is the oracle's order
          (`lib/transaction-form-layout.ts`). */}
      <TransactionMoreOptions open={moreOptionsOpen} onOpenChange={setMoreOptionsOpen}>
        {/* `portfolio-cash` PC-L14: a FEE may name the instrument it is about —
            a reference only (no position leg), so optional and out of the
            essentials. `instrumentId` is posted only when one is chosen. */}
        {kind === "FEE" && (
          <Controller
            name="instrumentId"
            control={control}
            render={({ field }) => (
              <FocusTarget register={field.ref}>
                <InstrumentPicker
                  label={TRANSACTION_COPY.feeInstrumentOptional}
                  value={field.value}
                  onChange={(id) => field.onChange(id)}
                  error={errors.instrumentId?.message}
                  testId="instrument-picker"
                />
              </FocusTarget>
            )}
          />
        )}

        {kind === "DRIP" && (
          <Input
            label={TRANSACTION_COPY.sourceDividendId}
            data-testid="source-dividend-id-input"
            error={errors.sourceDividendId?.message}
            {...register("sourceDividendId")}
          />
        )}

        {kind === "BUY" && (
          <div className="k-checkbox">
            <input
              type="checkbox"
              id="settlement-toggle"
              className="k-checkbox-input"
              data-testid="settlement-toggle"
              {...register("settlementEnabled", {
                // F2 (security review, T-44): the fiat
                // `fxRateUserInput` field disappears once the settlement leg
                // is toggled on (`createTransactionBodySchema` forbids it
                // alongside `settlement` anyway), but a value already typed
                // there stayed in RHF state, ready to reappear un-explained if
                // the toggle were flipped back off — explicitly cleared here
                // rather than merely left unread, so nothing typed is
                // silently dropped without the user seeing it disappear at
                // the moment it stops applying.
                onChange: (event: ChangeEvent<HTMLInputElement>) => {
                  if (event.target.checked) setValue("fxRateUserInput", "");
                },
              })}
            />
            <div className="k-checkbox-text">
              <label htmlFor="settlement-toggle" className="k-checkbox-label">
                {TRANSACTION_COPY.settledInAsset}
              </label>
              <p className="k-checkbox-description">{TRANSACTION_COPY.settledInAssetDescription}</p>
            </div>
          </div>
        )}

        {kind === "BUY" && settlementEnabled && (
          <>
            <Controller
              name="settlementInstrumentId"
              control={control}
              render={({ field }) => (
                <FocusTarget register={field.ref}>
                  <InstrumentPicker
                    label={TRANSACTION_COPY.settlementInstrument}
                    value={field.value}
                    onChange={(id, _label, symbol) => {
                      field.onChange(id);
                      setValue("settlementInstrumentSymbol", symbol);
                    }}
                    error={errors.settlementInstrumentId?.message}
                    testId="settlement-instrument-picker"
                  />
                </FocusTarget>
              )}
            />
            <Input
              label={TRANSACTION_COPY.settlementAmount}
              numeric
              data-testid="settlement-amount-input"
              error={errors.settlementAmount?.message}
              {...register("settlementAmount")}
            />
            <div className="k-field">
              <Input
                label={TRANSACTION_COPY.settlementPinnedFxRate}
                hint={TRANSACTION_COPY.optional}
                numeric
                data-testid="settlement-fx-rate-user-input"
                error={errors.settlementFxRateUserInput?.message}
                {...register("settlementFxRateUserInput")}
              />
              {/* F2 (security review, T-44): the settlement leg's rate is pinned to base currency (a CryptoRateResolver quote, not an FxRateResolver rate), so its direction is "1 <settlement asset symbol> = ___ EUR", not a currency pair — minLength=1 since a ticker/ISIN has no fixed length. */}
              <FxDirectionLabel
                from={settlementInstrumentSymbol}
                to={BASE_CURRENCY}
                minLength={1}
              />
            </div>
          </>
        )}

        {settlementFields}

        {kind !== "CURRENCY_EXCHANGE" && !(kind === "BUY" && settlementEnabled) && fxRateField}

        {showsCostComponents && (
          <>
            {feeFxField}
            {feeOtherField}
          </>
        )}

        {/* The four optional components of CURRENCY_EXCHANGE's single total
            (FR-650): its « Frais » stays essential, its breakdown is here. */}
        {kind === "CURRENCY_EXCHANGE" && (
          <>
            <p className="k-ov-hint">{TRANSACTION_COPY.feeBreakdownHint}</p>
            {feeBrokerField}
            {feeFxField}
            {feeTaxField}
            {feeOtherField}
          </>
        )}

        {/* The user's own reference — a broker's order number, a
            statement line. It is what the row is *called* on a document, not
            part of what it is worth, and it belongs to every kind. */}
        <Input
          label={TRANSACTION_COPY.referenceOptional}
          data-testid="reference-input"
          error={errors.reference?.message}
          {...register("reference")}
        />

        {kind !== "FEE" && (
          <div className="k-field">
            <label className="k-field-label" htmlFor="note-input">
              {TRANSACTION_COPY.noteOptional}
            </label>
            <div className="k-input-shell">
              <textarea
                id="note-input"
                data-testid="note-input"
                className="k-input k-ov-textarea"
                {...register("note")}
              />
            </div>
          </div>
        )}
      </TransactionMoreOptions>

      {/* The design's live transaction preview.
          Recomputed on render from watched fields — pure arithmetic, no
          request, so it cannot cost a read per keystroke and there is nothing
          to debounce. Every figure it shows reproduces the ledger's own
          expression; everything it cannot compute honestly it names. */}
      {/* No cash moves on a transfer, so there is no movement to preview. */}
      {!isTransfer && (
        <TransactionPreviewBlock
          kind={kind}
          quantity={previewQuantity}
          unitPrice={previewUnitPrice}
          currency={currency}
          feeAmount={
            showsCostComponents
              ? feeTotal === null
                ? ""
                : toDecimalString(feeTotal)
              : previewFeeAmount
          }
          fxRateUserInput={previewFxRate}
          // FT-23 / F5: the preview may not report a magnitude in the trade's
          // currency once the ledger will record it in the account's.
          cashCurrency={cashCurrency}
          cashAmount={previewSettledAmount}
        />
      )}

      {mutation.isError && (
        <div role="alert" className="k-banner k-banner-loss" data-testid="submit-error">
          <Icon name="circle-alert" size="sm" />
          {/*
            This used to render `mutation.error.message`, which
            for an `ApiError` **is** the server's `problem.detail` verbatim
            (`api-client.ts`'s constructor). That is the one thing
            `problem-messages.ts` says is never rendered — English, technical,
            and since this cycle carrying internal design-doc references — and
            this form was the carve-out that kept doing it. Converged onto the
            shared mapper, which is what that file's own scope note called "a
            deletion, not a rewrite".
          */}
          <p>{messageForError(mutation.error).text}</p>
        </div>
      )}

      {!online && (
        <div role="alert" className="k-banner k-banner-neutral" data-testid="offline-error">
          <Icon name="info" size="sm" />
          <p>{COMMON_COPY.offlineExplanation}</p>
        </div>
      )}

      {/* F2 (security review, T-45, MEDIUM): the write already succeeded —
          this is deliberately `role="status"`, not `role="alert"`/an error
          styling, so as not to imply the transaction itself failed. The form's
          own submit/cancel controls are replaced by a single acknowledgment
          button below: resubmitting the same values here would create a
          second, duplicate transaction, since the first one is already saved. */}
      {calcEpochNotVerified && (
        <div role="status" data-testid="calc-epoch-stale-notice" className="k-banner k-banner-warn">
          <Icon name="alert-triangle" size="sm" />
          <p>{TRANSACTION_COPY.calcEpochStale}</p>
        </div>
      )}

      <div className="k-ov-actions">
        {calcEpochNotVerified ? (
          <Button
            variant="primary"
            data-testid="calc-epoch-stale-notice-close"
            onClick={() => {
              setCalcEpochNotVerified(false);
              reset(defaultTransactionFormValues());
              setMarketValueEdited(false);
              onSubmitted();
            }}
          >
            {COMMON_COPY.close}
          </Button>
        ) : (
          <>
            <Button variant="ghost" data-testid="transaction-form-cancel" onClick={onCancel}>
              {COMMON_COPY.cancel}
            </Button>
            <Button
              type="submit"
              variant="primary"
              data-testid="transaction-form-submit"
              disabled={!online || isSubmitting || mutation.isPending}
            >
              {TRANSACTION_COPY.submitCreate}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
