import type { RatePreset } from "@kerdial/api-contracts";
import { apiFetch } from "./core.js";

/**
 * `/api/v1/settings/*` — the rate presets the transaction dialog's chips read
 * (FR-666).
 *
 * The wire shape is the shared contract's (`ratePresetListSchema` in
 * `@kerdial/api-contracts`), so it is imported rather than mirrored by hand:
 * the « + » mini-form validates the list it is about to send with that same
 * schema. Every rate and minimum is a canonical decimal **string**; a minimum is an absent key when there is none.
 *
 * **No read budget.** One small read per dialog opening, cached under one key
 * (`queries/settings.ts`), the reasoning `fx.ts` records for its own one-shot
 * read.
 */
export interface RatePresetListResponse {
  readonly items: readonly RatePreset[];
}

/** `GET /settings/rate-presets` — the stored list, or the server's four defaults while none is stored. */
export function fetchRatePresets(signal?: AbortSignal): Promise<RatePresetListResponse> {
  return apiFetch<RatePresetListResponse>("/settings/rate-presets", undefined, signal);
}

/** `PUT /settings/rate-presets` — replaces the **whole** list (TDR-D3) and answers it as stored, canonicalised (C-15). */
export function saveRatePresets(list: RatePresetListResponse): Promise<RatePresetListResponse> {
  return apiFetch<RatePresetListResponse>("/settings/rate-presets", {
    method: "PUT",
    body: JSON.stringify(list),
  });
}
