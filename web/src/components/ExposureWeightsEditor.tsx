import type { Dispatch } from "react";
import type { ExposureWeightDimension } from "@kerdial/api-contracts";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import type {
  ExposureWeightRowsAction,
  ExposureWeightRowsState,
  ExposureWeightSetView,
} from "../lib/exposure-weights-form.js";
import { sectorDisplayLabel } from "../lib/sector-display.js";
import { CountryPicker } from "./CountryPicker.js";
import { Button, IconButton, Input, Select, type SelectOption } from "./ui/index.js";

/**
 * `<ExposureWeightsEditor>` — one dimension's hand-entered weight set inside
 * the classification dialog (FR-734): « Pondérations par secteur » or
 * « Pondérations par pays ». A list of rows (bucket, percentage) with add and
 * remove, the live total and the « Reste non classé » under it, and each
 * row's refusal beside it.
 *
 * Controlled: the rows live in the form (`exposure-weights-form.ts`'s
 * reducer), which also needs them to build the request and to decide whether
 * saving is allowed; this component only renders them and dispatches edits.
 *
 * - **Sector rows** use the native `Select` over `SECTOR_CODES` minus the
 *   codes chosen in other rows (nine fixed options stay a native control).
 * - **Country rows** use `CountryPicker` with the codes of the other rows as
 *   `excludedCodes`, so a duplicate country cannot be picked (AC-633).
 *
 * A weight set has no dates (EW-L12) and no « Autres » bucket (EW-L6): what
 * is not listed is « Non classé ».
 */
export interface ExposureWeightsEditorProps {
  readonly dimension: ExposureWeightDimension;
  readonly state: ExposureWeightRowsState;
  readonly dispatch: Dispatch<ExposureWeightRowsAction>;
  readonly view: ExposureWeightSetView;
  readonly disabled?: boolean;
}

const TITLE: Readonly<Record<ExposureWeightDimension, string>> = {
  sector: INSTRUMENT_COPY.weightsSectorTitle,
  country: INSTRUMENT_COPY.weightsCountryTitle,
};

function sectorOptions(own: string, taken: ReadonlySet<string>): readonly SelectOption[] {
  return [
    { value: "", label: INSTRUMENT_COPY.weightsSectorChoose },
    ...SECTOR_CODES.filter((code) => code === own || !taken.has(code)).map((code) => ({
      value: code,
      label: sectorDisplayLabel(code),
    })),
  ];
}

export function ExposureWeightsEditor({
  dimension,
  state,
  dispatch,
  view,
  disabled = false,
}: ExposureWeightsEditorProps) {
  const testId = `instrument-weights-${dimension}`;
  const summary =
    view.totalText === null
      ? null
      : view.remainderText === null
        ? view.totalText
        : `${view.totalText} · ${view.remainderText}`;

  return (
    <fieldset className="k-weights" data-testid={testId}>
      <legend className="k-weights-title">{TITLE[dimension]}</legend>
      {state.rows.length > 0 && (
        <ul className="k-weights-rows">
          {state.rows.map((row) => {
            const taken = new Set(
              state.rows
                .filter((other) => other.rowId !== row.rowId && other.code !== "")
                .map((other) => other.code),
            );
            const error = view.rowErrors.get(row.rowId);
            return (
              <li key={row.rowId} className="k-weights-row" data-testid={`${testId}-row`}>
                <div className="k-weights-bucket">
                  {dimension === "sector" ? (
                    <Select
                      label={INSTRUMENT_COPY.weightsSectorField}
                      data-testid={`${testId}-sector-select`}
                      options={sectorOptions(row.code, taken)}
                      value={row.code}
                      disabled={disabled}
                      onChange={(event) =>
                        dispatch({ type: "setCode", rowId: row.rowId, code: event.target.value })
                      }
                    />
                  ) : (
                    <CountryPicker
                      label={INSTRUMENT_COPY.weightsCountryField}
                      value={row.code === "" ? null : row.code}
                      onChange={(next) =>
                        dispatch({ type: "setCode", rowId: row.rowId, code: next ?? "" })
                      }
                      excludedCodes={taken}
                      testId={`${testId}-country-${row.rowId}`}
                      disabled={disabled}
                    />
                  )}
                </div>
                <div className="k-weights-percent">
                  <Input
                    type="text"
                    numeric
                    suffix="%"
                    label={INSTRUMENT_COPY.weightsPercentField}
                    data-testid={`${testId}-percent`}
                    value={row.weightText}
                    disabled={disabled}
                    onChange={(event) =>
                      dispatch({
                        type: "setWeight",
                        rowId: row.rowId,
                        weightText: event.target.value,
                      })
                    }
                  />
                </div>
                <div className="k-weights-remove">
                  <span className="k-field-label" aria-hidden="true">
                    {"\u00a0"}
                  </span>
                  <IconButton
                    icon="trash"
                    label={INSTRUMENT_COPY.weightsRemoveRow}
                    data-testid={`${testId}-remove`}
                    disabled={disabled}
                    onClick={() => dispatch({ type: "remove", rowId: row.rowId })}
                  />
                </div>
                {error !== undefined && (
                  <p
                    className="k-field-error k-weights-error"
                    role="alert"
                    data-testid={`${testId}-error`}
                  >
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {summary !== null && (
        <p className="k-weights-total" aria-live="polite" data-testid={`${testId}-total`}>
          {summary}
        </p>
      )}
      <div>
        <Button
          variant="ghost"
          size="sm"
          iconLeft="plus"
          data-testid={`${testId}-add`}
          disabled={disabled}
          onClick={() => dispatch({ type: "add" })}
        >
          {INSTRUMENT_COPY.weightsAddRow}
        </Button>
      </div>
    </fieldset>
  );
}
