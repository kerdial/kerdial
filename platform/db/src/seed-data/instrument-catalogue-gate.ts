/**
 * The offline seed gate for the checked-in instrument catalogue — IR-19
 * (DD32; spec
 * FR-16–FR-19, AC-19, AC-20).
 *
 * A **pure** validator. It performs **no I/O of any kind** — no `fetch`, no
 * `fs`, no `pg`, no dynamic `import()` — which is how AC-20 ("the gate
 * performs no network I/O, verified with egress blocked") is satisfied
 * *structurally* rather than by promise. `instrument-catalogue-gate.test.ts`
 * asserts that property against this file's own source text, so a future
 * import of a socket-opening module fails here rather than in CI on a bad
 * network day.
 *
 * The recorded evidence per row (source URL, retrieval date, verified name —
 * FR-19) is what ships; the identifier round trip that *produced* the
 * verified name is a one-off, offline authoring step (FR-18), never a
 * build-time or request-time call. This gate only checks that the recorded
 * evidence is present and internally consistent, plus the ISO 6166 check
 * digit and the dataset-level uniqueness invariants.
 *
 * Three consumers (DD32): the seed-migration generator (refuses to emit), the
 * vitest suite beside this file (a negative fixture per rule — *"a gate that
 * only passes on good data is a gate nobody has tested"*), and the
 * `pnpm instrument-catalogue-gate` CLI wired into `scripts/verify.sh`'s
 * static gate lane.
 *
 * **What this gate does not check.** Rule 1 (`SOURCE_URL_NOT_HTTPS`)
 * validates `source.url` against the `^https://` *scheme* only — it has no
 * host constraint, and passing it does not mean the host is approved. Host
 * allowlisting is a separate control, owned by
 * `core/api-contracts/src/outbound-host-containment.test.ts`'s
 * `SEED_EVIDENCE_HOSTS`. That split is deliberate — this gate is pure and
 * I/O-free by the property documented above, which a host allowlist has no
 * bearing on — but this gate now also runs standalone in `scripts/verify.sh`
 * and `ci.yml`'s `gates` job, wired to look like *the* control. It is not:
 * a 52nd row citing an arbitrary host passes here and is rejected only by
 * the containment test.
 */
import { isValidIsinCheckDigit } from "@kerdial/api-contracts";
import { CURATED_EXCHANGE_MICS } from "@kerdial/core-reference-data";
import { ISO_4217_CURRENCIES } from "./iso-4217-currencies.js";

/**
 * The eleven rejection rules and their canonical numbers. **1–9 are AC-19's
 * nine verbatim**; 10 and 11 are the two folded into the same pass because
 * they are the same class of error: a malformed
 * `domicileCountry`, and any sector/industry key present on a row at all —
 * FR-17 enforced *at the gate*, not merely asserted after the migration.
 */
export const SEED_RULE_NUMBERS = {
  SOURCE_URL_NOT_HTTPS: 1,
  SOURCE_RETRIEVED_ON_NOT_ISO_DATE: 2,
  SOURCE_VERIFIED_NAME_MISSING: 3,
  VERIFIED_NAME_MISMATCH: 4,
  ISIN_CHECK_DIGIT_INVALID: 5,
  EXCHANGE_MIC_NOT_CURATED: 6,
  LISTING_CURRENCY_NOT_SEEDED: 7,
  DUPLICATE_ISIN_EXCHANGE_MIC: 8,
  ID_NOT_UNIQUE_UUID: 9,
  DOMICILE_COUNTRY_MALFORMED: 10,
  CLASSIFICATION_KEY_PRESENT: 11,
} as const;

export type SeedRule = keyof typeof SEED_RULE_NUMBERS;

export interface SeedViolation {
  /** The rule this row broke — the machine-readable name tests assert on. */
  readonly rule: SeedRule;
  /** 1–9 = AC-19's nine rules in its own order; 10–11 = the two folded rules. */
  readonly ruleNumber: number;
  /** Index of the offending row in the dataset, for a locatable message. */
  readonly rowIndex: number;
  /** Best-effort human label for the row (its ISIN, or its display name, or `<unidentified>`). */
  readonly rowLabel: string;
  /** What exactly was wrong, including the offending value. */
  readonly detail: string;
}

/**
 * The gate's input is deliberately `unknown`: it validates data that may be
 * malformed in any way, including rows that are not objects and rows carrying
 * keys the `SeededInstrument` interface forbids. Typing the parameter as the
 * interface would make the negative fixtures untypeable and would hand the
 * compiler a guarantee the gate exists precisely to *check* — the dataset is
 * a hand-authored file, and a hand edit can violate its own declared type via
 * a cast at any time.
 */
export type SeedRowInput = unknown;

const HTTPS_URL = /^https:\/\/[^\s]+$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ALPHA2 = /^[A-Z]{2}$/;
/**
 * A well-formed UUID (any version 1–8, RFC 4122 variant). DD33 requires the
 * seeded literals to be UUIDv7 specifically; AC-19's rule 9 says "well-formed
 * UUID", so the version nibble is deliberately not pinned here — pinning it
 * would make this gate stricter than the criterion it implements, which is a
 * change to make in the spec, not silently in the gate.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keys that must not appear on a seeded row at all (FR-17): both the TS and the SQL spelling. */
