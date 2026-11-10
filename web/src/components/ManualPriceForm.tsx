import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Controller, useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import { MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES } from "../lib/api-limits.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { messageForError } from "../lib/problem-messages.js";
import {
  instrumentPricesQueryOptions,
  postManualPricePointMutationOptions,
} from "../lib/queries.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { CurrencySelect } from "./CurrencySelect.js";
import { Button, Input } from "./ui/index.js";

/**
 * `ManualPriceForm.tsx` — UR-14 (Flag B).
 *
 * Answers three of UR-14's seven data-management questions directly (the
 * other four — instrument identity, why it needs manual pricing, the latest
 * existing price, and the surrounding price history — are `ManualPriceDialog`'s
 * job, since they need `holding`/`PricePointTable`, not this form's own
 * fields): **what date am I entering** (native `<input type="date">`,
 * FR-132/AC123), **what currency** (the existing `<CurrencySelect>`), and
 * **am I replacing an existing manual value** (the pre-check below, AC129).
 *
 * **The upsert pre-check (AC129).**
 * `POST /instruments/:id/prices` is an upsert on `(tenantId, instrumentId,
 * priceDate)` with no create-vs-overwrite signal in its response
 * (`instruments.controller.ts:383-384`) — the only way to answer "am I
 * replacing an existing value?" *before* submitting is an advisory read:
 * `GET /instruments/:id/prices?from=D&to=D` for the exact date being typed,
 * reusing `instrumentPricesQueryOptions` (the rule is that "priority
 * assignment is per query-options factory, never per call site" — this is
 * the same factory `PricePointTable.tsx` uses for its own window, at the
 * same `background` priority, not a separate one invented for this call
 * site). The warning only fires when a **manual** point already exists for
 * that exact date (`origin === "MANUAL"`) — an automated point on the same
 * date lives in a different table and is not what this upsert would
 * overwrite. The copy is explicit that this check is **advisory, not a
 * server-side guarantee**: a race between this read and the eventual submit
 * is possible (a concurrent write, another tab, another user), so the check
 * can be stale by the time `Enregistrer` is actually pressed.
 */

