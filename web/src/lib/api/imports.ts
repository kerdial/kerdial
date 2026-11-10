import type {
  ImportFileTypeName,
  ImportInstrumentResolution,
  ImportMode,
  ImportSummaryResponse,
  ImportTransferDestination,
} from "@kerdial/api-contracts";
import { API_BASE, apiFetch } from "./core.js";

/**
 * `POST /api/v1/imports/instruments` and `POST /api/v1/imports/transactions` —
 * the two routes Batch D shipped (CI-16), reached from the `/import` wizard (CI-22).
 *
 * ## Everything here is a `FormData` body, and that is the point
 *
 * These are this codebase's **first** `FormData` callers. `apiFetch` used to
 * stamp `content-type: application/json` on any body at all, which would have
 * sent a multipart upload with no boundary; CI-21 fixed that and
 * `core.test.ts` holds the line. Nothing below sets a `content-type` — the
 * browser must, because only it knows the boundary it generated.
 *
 * ## Why the fields are stringified here rather than in the wizard
 *
 * `multipart/form-data` has no types: every field on the wire is a string
 * (`core/api-contracts`'s `import-request.schema.ts` says so, and validates
 * accordingly). Doing the conversion in one place means the wizard never has
 * to remember that `resolutions` in particular is a **JSON document carried as
 * a string** — the one structured field, and the one a caller would most
 * naturally hand over as an array and silently serialise as
 * `[object Object]`.
 *
 * ## No read budget
 *
 * Unlike every GET wrapper in the sibling modules, these are one-shot,
 * user-initiated writes behind an explicit button, so they do not run through
 * `cheapReadBudget`/`valuationReadBudget` — the same convention
 * `createTransaction`/`editTransaction` already follow. The server has its own
 * pair of caps for this route (a rate cap and a concurrency cap of 1),
 * which is what actually bounds them.
 */

/** The asset-catalogue route. `fileType` is absent by design: the route *is* `ASSETS` (NG3). */
export function importInstrumentsFile(params: {
  readonly file: File;
  readonly mode: ImportMode;
  /**
   * Required on `APPLY`, and it is what makes the confirm issue **zero**
   * provider calls: the user re-submits the list the dry run proposed,
   * *as they edited it*, rather than the server re-running discovery.
   */
  readonly resolutions?: readonly ImportInstrumentResolution[];
}): Promise<ImportSummaryResponse> {
  const body = new FormData();
  body.set("file", params.file, params.file.name);
  body.set("mode", params.mode);
  if (params.resolutions !== undefined) {
    body.set("resolutions", JSON.stringify(params.resolutions));
  }
  return apiFetch<ImportSummaryResponse>("/imports/instruments", { method: "POST", body });
}

/**
 * The transaction route. Both ids are required in **both** modes, not only on
 * the apply: a dry run resolves each row's instrument and computes each row's
 * fingerprint against the destination it would be written to, so a dry run
 * without one would report counts for an import nobody could confirm.
 */
export function importTransactionsFile(params: {
  readonly file: File;
  readonly mode: ImportMode;
  readonly fileType: Exclude<ImportFileTypeName, "ASSETS">;
  readonly portfolioId: string;
  readonly cashAccountId: string;
  /**
   * `security-transfer` FR-583: where each source-leg transfer's units went.
   * A JSON document carried as a string, like `resolutions`. Omitted when
   * empty — the server reads absence as "every such row written alone", which
   * is what an empty list means too.
   */
  readonly transferDestinations?: readonly ImportTransferDestination[];
}): Promise<ImportSummaryResponse> {
  const body = new FormData();
  body.set("file", params.file, params.file.name);
  body.set("mode", params.mode);
  body.set("fileType", params.fileType);
  body.set("portfolioId", params.portfolioId);
  body.set("cashAccountId", params.cashAccountId);
  if (params.transferDestinations !== undefined && params.transferDestinations.length > 0) {
    body.set("transferDestinations", JSON.stringify(params.transferDestinations));
  }
  return apiFetch<ImportSummaryResponse>("/imports/transactions", { method: "POST", body });
}

/**
 * The two Kerdial routes (EI-26/EI-33). **Two fields, `file` and `mode`, and nothing else.**
 *
 * ## The three fields the sibling wrappers send and these deliberately do not
 *
 * - **`fileType`** — the route *is* the file type, the same rule applied to
 *   two more routes (NG3).
 * - **`portfolioId`/`cashAccountId`** — a Kerdial CSV names its portfolio and
 *   cash account **per row** (FR-532/FR-533) and a catalogue package carries
 *   whole portfolios, so there is no single destination to send. This is the
 *   same fact the wizard expresses by skipping its own destination step.
 * - **`resolutions`** — read by nothing on either route:
 *   `planCatalogue` makes no proposals, and a Kerdial transactions row carries
 *   no `kind` and no listing currency, so an unresolved identity can only be
 *   `INSTRUMENT_NOT_RESOLVED` and never a proposal. The server made the field
 *   optional rather than keep requiring a value nothing reads, so this client
 *   sends none — a dead field on the wire is a field a later reader will
 *   believe.
 *
 * One function for the two routes, given the field sets are identical and the
 * server validates both through one schema (`importKerdialFieldsSchema`): two
 * copies of one `FormData` build would be two things to keep in step for no
 * stated difference.
 */
export function importKerdialFile(params: {
  readonly file: File;
  readonly mode: ImportMode;
  readonly fileType: "KERDIAL_CATALOGUE" | "KERDIAL_TRANSACTIONS";
}): Promise<ImportSummaryResponse> {
  const body = new FormData();
  body.set("file", params.file, params.file.name);
  body.set("mode", params.mode);
  const path =
    params.fileType === "KERDIAL_CATALOGUE"
      ? "/imports/kerdial/catalogue"
      : "/imports/kerdial/transactions";
  return apiFetch<ImportSummaryResponse>(path, { method: "POST", body });
}

/**
 * `GET /exports/instruments` and `GET /exports/transactions` as **paths for an
 * `<a href download>`**, not as `fetch` wrappers — and the whole
 * point of the pair.
 *
 * These are CSRF-exempt GETs whose session cookie rides a same-origin
 * navigation, and the server already sets `Content-Disposition: attachment`
 * with the filename. A `fetch` + `URL.createObjectURL` path would hold a second
 * copy of a file up to 32 MiB in browser memory and invent a filename that
 * could disagree with the server's. So there is no function here to call: there
 * are two strings to put in an `href`, declared beside the import wrappers
 * because that is where a reader looks for the shape of this surface.
 *
 * `API_BASE` is not re-derived: `core.ts` owns the prefix every other call
 * in this directory goes through.
 */
export const EXPORT_CATALOGUE_HREF = `${API_BASE}/exports/instruments?icons=included`;
export const EXPORT_CATALOGUE_WITHOUT_ICONS_HREF = `${API_BASE}/exports/instruments?icons=omitted`;
export const EXPORT_TRANSACTIONS_HREF = `${API_BASE}/exports/transactions`;
