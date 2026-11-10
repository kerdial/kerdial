import { useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateInstrumentClassificationBodySchema } from "@kerdial/api-contracts";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import type {
  InstrumentDetailResponse,
  UpdateInstrumentClassificationInput,
} from "../lib/api-client.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { updateInstrumentClassificationMutationOptions } from "../lib/queries.js";
import { SECTOR_UNCLASSIFIED_LABEL, sectorDisplayLabel } from "../lib/sector-display.js";
import { COUNTRY_UNKNOWN_LABEL } from "../lib/country-display.js";
import { messageForError } from "../lib/problem-messages.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Button, Input, Select, type SelectOption } from "./ui/index.js";

/**
 * `InstrumentClassificationForm.tsx` — IR-18 (DD30/DD31; FR-3/FR-31,
 * AC-36). The user override behind `InstrumentDetailView`'s « Modifier »
 * affordance — the « Classification » section of that dialog now, its own
 * « Corriger le secteur ou le pays » button before that: the reason
 * « Non classé » is a **starting state rather than a dead end**, and the only
 * surface from which
 * `domicile_country` is ever filled (OD-3 refuses to guess it from a MIC).
 *
 * ## Three fields, and what "clear" means in each
 *
 * Every field can be *emptied*, and emptying sends `null` — which the route
 * translates into a real `NULL`, i.e. back to « Non classé » / « Non
 * renseigné ». That is deliberate and is the whole point of DD30: a correction
 * surface that could only ever *set* a value would make a wrong provider
 * classification permanent.
 *
 *  - **Secteur** — a native `<select>` over `SECTOR_CODES` plus a « Non classé »
 *    option whose value is the empty string. Every option's text comes from
 *    `sectorDisplayLabel`, the **one** place `web` turns a sector code into
 *    text (enforced by `classification-display-single-site.test.ts`) —
 *    this form does not reach for the vocabulary's `sectorLabel` itself.
 *  - **Pays du siège social** — a two-letter code. Uppercased before
 *    validation, following `InstrumentCreateForm`'s shipped precedent for
 *    `isin`/`exchangeMic`/`listingCurrency` (LOW, security review): it widens
 *    the accepted *input*, never the *validated* value, so no client/server
 *    drift is possible. Anything that still fails
 *    `domicileCountrySchema` after that is reported with **the shared schema's
 *    own message** (see {@link classificationFormResolver}).
 *  - **Secteur détaillé** — the provider's opaque label, prefilled **as
 *    received** (A7: it is data, exactly like a `display_name` of "Air
 *    Liquide S.A.", never translated) with an explicit clear action beside it.
 *    Editable at all by DD31, which resolves the AC-36 ↔ OD-2/OD-10 tension:
 *    `app_web` is granted this column, so something must be able to write it,
 *    and a user who corrects a wrong sector would otherwise be stuck with the
 *    provider's now-inconsistent detail string underneath it.
 *
 * ## Validation is the shared schema, not a copy of it
 *
 * The resolver builds the **exact request body** and hands it to
 * `updateInstrumentClassificationBodySchema` from `@kerdial/api-contracts` —
 * the same object `api`'s controller validates against
 * (`web/src/lib/tester-schema-parity.test.ts` asserts the identity, FR-31).
 * There is no `web`-local country/sector rule to drift: the only thing this
 * file decides is which fields are present, never what a valid value is.
 *
 * ## The shared catalogue, stated and not fixed (C27, NG11)
 *
 * `instrument` rows are shared reference data, so this correction changes the
 * row **every tenant reads**. The form says so in its own copy rather than
 * pretending otherwise, and this cycle deliberately does not fix it: it is
 * harmless while phase 1 is single-user (ADR-0014), and a per-tenant override
 * table is an explicit non-goal (NG11).
 */

export interface InstrumentClassificationFormValues {
  /** `""` is « Non classé » — the option that clears the column. */
  sectorCode: string;
  /** `""` is « Non renseigné ». */
  domicileCountry: string;
  /** `""` clears the provider's detail label. */
  industryLabel: string;
}

/** The request body this form submits: three fields, `null` where the user emptied one. */
export interface InstrumentClassificationPatch {
  readonly sectorCode: string | null;
  readonly domicileCountry: string | null;
  readonly industryLabel: string | null;
}

/**
 * Form values -> request body. Exported for its own unit test: this is the
 * whole of "« Non classé » clears the value", and it is one pure function
 * rather than a branch inside `onValid`.
 */
export function buildClassificationPatch(
  values: InstrumentClassificationFormValues,
): InstrumentClassificationPatch {
  const domicile = values.domicileCountry.trim().toUpperCase();
  const industry = values.industryLabel.trim();
  return {
    sectorCode: values.sectorCode === "" ? null : values.sectorCode,
    domicileCountry: domicile === "" ? null : domicile,
    industryLabel: industry === "" ? null : industry,
  };
}

/**
 * The shared schema as the resolver, over the payload actually sent. Issue
 * paths map straight onto field names because the body's keys *are* the field
 * names, and the message shown is the schema's own — never a sentence authored
 * here (FR-31's parity property).
 */
