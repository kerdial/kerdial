import { useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateInstrumentScpiAttributesBodySchema } from "@kerdial/api-contracts";
import type {
  InstrumentDetailResponse,
  UpdateInstrumentScpiAttributesInput,
} from "../lib/api-client.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { updateInstrumentScpiAttributesMutationOptions } from "../lib/queries.js";
import { messageForError } from "../lib/problem-messages.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Button, Input } from "./ui/index.js";

/**
 * `InstrumentScpiAttributesForm.tsx` — the « Caractéristiques SCPI » section of
 * `InstrumentDetailView`'s « Modifier » dialog (scpi cycle, FR-612/FR-619). The
 * `InstrumentClassificationForm` shape: its own resolver over the shared
 * `updateInstrumentScpiAttributesBodySchema`, its own mutation, its own
 * confirmation — so a failure here never reads as a failure of the other two
 * sections.
 *
 * **Only what changed is sent.** `PATCH /instruments/:id/scpi-attributes` reads
 * an absent key as "leave it" and `null` as "clear it", so a field left as it
 * was prefilled is omitted, a field emptied is `null`, and a field edited is its
 * trimmed text. The fee stays the decimal string the user typed (NFR-76); the
 * server answers with its canonical two-decimal form, and the rows above
 * re-render from that response's key, never from what was sent.
 *
 * Same shared-catalogue caveat as the classification form (C27, R4):
 * the attributes live on the shared `instrument` row.
 */

export interface InstrumentScpiAttributesFormValues {
  /** `""` clears the société de gestion. */
  managementCompany: string;
  /** `""` clears the fee; otherwise a decimal string, never a JS number. */
  subscriptionFeePct: string;
}

type ScpiAttributesPatch = Omit<UpdateInstrumentScpiAttributesInput, "instrumentId">;

/** Form values -> request body: only the fields that differ from the stored values, `null` for an emptied one. */
function buildScpiAttributesPatch(
  values: InstrumentScpiAttributesFormValues,
  instrument: InstrumentDetailResponse,
): ScpiAttributesPatch {
  const patch: { managementCompany?: string | null; subscriptionFeePct?: string | null } = {};
  for (const field of ["managementCompany", "subscriptionFeePct"] as const) {
    const typed = values[field].trim();
    const next = typed === "" ? null : typed;
    if (next !== (instrument[field] ?? null)) patch[field] = next;
  }
  return patch;
}

/** The shared schema as the resolver, over the payload actually sent — its own messages, never a sentence authored here. */
function scpiAttributesFormResolver(
  instrument: InstrumentDetailResponse,
): Resolver<InstrumentScpiAttributesFormValues> {
  return async (values) => {
    const result = updateInstrumentScpiAttributesBodySchema.safeParse(
      buildScpiAttributesPatch(values, instrument),
    );
    if (result.success) return { values, errors: {} };

    const errors: FieldErrors<InstrumentScpiAttributesFormValues> = {};
    for (const issue of result.error.issues) {
      // The at-least-one rule has no path: it lands on the first field.
      const field = (issue.path.join(".") ||
        "managementCompany") as keyof InstrumentScpiAttributesFormValues;
      if (errors[field] === undefined) {
        errors[field] = { type: issue.code, message: issue.message };
      }
    }
    return { values: {}, errors };
  };
}

export interface InstrumentScpiAttributesFormProps {
  /** The SCPI being edited — its current attributes prefill the form, and its id is the route parameter. */
  readonly instrument: InstrumentDetailResponse;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}

export function InstrumentScpiAttributesForm({
  instrument,
  onSaved,
  onCancel,
}: InstrumentScpiAttributesFormProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<InstrumentScpiAttributesFormValues>({
    resolver: scpiAttributesFormResolver(instrument),
    defaultValues: {
      managementCompany: instrument.managementCompany ?? "",
      subscriptionFeePct: instrument.subscriptionFeePct ?? "",
    },
  });

  const mutation = useMutation(updateInstrumentScpiAttributesMutationOptions(queryClient));

  const onValid = (values: InstrumentScpiAttributesFormValues) => {
    mutation.mutate(
      { instrumentId: instrument.id, ...buildScpiAttributesPatch(values, instrument) },
      { onSuccess: () => onSaved() },
    );
  };

  return (
    <form
      data-testid="instrument-scpi-attributes-form"
      className="k-inst-form"
      onSubmit={(event) => void handleSubmit(onValid)(event)}
    >
      <Input
        type="text"
        label={INSTRUMENT_COPY.managementCompany}
        maxLength={120}
        data-testid="instrument-scpi-management-company-input"
        error={errors.managementCompany?.message}
        {...register("managementCompany")}
      />

      {/* NFR-76: a text input carrying a decimal string, never `type="number"`. */}
      <Input
        type="text"
        numeric
        label={INSTRUMENT_COPY.subscriptionFeePctInput}
        data-testid="instrument-scpi-subscription-fee-input"
        error={errors.subscriptionFeePct?.message}
        {...register("subscriptionFeePct")}
      />

      {mutation.isError && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-scpi-attributes-error"
        >
          {messageForError(mutation.error).text}
        </p>
      )}

      {!online && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-scpi-attributes-offline-error"
        >
          {COMMON_COPY.offlineExplanation}
        </p>
      )}

      <div className="k-inst-form-actions">
        <Button variant="ghost" data-testid="instrument-scpi-attributes-cancel" onClick={onCancel}>
          {COMMON_COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="instrument-scpi-attributes-submit"
          disabled={!online || isSubmitting || mutation.isPending}
        >
          {COMMON_COPY.save}
        </Button>
      </div>
    </form>
  );
}
