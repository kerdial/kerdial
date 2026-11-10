import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InstrumentDetailResponse } from "../lib/api-client.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import {
  ICON_FORMAT_LABELS,
  iconBytesToBase64,
  iconSizeText,
  pickIconFile,
  type PickState,
} from "../lib/icon-pick.js";
import { messageForError } from "../lib/problem-messages.js";
import {
  removeInstrumentIconMutationOptions,
  setInstrumentIconMutationOptions,
} from "../lib/queries.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Button } from "./ui/index.js";

/**
 * `InstrumentIconForm.tsx` — the **only** surface from which an instrument
 * icon is set, replaced or removed (FR-291, LD-5, and NG2/NG3/NG4, which keep it off
 * the pickers, the asset-search popover, the discovery search and the
 * create form).
 *
 * ## There is no image preview, and that is a CSP consequence rather than an
 * oversight (V6, NG7, AC-311)
 *
 * The obvious thing to build here is a thumbnail of the file the user just
 * picked, from `URL.createObjectURL(file)`. It **cannot render**: this app's
 * `img-src` directive is `'self'`, which admits neither `blob:` nor `data:`,
 * and widening it is an explicit non-goal — the whole reason the bytes are
 * served from a same-origin route in the first place. So this component
 * constructs no `blob:` and no `data:` URL anywhere, and
 * `InstrumentIconForm.test.tsx` asserts that on the source text *and* on the
 * rendered DOM.
 *
 * What the user sees between picking a file and the upload completing is a
 * **facts panel** instead: the filename they chose, the format read from the
 * file's own leading bytes, its pixel dimensions, its size, and a verdict.
 * Every one of those facts comes from {@link sniffInstrumentIcon} — the exact
 * function the server runs on the same bytes (IK-2) — so the client's verdict
 * cannot disagree with the server's, and a rejection message here is read from
 * `MESSAGE_TABLE` by the same code the server would have answered with. That
 * is a stronger guarantee than a thumbnail: a thumbnail shows a file the
 * server has not yet agreed to accept. After a successful save the **real**
 * icon appears in the badge on this same screen, from the same-origin URL.
 *
 * The filename is the user's own string, rendered as text (React escapes it)
 * and **never sent to the server** — FR-304 and NFR-4(b): no client-supplied
 * string is stored, echoed or logged.
 *
 * ## Pre-validation order, and why `file.size` is first
 *
 * 1. `file.size > INSTRUMENT_ICON_MAX_BYTES` ⇒ rejected, and **nothing is
 *    read**. Checking the ceiling before `arrayBuffer()` is what keeps a
 *    50 MB pick from being buffered into the tab's memory to be told it is
 *    too big.
 * 2. otherwise the bytes are read (bounded by step 1) and sniffed.
 * 3. an unsupported signature or an unreadable header ⇒ rejected with that
 *    branch's own code.
 * 4. dimensions over `INSTRUMENT_ICON_MAX_PIXELS` on either axis ⇒ rejected.
 * 5. only then does « Enregistrer » enable, over the buffer already read.
 *
 * The server re-runs every one of these on the bytes it receives and is the
 * authority; this is a pre-flight that saves a round trip and gives an
 * immediate, specific sentence, never the validation itself.
 *
 * ## What jsdom can and cannot prove about this component
 *
 * The suite drives the file input with a real `File` and a `fireEvent.change`,
 * which exercises every branch above and the whole facts panel. It does
 * **not** prove that a click on the native file-picker button opens a picker,
 * nor that the OS dialog honours `accept` — jsdom has neither. `accept` is a
 * hint either way, which is precisely why the bytes are sniffed (FR-292); the
 * real interaction belongs to GATE-3's e2e lane.
 */

/**
 * The pre-flight, the facts-panel formatters and the base64 encoder all live
 * in `lib/icon-pick.ts` (`portfolio-details` PD-17): the portfolio icon field
 * runs the *same* checks against the *same* ceilings, and a second copy here
 * is how the two would drift into accepting different files. The extraction
 * was a pure move — nothing this component does changed with it.
 */

export interface InstrumentIconFormProps {
  /** The instrument being iconed — its `id` addresses the route and its `hasIcon` decides whether removal is offered at all. */
  readonly instrument: InstrumentDetailResponse;
  readonly onSaved: () => void;
  readonly onRemoved: () => void;
  readonly onCancel: () => void;
}