export function classificationFormResolver(): Resolver<InstrumentClassificationFormValues> {
  return async (values) => {
    const result = updateInstrumentClassificationBodySchema.safeParse(
      buildClassificationPatch(values),
    );
    if (result.success) return { values, errors: {} };

    const errors: FieldErrors<InstrumentClassificationFormValues> = {};
    for (const issue of result.error.issues) {
      const field = (issue.path.join(".") ||
        "sectorCode") as keyof InstrumentClassificationFormValues;
      if (errors[field] === undefined) {
        errors[field] = { type: issue.code, message: issue.message };
      }
    }
    return { values: {}, errors };
  };
}

/** « Non classé » first, then the nine codes in the vocabulary's own display order. */
const SECTOR_OPTIONS: readonly SelectOption[] = [
  { value: "", label: SECTOR_UNCLASSIFIED_LABEL },
  ...SECTOR_CODES.map((code) => ({ value: code, label: sectorDisplayLabel(code) })),
];

const SHARED_CATALOGUE_NOTE =
  "Le catalogue d'instruments est partagé : cette correction vaut pour tous les portefeuilles de " +
  "l'application. En phase 1, une seule personne l'utilise.";

export interface InstrumentClassificationFormProps {
  /** The instrument being corrected — its current values prefill the form, and its id is the route parameter. */
  readonly instrument: InstrumentDetailResponse;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}

export function InstrumentClassificationForm({
  instrument,
  onSaved,
  onCancel,
}: InstrumentClassificationFormProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<InstrumentClassificationFormValues>({
    resolver: classificationFormResolver(),
    defaultValues: {
      // Prefilled from the server's own response — never from a cached guess,
      // and never normalised on the way in: an unknown-but-present code stays
      // exactly as stored (the same honesty rule `sectorDisplayLabel` applies
      // to rendering one).
      sectorCode: instrument.sectorCode ?? "",
      domicileCountry: instrument.domicileCountry ?? "",
      industryLabel: instrument.industryLabel ?? "",
    },
  });

  const mutation = useMutation(updateInstrumentClassificationMutationOptions(queryClient));

  const onValid = (values: InstrumentClassificationFormValues) => {
    const patch: UpdateInstrumentClassificationInput = {
      instrumentId: instrument.id,
      ...buildClassificationPatch(values),
    };
    mutation.mutate(patch, { onSuccess: () => onSaved() });
  };

  const industryLabelValue = watch("industryLabel");
  // SCPI (N11): an SCPI carries no sector vocabulary, so only the
  // domicile is offered. Both hidden fields stay `""` (prefilled from the
  // SCPI's always-null columns), so the body still sends `null` for them —
  // the no-op this route already accepts.
  const showSector = instrument.kind !== "SCPI";

  return (
    <form
      data-testid="instrument-classification-form"
      className="k-inst-form"
      onSubmit={(event) => void handleSubmit(onValid)(event)}
    >
      {showSector && (
        <Select
          label={INSTRUMENT_COPY.classificationSector}
          data-testid="instrument-classification-sector-select"
          options={SECTOR_OPTIONS}
          error={errors.sectorCode?.message}
          {...register("sectorCode")}
        />
      )}

      <Input
        type="text"
        label={INSTRUMENT_COPY.classificationDomicile}
        maxLength={2}
        placeholder={INSTRUMENT_COPY.classificationDomicilePlaceholder}
        hint={fill(INSTRUMENT_COPY.classificationDomicileHint, { unknown: COUNTRY_UNKNOWN_LABEL })}
        data-testid="instrument-classification-domicile-input"
        error={errors.domicileCountry?.message}
        {...register("domicileCountry")}
      />

      {showSector && (
        <div className="k-inst-form-row">
          <Input
            type="text"
            label={INSTRUMENT_COPY.classificationIndustry}
            data-testid="instrument-classification-industry-input"
            error={errors.industryLabel?.message}
            {...register("industryLabel")}
          />
          <Button
            variant="ghost"
            size="sm"
            data-testid="instrument-classification-industry-clear"
            disabled={industryLabelValue === ""}
            onClick={() => setValue("industryLabel", "", { shouldValidate: false })}
          >
            {INSTRUMENT_COPY.classificationClear}
          </Button>
        </div>
      )}

      <p data-testid="instrument-classification-shared-note" className="k-inst-note">
        {SHARED_CATALOGUE_NOTE}
      </p>

      {mutation.isError && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-classification-error"
        >
          {messageForError(mutation.error).text}
        </p>
      )}

      {!online && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-classification-offline-error"
        >
          {COMMON_COPY.offlineExplanation}
        </p>
      )}

      <div className="k-inst-form-actions">
        <Button variant="ghost" data-testid="instrument-classification-cancel" onClick={onCancel}>
          {COMMON_COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="instrument-classification-submit"
          disabled={!online || isSubmitting || mutation.isPending}
        >
          {INSTRUMENT_COPY.classificationSubmit}
        </Button>
      </div>
    </form>
  );
}
