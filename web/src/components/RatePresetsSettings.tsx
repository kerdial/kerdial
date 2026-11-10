import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RATE_PRESET_LABEL_MAX,
  RATE_PRESET_RUBRIQUES,
  ratePresetListSchema,
  type RatePreset,
} from "@kerdial/api-contracts";
import { RATE_PRESET_COPY } from "../lib/copy/rate-presets.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { messageForError } from "../lib/problem-messages.js";
import { ratePresetsQueryOptions, saveRatePresetsMutationOptions } from "../lib/queries.js";
import type { RatePresetRubrique } from "../lib/rate-preset-math.js";
import {
  typedPreset,
  validatePresetAt,
  withAppended,
  type PresetFieldErrors,
} from "../lib/rate-preset-validation.js";
import { Banner, Button, Card, IconButton, Input, Skeleton } from "./ui/index.js";

const RUBRIQUE_TITLE: Readonly<Record<RatePresetRubrique, string>> = {
  BROKERAGE: RATE_PRESET_COPY.settingsRubriqueBROKERAGE,
  TAX: RATE_PRESET_COPY.settingsRubriqueTAX,
  WITHHOLDING: RATE_PRESET_COPY.settingsRubriqueWITHHOLDING,
};

interface Fields {
  readonly label: string;
  readonly rate: string;
  readonly minimum: string;
}

const EMPTY_FIELDS: Fields = { label: "", rate: "", minimum: "" };

/** Where the edited row is: its index in the whole list, and the inputs' current text. */
interface Editing {
  readonly index: number;
  readonly fields: Fields;
}

type Outcome = "saved" | "invalid" | undefined;

/**
 * « Taux prédéfinis » on « Mon compte » (`transaction-dialog-refresh` FR-665,
 * TDR-D6): the tenant's rate presets, grouped by rubrique, with
 * add, edit, delete and reorder — **buttons, not drag**, so it stays
 * keyboard-operable with no new dependency.
 *
 * Every change is local until « Enregistrer », which `PUT`s the **whole**
 * list (TDR-D3) after validating it with the shared `ratePresetListSchema`.
 * Add and edit are validated against the list they would produce
 * (`rate-preset-validation.ts`, the « + » mini-form's own rule), so a
 * duplicate label or a seventh preset in a rubrique is a field error and
 * never a request. The response is put in the cache by the mutation
 * (`setQueryData`), so the dialog's chips show it at once; no ledger key is
 * touched — a preset never alters a recorded transaction (FR-659). A failed
 * save keeps the edits and reports in place (`messageForError`).
 *
 * An empty list is a valid list: deleting every preset and saving stores
 * `{items: []}`, which the server never re-seeds (C-10).
 */