export function InstrumentIconForm({
  instrument,
  onSaved,
  onRemoved,
  onCancel,
}: InstrumentIconFormProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const [pick, setPick] = useState<PickState>({ kind: "none" });
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const setMutation = useMutation(setInstrumentIconMutationOptions(queryClient));
  const removeMutation = useMutation(removeInstrumentIconMutationOptions(queryClient));

  const handlePick = async (file: File | undefined) => {
    setConfirmingRemove(false);
    setPick(await pickIconFile(file));
  };

  const submit = () => {
    if (pick.kind !== "ready") return;
    setMutation.mutate(
      {
        instrumentId: instrument.id,
        // The **sniffed** type, not `file.type`: the browser's guess comes from
        // the extension and is exactly the value FR-292 refuses to trust. The
        // server sniffs again and rejects a disagreement, so sending the
        // sniffed type means an honest client is never refused for the OS
        // having mislabelled a file.
        declaredContentType: pick.contentType,
        bytesBase64: iconBytesToBase64(pick.bytes),
      },
      { onSuccess: () => onSaved() },
    );
  };

  const remove = () => {
    removeMutation.mutate(instrument.id, { onSuccess: () => onRemoved() });
  };

  const busy = setMutation.isPending || removeMutation.isPending;
  const mutationError = setMutation.isError
    ? setMutation.error
    : removeMutation.isError
      ? removeMutation.error
      : undefined;

  return (
    <form
      data-testid="instrument-icon-form"
      className="k-inst-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p data-testid="instrument-icon-constraints" className="k-inst-note">
        {INSTRUMENT_COPY.iconConstraints}
      </p>

      {/* `accept` is a hint to the OS dialog — a user who switches it to "all
          files" walks straight past it — which is why the bytes are sniffed
          below and again on the server (FR-292). The same reasoning
          `ImportWizard.tsx`'s CSV input records for itself. */}
      <input
        type="file"
        accept="image/png,image/jpeg"
        data-testid="instrument-icon-file-input"
        aria-label={INSTRUMENT_COPY.iconChooseFile}
        onChange={(event) => void handlePick(event.target.files?.[0])}
      />

      {pick.kind === "rejected" && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-icon-rejected"
        >
          {`${pick.fileName} — ${pick.message}`}
        </p>
      )}

      {pick.kind === "ready" && (
        <p data-testid="instrument-icon-facts" className="k-inst-note">
          {[
            pick.fileName,
            ICON_FORMAT_LABELS[pick.contentType] ?? pick.contentType,
            `${pick.widthPx} × ${pick.heightPx} px`,
            iconSizeText(pick.bytes.byteLength),
            INSTRUMENT_COPY.iconReady,
          ].join(" · ")}
        </p>
      )}

      {pick.kind === "none" && !instrument.hasIcon && (
        <p data-testid="instrument-icon-none" className="k-inst-note">
          {INSTRUMENT_COPY.iconNone}
        </p>
      )}

      {mutationError !== undefined && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-icon-error"
        >
          {messageForError(mutationError).text}
        </p>
      )}

      {!online && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-icon-offline-error"
        >
          {COMMON_COPY.offlineExplanation}
        </p>
      )}

      {/* Removal is offered only when there is something to remove — and it
          asks first, since an icon the user uploaded is not recoverable from
          this app once the row is gone (no filename, no copy, nothing to
          restore from). */}
      {instrument.hasIcon &&
        (confirmingRemove ? (
          <div className="k-inst-form-row">
            <p role="alert" data-testid="instrument-icon-remove-confirm" className="k-inst-note">
              {INSTRUMENT_COPY.iconRemoveConfirm}
            </p>
            <Button
              variant="ghost"
              size="sm"
              data-testid="instrument-icon-remove-cancel"
              onClick={() => setConfirmingRemove(false)}
            >
              {COMMON_COPY.cancel}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-testid="instrument-icon-remove-confirmed"
              disabled={!online || busy}
              onClick={remove}
            >
              {INSTRUMENT_COPY.iconRemove}
            </Button>
          </div>
        ) : (
          <div className="k-inst-form-row">
            <Button
              variant="ghost"
              size="sm"
              data-testid="instrument-icon-remove"
              onClick={() => setConfirmingRemove(true)}
            >
              {INSTRUMENT_COPY.iconRemove}
            </Button>
          </div>
        ))}

      <div className="k-inst-form-actions">
        <Button variant="ghost" data-testid="instrument-icon-cancel" onClick={onCancel}>
          {COMMON_COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="instrument-icon-submit"
          disabled={!online || busy || pick.kind !== "ready"}
        >
          {instrument.hasIcon ? INSTRUMENT_COPY.iconReplace : INSTRUMENT_COPY.iconAdd}
        </Button>
      </div>
    </form>
  );
}
