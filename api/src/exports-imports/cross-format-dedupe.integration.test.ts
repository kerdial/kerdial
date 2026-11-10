import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "../auth/cookies.js";
import { loginAs, type SessionCookies } from "../test-support/http.js";
import { startTestApp, type TestApp } from "../test-support/test-app.js";

/**
 * **EI-32 — AC-428, cross-format dedupe, through the whole product path**
 * (`portfolio-export-import` AC-428, FR-540/FR-541, L17/OD-9).
 *
 * ## The scenario, and why it needs HTTP
 *
 * A tenant whose rows came from a **Portfolio-Performance** file carries
 * `import_fingerprint = "pp2:…"`. Exported as the Kerdial transactions CSV and
 * re-uploaded into the **same** tenant, every one of those rows must be skipped.
 *
 * EI-16 already proves the mechanism at the `plan`/`apply` layer with a
 * hand-constructed carried fingerprint. What is genuinely different here — and
 * the only reason this file pays for a Nest app and a Postgres container — is
 * that every link of the chain is the shipped one and none of them is a
 * fixture: the `pp2:` values are written by the **real PP import route**, the
 * CSV is the **real export route's** bytes, and the re-upload is the **real
 * Kerdial import route**. That is the literal action a user takes to check
 * their backup ("export my tenant, then import it back"), and it is the action
 * OD-9 exists for.
 *
 * ## The assertion that counts is the row count, not the summary
 *
 * So every claim about
 * duplicates is a **direct query** grouped by fingerprint. A response body
 * reporting `skipped: 4` is exactly what a broken apply that wrote four
 * duplicates and then mis-summarised them would also report.
 *
 * ## The negative half is a second tenant, not a comment
 *
 * "The carried fingerprint is what does the work" is only shown by removing it:
 * the second tenant re-imports the **same** export with the
 * `import_fingerprint` column blanked, and its rows import as new ones. Without
 * that case, a dedupe that happened by accident — say, by some other column
 * matching — would look identical.
 */

const PASSWORD = "correct horse battery staple dedupe";

const PP_HEADER =
  "Date;Type;Valeur;Devise de l'opération;Montant brut;Montant brut en devise;Taux de change;Frais;Impôts / Taxes;Parts;ISIN;WKN;Symbole boursier;Nom du titre;Note";

/** Four deposits, every one importable, so the counts below are exact rather than "the ones that landed". */
const PP_LINES: readonly string[] = [
  "2026-01-02T10:00;Dépôt;100,00;EUR;;;;;;;;;;;alpha",
  "2026-01-03T11:30;Dépôt;250,00;EUR;;;;;;;;;;;beta",
  "2026-01-04T09:15;Dépôt;75,50;EUR;;;;;;;;;;;gamma",
  "2026-01-05T08:45;Dépôt;42,25;EUR;;;;;;;;;;;delta",
];
const PP_ROWS = PP_LINES.length;

const BOM = "\uFEFF";
const CRLF = "\u000D\u000A";

function ppFile(): Buffer {
  return Buffer.from(BOM + [PP_HEADER, ...PP_LINES].join(CRLF) + CRLF, "utf8");
}

/**
 * The same exported CSV with every row's `import_fingerprint` cell emptied —
 * the file a hand-authored spreadsheet would have produced, and the reddening
 * companion to the dedupe case.
 *
 * Column-indexed rather than regex-replaced: the value is a hash, and blanking
 * it by pattern would silently do nothing the day the prefix changes.
 */
function withoutFingerprints(csv: string): Buffer {
  const lines = csv.split(CRLF).filter((line) => line !== "");
  // The writer's own delimiter is a comma (MEASURED,
  // `formats/kerdial-csv/serialize.ts`), and the header is found by the column
  // this function is about rather than by a position that could move.
  const headerIndex = lines.findIndex((line) => line.split(",").includes("import_fingerprint"));
  if (headerIndex < 0) throw new Error("the export carries no import_fingerprint column");
  const columns = lines[headerIndex]!.split(",");
  const column = columns.indexOf("import_fingerprint");

  const stripped = lines.map((line, index) => {
    if (index <= headerIndex) return line;
    const cells = line.split(",");
    // The premise: no cell of this fixture is quoted around a comma, so a
    // positional edit is safe. A fixture that grew one would land here rather
    // than silently blanking the wrong column.
    if (cells.length !== columns.length) {
      throw new Error(`row ${String(index)} has ${String(cells.length)} cells, not the header's`);
    }
    cells[column] = "";
    return cells.join(",");
  });
  const file = stripped.join(CRLF) + CRLF;
  if (file.includes("pp2:")) throw new Error("the strip left a carried fingerprint behind");
  return Buffer.from(file, "utf8");
}

interface Harness {
  readonly tenantId: string;
  readonly portfolioId: string;
  readonly cashAccountId: string;
  readonly session: SessionCookies;
}

