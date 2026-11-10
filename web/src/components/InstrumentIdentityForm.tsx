import { useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateInstrumentIdentityBodySchema } from "@kerdial/api-contracts";
import type { InstrumentDetailResponse, UpdateInstrumentIdentityInput } from "../lib/api-client.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { updateInstrumentIdentityMutationOptions } from "../lib/queries.js";
import { messageForError } from "../lib/problem-messages.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Button, Input } from "./ui/index.js";

/**
 * `InstrumentIdentityForm.tsx` — instrument-detail identity edit (issue,
 * requested 2026-09-09). The « Identité » section of `InstrumentDetailView`'s
 * « Modifier » dialog (merged with `InstrumentClassificationForm`,
 * which is the « Classification » section below it; the two were separate
 * buttons and separate dialogs before): this one renames the instrument
 * and/or fills a missing FIGI.
 *
 * ## Two fields, two different shapes
 *
 *  - **`displayName`** — always editable, always submitted (trimmed). There
 *    is no "clear" here: `instrument.display_name` is `NOT NULL`, and the
 *    field is prefilled from the server's own current value, so an
 *    unmodified submit round-trips it unchanged.
 *  - **`figi`** — **fill-once, not correct-or-clear**, the opposite shape
 *    from `InstrumentClassificationForm`'s three fields. Rendered as an input
 *    only when {@link InstrumentIdentityFormProps.instrument}'s `figi` is
 *    still `null`; once set, this form shows it read-only with
 *    {@link INSTRUMENT_COPY.identityFigiAlreadySetHint} instead of an input —
 *    there is no path in this UI (or in the database: migration `0061`'s
 *    grant has no row-conditional form beyond `ledger`'s own
 *    `WHERE figi IS NULL`) by which an already-set FIGI can be overwritten.
 *    A race (two tabs) still reaches the server's own 409
 *    (`INSTRUMENT_FIGI_ALREADY_SET`), surfaced via `messageForError` exactly
 *    like any other write conflict.
 *
 * ## Validation is the shared schema, not a copy of it
 *
 * Same discipline as `InstrumentClassificationForm`: the resolver builds the
 * exact request body and hands it to `updateInstrumentIdentityBodySchema`
 * from `@kerdial/api-contracts` — the same object `api`'s controller
 * validates against.
 */

export interface InstrumentIdentityFormValues {
  displayName: string;
  /** Ignored (never sent) once the instrument already has a figi — see the file doc comment. */
  figi: string;
}

/** The request body this form submits — `figi` present only when the instrument has none yet and the field is non-empty. */
export interface InstrumentIdentityPatch {
  readonly displayName: string;
  readonly figi?: string;
}

/**
 * Form values -> request body. Exported for its own unit test, mirroring
 * `buildClassificationPatch`'s precedent: this is the whole of "figi is
 * fill-once", stated as one pure function rather than a branch inside
 * `onValid`.
 */
export function buildIdentityPatch(
  values: InstrumentIdentityFormValues,
  currentFigi: string | null,
): InstrumentIdentityPatch {
  const displayName = values.displayName.trim();
  const figi = values.figi.trim();
  return {
    displayName,
    ...(currentFigi === null && figi !== "" ? { figi } : {}),
  };
}

/**
 * The shared schema as the resolver, over the payload actually sent — issue
 * paths map straight onto field names, and the message shown is the schema's
 * own.
 */
export function identityFormResolver(
  currentFigi: string | null,
): Resolver<InstrumentIdentityFormValues> {
  return async (values) => {
    const result = updateInstrumentIdentityBodySchema.safeParse(
      buildIdentityPatch(values, currentFigi),
    );
    if (result.success) return { values, errors: {} };

    const errors: FieldErrors<InstrumentIdentityFormValues> = {};
    for (const issue of result.error.issues) {
      const field = (issue.path.join(".") || "displayName") as keyof InstrumentIdentityFormValues;
      if (errors[field] === undefined) {
        errors[field] = { type: issue.code, message: issue.message };
      }
    }
    return { values: {}, errors };
  };
}

export interface InstrumentIdentityFormProps {
  /** The instrument being edited — its current values prefill the form, and its id is the route parameter. */
  readonly instrument: InstrumentDetailResponse;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}

export function InstrumentIdentityForm({
  instrument,
  onSaved,
  onCancel,
}: InstrumentIdentityFormProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const figiAlreadySet = instrument.figi !== null;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<InstrumentIdentityFormValues>({
    resolver: identityFormResolver(instrument.figi),
    defaultValues: {
      displayName: instrument.displayName,
      figi: "",
    },
  });

  const mutation = useMutation(updateInstrumentIdentityMutationOptions(queryClient));

  const onValid = (values: InstrumentIdentityFormValues) => {
    const patch = buildIdentityPatch(values, instrument.figi);
    const input: UpdateInstrumentIdentityInput = { instrumentId: instrument.id, ...patch };
    mutation.mutate(input, { onSuccess: () => onSaved() });
  };

  return (
    <form
      data-testid="instrument-identity-form"
      className="k-inst-form"
      onSubmit={(event) => void handleSubmit(onValid)(event)}
    >
      <Input
        type="text"
        label={INSTRUMENT_COPY.identityDisplayNameLabel}
        data-testid="instrument-identity-display-name-input"
        error={errors.displayName?.message}
        {...register("displayName")}
      />

      {figiAlreadySet ? (
        <div>
          <span className="k-inst-def-key">{INSTRUMENT_COPY.identityFigiLabel}</span>
          <p data-testid="instrument-identity-figi-already-set" className="k-inst-note mt-1">
            <span className="k-mono">{instrument.figi}</span> —{" "}
            {INSTRUMENT_COPY.identityFigiAlreadySetHint}
          </p>
        </div>
      ) : (
        <Input
          type="text"
          label={INSTRUMENT_COPY.identityFigiLabel}
          placeholder={INSTRUMENT_COPY.identityFigiPlaceholder}
          maxLength={12}
          data-testid="instrument-identity-figi-input"
          error={errors.figi?.message}
          {...register("figi")}
        />
      )}

      {mutation.isError && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-identity-error"
        >
          {messageForError(mutation.error).text}
        </p>
      )}

      {!online && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-identity-offline-error"
        >
          {COMMON_COPY.offlineExplanation}
        </p>
      )}

      <div className="k-inst-form-actions">
        <Button variant="ghost" data-testid="instrument-identity-cancel" onClick={onCancel}>
          {COMMON_COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="instrument-identity-submit"
          disabled={!online || isSubmitting || mutation.isPending}
        >
          {INSTRUMENT_COPY.identitySubmit}
        </Button>
      </div>
    </form>
  );
}
