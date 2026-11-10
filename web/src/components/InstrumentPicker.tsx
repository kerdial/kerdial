import { useState } from "react";
import type { InstrumentSummary } from "../lib/api-client.js";
import { Button } from "./ui/index.js";
import { AssetSearchPopover } from "./AssetSearchPopover.js";
import { InstrumentCreateDialog } from "./InstrumentCreateDialog.js";
import { InstrumentResultRow } from "./InstrumentResultRow.js";
import { FORM_COPY } from "../lib/copy/forms.js";

function FieldError({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p role="alert" className="k-field-error">
      {message}
    </p>
  );
}

export interface InstrumentPickerProps {
  label: string;
  value: string;
  /** `symbol` is the instrument's own ticker/ISIN (falling back to its display name) — needed wherever a caller labels an FX/quote-rate direction off the selected instrument itself (the settlement leg, F2 security review), not merely off a currency field. */
  onChange: (id: string, label: string, symbol: string) => void;
  error: string | undefined;
  testId: string;
}

/**
 * `GET /instruments?query=` (T-37) backed picker — the transaction form's
 * instrument control (extracted from `TransactionForm.tsx`).
 *
 * The search field itself is now `AssetSearchPopover`: a
 * real combobox over a keyboard-driven listbox, with the class chips and the
 * "N of M" footer. This component keeps what is *not* search — the selected
 * state, the field error, and the `InstrumentCreateDialog` the popover's
 * create action opens (F3 below is exactly why that dialog stays mounted
 * here, a sibling of both branches, rather than moving into the popover that
 * unmounts on selection). The read is unchanged: same
 * `instrumentSearchQueryOptions`, same debounce, one level down.
 */
export function InstrumentPicker({ label, value, onChange, error, testId }: InstrumentPickerProps) {
  /** The picked row itself, so the selected state renders the same `InstrumentResultRow` the search showed (FR-661, AC-552). */
  const [selected, setSelected] = useState<InstrumentSummary | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  /** The text the user had typed when they reached for "Créer un instrument…" — the create dialog's `initialDisplayName`. Held here because the popover unmounts its own query state the moment the dialog's success path selects an instrument. */
  const [createSeed, setCreateSeed] = useState("");

  /** Shared by a search-result click and the "Créer un instrument…" flow's success/duplicate outcome (`InstrumentCreateDialog`'s `onCreated`) — same selection every path lands on. */
  function selectInstrument(instrument: InstrumentSummary): void {
    const symbol = instrument.symbol ?? instrument.isin ?? instrument.displayName;
    const optionLabel = `${instrument.displayName} (${instrument.symbol ?? instrument.isin ?? instrument.id})`;
    setSelected(instrument);
    onChange(instrument.id, optionLabel, symbol);
  }

  // F3 (tester-found defect): the
  // creation dialog used to be rendered only inside the `value === ""`
  // branch below, so `selectInstrument` — called synchronously from
  // `InstrumentCreateDialog`'s own `onCreated` prop, at the exact moment it
  // sets its *own* `createdInstrument` state to show the success panel —
  // flipped `value` to non-empty in that same React commit, which switched
  // this component to the `value !== ""` branch and unmounted
  // `<InstrumentCreateDialog>` entirely before its success panel (and the
  // `InstrumentHistoryStatus` indication D9 requires) ever painted.
  // `NewInstrumentButton.tsx`'s standalone launch point has no equivalent
  // hazard because it always mounts `InstrumentCreateDialog` unconditionally
  // — this now does the same: the dialog is rendered once, as a sibling of
  // whichever branch below is currently showing, so selecting the freshly
  // created instrument no longer unmounts it out from under itself. The
  // dialog still owns its own close timing entirely (its internal
  // `createdInstrument` state, `handleOpenChange`) — this parent only ever
  // flips `createDialogOpen` open (on "Créer un instrument…") or closed (via
  // `onOpenChange`, called by the dialog itself: immediately for a
  // non-backfillable kind/409-existing outcome, or once the user dismisses
  // the success panel for a backfillable one).
  const pickerContent =
    value !== "" ? (
      <div className="k-field">
        <span className="k-field-label">{label}</span>
        <div data-testid={`${testId}-selected`} className="k-ov-asset">
          {/* A value this instance did not pick (none today) still shows
              something rather than an empty box: the bare id, as before. */}
          {selected !== null && selected.id === value ? (
            <InstrumentResultRow instrument={selected} />
          ) : (
            <span className="k-ov-asset-name">{value}</span>
          )}
          <Button
            variant="secondary"
            size="sm"
            data-testid={`${testId}-change`}
            onClick={() => {
              setSelected(null);
              onChange("", "", "");
            }}
          >
            {FORM_COPY.change}
          </Button>
        </div>
        <FieldError message={error} />
      </div>
    ) : (
      <div className="k-field">
        {/* The instrument-creation UI task, now the popover's footer action: a
            search that finds nothing offers creating the instrument on the
            spot, rather than a dead end that blocks the very first transaction
            against a catalogue that has never been populated. */}
        <AssetSearchPopover
          label={label}
          testId={testId}
          onSelect={selectInstrument}
          onCreate={(typed) => {
            setCreateSeed(typed);
            setCreateDialogOpen(true);
          }}
        />
        <FieldError message={error} />
      </div>
    );

  return (
    <>
      {pickerContent}
      <InstrumentCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        initialDisplayName={createSeed}
        onCreated={(instrument) => selectInstrument(instrument)}
      />
    </>
  );
}