export function RatePresetsSettings() {
  const queryClient = useQueryClient();
  const query = useQuery(ratePresetsQueryOptions());
  const mutation = useMutation(saveRatePresetsMutationOptions(queryClient));
  // `null` while nothing is edited: the card then reads the cache directly.
  const [draft, setDraft] = useState<readonly RatePreset[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editErrors, setEditErrors] = useState<PresetFieldErrors>({});
  const [adding, setAdding] = useState<Partial<Record<RatePresetRubrique, Fields>>>({});
  const [addErrors, setAddErrors] = useState<
    Partial<Record<RatePresetRubrique, PresetFieldErrors>>
  >({});
  const [outcome, setOutcome] = useState<Outcome>(undefined);

  const items = draft ?? query.data?.items;

  const change = (next: readonly RatePreset[]): void => {
    setDraft(next);
    setOutcome(undefined);
    mutation.reset();
  };

  const move = (index: number, direction: -1 | 1): void => {
    if (items === undefined) return;
    const rubrique = items[index]?.rubrique;
    let other = index + direction;
    while (other >= 0 && other < items.length && items[other]?.rubrique !== rubrique) {
      other += direction;
    }
    const a = items[index];
    const b = items[other];
    if (a === undefined || b === undefined) return;
    const next = [...items];
    next[index] = b;
    next[other] = a;
    change(next);
  };

  const remove = (index: number): void => {
    if (items === undefined) return;
    if (editing !== null) setEditing(null);
    change(items.filter((_, at) => at !== index));
  };

  const startEdit = (index: number): void => {
    const preset = items?.[index];
    if (preset === undefined) return;
    setEditErrors({});
    setEditing({
      index,
      fields: { label: preset.label, rate: preset.rate, minimum: preset.minimum ?? "" },
    });
  };

  const commitEdit = (): void => {
    if (items === undefined || editing === null) return;
    const current = items[editing.index];
    if (current === undefined) return;
    const { label, rate, minimum } = editing.fields;
    const next = [...items];
    next[editing.index] = typedPreset(current.rubrique, label, rate, minimum);
    const checked = validatePresetAt(next, editing.index);
    if (!checked.ok) {
      setEditErrors(checked.errors);
      return;
    }
    setEditErrors({});
    setEditing(null);
    change(checked.list.items);
  };

  const add = (rubrique: RatePresetRubrique): void => {
    if (items === undefined) return;
    const fields = adding[rubrique] ?? EMPTY_FIELDS;
    const item = typedPreset(rubrique, fields.label, fields.rate, fields.minimum);
    const next = withAppended(items, item);
    const checked = validatePresetAt(next, next.indexOf(item));
    if (!checked.ok) {
      setAddErrors((all) => ({ ...all, [rubrique]: checked.errors }));
      return;
    }
    setAddErrors((all) => ({ ...all, [rubrique]: {} }));
    setAdding((all) => ({ ...all, [rubrique]: EMPTY_FIELDS }));
    change(checked.list.items);
  };

  const save = (): void => {
    if (items === undefined) return;
    const parsed = ratePresetListSchema.safeParse({ items });
    if (!parsed.success) {
      setOutcome("invalid");
      return;
    }
    setOutcome(undefined);
    mutation.mutate(parsed.data, {
      onSuccess: () => {
        setDraft(null);
        setOutcome("saved");
      },
    });
  };

  const typeAdd = (rubrique: RatePresetRubrique, field: keyof Fields, value: string): void => {
    setAdding((all) => ({
      ...all,
      [rubrique]: { ...(all[rubrique] ?? EMPTY_FIELDS), [field]: value },
    }));
  };

  const typeEdit = (field: keyof Fields, value: string): void => {
    setEditing((current) =>
      current === null ? null : { ...current, fields: { ...current.fields, [field]: value } },
    );
  };

  return (
    <Card>
      <section className="flex flex-col gap-4" data-testid="rate-presets-settings">
        <h2 className="text-base font-semibold text-text-strong">
          {RATE_PRESET_COPY.settingsTitle}
        </h2>
        <p className="text-sm text-text-muted">
          {RATE_PRESET_COPY.settingsIntro} {RATE_PRESET_COPY.settingsShared}
        </p>

        {query.isError && items === undefined ? (
          <Banner tone="loss" testId="rate-presets-load-error">
            {messageForError(query.error).text}
          </Banner>
        ) : items === undefined ? (
          <Skeleton
            rows={3}
            size="compact"
            label={COMMON_COPY.loading}
            testId="rate-presets-loading"
          />
        ) : (
          RATE_PRESET_RUBRIQUES.map((rubrique) => {
            const rows = items
              .map((preset, index) => ({ preset, index }))
              .filter(({ preset }) => preset.rubrique === rubrique);
            const addFields = adding[rubrique] ?? EMPTY_FIELDS;
            const addError = addErrors[rubrique] ?? {};
            return (
              <div
                key={rubrique}
                role="group"
                aria-labelledby={`rate-preset-group-title-${rubrique}`}
                className="flex flex-col gap-2"
                data-testid={`rate-preset-group-${rubrique}`}
              >
                <h3
                  id={`rate-preset-group-title-${rubrique}`}
                  className="text-sm font-semibold text-text-strong"
                >
                  {RUBRIQUE_TITLE[rubrique]}
                </h3>

                {rows.length === 0 ? (
                  <p
                    className="text-sm text-text-muted"
                    data-testid={`rate-preset-empty-${rubrique}`}
                  >
                    {RATE_PRESET_COPY.settingsEmpty}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {rows.map(({ preset, index }, position) => {
                      const rowId = `${rubrique}-${position}`;
                      if (editing?.index === index) {
                        return (
                          <li
                            key={rowId}
                            className="flex flex-wrap items-end gap-2"
                            data-testid={`rate-preset-row-${rowId}`}
                          >
                            <Input
                              label={RATE_PRESET_COPY.addLabel}
                              size="sm"
                              maxLength={RATE_PRESET_LABEL_MAX}
                              data-testid={`rate-preset-edit-label-${rowId}`}
                              value={editing.fields.label}
                              error={editErrors.label}
                              onChange={(event) => typeEdit("label", event.target.value)}
                            />
                            <Input
                              label={RATE_PRESET_COPY.addRate}
                              size="sm"
                              numeric
                              data-testid={`rate-preset-edit-rate-${rowId}`}
                              value={editing.fields.rate}
                              error={editErrors.rate}
                              onChange={(event) => typeEdit("rate", event.target.value)}
                            />
                            <Input
                              label={RATE_PRESET_COPY.addMinimum}
                              size="sm"
                              numeric
                              data-testid={`rate-preset-edit-minimum-${rowId}`}
                              value={editing.fields.minimum}
                              error={editErrors.minimum}
                              onChange={(event) => typeEdit("minimum", event.target.value)}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              data-testid={`rate-preset-edit-cancel-${rowId}`}
                              onClick={() => setEditing(null)}
                            >
                              {RATE_PRESET_COPY.addCancel}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              data-testid={`rate-preset-edit-done-${rowId}`}
                              onClick={commitEdit}
                            >
                              {RATE_PRESET_COPY.settingsEditDone}
                            </Button>
                          </li>
                        );
                      }
                      const name = { label: preset.label };
                      return (
                        <li
                          key={rowId}
                          className="flex items-center justify-between gap-2"
                          data-testid={`rate-preset-row-${rowId}`}
                        >
                          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                            <span className="truncate text-sm text-text-strong">
                              {preset.label}
                            </span>
                            <span className="k-mono text-sm">{preset.rate} %</span>
                            {preset.minimum !== undefined && (
                              <span className="k-mono text-sm text-text-muted">
                                {fill(RATE_PRESET_COPY.settingsMinimum, {
                                  minimum: preset.minimum,
                                })}
                              </span>
                            )}
                          </span>
                          <span className="flex shrink-0 gap-1">
                            <IconButton
                              icon="chevron-up"
                              size="sm"
                              label={fill(RATE_PRESET_COPY.settingsMoveUp, name)}
                              data-testid={`rate-preset-up-${rowId}`}
                              disabled={position === 0}
                              onClick={() => move(index, -1)}
                            />
                            <IconButton
                              icon="chevron-down"
                              size="sm"
                              label={fill(RATE_PRESET_COPY.settingsMoveDown, name)}
                              data-testid={`rate-preset-down-${rowId}`}
                              disabled={position === rows.length - 1}
                              onClick={() => move(index, 1)}
                            />
                            <IconButton
                              icon="pencil"
                              size="sm"
                              label={fill(RATE_PRESET_COPY.settingsEdit, name)}
                              data-testid={`rate-preset-edit-${rowId}`}
                              onClick={() => startEdit(index)}
                            />
                            <IconButton
                              icon="trash"
                              size="sm"
                              label={fill(RATE_PRESET_COPY.settingsDelete, name)}
                              data-testid={`rate-preset-delete-${rowId}`}
                              onClick={() => remove(index)}
                            />
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div
                  role="group"
                  aria-label={`${RATE_PRESET_COPY.addGroupLabel} : ${RUBRIQUE_TITLE[rubrique]}`}
                  className="flex flex-wrap items-end gap-2"
                  data-testid={`rate-preset-new-${rubrique}`}
                >
                  <Input
                    label={RATE_PRESET_COPY.addLabel}
                    size="sm"
                    maxLength={RATE_PRESET_LABEL_MAX}
                    data-testid={`rate-preset-new-label-${rubrique}`}
                    value={addFields.label}
                    error={addError.label}
                    onChange={(event) => typeAdd(rubrique, "label", event.target.value)}
                  />
                  <Input
                    label={RATE_PRESET_COPY.addRate}
                    size="sm"
                    numeric
                    data-testid={`rate-preset-new-rate-${rubrique}`}
                    value={addFields.rate}
                    error={addError.rate}
                    onChange={(event) => typeAdd(rubrique, "rate", event.target.value)}
                  />
                  <Input
                    label={RATE_PRESET_COPY.addMinimum}
                    size="sm"
                    numeric
                    data-testid={`rate-preset-new-minimum-${rubrique}`}
                    value={addFields.minimum}
                    error={addError.minimum}
                    onChange={(event) => typeAdd(rubrique, "minimum", event.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft="plus"
                    data-testid={`rate-preset-new-submit-${rubrique}`}
                    onClick={() => add(rubrique)}
                  >
                    {RATE_PRESET_COPY.addSubmit}
                  </Button>
                </div>
              </div>
            );
          })
        )}

        {outcome === "invalid" && (
          <Banner tone="loss" testId="rate-presets-error">
            {RATE_PRESET_COPY.settingsListInvalid}
          </Banner>
        )}
        {mutation.isError && (
          <Banner tone="loss" testId="rate-presets-error">
            {messageForError(mutation.error).text}
          </Banner>
        )}
        {outcome === "saved" && (
          <Banner tone="brand" testId="rate-presets-saved">
            {RATE_PRESET_COPY.settingsSaved}
          </Banner>
        )}

        <Button
          variant="primary"
          data-testid="rate-presets-save"
          disabled={items === undefined}
          loading={mutation.isPending}
          onClick={save}
        >
          {RATE_PRESET_COPY.settingsSave}
        </Button>
      </section>
    </Card>
  );
}
