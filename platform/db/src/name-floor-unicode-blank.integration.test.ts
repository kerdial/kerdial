import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { portfolioNameSchema } from "@kerdial/api-contracts";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient, type Db } from "./client.js";

/**
 * This suite builds its own container rather than using
 * `@kerdial/platform-test-support`'s `startMigratedPostgres`, because
 * `platform/test-support` **depends on** `platform/db` — taking it as a
 * dependency here would be a cycle. Same reason, and the same idiom, as
 * `cash-account-schema.integration.test.ts` and the `0035` suite beside it.
 *
 * Unlike those two, it migrates the **whole** folder: the subject is the
 * schema as shipped, not one migration's delta.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

/**
 * Migration `0041` — the name floor's Unicode blank hole, on both
 * tables.
 *
 * ## What was wrong, and why nobody saw it
 *
 * `0028` replaced `length(btrim(name)) >= 1` with `name ~ '\S'`, recorded at
 * the time as the fix for, among other inputs, "a non-breaking space
 * (U+00A0)". It was not. `~ '\S'` is
 * `[^[:space:]]`, and glibc deliberately does not classify U+00A0 as space — a
 * no-break space is not a word separator. The tab/newline half was closed; the
 * U+00A0 half never was, because U+00A0 was **reasoned about rather than
 * tested**. `0038` mirrored the expression into `cash_account` and inherited
 * the hole, but characterised it (asserting the codepoints *accepted*) rather
 * than hiding it — which is why this was fixable by measurement instead of
 * being rediscovered by a user.
 *
 * ## Why this suite exists separately
 *
 * `cash-account-schema.integration.test.ts` migrates only as far as `0038`, so
 * its `KNOWN GAP` cases still assert *accepted* — true of the schema that
 * suite observes. This one runs the **full** migration set, so it asserts the
 * post-`0041` behaviour. Both are correct about their own subject; neither can
 * be deleted without losing a real observation.
 *
 * ## Two corrections `0041` had to make to the earlier characterisation
 *
 * Both found by measuring against `postgres:17` on the dev/CI provider, not by
 * re-reading the comment:
 *
 * 1. **The hole is ten codepoints, not the three named.** Swept over every
 *    Unicode space separator, line/paragraph separator and zero-width format
 *    character, `~ '\S'` admits all ten in `BLANKS_THE_REGEX_ADMITS`.
 * 2. **The originally proposed repair was a regression, and the obvious patch to it
 *    was still wrong.** It suggested *replacing* the regex with an explicit
 *    `btrim` trim set. Such a set strips only what it lists, so that closes
 *    U+00A0 while **opening** U+0085 (NEL), U+2000 (EN QUAD) and U+3000
 *    (IDEOGRAPHIC SPACE) — three the regex already rejects.
 *
 *    ANDing the two halves — `name ~ '\S' AND btrim(name, <the ten>) <> ''` —
 *    looks like the fix and is not. It passes for a name **mixing** the two
 *    families: U+00A0 satisfies the regex half (libc says it is not space) and
 *    U+3000 survives the trim set (it is not in the list), so each half sees a
 *    "real" character and neither sees that every character is blank. That was
 *    a first attempt at `0041`, and `SPANNING_MIXTURES` below is the case that
 *    caught it.
 *
 *    `0041` therefore extends the negated class instead:
 *    `name ~ '[^[:space:]<the ten>]'` — the name must contain a character that
 *    is neither in the collation's space class nor one of the ten. Correct by
 *    construction rather than by enumeration: "there exists a non-blank
 *    character" cannot be defeated by mixing blanks. It also degrades better,
 *    since `[:space:]` is inherited from the provider, so a space codepoint
 *    libc adds later is covered with no edit.
 *
 * Every blank below is written as a **numeric codepoint**, never as a literal.
 * A file full of invisible characters is unreviewable, and a stray editor
 * normalisation of one of them would silently change what is asserted.
 */
const cp = (codepoint: number): string => String.fromCodePoint(codepoint);

/** The ten codepoints libc's `\S` does **not** treat as space, so the regex half alone admits them. */
const BLANKS_THE_REGEX_ADMITS: readonly [string, number][] = [
  ["NO-BREAK SPACE (U+00A0)", 0x00a0],
  ["OGHAM SPACE MARK (U+1680)", 0x1680],
  ["MONGOLIAN VOWEL SEPARATOR (U+180E)", 0x180e],
  ["FIGURE SPACE (U+2007)", 0x2007],
  ["ZERO WIDTH SPACE (U+200B)", 0x200b],
  ["ZERO WIDTH NON-JOINER (U+200C)", 0x200c],
  ["ZERO WIDTH JOINER (U+200D)", 0x200d],
  ["NARROW NO-BREAK SPACE (U+202F)", 0x202f],
  ["WORD JOINER (U+2060)", 0x2060],
  ["ZERO WIDTH NO-BREAK SPACE (U+FEFF)", 0xfeff],
];

