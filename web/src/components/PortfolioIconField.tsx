import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import {
  ICON_FORMAT_LABELS,
  iconSizeText,
  pickIconFile,
  type PickState,
} from "../lib/icon-pick.js";
import { Button } from "./ui/index.js";

/**
 * `PortfolioIconField.tsx` — the icon control inside `PortfolioDetailsForm`
 * (FR-453 at the UI layer,
 * FR-460, FR-461).
 *
 * A **field**, not a dialog: unlike `InstrumentIconForm`, this issues no
 * request and owns no mutation. It reports one of three intents to the form —
 * *leave the icon alone*, *upload these bytes*, *remove it* — and the form
 * decides when and in what order those become requests (a sequential
 * `PATCH`-then-icon write). Keeping the request out of here is what makes the
 * create path possible at all: on create the bytes travel inside the single
 * `POST` body (FR-455), where there is no icon route to call.
 *
 * ## There is no image preview, and that is a CSP consequence rather than an
 * oversight
 *
 * `img-src 'self'` admits neither `blob:` nor `data:`, and widening it is a
 * non-goal — same-origin bytes are the whole reason the read route exists. So
 * this component constructs no `blob:` and no `data:` URL anywhere.
 *
 * What the user sees instead is a **facts panel**: the filename they chose,
 * the format read from the file's own leading bytes, its pixel dimensions, its
 * size, and a verdict. Every one of those comes from `lib/icon-pick.ts`, which
 * calls the exact function the server runs on the same bytes, so the client's
 * verdict cannot disagree with the server's and a rejection here is worded by
 * the same `MESSAGE_TABLE` entry the server's own code maps to. After a
 * successful save the real icon appears in the tile on the same screen, which
 * is a truer preview than a thumbnail of a file the server has not agreed to
 * accept.
 *
 * The filename is the user's own string, rendered as text (React escapes it)
 * and **never sent**: FR-462's storage carries no filename column and NFR-55
 * forbids echoing a client-supplied string.
 *
 * ## Removal asks first, and only when there is something to remove
 *
 * An uploaded icon is not recoverable from this app once the row is gone — no
 * filename, no copy, nothing to restore from — so « Supprimer l'icône »
 * confirms. On the create path there is nothing to remove, so the control is
 * absent rather than disabled.
 *
 * ## What jsdom can and cannot prove here
 *
 * The suite drives the file input with a real `File` and a `fireEvent.change`,
 * which exercises every pre-flight branch and the whole facts panel. It does
 * **not** prove that a click opens the OS picker, nor that the dialog honours
 * `accept` — jsdom has neither, and `accept` is a hint either way, which is
 * precisely why the bytes are sniffed.
 */

/**
 * What the field is asking the form to do with the icon.
 *
 * `"keep"` is the identity intent and the default in **both** modes: on create
 * there is no icon, on edit the stored one is untouched, and in neither case
 * does an untouched field contribute a request — which is what lets the form
 * issue only the writes the user actually made.
 */
export type IconIntent =
  | { readonly kind: "keep" }
  | { readonly kind: "set"; readonly bytes: Uint8Array; readonly contentType: string }
  | { readonly kind: "remove" };

export interface PortfolioIconFieldProps {
  /** `PortfolioSummary.hasIcon` for the row being edited; `false` on the create path, where removal is meaningless. */
  readonly hasIcon: boolean;
  /** The picker's own state, owned by the form so it survives a re-render and can be read at submit time. */
  readonly pick: PickState;
  readonly onPickChange: (pick: PickState) => void;
  /** `true` once the user has asked for the stored icon to be removed — mutually exclusive with a ready pick. */
  readonly removeRequested: boolean;
  readonly onRemoveRequestedChange: (removeRequested: boolean) => void;
  /** The server's refusal for the icon write specifically, routed here by the form's `ApiError.code` branching (a deliberate non-atomicity on the edit path). */
  readonly errorMessage?: string | undefined;
  readonly disabled?: boolean;
}