const FORBIDDEN_CLASSIFICATION_KEYS = [
  "sectorCode",
  "sector_code",
  "industryLabel",
  "industry_label",
] as const;

const CURATED_MICS: ReadonlySet<string> = new Set(
  CURATED_EXCHANGE_MICS.map((exchange) => exchange.mic),
);
const SEEDED_CURRENCY_CODES: ReadonlySet<string> = new Set(
  ISO_4217_CURRENCIES.map((currency) => currency.code),
);

/**
 * Legal-form suffixes stripped by {@link normaliseInstrumentName}, as *token
 * sequences* because normalisation has already turned punctuation into
 * separators: `S.A.` arrives here as the two tokens `S A`. This is exactly
 * this list (`SA | S.A. | SE | NV | PLC | INC | CORP`) and nothing
 * more — a suffix is added to this list only by amending this rule, not
 * because a row failed.
 */
const LEGAL_FORM_SUFFIX_TOKENS: readonly (readonly string[])[] = [
  ["S", "A"],
  ["SA"],
  ["SE"],
  ["NV"],
  ["PLC"],
  ["INC"],
  ["CORP"],
];

/**
 * The `verifiedName` ↔ `displayName` normalisation (gate rule 4, A17).
 * Written down here because A17's whole point is that it is a documented,
 * deterministic transform that is **never silently loosened when a row
 * fails** — loosening it to admit a failing row is the error this rule exists
 * to catch, so a change here is a design change with its own justification.
 *
 * In order:
 *
 * 1. Unicode NFKD-decompose and drop combining marks, so `Société` and
 *    `SOCIETE` are the same name. (An addition to the four originally listed
 *    steps, recorded here: an identifier round trip returns unaccented ASCII
 *    for continental European names, and diacritic folding can never conflate
 *    two *different* companies.)
 * 2. Upper-case (the case fold).
 * 3. Replace every character outside `A–Z0–9` with a space — this is the
 *    "collapse punctuation" step, and it is what turns `S.A.` into `S A`.
 * 4. Collapse whitespace runs and trim.
 * 5. Strip trailing legal-form suffix tokens, repeatedly, never to the point
 *    of emptying the name.
 */
export function normaliseInstrumentName(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

  let tokens = folded.length === 0 ? [] : folded.split(" ");

  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of LEGAL_FORM_SUFFIX_TOKENS) {
      if (tokens.length <= suffix.length) continue;
      const tail = tokens.slice(tokens.length - suffix.length);
      if (tail.every((token, i) => token === suffix[i])) {
        tokens = tokens.slice(0, tokens.length - suffix.length);
        stripped = true;
        break;
      }
    }
  }

  return tokens.join(" ");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** A real calendar date in the `YYYY-MM-DD` ISO-8601 profile (`2026-02-30` is not one). */
function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const asDate = new Date(Date.UTC(year, month - 1, day));
  return (
    asDate.getUTCFullYear() === year &&
    asDate.getUTCMonth() === month - 1 &&
    asDate.getUTCDate() === day
  );
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Validates the checked-in seed catalogue. Returns every violation found (not
 * just the first): a hand-authored dataset is fixed row by row, so a gate that
 * reports one problem per run is a gate that costs eleven runs.
 */
