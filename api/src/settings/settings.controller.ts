import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import { ratePresetListSchema } from "@kerdial/api-contracts";
import { getRatePresets, replaceRatePresets } from "@kerdial/ledger";
import type { SessionContext } from "@kerdial/platform-auth";
import type { Db } from "@kerdial/platform-db";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { DB } from "../db/db.tokens.js";
import type { RatePresetsResponse } from "./settings.schema.js";

/**
 * `/settings/*`
 * (TDR-T4); FR-664, FR-666, FR-667, NFR-85, AC-553..AC-556.
 *
 * Two routes over the tenant's one rate-preset list: a read, and a whole-list
 * replace (TDR-D3 — the list holds at most 18 items, is always read whole, and
 * its cross-item rules are checked once against one snapshot).
 *
 * Auth and CSRF are the global `AuthGuard`/`CsrfGuard` (`app.module.ts`'s
 * `APP_GUARD`s), so `auth.e2e.test.ts`'s route-registry sweep covers both
 * routes with no edit. No route-level throttle: the instance-wide admission
 * bound is the only one. **The controller logs nothing of its own**
 * (NFR-85): a label or a rate is user text, and no line here may carry it.
 * No new error code: a schema failure is `parseOrThrow`'s per-field `400`, and
 * the service raises no domain error.
 */
@Controller("settings")
export class SettingsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** `GET /settings/rate-presets` — the stored list, or the four defaults while none is stored. Never writes. */
  @Get("rate-presets")
  async ratePresets(@CurrentSession() session: SessionContext): Promise<RatePresetsResponse> {
    return { items: await getRatePresets(this.db, session.tenantId) };
  }

  /**
   * `PUT /settings/rate-presets` — replace the whole list; `200` with the list
   * as stored, which is canonicalised (`"0.350"` reads back `"0.35"`, C-15).
   * An identical list is a no-op (FR-667). `{ items: [] }` is a stored state,
   * never re-seeded (AC-553).
   */
  @Put("rate-presets")
  async replaceRatePresets(
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<RatePresetsResponse> {
    const parsed = parseOrThrow(ratePresetListSchema, body);
    return { items: await replaceRatePresets(this.db, session.tenantId, parsed.items) };
  }
}