export interface ManualPriceFormValues {
  priceDate: string;
  close: string;
  currency: string;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultManualPriceFormValues(defaultCurrency = ""): ManualPriceFormValues {
  return { priceDate: todayIsoDate(), close: "", currency: defaultCurrency };
}

function tryParseClose(raw: string): Decimal | undefined {
  try {
    return parseDecimalString(raw.trim());
  } catch {
    return undefined;
  }
}

/**
 * Client-side mirror of `createManualPriceBodySchema`'s `close` refinement
 * (`api/src/instruments/instruments.schema.ts`) — not shared via
 * `@kerdial/api-contracts` (that schema is not exported from the shared
 * package; only the instrument-creation body is, per that package's own
 * header comment), so this is a hand-written pre-submit check against the
 * same UR-1-mirrored cap ({@link MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES}).
 * The server remains authoritative — this only gives an immediate inline
 * message instead of a round trip for the two mistakes the server would
 * otherwise reject (`MANUAL_PRICE_POINT_SCALE_EXCEEDED`, and a non-positive
 * close the server's own `.greaterThan(0)` refinement rejects too).
 */
export function manualPriceCloseError(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return "Le cours est obligatoire.";
  const parsed = tryParseClose(trimmed);
  if (parsed === undefined) return "Le cours doit être un nombre décimal valide.";
  if (!parsed.greaterThan(0)) return "Le cours doit être strictement positif.";
  if (parsed.decimalPlaces() > MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES) {
    return `Le cours ne peut pas comporter plus de ${MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES} décimales.`;
  }
  return undefined;
}

function manualPriceFormResolver(): Resolver<ManualPriceFormValues> {
  return async (values) => {
    const errors: FieldErrors<ManualPriceFormValues> = {};
    if (!ISO_DATE_PATTERN.test(values.priceDate)) {
      errors.priceDate = { type: "required", message: "La date est obligatoire." };
    }
    const closeError = manualPriceCloseError(values.close);
    if (closeError !== undefined) {
      errors.close = { type: "invalid", message: closeError };
    }
    if (values.currency.trim() === "") {
      errors.currency = { type: "required", message: "La devise est obligatoire." };
    }
    if (Object.keys(errors).length > 0) return { values: {}, errors };
    return { values, errors: {} };
  };
}

export interface ManualPriceFormProps {
  readonly instrumentId: string;
  readonly defaultCurrency?: string;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}

export function ManualPriceForm({
  instrumentId,
  defaultCurrency = "",
  onSaved,
  onCancel,
}: ManualPriceFormProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    watch,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ManualPriceFormValues>({
    resolver: manualPriceFormResolver(),
    defaultValues: defaultManualPriceFormValues(defaultCurrency),
  });

  const priceDate = watch("priceDate");

  // AC129: exactly one extra request scoped to the single date being
  // entered — reusing `instrumentPricesQueryOptions(instrumentId, d, d)`
  // means repeated checks of the identical date share one cached query
  // (TanStack Query's own key-based dedupe), rather than one request per
  // keystroke; `enabled` gates out anything that is not yet a complete ISO
  // date (an in-progress native date-input value).
  const precheck = useQuery({
    ...instrumentPricesQueryOptions(instrumentId, priceDate, priceDate),
    enabled: ISO_DATE_PATTERN.test(priceDate),
  });
  // Defensive: the request is already scoped to `from === to === priceDate`,
  // so the server should never return a point for any other date — but this
  // re-checks `priceDate` explicitly anyway (cheap, at most a couple of
  // rows) rather than trusting that scoping blindly, so a server or mock
  // that answers more broadly than asked can never turn into a false
  // replace-warning for the wrong date.
  const willReplaceExistingManualValue =
    precheck.data?.some((point) => point.origin === "MANUAL" && point.priceDate === priceDate) ??
    false;

  const mutation = useMutation(postManualPricePointMutationOptions(queryClient));

  const onValid = (values: ManualPriceFormValues) => {
    mutation.mutate(
      {
        instrumentId,
        priceDate: values.priceDate,
        close: values.close.trim(),
        currency: values.currency,
      },
      {
        onSuccess: () => {
          reset(defaultManualPriceFormValues(values.currency));
          onSaved();
        },
      },
    );
  };

  return (
    <form
      data-testid="manual-price-form"
      className="k-inst-form"
      onSubmit={(event) => void handleSubmit(onValid)(event)}
    >
      <Input
        type="date"
        label={INSTRUMENT_COPY.priceDate}
        data-testid="manual-price-date-input"
        error={errors.priceDate?.message}
        {...register("priceDate")}
      />

      {/* AC129: stated unconditionally — the
          upsert semantics apply to every date, not only ones the pre-check
          happens to have already resolved. */}
      <p data-testid="manual-price-upsert-note" className="k-inst-note">
        {INSTRUMENT_COPY.priceDateAlreadyUsedHint}
      </p>

      {willReplaceExistingManualValue && (
        <p
          role="alert"
          data-testid="manual-price-replace-warning"
          className="k-inst-banner k-inst-banner-warn"
        >
          {INSTRUMENT_COPY.priceDateTaken}
          <br />
          {INSTRUMENT_COPY.priceDateTakenCaveat}
        </p>
      )}

      <div className="k-inst-form-row">
        {/* The kit's `<Input numeric>` is what applies
            tabular figures and right alignment, and its `error` slot carries
            the decimal-places error state for this exact field. */}
        <Input
          type="text"
          numeric
          label={INSTRUMENT_COPY.price}
          data-testid="manual-price-close-input"
          error={errors.close?.message}
          {...register("close")}
        />

        {/* `CurrencySelect` is a shared component this form does not own, so it
            keeps its own markup; the label and error around it are the kit's. */}
        <div className="k-field k-field-md">
          <span className="k-field-label">{INSTRUMENT_COPY.priceCurrency}</span>
          <Controller
            name="currency"
            control={control}
            render={({ field }) => (
              <CurrencySelect
                value={field.value}
                onChange={field.onChange}
                testId="manual-price-currency-select"
              />
            )}
          />
          {errors.currency?.message !== undefined && (
            <p role="alert" className="k-field-error">
              {errors.currency.message}
            </p>
          )}
        </div>
      </div>

      {/* AC105: MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED/MANUAL_PRICE_POINT_SCALE_EXCEEDED
          (and any other mutation error) all render here, via UR-6's
          messageForError — never the server's own detail/title, never a
          silent failure, and the dialog is never closed for the caller. */}
      {mutation.isError && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="manual-price-submit-error"
        >
          {messageForError(mutation.error).text}
        </p>
      )}

      {!online && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="manual-price-offline-error"
        >
          {COMMON_COPY.offlineExplanation}
        </p>
      )}

      <div className="k-inst-form-actions">
        <Button variant="ghost" data-testid="manual-price-cancel" onClick={onCancel}>
          {COMMON_COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="manual-price-submit"
          disabled={!online || isSubmitting || mutation.isPending}
        >
          {INSTRUMENT_COPY.savePrice}
        </Button>
      </div>
    </form>
  );
}