export function validateSeededInstruments(rows: readonly SeedRowInput[]): readonly SeedViolation[] {
  const violations: SeedViolation[] = [];
  const seenListings = new Map<string, number>();
  const seenIds = new Map<string, number>();

  rows.forEach((rawRow, rowIndex) => {
    // A row that is not an object at all is not special-cased: every field
    // read below then finds nothing, and rules 1, 2, 3, 5, 6, 7, 9 and 10 all
    // fire on it. That is more informative than one synthetic "not an object"
    // violation, and it needs no rule outside AC-19's list.
    const row = asRecord(rawRow) ?? {};
    const isin = asNonEmptyString(row["isin"]);
    const displayName = asNonEmptyString(row["displayName"]);
    const rowLabel = isin ?? displayName ?? "<unidentified>";

    const push = (rule: SeedRule, detail: string): void => {
      violations.push({
        rule,
        ruleNumber: SEED_RULE_NUMBERS[rule],
        rowIndex,
        rowLabel,
        detail,
      });
    };

    const source = asRecord(row["source"]);

    // 1 — source.url missing or not ^https://. Scheme only — the host
    // is not checked here; see this file's own header for where that control
    // lives. A passing row has an HTTPS URL, not necessarily an approved one.
    const url = asNonEmptyString(source?.["url"]);
    if (url === null || !HTTPS_URL.test(url)) {
      push(
        "SOURCE_URL_NOT_HTTPS",
        `source.url must be a first-party page URL matching ^https:// (FR-18), got ${describe(source?.["url"])}`,
      );
    }

    // 2 — source.retrievedOn missing or not an ISO-8601 date
    const retrievedOn = asNonEmptyString(source?.["retrievedOn"]);
    if (retrievedOn === null || !isIsoCalendarDate(retrievedOn)) {
      push(
        "SOURCE_RETRIEVED_ON_NOT_ISO_DATE",
        `source.retrievedOn must be an ISO-8601 date (YYYY-MM-DD), got ${describe(source?.["retrievedOn"])}`,
      );
    }

    // 3 — source.verifiedName missing or empty
    const verifiedName = asNonEmptyString(source?.["verifiedName"]);
    if (verifiedName === null) {
      push(
        "SOURCE_VERIFIED_NAME_MISSING",
        `source.verifiedName must record the name the identifier round trip returned (FR-19), got ${describe(source?.["verifiedName"])}`,
      );
    }

    // 4 — source.verifiedName does not match displayName under the documented normalisation
    if (verifiedName !== null) {
      const normalisedVerified = normaliseInstrumentName(verifiedName);
      const normalisedDisplay = displayName === null ? "" : normaliseInstrumentName(displayName);
      if (normalisedVerified !== normalisedDisplay || normalisedVerified.length === 0) {
        push(
          "VERIFIED_NAME_MISMATCH",
          `source.verifiedName ${describe(verifiedName)} normalises to ${describe(normalisedVerified)} but displayName ${describe(row["displayName"])} normalises to ${describe(normalisedDisplay)}`,
        );
      }
    }

    // 5 — isin fails isValidIsinCheckDigit
    if (isin === null || !isValidIsinCheckDigit(isin)) {
      push(
        "ISIN_CHECK_DIGIT_INVALID",
        `isin must satisfy the ISO 6166 check digit, got ${describe(row["isin"])}`,
      );
    }

    // 6 — exchangeMic absent from CURATED_EXCHANGE_MICS
    const exchangeMic = asNonEmptyString(row["exchangeMic"]);
    if (exchangeMic === null || !CURATED_MICS.has(exchangeMic)) {
      push(
        "EXCHANGE_MIC_NOT_CURATED",
        `exchangeMic must be one of CURATED_EXCHANGE_MICS, got ${describe(row["exchangeMic"])}`,
      );
    }

    // 7 — listingCurrency absent from the seeded currency list
    const listingCurrency = asNonEmptyString(row["listingCurrency"]);
    if (listingCurrency === null || !SEEDED_CURRENCY_CODES.has(listingCurrency)) {
      push(
        "LISTING_CURRENCY_NOT_SEEDED",
        `listingCurrency must be a seeded ISO 4217 currency code, got ${describe(row["listingCurrency"])}`,
      );
    }

    // 8 — duplicate (isin, exchangeMic) within the dataset
    if (isin !== null && exchangeMic !== null) {
      const listingKey = `${isin}|${exchangeMic}`;
      const firstIndex = seenListings.get(listingKey);
      if (firstIndex === undefined) {
        seenListings.set(listingKey, rowIndex);
      } else {
        push(
          "DUPLICATE_ISIN_EXCHANGE_MIC",
          `(isin, exchangeMic) = (${isin}, ${exchangeMic}) already appears at row ${firstIndex}`,
        );
      }
    }

    // 9 — duplicate or malformed id
    const id = asNonEmptyString(row["id"]);
    if (id === null || !UUID.test(id)) {
      push(
        "ID_NOT_UNIQUE_UUID",
        `id must be a well-formed UUID literal (DD33 mints UUIDv7), got ${describe(row["id"])}`,
      );
    } else {
      const firstIndex = seenIds.get(id.toLowerCase());
      if (firstIndex === undefined) {
        seenIds.set(id.toLowerCase(), rowIndex);
      } else {
        push("ID_NOT_UNIQUE_UUID", `id ${id} already appears at row ${firstIndex}`);
      }
    }

    // 10 — domicileCountry not ^[A-Z]{2}$
    const domicileCountry = asNonEmptyString(row["domicileCountry"]);
    if (domicileCountry === null || !ALPHA2.test(domicileCountry)) {
      push(
        "DOMICILE_COUNTRY_MALFORMED",
        `domicileCountry must be an uppercase ISO 3166-1 alpha-2 code, got ${describe(row["domicileCountry"])}`,
      );
    }

    // 11 — any sector/industry key present on the row at all (FR-17)
    for (const key of FORBIDDEN_CLASSIFICATION_KEYS) {
      if (Object.hasOwn(row, key)) {
        push(
          "CLASSIFICATION_KEY_PRESENT",
          `the seed carries no sector or industry (FR-17), but this row has a "${key}" key`,
        );
      }
    }
  });

  return violations;
}

/** Renders violations for the CLI, in the `no-floats-schema-gate` idiom. */
export function formatSeedViolations(violations: readonly SeedViolation[]): string {
  return violations
    .map(
      (violation) =>
        `  - rule ${violation.ruleNumber} (${violation.rule}) — row ${violation.rowIndex} [${violation.rowLabel}]: ${violation.detail}`,
    )
    .join("\n");
}
