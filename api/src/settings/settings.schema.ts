import type { RatePreset } from "@kerdial/api-contracts";

/**
 * DTOs for `/settings/*` (TDR-T4); FR-666.
 *
 * The request schema is `@kerdial/api-contracts`' `ratePresetListSchema`,
 * imported by identity in the controller rather than re-declared here, so the
 * web form and this route validate against the same object. The response is the same `{ items }` shape: the stored list, in
 * display order, every decimal a canonical string.
 */
export interface RatePresetsResponse {
  readonly items: readonly RatePreset[];
}