/**
 * The field's state ⇒ the intent the form acts on. A pure function of the two
 * pieces of state, exported so the form's submit path and this component's own
 * test read the same rule rather than two copies of it.
 *
 * A ready pick wins over a pending removal: picking a file after asking to
 * remove is a change of mind, and an upload leaves nothing to delete anyway
 * (`PUT` is an upsert, FR-461).
 */
export function iconIntentOf(pick: PickState, removeRequested: boolean): IconIntent {
  if (pick.kind === "ready") {
    return { kind: "set", bytes: pick.bytes, contentType: pick.contentType };
  }
  if (removeRequested) return { kind: "remove" };
  return { kind: "keep" };
}

export function PortfolioIconField({
  hasIcon,
  pick,
  onPickChange,
  removeRequested,
  onRemoveRequestedChange,
  errorMessage,
  disabled = false,
}: PortfolioIconFieldProps) {
  const handlePick = async (file: File | undefined) => {
    onRemoveRequestedChange(false);
    onPickChange(await pickIconFile(file));
  };

  return (
    <div className="k-pf-field" data-testid="portfolio-icon-field">
      <span>{PORTFOLIO_COPY.iconField}</span>

      <p data-testid="portfolio-icon-constraints" className="k-pf-hint">
        {PORTFOLIO_COPY.iconConstraints}
      </p>

      {/* `accept` is a hint to the OS dialog — a user who switches it to "all
          files" walks straight past it — which is why the bytes are sniffed
          here and again on the server (FR-460). */}
      <input
        type="file"
        accept="image/png,image/jpeg"
        data-testid="portfolio-icon-file-input"
        aria-label={PORTFOLIO_COPY.iconChooseFile}
        disabled={disabled}
        onChange={(event) => void handlePick(event.target.files?.[0])}
      />

      {pick.kind === "rejected" && (
        <p role="alert" className="k-pf-error" data-testid="portfolio-icon-rejected">
          {`${pick.fileName} — ${pick.message}`}
        </p>
      )}

      {pick.kind === "ready" && (
        <p data-testid="portfolio-icon-facts" className="k-pf-hint">
          {[
            pick.fileName,
            ICON_FORMAT_LABELS[pick.contentType] ?? pick.contentType,
            `${pick.widthPx} × ${pick.heightPx} px`,
            iconSizeText(pick.bytes.byteLength),
            PORTFOLIO_COPY.iconReady,
          ].join(" · ")}
        </p>
      )}

      {pick.kind === "none" && !removeRequested && (
        <p data-testid="portfolio-icon-state" className="k-pf-hint">
          {hasIcon ? PORTFOLIO_COPY.iconKept : PORTFOLIO_COPY.iconNone}
        </p>
      )}

      {errorMessage !== undefined && (
        <p role="alert" className="k-pf-error" data-testid="portfolio-icon-error">
          {errorMessage}
        </p>
      )}

      {/* Removal is offered only when there is something to remove — so the
          create path never shows it (FR-453's affordance is "clear it", and an
          unset field has nothing to clear). */}
      {hasIcon &&
        (removeRequested ? (
          <div className="k-pf-field-row">
            <p role="alert" data-testid="portfolio-icon-remove-confirm" className="k-pf-hint">
              {PORTFOLIO_COPY.iconRemoveConfirm}
            </p>
            <Button
              variant="ghost"
              size="sm"
              data-testid="portfolio-icon-remove-cancel"
              disabled={disabled}
              onClick={() => onRemoveRequestedChange(false)}
            >
              {PORTFOLIO_COPY.iconRemoveCancel}
            </Button>
          </div>
        ) : (
          <div className="k-pf-field-row">
            <Button
              variant="ghost"
              size="sm"
              data-testid="portfolio-icon-remove"
              disabled={disabled}
              onClick={() => {
                onPickChange({ kind: "none" });
                onRemoveRequestedChange(true);
              }}
            >
              {PORTFOLIO_COPY.iconRemove}
            </Button>
          </div>
        ))}
    </div>
  );
}