/**
 * Codepoints libc *does* classify as space, i.e. the ones `[:space:]` covers
 * and the explicit ten do not. If a future edit replaced the class with a
 * hand-listed trim set — the literal suggestion — these would start being
 * admitted. This is the test that catches that regression.
 */
const COVERED_BY_THE_SPACE_CLASS: readonly [string, number][] = [
  ["NEL (U+0085)", 0x0085],
  ["EN QUAD (U+2000)", 0x2000],
  ["EM SPACE (U+2003)", 0x2003],
  ["THIN SPACE (U+2009)", 0x2009],
  ["LINE SEPARATOR (U+2028)", 0x2028],
  ["PARAGRAPH SEPARATOR (U+2029)", 0x2029],
  ["MEDIUM MATHEMATICAL SPACE (U+205F)", 0x205f],
  ["IDEOGRAPHIC SPACE (U+3000)", 0x3000],
];

/** The plain ASCII cases, all inside `[:space:]`. */
const ASCII_BLANKS: readonly [string, number][] = [
  ["SPACE (U+0020)", 0x0020],
  ["TAB (U+0009)", 0x0009],
  ["LINE FEED (U+000A)", 0x000a],
  ["CARRIAGE RETURN (U+000D)", 0x000d],
  ["VERTICAL TAB (U+000B)", 0x000b],
  ["FORM FEED (U+000C)", 0x000c],
];

