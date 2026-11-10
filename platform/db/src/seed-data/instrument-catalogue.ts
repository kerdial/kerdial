/**
 * The checked-in sample instrument catalogue — IR-20
 * (DD33; spec
 * FR-15–FR-19, OD-5(b), OD-6(a)).
 *
 * ~51 widely-held European and US large capitalisations, compiled 2026-08-22.
 * **A static sample catalogue, not any index's membership** — there is no
 * membership-refresh mechanism and no claim of tracking anything; it exists so
 * a fresh install's first search finds something, and `web` renders its
 * compilation date so the snapshot is never presented as live. Names were
 * chosen for breadth and familiarity, one row per listing.
 *
 * Pure data, **no imports** — deliberately, so the gate
 * (`instrument-catalogue-gate.ts`) and the seed-migration generator can both
 * consume it with no resolution concerns. That is why `SeededInstrument` is
 * declared here rather than imported. Same idiom as `market-calendar.ts`.
 *
 * Every row is `primary_identifier = ISIN`, `quote_policy = AUTO` and
 * `owner_tenant_id` **omitted** ⇒ NULL ⇒ shared (D-17), carries **no sector and
 * no industry** (FR-17: a company's ISIN and country of incorporation are facts
 * from primary sources and may ship; another party's classification output may
 * not — the gate's rule 11 rejects the mere *presence* of such a key), and
 * carries **no `figi`** (NG10 — the column exists and stays unwritten).
 *
 * **How each row was verified (FR-18's two-step protocol, one-off and
 * offline).** No ISIN here was written from memory or inference:
 *
 * 1. The identifier was sourced from a **first-party venue or regulator page**.
 *    For the Euronext rows that page is `source.url` itself, and the URL *is*
 *    the evidence because it encodes ISIN and MIC together; the page's own
 *    embedded instrument record was read back for name, symbol, ISIN and MIC.
 *    For the US rows `source.url` is an SEC N-PORT-P holdings report, which is
 *    public domain and carries, per position, the issuer name, LEI, asset
 *    category, currency, investment country and the ISIN.
 * 2. The identifier was **round-tripped through an identifier-mapping service**
 *    keyed on the ISIN, asserting the returned name is the intended company.
 *    That returned name is what `source.verifiedName` records. **This round
 *    trip, not the check digit, is what catches the dangerous error** — a
 *    valid-check-digit-but-wrong-company ISIN passes `isValidIsinCheckDigit`
 *    silently. The same round trip, re-issued with the MIC and the
 *    currency as filters, is what corroborates `exchangeMic` and
 *    `listingCurrency`; re-issued with the *wrong* currency it came back empty
 *    for 50 of the 51 listings, which is what makes it evidence rather than an
 *    echo. `domicileCountry` is the legal-entity jurisdiction from the global
 *    LEI registry keyed on the same ISIN — not the ISIN's national prefix,
 *    which would have put Eurofins Scientific (a Luxembourg entity with an
 *    `FR`-prefixed identifier) in the wrong country.
 *
 * The **recorded evidence is what ships**; the network step happened once, at
 * authoring time. Nothing in the shipped code, the build or CI ever contacts an
 * identifier-mapping service, and the gate that polices these rows performs no
 * I/O at all (NG10, NFR-7, AC-20, AC-33).
 *
 * **To add a row:** run both steps above, paste the evidence, mint a fresh
 * UUIDv7 literal, and let `pnpm instrument-catalogue-gate` decide. Do not
 * loosen the gate's name normalisation to admit a row whose `displayName`
 * disagrees with its `verifiedName` — fix the `displayName` (A17). A
 * name that cannot be sourced from a first-party page is **omitted, not
 * guessed**: `~51` is a target, and AC-18 asserts dataset-vs-database equality,
 * not a literal count (A18).
 */

/** FR-22's as-of date: the day this snapshot was compiled, rendered by `web`. */
export const INSTRUMENT_CATALOGUE_COMPILED_ON = "2026-08-22";

