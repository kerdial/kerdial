import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "../auth/cookies.js";
import { loginAs, type SessionCookies } from "../test-support/http.js";
import { startTestApp, type TestApp } from "../test-support/test-app.js";

/**
 * TESTER-1 — hand-authored CSV shapes a spreadsheet migrant would produce, and
 * a handful of adversarial catalogue-icon inputs, all exercised through the
 * real HTTP routes (Batches A1–D2).
 *
 * Every scenario in the first `describe` block already has a unit-level
 * companion in `importer/src/formats/kerdial-csv/lexer.test.ts` and
 * `columns.test.ts` — this file's own value is entirely the layer: the real
 * multipart route, the real problem+json mapping, and (where the row is
 * accepted) the real stored row, read back with a direct query rather than
 * inferred from the neutral row `parse` produced.
 *
 * Not re-tested here, because it is already covered at the layer this file
 * would otherwise duplicate: the stalling-body / declared-`content-length`
 * probe (`imports-multipart-content-length.e2e.test.ts`, EI-29 — already a
 * bare-Fastify, real-socket test against the shipped ceilings); the malformed
 * / colliding `import_fingerprint` cases
 * (`importer/src/pipeline/apply.kerdial.integration.test.ts`, cases (a)
 * and the "forged value" case); the pathologically nested JSON document
 * (`importer/src/formats/kerdial-json/index.test.ts` and `schema.test.ts`, at
 * 200 000 levels, MEASURED against the deployed Node runtime).
 */

const PASSWORD = "correct horse battery staple tester1-handauthored";

const CATALOGUE_PATH = "/api/v1/imports/kerdial/catalogue";
const TRANSACTIONS_PATH = "/api/v1/imports/kerdial/transactions";

/**
 * The shipped catalogue's own Air Liquide row (MEASURED, migration
 * `0037_seed_instrument_catalogue.sql` — the same needle
 * `exports.tenant-isolation.integration.test.ts` uses), so a CSV row can
 * resolve an instrument without this file also having to carry a catalogue
 * JSON import through every case that merely needs *some* known instrument.
 */
const SHARED_ISIN = "FR0000120073";
const SHARED_MIC = "XPAR";

interface Harness {
  readonly tenantId: string;
  readonly session: SessionCookies;
}

/** A signature-valid, sized-to-the-byte PNG (`catalogue-icon-validator.port.test.ts`'s own idiom). */
function pngOfExactly(totalBytes: number, fill = 0x11): Uint8Array {
  const bytes = new Uint8Array(totalBytes).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 64);
  view.setUint32(20, 64);
  return bytes;
}

function catalogueDoc(options: {
  readonly isin: string;
  readonly portfolio: string;
  readonly cashAccount: string;
  readonly icon?: {
    readonly contentType: string;
    readonly source: string;
    readonly base64: string;
  };
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generator: "tester1",
      exportedAt: "2026-09-24T10:00:00Z",
      baseCurrency: "EUR",
      iconsIncluded: options.icon !== undefined,
      instruments: [
        {
          identity: { kind: "SHARE", isin: options.isin, exchangeMic: "XNAS" },
          private: false,
          listingCurrency: "USD",
          displayName: "Tester-1 icon instrument",
          primaryIdentifier: "ISIN",
          quotePolicy: "AUTO",
          status: "ACTIVE",
          manualPrices: [],
          ...(options.icon !== undefined && { icon: options.icon }),
        },
      ],
      portfolios: [
        {
          name: options.portfolio,
          cashAccounts: [{ name: options.cashAccount, currency: "EUR", archived: false }],
        },
      ],
      fxRatesUser: [],
    }),
    "utf8",
  );
}

