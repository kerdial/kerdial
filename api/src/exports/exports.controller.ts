import { Controller, Get, Inject, Query, Res, UseInterceptors } from "@nestjs/common";
import type { KerdialJsonLimits } from "@kerdial/importer";
import type { SessionContext } from "@kerdial/platform-auth";
import { rootLogger } from "@kerdial/platform-logging";
import type { Db } from "@kerdial/platform-db";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { exportThrottleInterceptor } from "../common/export-throttle.interceptor.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { DB } from "../db/db.tokens.js";
import { KERDIAL_JSON_IMPORT_LIMITS } from "../imports/import-limits.tokens.js";
import { EXPORT_READS, type ExportReads } from "./exports.tokens.js";

/**
 * `GET /exports/instruments` and `GET /exports/transactions` — the whole-tenant
 * export (FR-500,
 * FR-508–FR-513).
 *
 * ## What this controller is, and what it deliberately is not
 *
 * It is a header-setter and a size gate. Every read, every `withTenant`
 * transaction and both serializers live in `exports.reads.ts` (EI-21) and in
 * `@kerdial/importer`; nothing below opens a transaction, touches a
 * table or formats a byte of the body.
 *
 * ## Auth, CSRF and caching — three properties, none of them added here
 *
 *  - **Session-guarded** by the global `AuthGuard` (`app.module.ts`'s
 *    `APP_GUARD`), like every other route: no `@Public()`, no per-route
 *    opt-in.
 *  - **No CSRF token needed, and that is measured rather than assumed**:
 *    `CsrfGuard` returns `true` for any method outside
 *    `STATE_CHANGING_METHODS = {POST, PUT, PATCH, DELETE}` (MEASURED,
 *    `api/src/auth/csrf.guard.ts:10,50`, re-read 2026-09-24). So a plain
 *    `<a href="/api/v1/exports/transactions" download>` works — a same-origin
 *    GET carrying the session cookie and no custom header — which is the
 *    delivery path the web client takes. `exports.e2e.test.ts` asserts the exemption over
 *    real HTTP rather than trusting this paragraph.
 *  - **`Cache-Control: no-store` is inherited, not set here**:
 *    `security-headers.ts`'s `cacheControlForPath` returns `no-store` for
 *    everything under `/api/v1`, applied by `buildApp`'s global `onSend`
 *    (MEASURED, `api/src/app.ts:459-462`). An export body is tenant financial
 *    data; it is covered by construction, and the e2e asserts it per case —
 *    including on the `413`, where the body is a problem document and the rule
 *    still has to hold.
 *
 * ## The `Buffer` response, and why `passthrough` is load-bearing
 *
 * Both handlers follow `GET /instruments/:id/icon`'s shape exactly (MEASURED,
 * `api/src/instruments/instruments.controller.ts:741-765`): `@Res({ passthrough:
 * true })`, the three headers set **before** the return, and the bytes
 * *returned* so Nest's pipeline stays in charge. A non-passthrough `@Res()`
 * takes Nest out of the response path, and the instance-wide admission bound
 * releases its in-flight slot in `finalize` — so it would leak a slot per
 * export until the cap wedged shut (`common/admission-bound.interceptor.ts`,
 * and that route's own doc comment recording the same hazard).
 *
 * ## The filename is a constant (FR-509)
 *
 * `kerdial-instruments.json` and `kerdial-transactions.csv` are written as
 * literals below and interpolate nothing. There is no request field that names
 * a file, so there is nothing to reflect — the icon route's own discipline,
 * reached by a different road (it emits no filename because it stores none).
 *
 * ## `413 EXPORT_TOO_LARGE`, never a truncated file (KD4)
 *
 * The catalogue's ceiling is the **same constant** the import route's
 * `maxFileBytes` is, and the symmetry is the point: this product must never
 * emit a file it cannot take back. Past it, the response is a problem document
 * naming the byte size, the ceiling and `?icons=omitted` as the remedy.
 *
 * **It is decided twice, and the first one is the one that matters**
 * (security review M2). This controller used to decide it only
 * on `result.byteLength`, i.e. after `exports.reads.ts` had built the whole
 * document — at the shipped icon cap that is ~500 × 349 528 base64 characters
 * plus the JSON around them plus the `Buffer` under them, ~0.5 GB per request,
 * on a route whose default is `icons=included` and whose trigger is the primary
 * export link. The ceiling now travels *into* the read, which charges each icon
 * row against it on `byte_length` before encoding anything and stops paging; the
 * byte check below survives as the exact backstop for the JSON overhead the
 * projection deliberately under-counts.
 *
 * The transactions CSV has no such gate: its size is bounded by the row cap and by
 * the ~277 bytes/row (MEASURED, EI-23), not by an icon budget, and inventing
 * a second ceiling for it would be a limit with no arithmetic behind it.
 */

/**
 * `?icons=` — KD4.2's size lever. **Defaulting to `included`** because the
 * unqualified export is the backup: a document that silently dropped icons
 * would round-trip into a tenant missing them, and the ceiling's own remedy
 * text ("try `?icons=omitted`") only reads as a remedy if the default is the
 * other one.
 */