describe("migration 0041 — an all-blank name is refused on portfolio and cash_account alike", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: ReturnType<typeof createPostgresClient>;
  let ownerDb: Db;
  const TENANT = "00000000-0000-7000-8000-000000041001";
  const PORTFOLIO = "00000000-0000-7000-8000-000000041002";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);
    await migrate(ownerDb, { migrationsFolder });

    await ownerClient`INSERT INTO "tenant" (id) VALUES (${TENANT}::uuid)`;
    await ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name)
      VALUES (${PORTFOLIO}::uuid, ${TENANT}::uuid, 'Portefeuille 0041')`;
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  });

  it("the collation provider every claim here depends on is the libc one dev and CI run, asserted not assumed", async () => {
    // `\S`'s space class is provider-dependent, so an ICU-collated target must
    // fail here visibly rather than silently shift the floor. The trim-set half
    // is provider-independent, which is what makes the conjunction more robust
    // to that move than either half alone.
    const [row] = await ownerClient<{ provider: string; collate: string }[]>`
      SELECT datlocprovider AS provider, datcollate AS collate
      FROM pg_database WHERE datname = current_database()`;
    expect(row?.provider).toBe("c");
    expect(row?.collate).toBe("en_US.utf8");
  });

  const TABLES = [
    { table: "portfolio", constraint: "portfolio_name_length" },
    { table: "cash_account", constraint: "cash_account_name_length" },
  ] as const;

  for (const { table, constraint } of TABLES) {
    describe(table, () => {
      const insertName = (name: string): Promise<unknown> =>
        table === "portfolio"
          ? ownerClient`
              INSERT INTO "portfolio" (id, tenant_id, name)
              VALUES (gen_random_uuid(), ${TENANT}::uuid, ${name})`
          : ownerClient`
              INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency)
              VALUES (gen_random_uuid(), ${TENANT}::uuid, ${PORTFOLIO}::uuid, ${name}, 'EUR')`;

      const rejects = async (name: string): Promise<void> => {
        await expect(insertName(name)).rejects.toMatchObject({
          code: "23514",
          constraint_name: constraint,
        });
      };

      it.each(BLANKS_THE_REGEX_ADMITS)(
        "REJECTS a name of only %s — the explicit ten, i.e. what 0028 missed",
        async (_label, codepoint) => {
          await rejects(cp(codepoint));
        },
      );

      it.each(COVERED_BY_THE_SPACE_CLASS)(
        "REJECTS a name of only %s — inherited from [:space:], not from the explicit ten",
        async (_label, codepoint) => {
          await rejects(cp(codepoint));
        },
      );

      it.each(ASCII_BLANKS)("REJECTS a name of only %s", async (_label, codepoint) => {
        await rejects(cp(codepoint));
      });

      /**
       * The case that killed the conjunction. A name mixing one codepoint from
       * each family defeats `~ '\S' AND btrim(name, <the ten>) <> ''`:
       * `U+00A0` is not space to libc, so the regex half passes, and `U+3000`
       * is absent from the trim set, so the other half passes too. Measured
       * ADMITTED under that formulation, rejected under the shipped one.
       *
       * Exhaustively: none of the 961 ordered pairs over the thirty-one blank
       * codepoints is admitted by the class form. These are the named
       * representatives of that sweep.
       */
      it("REJECTS mixtures that SPAN the two families — the case an AND of two half-floors admits", async () => {
        const everyBlankTheRegexAdmits = BLANKS_THE_REGEX_ADMITS.map(([, c]) => cp(c)).join("");
        for (const name of [
          cp(0x00a0) + cp(0x3000),
          everyBlankTheRegexAdmits + cp(0x3000),
          cp(0x200b) + cp(0x0009) + cp(0x00a0),
          cp(0x00a0) + " ",
          everyBlankTheRegexAdmits,
          " " + cp(0x202f) + cp(0x000a) + cp(0xfeff) + " ",
        ]) {
          await rejects(name);
        }
      });

      it("ACCEPTS a name that merely CONTAINS one, and every ordinary name", async () => {
        // Why this matters beyond politeness: U+200C/U+200D are meaningful
        // joiners inside Persian, Devanagari and emoji sequences. A floor that
        // refused any name *containing* them would be a bug, not a fix.
        for (const name of [
          "Cash" + cp(0x00a0) + "EUR",
          "Compte" + cp(0x202f) + "2",
          "Z" + cp(0x200c) + "ero",
          "Courant EUR",
          "  Courant EUR  ",
          "Epargne PEA",
          "A",
          "Compte n" + cp(0x00b0) + "2",
        ]) {
          // Not `.resolves` — the point is that no CHECK fires, so a rejection
          // must surface as this test's own failure with the name in it.
          await insertName(name).catch((err: unknown) => {
            throw new Error(`${JSON.stringify(name)} must still be storable, but: ${String(err)}`);
          });
        }
      });
    });
  }

  /**
   * The cross-layer half. A database floor the HTTP boundary does not
   * mirror is not a fix — it is a 500.
   *
   * `portfolioNameSchema` (shared by portfolios *and* cash accounts) used to
   * rely on `.trim()` alone, and `String.prototype.trim` strips JavaScript's
   * whitespace set, not libc's `[:space:]` plus `0041`'s ten. Six codepoints
   * fall in that gap — U+0085, U+180E, U+200B, U+200C, U+200D, U+2060 — so a
   * name of only one of them passed validation and was then refused by the
   * database. U+0085 already behaved that way before `0041`; the other five
   * would have started the moment it landed.
   *
   * This is the guard that keeps the two floors together: every input the
   * database refuses must also be refused at the boundary, so the user gets a
   * 400 naming the problem instead of an unmapped 500.
   */
  describe("the HTTP boundary refuses everything the database refuses", () => {
    const everyBlank = [
      ...BLANKS_THE_REGEX_ADMITS,
      ...COVERED_BY_THE_SPACE_CLASS,
      ...ASCII_BLANKS,
    ] as const;

    it.each(everyBlank)("portfolioNameSchema rejects a name of only %s", (_label, codepoint) => {
      expect(portfolioNameSchema.safeParse(cp(codepoint)).success).toBe(false);
    });

    it("...and rejects mixtures, including the cross-family pair that defeats an AND of two half-floors", () => {
      const holes = BLANKS_THE_REGEX_ADMITS.map(([, c]) => cp(c)).join("");
      for (const name of [
        cp(0x00a0) + cp(0x3000),
        cp(0x200b) + " ",
        holes,
        holes + cp(0x3000),
        " " + cp(0x202f) + cp(0x000a) + cp(0xfeff) + " ",
      ]) {
        expect(portfolioNameSchema.safeParse(name).success, JSON.stringify(name)).toBe(false);
      }
    });

    it("...and still accepts every ordinary name, storing it unmodified apart from the documented trim", () => {
      // A `.refine`, not a `.transform`: U+200C/U+200D are meaningful joiners
      // inside Persian, Devanagari and emoji sequences, so a name that merely
      // *contains* one must survive byte-for-byte.
      for (const name of [
        "Cash" + cp(0x00a0) + "EUR",
        "Z" + cp(0x200c) + "ero",
        "Compte" + cp(0x202f) + "2",
        "Courant EUR",
      ]) {
        const parsed = portfolioNameSchema.safeParse(name);
        expect(parsed.success, JSON.stringify(name)).toBe(true);
        expect(parsed.success && parsed.data).toBe(name);
      }
      // The one documented mutation, unchanged by that fix.
      const padded = portfolioNameSchema.safeParse("  Courant EUR  ");
      expect(padded.success && padded.data).toBe("Courant EUR");
    });

    it("every blank the DATABASE refuses is refused by the boundary too — stated as set containment, not case by case", async () => {
      // Belt and braces on the two lists above: ask the database directly, so
      // a codepoint added to one list and not the other cannot hide.
      const refusedByBoundary: number[] = [];
      const refusedByDatabase: number[] = [];
      for (const [, codepoint] of everyBlank) {
        if (!portfolioNameSchema.safeParse(cp(codepoint)).success) {
          refusedByBoundary.push(codepoint);
        }
        const rows = await ownerClient<{ ok: boolean }[]>`
          SELECT (${cp(codepoint)} ~ '[^[:space:]\u00A0\u1680\u180E\u2007\u200B\u200C\u200D\u202F\u2060\uFEFF]') AS ok`;
        if (!rows[0]?.ok) refusedByDatabase.push(codepoint);
      }
      expect(refusedByDatabase.length).toBeGreaterThan(0);
      expect(refusedByBoundary).toEqual(refusedByDatabase);
    });
  });

  it("all FOUR free-text columns carry the SAME expression — 0041/0068 land on all or none", async () => {
    // The drift this rule exists to prevent: `cash_account_name_length` mirrors
    // `portfolio_name_length` expression for expression so the two stay
    // reviewable side by side, and 0038 recorded that strengthening one alone
    // would put them out of step. Compared through the database's own rendering
    // of each CHECK, with the table qualifier normalised away, so a change to
    // one that is not made to the others fails here.
    //
    // **`0068` (portfolio-details, SD-6/PD-4) makes it four.** `broker` and
    // `description` are new free-text columns on `portfolio`, and the ten
    // codepoints are a property of Unicode whitespace rather than of `name`
    // specifically — a fresh `.trim().min(1)`-shaped floor on either would
    // reopen the identical hole. They therefore copy the expression
    // character for character, and this assertion — extended from two rendered
    // definitions to four — is the only form of drift guard that holds for a
    // copied expression.
    //
    // Two things legitimately differ between the four and are normalised away
    // here rather than asserted equal: the **column name** and the **upper
    // bound** (L5: 200 for `name`/`cash_account.name`/`broker`, 2000 for
    // `description`, the `transaction.note` bound). Everything else — the
    // negated class, the `btrim`, the shape of the conjunction — must be
    // identical, which is precisely the half the original bug was about.
    const COLUMNS: readonly [constraint: string, column: string][] = [
      ["cash_account_name_length", "name"],
      ["portfolio_broker_length", "broker"],
      ["portfolio_description_length", "description"],
      ["portfolio_name_length", "name"],
    ];
    const rows = await ownerClient<{ conname: string; definition: string }[]>`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.conname IN ${ownerClient(COLUMNS.map(([constraint]) => constraint))}
      ORDER BY c.conname`;

    expect(rows.map((r) => r.conname)).toEqual(COLUMNS.map(([constraint]) => constraint));
    const normalised = rows.map((r, i) =>
      r.definition
        .replaceAll("cash_account.", "")
        .replaceAll("portfolio.", "")
        .replaceAll(COLUMNS[i]?.[1] ?? "", "<col>")
        .replace(/<= \d+/, "<= <max>"),
    );
    for (const definition of normalised) {
      expect(definition).toBe(normalised[0]);
    }

    // And it is the extended class, not a bare `\S` and not a trim set: both
    // would satisfy the equality above while reopening one of the two
    // families. Every one of the ten must appear inside the negated class.
    expect(normalised[0]).toContain("[^[:space:]");
    for (const [label, codepoint] of BLANKS_THE_REGEX_ADMITS) {
      // Matched as the `\uXXXX` escape *text*, which is how the literal was
      // written and how `pg_get_constraintdef` renders it back — deliberately
      // not as the character itself. A CHECK containing ten invisible
      // codepoints would be unreviewable, and a stray editor normalisation of
      // one of them would silently reopen that codepoint.
      const escape = "\\u" + codepoint.toString(16).toUpperCase().padStart(4, "0");
      expect(normalised[0], `${label} must be listed in the CHECK as ${escape}`).toContain(escape);
    }
  });
});
