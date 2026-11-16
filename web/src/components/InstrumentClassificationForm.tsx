import { useReducer, useState } from "react";
import { Controller, useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND,
  updateInstrumentClassificationBodySchema,
  type ExposureWeightDimension,
  type InstrumentKind,
} from "@kerdial/api-contracts";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import type {
  InstrumentDetailResponse,
  UpdateInstrumentClassificationInput,
} from "../lib/api-client.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import {
  deriveExposureWeightSet,
  exposureWeightRowsReducer,
  initialExposureWeightRows,
  sameExposureWeightSet,
} from "../lib/exposure-weights-form.js";
import {
  updateInstrumentClassificationMutationOptions,
  updateInstrumentExposureWeightsMutationOptions,
} from "../lib/queries.js";
import { SECTOR_UNCLASSIFIED_LABEL, sectorDisplayLabel } from "../lib/sector-display.js";
import { COUNTRY_UNKNOWN_LABEL } from "../lib/country-display.js";
import { messageForError } from "../lib/problem-messages.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { CountryPicker } from "./CountryPicker.js";
import { ExposureWeightsEditor } from "./ExposureWeightsEditor.js";
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
 *    text (a convention, not enforced by any test) — this form does not
 *    reach for the vocabulary's `sectorLabel` itself.
 *  - **Pays du siège social** — a `CountryPicker` (FR-738, EW-L7): a search
 *    over the embedded ISO 3166-1 list that can only commit a code from it,
 *    and whose « Effacer » action empties the field. A stored code **outside**
 *    the list (the column, and the route, accept any two upper-case letters)
 *    is shown raw as the current value and sent back unchanged on save unless
 *    the user picks another country or clears — opening and saving this form
 *    never blanks or rewrites it. The upper-casing in
 *    {@link buildClassificationPatch} is a no-op for a picked code and still
 *    normalises a stored one; anything that fails `domicileCountrySchema` is
 *    reported with **the shared schema's own message** (see
 *    {@link classificationFormResolver}).
 *  - **Secteur détaillé** — the provider's opaque label, prefilled **as
 *    received** (A7: it is data, exactly like a `display_name` of "Air
 *    Liquide S.A.", never translated) with an explicit clear action beside it.
 *    Editable at all by DD31, which resolves the AC-36 ↔ OD-2/OD-10 tension:
 *    `app_web` is granted this column, so something must be able to write it,
 *    and a user who corrects a wrong sector would otherwise be stuck with the
 *    provider's now-inconsistent detail string underneath it.
 *
 * ## Weights, for a kind that can carry them (FR-734, FR-736)
 *
 * Which sections a kind gets is read from `EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND`
 * — the one eligibility list the API and the importer also consume — never
 * from a kind literal here:
 *
 *  - a kind that weighs **sectors** (ETF, FUND) loses the single « Secteur »
 *    select (FR-736, EW-L18: a single sector *is* a one-row weight set at
 *    100 %, so a converted ETF opens with that one row prefilled) and keeps
 *    « Secteur détaillé » (EW-L16);
 *  - a kind that weighs **countries** (ETF, FUND, SCPI) gets « Pondérations
 *    par pays »; the domicile stays its own field (FR-139);
 *  - a kind that weighs nothing (SHARE, CRYPTO, INDEX) is exactly the form it
 *    was, and saves exactly the three-field PATCH it always sent.
 *
 * **Two writes, deliberately sequenced.** For a kind that weighs anything:
 * (1) when a weight set differs from the stored one, `PATCH
 * …/exposure-weights` naming only the dimensions that differ; (2) then, when
 * a classification field differs, `PATCH …/classification` **without
 * `sectorCode`** (the server refuses a non-null one on a kind that weighs
 * sectors, and an SCPI has no sector vocabulary) and without `industryLabel`
 * where that field is not offered. The two are not atomic with each other: a
 * failure of (2) after (1) succeeded says the weights were saved and the
 * classification was not.
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

/**
 * The weight dimensions a kind may carry. The wire's `kind` is a plain
 * string, so an unknown kind carries none — the form it gets is the plain
 * classification form.
 */
function weightDimensionsOf(kind: string): readonly ExposureWeightDimension[] {
  return Object.hasOwn(EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND, kind)
    ? EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND[kind as InstrumentKind]
    : [];
}

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
    control,
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
  const weightsMutation = useMutation(updateInstrumentExposureWeightsMutationOptions(queryClient));
  // The classification write's error when it failed after the weights were
  // saved — the one outcome neither mutation's own error state can say.
  const [classificationFailedAfterWeights, setClassificationFailedAfterWeights] = useState<
    { readonly error: unknown } | undefined
  >(undefined);

  // SCPI (N11): an SCPI carries no sector vocabulary, so neither the sector
  // select nor « Secteur détaillé » is offered — both stay `""` (the SCPI's
  // always-null columns), so the three-field body would send `null`, a no-op.
  const carriesSectorVocabulary = instrument.kind !== "SCPI";
  const dimensions = weightDimensionsOf(instrument.kind);
  const weighsSectors = dimensions.includes("sector");
  const weighsCountries = dimensions.includes("country");
  const weighsAnything = dimensions.length > 0;
  const showSectorSelect = carriesSectorVocabulary && !weighsSectors;
  const showIndustry = carriesSectorVocabulary;

  const [sectorRows, dispatchSector] = useReducer(
    exposureWeightRowsReducer,
    instrument.sectorWeights,
    initialExposureWeightRows,
  );
  const [countryRows, dispatchCountry] = useReducer(
    exposureWeightRowsReducer,
    instrument.countryWeights,
    initialExposureWeightRows,
  );
  const sectorView = deriveExposureWeightSet("sector", sectorRows.rows);
  const countryView = deriveExposureWeightSet("country", countryRows.rows);
  const weightsValid =
    (!weighsSectors || sectorView.valid) && (!weighsCountries || countryView.valid);

  const onValid = async (values: InstrumentClassificationFormValues) => {
    setClassificationFailedAfterWeights(undefined);
    mutation.reset();
    weightsMutation.reset();
    const patch = buildClassificationPatch(values);
    if (!weighsAnything) {
      const body: UpdateInstrumentClassificationInput = { instrumentId: instrument.id, ...patch };
      mutation.mutate(body, { onSuccess: () => onSaved() });
      return;
    }

    // Compared with the instrument as the server last returned it, so a save
    // that just landed (and refetched) is no longer "dirty".
    const sectorDirty =
      weighsSectors && !sameExposureWeightSet(sectorView.items, instrument.sectorWeights);
    const countryDirty =
      weighsCountries && !sameExposureWeightSet(countryView.items, instrument.countryWeights);
    const stored = buildClassificationPatch({
      sectorCode: instrument.sectorCode ?? "",
      domicileCountry: instrument.domicileCountry ?? "",
      industryLabel: instrument.industryLabel ?? "",
    });
    const classificationDirty =
      patch.domicileCountry !== stored.domicileCountry ||
      (showIndustry && patch.industryLabel !== stored.industryLabel);

    let weightsSaved = false;
    if (sectorDirty || countryDirty) {
      try {
        await weightsMutation.mutateAsync({
          instrumentId: instrument.id,
          ...(sectorDirty ? { sectorWeights: sectorView.items } : {}),
          ...(countryDirty ? { countryWeights: countryView.items } : {}),
        });
        weightsSaved = true;
      } catch {
        return; // shown through `weightsMutation.error`
      }
    }
    if (classificationDirty) {
      try {
        await mutation.mutateAsync({
          instrumentId: instrument.id,
          domicileCountry: patch.domicileCountry,
          ...(showIndustry ? { industryLabel: patch.industryLabel } : {}),
        });
      } catch (error) {
        if (weightsSaved) setClassificationFailedAfterWeights({ error });
        return;
      }
    }
    onSaved();
  };

  const industryLabelValue = watch("industryLabel");
  const errorText =
    classificationFailedAfterWeights !== undefined
      ? undefined
      : weightsMutation.isError
        ? messageForError(weightsMutation.error).text
        : mutation.isError
          ? messageForError(mutation.error).text
          : undefined;
  const editorsDisabled = mutation.isPending || weightsMutation.isPending;

  return (
    <form
      data-testid="instrument-classification-form"
      className="k-inst-form"
      onSubmit={(event) => void handleSubmit(onValid)(event)}
    >
      {showSectorSelect && (
        <Select
          label={INSTRUMENT_COPY.classificationSector}
          data-testid="instrument-classification-sector-select"
          options={SECTOR_OPTIONS}
          error={errors.sectorCode?.message}
          {...register("sectorCode")}
        />
      )}

      <Controller
        control={control}
        name="domicileCountry"
        render={({ field }) => (
          <CountryPicker
            label={INSTRUMENT_COPY.classificationDomicile}
            // `""` is the form's « Non renseigné »; the picker speaks `null`.
            value={field.value === "" ? null : field.value}
            onChange={(next) => field.onChange(next ?? "")}
            hint={fill(INSTRUMENT_COPY.classificationDomicileHint, {
              unknown: COUNTRY_UNKNOWN_LABEL,
            })}
            // `${testId}-input` keeps the handle the text field had.
            testId="instrument-classification-domicile"
            error={errors.domicileCountry?.message}
          />
        )}
      />

      {showIndustry && (
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

      {weighsSectors && (
        <ExposureWeightsEditor
          dimension="sector"
          state={sectorRows}
          dispatch={dispatchSector}
          view={sectorView}
          disabled={editorsDisabled}
        />
      )}
      {weighsCountries && (
        <ExposureWeightsEditor
          dimension="country"
          state={countryRows}
          dispatch={dispatchCountry}
          view={countryView}
          disabled={editorsDisabled}
        />
      )}

      <p data-testid="instrument-classification-shared-note" className="k-inst-note">
        {SHARED_CATALOGUE_NOTE}
      </p>

      {classificationFailedAfterWeights !== undefined && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-classification-partial-error"
        >
          {fill(INSTRUMENT_COPY.weightsSavedClassificationNot, {
            reason: messageForError(classificationFailedAfterWeights.error).text,
          })}
        </p>
      )}

      {errorText !== undefined && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-classification-error"
        >
          {errorText}
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
          disabled={
            !online ||
            isSubmitting ||
            mutation.isPending ||
            weightsMutation.isPending ||
            !weightsValid
          }
        >
          {INSTRUMENT_COPY.classificationSubmit}
        </Button>
      </div>
    </form>
  );
}