const exportsCatalogueQuerySchema = z.strictObject({
  icons: z.enum(["included", "omitted"]).default("included"),
});

/** FR-508's two names, as literals. Nothing client-supplied reaches either. */
const CATALOGUE_FILENAME = "kerdial-instruments.json";
const TRANSACTIONS_FILENAME = "kerdial-transactions.csv";

@Controller("exports")
export class ExportsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EXPORT_READS) private readonly reads: ExportReads,
    // KD4.1 — the **same** token the catalogue import route reads its
    // `maxFileBytes` from. See `import-limits.tokens.ts`.
    @Inject(KERDIAL_JSON_IMPORT_LIMITS) private readonly jsonLimits: KerdialJsonLimits,
  ) {}

  /**
   * `GET /exports/instruments?icons=included|omitted` — the catalogue package
   * (FR-500(a), FR-508).
   *
   * **No path extension**, on either route: an `.json`/`.csv` suffix would be a
   * second statement of the format beside the content type, free to disagree
   * with it (KD6's own stated reason).
   */
  @Get("instruments")
  @UseInterceptors(exportThrottleInterceptor)
  async exportInstruments(
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const { icons } = parseOrThrow(exportsCatalogueQuerySchema, query);

    const result = await this.reads.readCatalogue(this.db, session.tenantId, {
      icons,
      // KD4.1 — the ceiling travels *into* the read, so the
      // refusal can be reached before the icons are encoded. It is the same
      // number this method's backstop below compares against, from the same
      // token, so the two can never disagree.
      maxFileBytes: this.jsonLimits.maxFileBytes,
    });

    // The early refusal (security review M2): the icon read
    // stopped paging and nothing was base64-encoded past the ceiling.
    if (result.refused) {
      throw this.#tooLarge(result.projectedBytes, "at least ");
    }

    // The exact backstop, unchanged in effect and now only a backstop: the
    // projection above deliberately under-counts the JSON each icon object
    // wraps its base64 in, so a document that squeaks past it is refused here
    // on its real size. Never a truncated file (KD4.3).
    if (result.byteLength > this.jsonLimits.maxFileBytes) {
      throw this.#tooLarge(result.byteLength, "");
    }

    // FR-513/NFR-62: a count, a duration and a byte size, and nothing else. No
    // instrument name, no amount, no per-table field name — the counts are in
    // the file the user just downloaded, and duplicating them here would need
    // one allow-list entry per table.
    //
    // EI-30: `bytes` is emitted only because it was added to
    // `LOG_FIELD_ALLOWLIST` in the same commit — an unlisted field is dropped
    // silently, so `exports.controller.test.ts` asserts it against the
    // **emitted** line rather than against this call site.
    rootLogger().info("exports: catalogue package served", {
      component: "api",
      count: result.counts.instruments,
      bytes: result.byteLength,
      duration_ms: Math.round(result.durationMs),
    });

    void reply
      .header("content-type", "application/json")
      .header("content-length", String(result.byteLength))
      .header("content-disposition", `attachment; filename="${CATALOGUE_FILENAME}"`);
    return result.body;
  }

  /**
   * KD4.3's `413`, written once and raised from both gates.
   *
   * The remedy is named in the body rather than left to the caller to find, and
   * `params` carries both figures as scalars so a UI can state them without
   * parsing the sentence. `qualifier` is `"at least "` for the early refusal,
   * whose byte count is a lower bound by construction — a UI that printed it as
   * exact would be stating a number the export never reached.
   */
  #tooLarge(bytes: number, qualifier: "" | "at least "): never {
    throw problemException(413, {
      title: "This catalogue is too large to export in one file",
      code: "EXPORT_TOO_LARGE",
      detail:
        `this catalogue serialises to ${qualifier}${String(bytes)} bytes, over the ` +
        `${String(this.jsonLimits.maxFileBytes)}-byte ceiling; request it with ` +
        `?icons=omitted to export the same document without icon bytes`,
      params: {
        bytes,
        maxBytes: this.jsonLimits.maxFileBytes,
        remedy: "icons=omitted",
      },
    });
  }

  /**
   * `GET /exports/transactions` — the transactions package (FR-500(b),
   * FR-508). `text/csv; charset=utf-8`: the charset is part of KD6's stated
   * pair, not an addition, because the file carries free-text notes and
   * instrument names.
   *
   * An empty tenant is a `200` with the version line and the header row and no
   * data rows (FR-512) — the serializer produces that unconditionally, so there
   * is no empty-case branch here to get wrong.
   */
  @Get("transactions")
  @UseInterceptors(exportThrottleInterceptor)
  async exportTransactions(
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const result = await this.reads.readTransactions(this.db, session.tenantId);

    // EI-30, the same three fields as the catalogue route's line — `count`
    // is this package's own unit, the row, and `bytes` is what makes a slow
    // export attributable to volume rather than to the read path.
    rootLogger().info("exports: transactions package served", {
      component: "api",
      count: result.rowCount,
      bytes: result.byteLength,
      duration_ms: Math.round(result.durationMs),
    });

    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-length", String(result.byteLength))
      .header("content-disposition", `attachment; filename="${TRANSACTIONS_FILENAME}"`);
    return result.body;
  }
}