describe("TESTER-1 — hand-authored CSV shapes and adversarial catalogue icons", () => {
  let app: TestApp;

  function server(): ReturnType<typeof supertest> {
    return supertest(app.built.app.getHttpServer());
  }

  function authed(request: supertest.Test, session: SessionCookies): supertest.Test {
    return request
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  async function registerTenant(label: string): Promise<Harness> {
    const tenantId = randomUUID();
    const email = `tester1-ha-${label}-${randomUUID()}@example.com`;
    await app.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    const session = await loginAs(server(), email, PASSWORD);
    return { tenantId, session };
  }

  function uploadCsv(
    harness: Harness,
    file: Buffer,
    fields: Record<string, string>,
  ): supertest.Test {
    const request = authed(server().post(TRANSACTIONS_PATH), harness.session).attach("file", file, {
      filename: "kerdial-transactions.csv",
      contentType: "text/csv",
    });
    for (const [name, value] of Object.entries(fields)) void request.field(name, value);
    return request;
  }

  function uploadCatalogue(
    harness: Harness,
    file: Buffer,
    fields: Record<string, string>,
  ): supertest.Test {
    const request = authed(server().post(CATALOGUE_PATH), harness.session).attach("file", file, {
      filename: "kerdial-instruments.json",
      contentType: "application/json",
    });
    for (const [name, value] of Object.entries(fields)) void request.field(name, value);
    return request;
  }

  beforeAll(async () => {
    app = await startTestApp();
  }, 180_000);

  afterAll(async () => {
    await app.stop();
  }, 60_000);

  describe("a `;`-delimited file with decimal commas — the French-Excel shape KD2 names by name", () => {
    it("imports a BUY row whose quantity and price use a comma decimal mark", async () => {
      const fresh = await registerTenant("semicolon-comma");
      const header = [
        "date",
        "type",
        "portfolio",
        "cash_account",
        "cash_account_currency",
        "gross_amount",
        "currency",
      ];
      const buyHeader = [...header, "isin", "exchange_mic", "quantity", "unit_price"];
      const file = Buffer.from(
        [
          "# kerdial-transactions v2",
          buyHeader.join(";"),
          [
            "2026-06-01",
            "DEPOSIT",
            "Comma portfolio",
            "Comma cash",
            "EUR",
            "1000,00",
            "EUR",
            "",
            "",
            "",
            "",
          ].join(";"),
          [
            "2026-06-02",
            "BUY",
            "Comma portfolio",
            "Comma cash",
            "EUR",
            "",
            "EUR",
            SHARED_ISIN,
            SHARED_MIC,
            "3,5",
            "120,75",
          ].join(";"),
        ]
          .map((line) => `${line}\r\n`)
          .join(""),
        "utf8",
      );

      const response = await uploadCsv(fresh, file, { mode: "APPLY", resolutions: "[]" });

      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(2);
      expect(response.body.rejected).toBe(0);

      const rows = await app.ownerClient<{ kind: string; quantity: string; unit_price: string }[]>`
        SELECT kind, quantity, unit_price FROM "transaction"
        WHERE tenant_id = ${fresh.tenantId}::uuid AND kind = 'BUY'`;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.quantity)).toBe(3.5);
      expect(Number(rows[0]!.unit_price)).toBe(120.75);
    });

    it("refuses a thousands separator inside a `;`-delimited numeric cell, naming the rule, and imports every other row", async () => {
      const fresh = await registerTenant("semicolon-thousands");
      const header = [
        "date",
        "type",
        "portfolio",
        "cash_account",
        "cash_account_currency",
        "gross_amount",
        "currency",
      ];
      const file = Buffer.from(
        [
          "# kerdial-transactions v2",
          header.join(";"),
          [
            "2026-06-01",
            "DEPOSIT",
            "Thousands portfolio",
            "Thousands cash",
            "EUR",
            "1000,00",
            "EUR",
          ].join(";"),
          // A non-breaking space thousands separator — banned outright by KD2, whatever the delimiter is.
          [
            "2026-06-02",
            "DEPOSIT",
            "Thousands portfolio",
            "Thousands cash",
            "EUR",
            "1 234,00",
            "EUR",
          ].join(";"),
        ]
          .map((line) => `${line}\r\n`)
          .join(""),
        "utf8",
      );

      const response = await uploadCsv(fresh, file, { mode: "DRY_RUN" });

      expect(response.status).toBe(200);
      expect(response.body.imported).toBe(1);
      expect(response.body.rejected).toBe(1);
      const rows = response.body.rows as { outcome: string; reason?: string; message?: string }[];
      const rejectedRow = rows.find((row) => row.outcome !== "IMPORT");
      expect(rejectedRow?.reason).toBe("MALFORMED_VALUE");
      expect(rejectedRow?.message?.toLowerCase()).toContain("thousands");
    });
  });

  it("refuses a header naming the same column twice — a whole-file failure, never a silently-ambiguous read", async () => {
    const fresh = await registerTenant("duplicate-header");
    const header = [
      "date",
      "type",
      "portfolio",
      "cash_account",
      "cash_account_currency",
      "gross_amount",
      "currency",
      "currency", // duplicated
    ];
    const file = Buffer.from(
      [
        "# kerdial-transactions v2",
        header.join(";"),
        ["2026-06-03", "DEPOSIT", "Dup portfolio", "Dup cash", "EUR", "10.00", "EUR", "EUR"].join(
          ";",
        ),
      ]
        .map((line) => `${line}\r\n`)
        .join(""),
      "utf8",
    );

    const response = await uploadCsv(fresh, file, { mode: "DRY_RUN" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("MALFORMED_FILE");
  });

  it("refuses a file missing a Tier-R column entirely — KERDIAL_CSV_MISSING_COLUMN, naming it", async () => {
    const fresh = await registerTenant("missing-column");
    // No `date` column at all.
    const header = [
      "type",
      "portfolio",
      "cash_account",
      "cash_account_currency",
      "gross_amount",
      "currency",
    ];
    const file = Buffer.from(
      [
        "# kerdial-transactions v2",
        header.join(";"),
        ["DEPOSIT", "Missing portfolio", "Missing cash", "EUR", "10.00", "EUR"].join(";"),
      ]
        .map((line) => `${line}\r\n`)
        .join(""),
      "utf8",
    );

    const response = await uploadCsv(fresh, file, { mode: "DRY_RUN" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("KERDIAL_CSV_MISSING_COLUMN");
    expect(response.body.detail).toContain("date");
  });

  it("imports two byte-identical rows as two distinct transactions, disambiguated by occurrence ordinal", async () => {
    const fresh = await registerTenant("identical-rows");
    const header = [
      "date",
      "type",
      "portfolio",
      "cash_account",
      "cash_account_currency",
      "gross_amount",
      "currency",
    ];
    const row = [
      "2026-06-04",
      "DEPOSIT",
      "Identical portfolio",
      "Identical cash",
      "EUR",
      "42.00",
      "EUR",
    ].join(";");
    const file = Buffer.from(
      ["# kerdial-transactions v2", header.join(";"), row, row]
        .map((line) => `${line}\r\n`)
        .join(""),
      "utf8",
    );

    const response = await uploadCsv(fresh, file, { mode: "APPLY", resolutions: "[]" });

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(2);
    expect(response.body.rejected).toBe(0);

    const rows = await app.ownerClient<{ import_fingerprint: string }[]>`
      SELECT import_fingerprint FROM "transaction" WHERE tenant_id = ${fresh.tenantId}::uuid ORDER BY seq`;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.import_fingerprint).not.toBe(rows[1]!.import_fingerprint);
  });

  it("stores a leading `=` in a note verbatim — never stripped, never interpreted (KD13)", async () => {
    const fresh = await registerTenant("leading-equals");
    const header = [
      "date",
      "type",
      "portfolio",
      "cash_account",
      "cash_account_currency",
      "gross_amount",
      "currency",
      "note",
    ];
    const note = "=SUM(A1:A2)";
    const file = Buffer.from(
      [
        "# kerdial-transactions v2",
        header.join(";"),
        [
          "2026-06-05",
          "DEPOSIT",
          "Equals portfolio",
          "Equals cash",
          "EUR",
          "10.00",
          "EUR",
          note,
        ].join(";"),
      ]
        .map((line) => `${line}\r\n`)
        .join(""),
      "utf8",
    );

    const response = await uploadCsv(fresh, file, { mode: "APPLY", resolutions: "[]" });
    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(1);

    const rows = await app.ownerClient<{ note: string }[]>`
      SELECT note FROM "transaction" WHERE tenant_id = ${fresh.tenantId}::uuid`;
    expect(rows[0]!.note).toBe(note);
  });

  it("round-trips an 18dp quantity and price exactly — the ledger's own numeric(38,18) scale", async () => {
    const fresh = await registerTenant("eighteen-dp");
    const header = [
      "date",
      "type",
      "portfolio",
      "cash_account",
      "cash_account_currency",
      "currency",
      "isin",
      "exchange_mic",
      "quantity",
      "unit_price",
      "gross_amount",
    ];
    const quantity = "1.234567890123456789";
    const unitPrice = "9.876543210987654321";
    const file = Buffer.from(
      [
        "# kerdial-transactions v2",
        header.join(";"),
        [
          "2026-06-06",
          "DEPOSIT",
          "Precision portfolio",
          "Precision cash",
          "EUR",
          "EUR",
          "",
          "",
          "",
          "",
          "1000.00",
        ].join(";"),
        [
          "2026-06-07",
          "BUY",
          "Precision portfolio",
          "Precision cash",
          "EUR",
          "EUR",
          SHARED_ISIN,
          SHARED_MIC,
          quantity,
          unitPrice,
          "",
        ].join(";"),
      ]
        .map((line) => `${line}\r\n`)
        .join(""),
      "utf8",
    );

    const response = await uploadCsv(fresh, file, { mode: "APPLY", resolutions: "[]" });
    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(2);
    expect(response.body.rejected).toBe(0);

    const rows = await app.ownerClient<{ quantity: string; unit_price: string }[]>`
      SELECT quantity, unit_price FROM "transaction"
      WHERE tenant_id = ${fresh.tenantId}::uuid AND kind = 'BUY'`;
    expect(rows[0]!.quantity).toBe(quantity);
    expect(rows[0]!.unit_price).toBe(unitPrice);
  });

  describe("adversarial catalogue icons, through the full HTTP route", () => {
    it("refuses the whole instrument entry when its icon's base64 exceeds the schema's own character ceiling", async () => {
      const fresh = await registerTenant("icon-over-char-ceiling");
      // Any content works for this probe — the schema's `.max()` refuses on
      // length alone, before any decode, per its own stated bound.
      const overLimitBase64 = "A".repeat(349_528 + 1);
      const doc = catalogueDoc({
        isin: "GB0002634946",
        portfolio: "Icon ceiling portfolio",
        cashAccount: "Icon ceiling cash",
        icon: { contentType: "image/png", source: "MANUAL", base64: overLimitBase64 },
      });

      const response = await uploadCatalogue(fresh, doc, { mode: "APPLY", resolutions: "[]" });

      expect(response.status).toBe(200); // a per-entry problem, not a whole-file failure
      expect(response.body.rejected).toBe(1);
      const entries = response.body.entries as { reason: string; section: string }[];
      expect(entries.some((entry) => entry.section === "instruments")).toBe(true);

      const instruments = await app.ownerClient<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "instrument" WHERE isin = 'GB0002634946'`;
      expect(instruments[0]!.n).toBe(0);
    });

    it("refuses only the icon (not the instrument) when its declared type disagrees with its sniffed bytes", async () => {
      const fresh = await registerTenant("icon-not-a-png");
      const notActuallyAnImage = Buffer.from(
        "this is plainly not a PNG or a JPEG",
        "utf8",
      ).toString("base64");
      const doc = catalogueDoc({
        isin: "ES0113900J37",
        portfolio: "Icon sniff portfolio",
        cashAccount: "Icon sniff cash",
        icon: { contentType: "image/png", source: "MANUAL", base64: notActuallyAnImage },
      });

      const response = await uploadCatalogue(fresh, doc, { mode: "APPLY", resolutions: "[]" });

      expect(response.status).toBe(200);
      expect(response.body.applyFailed).toBe(0);
      expect(response.body.imported).toBe(2); // the instrument AND the portfolio still import
      expect(response.body.byReason["ICON_REJECTED"]).toBe(1);

      const instruments = await app.ownerClient<{ id: string }[]>`
        SELECT id FROM "instrument" WHERE isin = 'ES0113900J37'`;
      expect(instruments).toHaveLength(1);

      const icons = await app.ownerClient<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "instrument_icon" WHERE instrument_id = ${instruments[0]!.id}::uuid`;
      expect(icons[0]!.n).toBe(0);
    });

    it("proves the sniff-mismatch case is a real refusal, not a no-op icon: a genuine PNG on the same route is stored", async () => {
      // The discriminator for the case above — without it, "no icon row" is
      // equally consistent with the icon block never being reached at all.
      const fresh = await registerTenant("icon-genuine-png");
      const realPng = Buffer.from(pngOfExactly(256, 0x22)).toString("base64");
      const doc = catalogueDoc({
        isin: "FR0000131104",
        portfolio: "Icon genuine portfolio",
        cashAccount: "Icon genuine cash",
        icon: { contentType: "image/png", source: "MANUAL", base64: realPng },
      });

      const response = await uploadCatalogue(fresh, doc, { mode: "APPLY", resolutions: "[]" });

      expect(response.status).toBe(200);
      expect(response.body.applyFailed).toBe(0);
      expect(response.body.byReason["ICON_REJECTED"]).toBeUndefined();

      // `FR0000131104` already exists in the shipped catalogue seed under a
      // different exchange MIC (MEASURED, this run) — this document's own
      // `XNAS` listing is therefore a *second*, distinct instrument row, and
      // the query below must say which one to avoid picking the seeded row.
      const instruments = await app.ownerClient<{ id: string }[]>`
        SELECT id FROM "instrument" WHERE isin = 'FR0000131104' AND exchange_mic = 'XNAS'`;
      expect(instruments).toHaveLength(1);
      const icons = await app.ownerClient<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "instrument_icon" WHERE instrument_id = ${instruments[0]!.id}::uuid`;
      expect(icons[0]!.n).toBe(1);
    });
  });
});
