import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseDecimalString } from "@kerdial/core-decimal";
import type { WatchlistRow } from "../lib/api-client.js";
import {
  WATCHLIST_NOTE_MAX_LENGTH,
  WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES,
} from "../lib/api-limits.js";
import { fill } from "../lib/copy/fill.js";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { messageForError } from "../lib/problem-messages.js";
import { updateWatchlistItemMutationOptions } from "../lib/queries.js";
import { Button, IconButton, Input } from "./ui/index.js";
import { LedgerAmount } from "./LedgerAmount.js";

/**
 * `WatchlistTargetEditor.tsx` — UR-53/FR-341's target-price and note editor.
 *
 * ## Moved off the row, unchanged in contract
 *
 * This component shipped inside `WatchlistTable.tsx` as `WatchlistRowEditor`,
 * one per row on both list surfaces. The owner's verdict on the shipped list
 * was that the row was too heavy — the editor was the widest cell (target,
 * note and a pencil, then two fields once open). It now lives on the
 * instrument's own analysis screen (`WatchlistAnalysisView.tsx`), once, and
 * the row shows the target **read-only**. Same component, same test ids
 * (`watchlist-edit-*`), same `PATCH /watchlist/:instrumentId` contract, same
 * WL-1 guard — only the mount point moved, which is what let the e2e tests
 * change a `goto` and nothing else.
 *
 * ## It sends only what changed
 *
 * That is what makes the route's three-way contract usable: an untouched
 * field is an absent key (leave it alone), a cleared field is an explicit
 * `null` (clear it), and a filled one is a value. Sending `{targetPrice: null}`
 * for a field the user never touched would wipe a stored target on every note
 * edit.
 *
 * The saved value re-renders because the mutation invalidates `["watchlist"]`
 * and the screen re-reads (AC-345) — the response is the **stored row**, not
 * the valued one, so nothing here patches a row in place from a write's answer.
 */

/**
 * WL-1 — the target-price field's own scale bound, checked
 * **before** the `PATCH` is issued, exactly as the note field is bounded by
 * `maxLength` rather than discovered as a 400.
 *
 * `watchlist_item.target_price` is `numeric(38, 18)`: a 19th fractional digit
 * is either rounded away (to zero below 5e-19, which the table's positive
 * CHECK then refuses as a raw `23514` — the 500 this finding recorded) or
 * silently truncates the figure the user typed. The bound comes from
 * `api-limits.ts`'s mirror of `ledger`'s constant, never a literal here.
 *
 * **Only the scale.** A non-positive or unparseable entry is deliberately
 * left to the server's own refusal (`VALIDATION_ERROR`, rendered by
 * `messageForError` below): this helper exists to close the one gap the
 * finding names, not to grow a second, drifting copy of the request schema.
 * The count is `Decimal#decimalPlaces()` — never `Number()`/`parseFloat`,
 * which `web/src`'s own eslint rule forbids outright.
 */
export function watchlistTargetPriceScaleError(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  let parsed;
  try {
    parsed = parseDecimalString(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.decimalPlaces() > WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES) {
    return fill(WATCHLIST_COPY.targetPriceScaleError, {
      max: String(WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES),
    });
  }
  return undefined;
}

export function WatchlistTargetEditor({
  row,
  testId,
}: {
  readonly row: WatchlistRow;
  readonly testId: string;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(updateWatchlistItemMutationOptions(queryClient));
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(row.targetPrice ?? "");
  const [note, setNote] = useState(row.note ?? "");

  if (!editing) {
    return (
      <span className="k-wl-edit">
        <span data-testid={`${testId}-target`} className="k-num">
          {row.targetPrice === null ? (
            WATCHLIST_COPY.targetPriceEmpty
          ) : (
            <LedgerAmount amount={row.targetPrice} currency={row.listingCurrency} />
          )}
        </span>
        <span data-testid={`${testId}-note`} className="k-wl-note">
          {row.note ?? WATCHLIST_COPY.noteEmpty}
        </span>
        <IconButton
          icon="pencil"
          label={fill(WATCHLIST_COPY.targetPriceEdit, { name: row.displayName })}
          size="sm"
          data-testid={`${testId}-open`}
          onClick={() => {
            setTarget(row.targetPrice ?? "");
            setNote(row.note ?? "");
            setEditing(true);
          }}
        />
      </span>
    );
  }

  const storedTarget = row.targetPrice ?? "";
  const storedNote = row.note ?? "";
  const targetScaleError = watchlistTargetPriceScaleError(target);

  return (
    <span className="k-wl-edit k-wl-edit-open">
      <Input
        label={WATCHLIST_COPY.targetPriceLabel}
        size="sm"
        numeric
        inputMode="decimal"
        suffix={row.listingCurrency}
        data-testid={`${testId}-target-input`}
        // WL-1: `<Input>`'s own error slot — `aria-invalid` plus
        // an `alert` message — so the 19th fractional digit is refused in the
        // field, and {@link watchlistTargetPriceScaleError} then blocks the
        // save below. Both halves are needed: a message nobody is stopped by
        // is not a bound.
        error={targetScaleError}
        value={target}
        onChange={(event) => setTarget(event.target.value)}
      />
      <Input
        label={WATCHLIST_COPY.noteLabel}
        size="sm"
        // Bounded by the server's own constant, mirrored in `api-limits.ts`
        // (FR-341): the field refuses the 501st character rather than letting
        // the user discover the limit as a 400.
        maxLength={WATCHLIST_NOTE_MAX_LENGTH}
        data-testid={`${testId}-note-input`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <Button
        size="sm"
        variant="primary"
        data-testid={`${testId}-save`}
        loading={mutation.isPending}
        onClick={() => {
          // WL-1 — refused here, so no request is issued at all.
          if (targetScaleError !== undefined) return;
          const trimmedTarget = target.trim();
          const trimmedNote = note.trim();
          const patch = {
            instrumentId: row.instrumentId,
            // Absent when unchanged, `null` when cleared, the value otherwise
            // — see this component's own doc comment.
            ...(trimmedTarget === storedTarget
              ? {}
              : { targetPrice: trimmedTarget === "" ? null : trimmedTarget }),
            ...(trimmedNote === storedNote
              ? {}
              : { note: trimmedNote === "" ? null : trimmedNote }),
          };
          mutation.mutate(patch, { onSuccess: () => setEditing(false) });
        }}
      >
        {WATCHLIST_COPY.editSave}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid={`${testId}-cancel`}
        onClick={() => setEditing(false)}
      >
        {WATCHLIST_COPY.editCancel}
      </Button>
      {mutation.isError && (
        <span role="alert" data-testid={`${testId}-error`} className="k-wl-toggle-note">
          {messageForError(mutation.error).text}
        </span>
      )}
    </span>
  );
}
