import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RATE_PRESET_LABEL_MAX, type RatePreset } from "@kerdial/api-contracts";
import { RATE_PRESET_COPY } from "../lib/copy/rate-presets.js";
import type { RatePresetRubrique } from "../lib/rate-preset-math.js";
import {
  typedPreset,
  validatePresetAt,
  withAppended,
  type PresetFieldErrors,
} from "../lib/rate-preset-validation.js";
import { saveRatePresetsMutationOptions } from "../lib/queries.js";
import { messageForError } from "../lib/problem-messages.js";
import { Button, Input } from "./ui/index.js";

export interface RatePresetAddFormProps {
  readonly rubrique: RatePresetRubrique;
  /** The cached whole list, every rubrique — what the `PUT` replaces. */
  readonly presets: readonly RatePreset[];
  /** Closes the mini-form: after a save, or on « Annuler ». */
  readonly onDone: () => void;
}

/**
 * The « + » mini-form (`transaction-dialog-refresh` FR-658):
 * label, rate and optional minimum, saved to the tenant's list.
 *
 * **Not a `<form>`.** It sits inside the transaction `<form>`, where a nested
 * form is invalid HTML, and an Enter in one of its inputs would submit the
 * transaction. So Enter is prevented on the group and runs « Ajouter »
 * instead — the `AssetSearchPopover` precedent (R-11).
 *
 * The whole resulting list is validated with the shared `ratePresetListSchema`
 * before anything is sent — the cap of six, a duplicate label, a rate out of
 * bounds all stop here with a field error and no request. The saved list is
 * the `PUT` response, put in the cache by the mutation; the new preset is
 * **not** applied to the field (FR-658).
 */
export function RatePresetAddForm({ rubrique, presets, onDone }: RatePresetAddFormProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation(saveRatePresetsMutationOptions(queryClient));
  const [label, setLabel] = useState("");
  const [rate, setRate] = useState("");
  const [minimum, setMinimum] = useState("");
  const [errors, setErrors] = useState<PresetFieldErrors>({});
  const groupRef = useRef<HTMLDivElement>(null);

  // Opening the mini-form puts the caret in its first input.
  useEffect(() => {
    groupRef.current?.querySelector("input")?.focus();
  }, []);

  const add = () => {
    const item = typedPreset(rubrique, label, rate, minimum);
    const items = withAppended(presets, item);
    const checked = validatePresetAt(items, items.indexOf(item));
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    mutation.mutate(checked.list, { onSuccess: onDone });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!mutation.isPending) add();
  };

  return (
    <div
      className="k-ov-chip-new"
      role="group"
      aria-label={RATE_PRESET_COPY.addGroupLabel}
      data-testid={`rate-chip-new-${rubrique}`}
      ref={groupRef}
      onKeyDown={onKeyDown}
    >
      <Input
        label={RATE_PRESET_COPY.addLabel}
        size="sm"
        maxLength={RATE_PRESET_LABEL_MAX}
        data-testid={`rate-chip-new-label-${rubrique}`}
        value={label}
        error={errors.label}
        onChange={(event) => setLabel(event.target.value)}
      />
      <Input
        label={RATE_PRESET_COPY.addRate}
        size="sm"
        numeric
        data-testid={`rate-chip-new-rate-${rubrique}`}
        value={rate}
        error={errors.rate}
        onChange={(event) => setRate(event.target.value)}
      />
      <Input
        label={RATE_PRESET_COPY.addMinimum}
        size="sm"
        numeric
        data-testid={`rate-chip-new-minimum-${rubrique}`}
        value={minimum}
        error={errors.minimum}
        onChange={(event) => setMinimum(event.target.value)}
      />
      <div className="k-ov-chip-new-actions">
        <Button
          variant="ghost"
          size="sm"
          data-testid={`rate-chip-new-cancel-${rubrique}`}
          onClick={onDone}
        >
          {RATE_PRESET_COPY.addCancel}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          data-testid={`rate-chip-new-submit-${rubrique}`}
          loading={mutation.isPending}
          onClick={add}
        >
          {RATE_PRESET_COPY.addSubmit}
        </Button>
      </div>
      {mutation.isError && (
        <p role="alert" className="k-field-error" data-testid={`rate-chip-new-error-${rubrique}`}>
          {messageForError(mutation.error).text}
        </p>
      )}
    </div>
  );
}