export interface SeededInstrument {
  /** UUIDv7 literal, minted once at authoring time (DD33) — never `gen_random_uuid()`, so the generated SQL is deterministic and a regeneration-drift test is possible. */
  readonly id: string;
  /** Share class included where two classes are seeded. Must normalise-equal `source.verifiedName` (gate rule 4). */
  readonly displayName: string;
  readonly isin: string;
  /** Must be in `CURATED_EXCHANGE_MICS` — the *operating* MIC, so NASDAQ tiers are `XNAS`. */
  readonly exchangeMic: string;
  /** Must be a seeded `currency` row. */
  readonly listingCurrency: string;
  readonly symbol: string;
  /** Verified per row from the global LEI registry; ISO 3166-1 alpha-2. */
  readonly domicileCountry: string;
  readonly source: {
    /** First-party venue or regulator page; `^https://`. */
    readonly url: string;
    /** ISO-8601 date the page was retrieved. */
    readonly retrievedOn: string;
    /** The name the identifier round trip returned (FR-19). */
    readonly verifiedName: string;
  };
}

/**
 * 51 rows: 40 European listings (39 Euronext Paris, ArcelorMittal on Euronext
 * Amsterdam) and 11 US listings covering 10 companies — both Alphabet share
 * classes are seeded with the class in the display name (D-16), because a
 * missing class forces exactly the manual creation this seed exists to avoid.
 * All rows are equities; there is no ETF row.
 */