describe("EI-32 — AC-428: a pp2-fingerprinted tenant, exported as Kerdial CSV and re-imported", () => {
  let app: TestApp;

  function server(): ReturnType<typeof supertest> {
    return supertest(app.built.app.getHttpServer());
  }

  function authed(request: supertest.Test, session: SessionCookies): supertest.Test {
    return request
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  /** A tenant whose four transactions were written by the **real** Portfolio-Performance import route. */
  async function ppOriginTenant(label: string): Promise<Harness> {
    const tenantId = randomUUID();
    const email = `dedupe-${label}-${randomUUID()}@example.com`;
    await app.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    const session = await loginAs(server(), email, PASSWORD);

    const created = await authed(server().post("/api/v1/portfolios"), session).send({
      name: `Dedupe ${label}`,
    });
    expect(created.status).toBe(201);
    const portfolioId = created.body.id as string;
    await seedCashAccountsForPortfolio(app.ownerDb, portfolioId);
    const cashAccountId = cash(portfolioId, "EUR");

    const imported = await authed(server().post("/api/v1/imports/transactions"), session)
      .attach("file", ppFile(), { filename: "cash.csv", contentType: "text/csv" })
      .field("mode", "APPLY")
      .field("fileType", "CASH_ACCOUNT_TRANSACTIONS")
      .field("portfolioId", portfolioId)
      .field("cashAccountId", cashAccountId);
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(PP_ROWS);

    return { tenantId, portfolioId, cashAccountId, session };
  }

  async function exportTransactions(session: SessionCookies): Promise<string> {
    const response = await server()
      .get("/api/v1/exports/transactions")
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .buffer(true)
      .parse((res, callback) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => callback(null, text));
      });
    expect(response.status).toBe(200);
    return response.body as string;
  }

  function reimport(session: SessionCookies, file: Buffer): supertest.Test {
    return authed(server().post("/api/v1/imports/kerdial/transactions"), session)
      .attach("file", file, { filename: "kerdial-transactions.csv", contentType: "text/csv" })
      .field("mode", "APPLY");
  }

  /** Every fingerprint this tenant holds, with how many rows carry it. */
  async function fingerprints(tenantId: string): Promise<Map<string, number>> {
    const rows = await app.ownerClient`
      SELECT coalesce(import_fingerprint, '') AS fingerprint, count(*)::int AS n
      FROM "transaction" WHERE tenant_id = ${tenantId}::uuid
      GROUP BY import_fingerprint`;
    return new Map(rows.map((row) => [String(row["fingerprint"]), row["n"] as number]));
  }

  async function transactionCount(tenantId: string): Promise<number> {
    const rows = await app.ownerClient`
      SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${tenantId}::uuid`;
    return rows[0]!["n"] as number;
  }

  let subject: Harness;
  let exported: string;

  beforeAll(async () => {
    app = await startTestApp();
    subject = await ppOriginTenant("subject");
    exported = await exportTransactions(subject.session);
  }, 300_000);

  afterAll(async () => {
    await app.stop();
  }, 60_000);

  it("the source rows really are pp2-fingerprinted — the premise, measured", async () => {
    const carried = await fingerprints(subject.tenantId);
    expect(carried.size).toBe(PP_ROWS);
    for (const [value, count] of carried) {
      expect(value.startsWith("pp2:")).toBe(true);
      expect(count).toBe(1);
    }
  });

  it("the export carries each row's own pp2 value verbatim (FR-540)", async () => {
    const carried = [...(await fingerprints(subject.tenantId)).keys()];
    // Every stored value, found in the file — not "the file mentions pp2".
    for (const value of carried) expect(exported).toContain(value);
  });

  it("AC-428: re-importing that export into the same tenant skips every row", async () => {
    const before = await transactionCount(subject.tenantId);

    const response = await reimport(subject.session, Buffer.from(exported, "utf8"));

    expect(response.status).toBe(200);
    expect(response.body.rowCount).toBe(PP_ROWS);
    expect(response.body.skipped).toBe(PP_ROWS);
    expect(response.body.imported).toBe(0);
    expect(response.body.byReason["ALREADY_IMPORTED"]).toBe(PP_ROWS);

    // The half the spec insists on: a direct count, not the summary above.
    expect(await transactionCount(subject.tenantId)).toBe(before);
  }, 120_000);

  it("…and zero duplicates exist, by fingerprint, after the re-import", async () => {
    const carried = await fingerprints(subject.tenantId);
    expect(carried.size).toBe(PP_ROWS);
    expect([...carried.values()]).toEqual(Array.from({ length: PP_ROWS }, () => 1));
    // The fingerprints are still the **source** values: the KD8 rule is that
    // a carried value is stored verbatim rather than re-fingerprinted under
    // `kd1`, so a second round trip is idempotent too.
    for (const value of carried.keys()) expect(value.startsWith("pp2:")).toBe(true);
  });

  it("a second re-import changes nothing either — the value did not move under kd1", async () => {
    const response = await reimport(subject.session, Buffer.from(exported, "utf8"));

    expect(response.status).toBe(200);
    expect(response.body.skipped).toBe(PP_ROWS);
    expect(await transactionCount(subject.tenantId)).toBe(PP_ROWS);
  }, 120_000);

  it("the carried column is what does it: with it stripped, the same rows import as new ones", async () => {
    // The reddening companion, in its own tenant so the case above stays
    // undisturbed. This is the *same* export bytes minus one column's values —
    // so if these rows still deduped, the dedupe would be coming from
    // somewhere other than FR-540's channel and AC-428 would be vacuous.
    const other = await ppOriginTenant("stripped");
    const ownExport = await exportTransactions(other.session);
    expect(await transactionCount(other.tenantId)).toBe(PP_ROWS);

    const response = await reimport(other.session, withoutFingerprints(ownExport));

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(PP_ROWS);
    expect(response.body.skipped).toBe(0);
    expect(await transactionCount(other.tenantId)).toBe(PP_ROWS * 2);

    // And the new rows carry `kd1:` values — FR-542's recipe — beside the
    // original `pp2:` ones, which is the observable difference between "the
    // carried value matched" and "a fresh one was computed".
    const carried = [...(await fingerprints(other.tenantId)).keys()];
    expect(carried.filter((one) => one.startsWith("pp2:"))).toHaveLength(PP_ROWS);
    expect(carried.filter((one) => one.startsWith("kd1:"))).toHaveLength(PP_ROWS);
  }, 300_000);
});