export const SEEDED_INSTRUMENTS: readonly SeededInstrument[] = [
  // ── Euronext (39 Euronext Paris, 1 Euronext Amsterdam) ─────────────────────────
  {
    id: "01a02b21-eb98-7333-b4b0-8dc6be3a2fac",
    displayName: "TotalEnergies",
    isin: "FR0000120271",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "TTE",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120271-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "TOTALENERGIES SE",
    },
  },
  {
    // The one row whose `verifiedName` comes from the LEI registry rather than
    // the identifier-mapping round trip, and the reason is worth stating.
    //
    // The mapping response truncates this company's name at 28 characters
    // ("LVMH MOET HENNESSY LOUIS VUI"). Rule 4 then forces `displayName` to
    // match, which would have shipped a mangled word into the UI. The three
    // ways out were: accept it; omit the row (rejected — A18's omission clause
    // is for names that *cannot* be verified, and this one can); or record the
    // round trip against a source that returns full legal names. This row takes
    // the third. The gate's transform is **not** bent to admit a prettier name,
    // which is what A17 forbids.
    //
    // Evidence, keyed on this same ISIN (not on a name search):
    //   GET https://api.gleif.org/api/v1/lei-records?filter[isin]=FR0000121014
    //   -> LEI IOG4E947OATN0KJYSD45, legalName "LVMH MOET HENNESSY LOUIS VUITTON",
    //      jurisdiction FR, legal address FR
    // The mapping round trip agrees on identity (its truncated string is a
    // prefix of this one) and on venue; only its field length differs. Rule 4's
    // purpose is to catch a *different company*, and a full legal name serves
    // that at least as well as a truncated vendor field.
    id: "01a02b21-eb99-791f-893d-6020fe136416",
    displayName: "LVMH Moët Hennessy Louis Vuitton",
    isin: "FR0000121014",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "MC",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000121014-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "LVMH MOET HENNESSY LOUIS VUITTON",
    },
  },
  {
    id: "01a02b21-eb9a-7b5b-92a5-6828e979da02",
    displayName: "Sanofi",
    isin: "FR0000120578",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "SAN",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120578-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "SANOFI",
    },
  },
  {
    id: "01a02b21-eb9b-7c09-aa43-df04bfa6d0b8",
    displayName: "Airbus",
    isin: "NL0000235190",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "AIR",
    domicileCountry: "NL",
    source: {
      url: "https://live.euronext.com/en/product/equities/NL0000235190-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "AIRBUS SE",
    },
  },
  {
    id: "01a02b21-eb9c-7752-a884-719d130930d5",
    displayName: "Schneider Electric",
    isin: "FR0000121972",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "SU",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000121972-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "SCHNEIDER ELECTRIC SE",
    },
  },
  {
    id: "01a02b21-eb9d-7796-86cf-70df25276621",
    displayName: "Air Liquide",
    isin: "FR0000120073",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "AI",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120073-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "AIR LIQUIDE SA",
    },
  },
  {
    id: "01a02b21-eb9e-7313-9223-24a9eda451c1",
    displayName: "Hermès International",
    isin: "FR0000052292",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "RMS",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000052292-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "HERMES INTERNATIONAL",
    },
  },
  {
    id: "01a02b21-eb9f-75bc-a9d1-c8dc35804dd5",
    displayName: "EssilorLuxottica",
    isin: "FR0000121667",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "EL",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000121667-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "ESSILORLUXOTTICA",
    },
  },
  {
    id: "01a02b21-eba0-72ce-b2d1-9595ca41f6ed",
    displayName: "Safran",
    isin: "FR0000073272",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "SAF",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000073272-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "SAFRAN SA",
    },
  },
  {
    id: "01a02b21-eba1-7425-8a96-01f00233679c",
    displayName: "BNP Paribas",
    isin: "FR0000131104",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "BNP",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000131104-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "BNP PARIBAS",
    },
  },
  {
    id: "01a02b21-eba2-78ba-942a-589f6b079ae0",
    displayName: "AXA",
    isin: "FR0000120628",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "CS",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120628-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "AXA SA",
    },
  },
  {
    id: "01a02b21-eba3-7f50-9c70-a0cea619c7b5",
    displayName: "Vinci",
    isin: "FR0000125486",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "DG",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000125486-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "VINCI SA",
    },
  },
  {
    id: "01a02b21-eba4-7dd2-8cb4-8ba33a914dae",
    displayName: "Danone",
    isin: "FR0000120644",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "BN",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120644-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "DANONE",
    },
  },
  {
    id: "01a02b21-eba5-7348-aad5-81afd4f0514d",
    displayName: "Kering",
    isin: "FR0000121485",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "KER",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000121485-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "KERING",
    },
  },
  {
    id: "01a02b21-eba6-7bdd-adc6-2b5f1ad9e1fc",
    displayName: "Pernod Ricard",
    isin: "FR0000120693",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "RI",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120693-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "PERNOD RICARD SA",
    },
  },
  {
    id: "01a02b21-eba7-7263-96ce-e30739494a44",
    displayName: "Compagnie de Saint-Gobain",
    isin: "FR0000125007",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "SGO",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000125007-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "COMPAGNIE DE SAINT GOBAIN",
    },
  },
  {
    id: "01a02b21-eba8-785f-a786-4027b7177ae4",
    displayName: "Dassault Systèmes",
    isin: "FR0014003TT8",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "DSY",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0014003TT8-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "DASSAULT SYSTEMES SE",
    },
  },
  {
    // "(CGDE)" is the round trip's own qualifier for Compagnie Générale des
    // Établissements Michelin; kept so `displayName` matches the recorded
    // evidence (rule 4) rather than diverging from it for tidiness.
    id: "01a02b21-eba9-7db0-92de-698eb974774c",
    displayName: "Michelin (CGDE)",
    isin: "FR001400AJ45",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "ML",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR001400AJ45-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "MICHELIN (CGDE)",
    },
  },
  {
    id: "01a02b21-ebaa-764e-be74-bb13dbac0f55",
    displayName: "Capgemini",
    isin: "FR0000125338",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "CAP",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000125338-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "CAPGEMINI SE",
    },
  },
  {
    id: "01a02b21-ebab-7c7c-aa3a-f80e429f0e1e",
    displayName: "L'Oréal",
    isin: "FR0000120321",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "OR",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120321-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "L'OREAL",
    },
  },
  {
    id: "01a02b21-ebac-7ca3-b6fb-36d009111a55",
    displayName: "Orange",
    isin: "FR0000133308",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "ORA",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000133308-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "ORANGE",
    },
  },
  {
    id: "01a02b21-ebad-7144-ae0f-d7c334a54421",
    displayName: "Legrand",
    isin: "FR0010307819",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "LR",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0010307819-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "LEGRAND SA",
    },
  },
  {
    id: "01a02b21-ebae-7f25-a1e8-96c64c0f750c",
    displayName: "Publicis Groupe",
    isin: "FR0000130577",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "PUB",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000130577-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "PUBLICIS GROUPE",
    },
  },
  {
    id: "01a02b21-ebaf-7728-b613-303d95588e3d",
    displayName: "Thales",
    isin: "FR0000121329",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "HO",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000121329-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "THALES SA",
    },
  },
  {
    id: "01a02b21-ebb0-772d-8574-e676eadf86d2",
    displayName: "Crédit Agricole",
    isin: "FR0000045072",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "ACA",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000045072-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "CREDIT AGRICOLE SA",
    },
  },
  {
    id: "01a02b21-ebb1-7119-a9f4-c1ebc6a7cffa",
    displayName: "Société Générale",
    isin: "FR0000130809",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "GLE",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000130809-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "SOCIETE GENERALE SA",
    },
  },
  {
    id: "01a02b21-ebb2-773b-989d-0914260af46d",
    displayName: "Veolia Environnement",
    isin: "FR0000124141",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "VIE",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000124141-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "VEOLIA ENVIRONNEMENT",
    },
  },
  {
    id: "01a02b21-ebb3-704e-90cd-32d726805fdf",
    displayName: "Engie",
    isin: "FR0010208488",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "ENGI",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0010208488-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "ENGIE",
    },
  },
  {
    id: "01a02b21-ebb4-752f-8f13-3663b9fbb9cb",
    displayName: "Renault",
    isin: "FR0000131906",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "RNO",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000131906-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "RENAULT SA",
    },
  },
  {
    id: "01a02b21-ebb5-7d5f-ad72-8344a1df072f",
    displayName: "Stellantis",
    isin: "NL00150001Q9",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "STLAP",
    domicileCountry: "NL",
    source: {
      url: "https://live.euronext.com/en/product/equities/NL00150001Q9-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "STELLANTIS NV",
    },
  },
  {
    id: "01a02b21-ebb6-73ac-b67e-037c0b76a81c",
    displayName: "Bouygues",
    isin: "FR0000120503",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "EN",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120503-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "BOUYGUES SA",
    },
  },
  {
    id: "01a02b21-ebb7-7ea6-bba0-5ef190022417",
    displayName: "Carrefour",
    isin: "FR0000120172",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "CA",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120172-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "CARREFOUR SA",
    },
  },
  {
    // The only listing whose wrong-currency control was *not* empty: this
    // issuer also has a USD-denominated line on the same venue. The row below
    // is the EUR line, pinned by the venue page's own symbol `AC` (the USD line
    // is `ACMC`), so the positive assertion still identifies it uniquely.
    id: "01a02b21-ebb8-7743-ba54-c79025953101",
    displayName: "Accor",
    isin: "FR0000120404",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "AC",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0000120404-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "ACCOR SA",
    },
  },
  {
    // `LU`, not `FR`: a Luxembourg entity with an `FR`-prefixed identifier, and
    // the reason `domicileCountry` comes from the LEI registry rather than the
    // ISIN's national prefix.
    id: "01a02b21-ebb9-7ede-9f54-17e3e57aba3a",
    displayName: "Eurofins Scientific",
    isin: "FR0014000MR3",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "ERF",
    domicileCountry: "LU",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0014000MR3-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "EUROFINS SCIENTIFIC",
    },
  },
  {
    id: "01a02b21-ebba-7353-b79a-c97ddfa6e94c",
    displayName: "Edenred",
    isin: "FR0010908533",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "EDEN",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0010908533-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "EDENRED",
    },
  },
  {
    id: "01a02b21-ebbb-76c3-8777-611bac71ce7e",
    displayName: "Bureau Veritas",
    isin: "FR0006174348",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "BVI",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0006174348-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "BUREAU VERITAS SA",
    },
  },
  {
    id: "01a02b21-ebbc-783c-9fb4-c8fe9753f0f2",
    displayName: "Alstom",
    isin: "FR0010220475",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "ALO",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0010220475-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "ALSTOM",
    },
  },
  {
    id: "01a02b21-ebbd-7686-b3fe-3b44c625f11f",
    displayName: "Arkema",
    isin: "FR0010313833",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "AKE",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR0010313833-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "ARKEMA",
    },
  },
  {
    id: "01a02b21-ebbe-7c7d-b9c5-28a14853753a",
    displayName: "Worldline",
    isin: "FR00140182K6",
    exchangeMic: "XPAR",
    listingCurrency: "EUR",
    symbol: "WLN",
    domicileCountry: "FR",
    source: {
      url: "https://live.euronext.com/en/product/equities/FR00140182K6-XPAR",
      retrievedOn: "2026-08-22",
      verifiedName: "WORLDLINE SA",
    },
  },
  {
    id: "01a02b21-ebbf-7680-a815-d0ac94b6008d",
    // The one row whose `domicileCountry` came from the LEI registry's *entity*
    // record rather than its ISIN mapping — the registry publishes no mapping
    // for this equity line, so the jurisdiction was read from the entity the
    // round trip named, and it agrees with the identifier's `LU` prefix.
    displayName: "ArcelorMittal",
    isin: "LU1598757687",
    exchangeMic: "XAMS",
    listingCurrency: "EUR",
    symbol: "MT",
    domicileCountry: "LU",
    source: {
      url: "https://live.euronext.com/en/product/equities/LU1598757687-XAMS",
      retrievedOn: "2026-08-22",
      verifiedName: "ARCELORMITTAL",
    },
  },
  // ── United States (8 NASDAQ, 3 NYSE) ────────────────────────────────────────
  {
    id: "01a02b21-ebc0-7b2a-b3d1-b2c09d10640c",
    displayName: "Apple Inc.",
    isin: "US0378331005",
    exchangeMic: "XNAS",
    listingCurrency: "USD",
    symbol: "AAPL",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "APPLE INC",
    },
  },
  {
    id: "01a02b21-ebc1-7e5d-b9d3-443e4e93c00a",
    displayName: "Microsoft Corp.",
    isin: "US5949181045",
    exchangeMic: "XNAS",
    listingCurrency: "USD",
    symbol: "MSFT",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "MICROSOFT CORP",
    },
  },
  {
    id: "01a02b21-ebc2-7fab-8353-af27475394fa",
    displayName: "NVIDIA Corp.",
    isin: "US67066G1040",
    exchangeMic: "XNAS",
    listingCurrency: "USD",
    symbol: "NVDA",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "NVIDIA CORP",
    },
  },
  {
    id: "01a02b21-ebc3-726e-8777-9c4ddacffc0d",
    displayName: "Amazon.com Inc.",
    isin: "US0231351067",
    exchangeMic: "XNAS",
    listingCurrency: "USD",
    symbol: "AMZN",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "AMAZON.COM INC",
    },
  },
  {
    id: "01a02b21-ebc4-7897-838d-19fed4b5a4e2",
    displayName: "Alphabet Inc. Cl A",
    isin: "US02079K3059",
    exchangeMic: "XNAS",
    listingCurrency: "USD",
    symbol: "GOOGL",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "ALPHABET INC-CL A",
    },
  },
  {
    id: "01a02b21-ebc5-732e-b39f-6a0f68560d9e",
    displayName: "Alphabet Inc. Cl C",
    isin: "US02079K1079",
    exchangeMic: "XNAS",
    listingCurrency: "USD",
    symbol: "GOOG",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/1670310/000167031026000041/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "ALPHABET INC-CL C",
    },
  },
  {
    id: "01a02b21-ebc6-7374-9a33-2fde388f9d56",
    displayName: "Meta Platforms Inc. Class A",
    isin: "US30303M1027",
    exchangeMic: "XNAS",
    listingCurrency: "USD",
    symbol: "META",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "META PLATFORMS INC-CLASS A",
    },
  },
  {
    id: "01a02b21-ebc7-7f02-b8e1-2e72cf99db09",
    displayName: "Broadcom Inc.",
    isin: "US11135F1012",
    exchangeMic: "XNAS",
    listingCurrency: "USD",
    symbol: "AVGO",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "BROADCOM INC",
    },
  },
  {
    id: "01a02b21-ebc8-7c67-a4a6-efed3ec9682b",
    displayName: "Visa Inc. Class A Shares",
    isin: "US92826C8394",
    exchangeMic: "XNYS",
    listingCurrency: "USD",
    symbol: "V",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "VISA INC-CLASS A SHARES",
    },
  },
  {
    id: "01a02b21-ebc9-7eff-9857-39ae33a8c3e4",
    displayName: "JPMorgan Chase & Co.",
    isin: "US46625H1005",
    exchangeMic: "XNYS",
    listingCurrency: "USD",
    symbol: "JPM",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "JPMORGAN CHASE & CO",
    },
  },
  {
    id: "01a02b21-ebca-7684-b224-9e1af83aa9f9",
    displayName: "Eli Lilly & Co.",
    isin: "US5324571083",
    exchangeMic: "XNYS",
    listingCurrency: "USD",
    symbol: "LLY",
    domicileCountry: "US",
    source: {
      url: "https://www.sec.gov/Archives/edgar/data/793347/000109926326006571/primary_doc.xml",
      retrievedOn: "2026-08-22",
      verifiedName: "ELI LILLY & CO",
    },
  },
];
