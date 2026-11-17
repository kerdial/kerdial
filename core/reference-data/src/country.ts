/**
 * The embedded country list (FR-740, EW-L8) and its French labels (FR-8..FR-11).
 * Renders the country fields the API puts on the wire — « Pays de cotation »
 * (derived from `exchange_mic`) and « Pays du siège social »
 * (`instrument.domicile_country`) — in French, and is the vocabulary a country
 * exposure weight is validated against.
 *
 * **Every officially assigned ISO 3166-1 alpha-2 code, and nothing else.** The
 * ISO 3166 half of the earlier NG7 is lifted: {@link ISO_3166_COUNTRIES}
 * carries the 249 officially assigned codes (no user-assigned code such as
 * `XK`, no exceptionally reserved one such as `EU`, `UN` or `UK`, no
 * transitionally reserved one). The MIC half of NG7 stands: this list adds no
 * exchange curation. A code outside the list is still not an error for a
 * *label* — {@link countryLabel} returns `undefined` and its caller renders the
 * raw code (a stored domicile is validated by charset only, EW-L7).
 *
 * **Source, produced once at authoring time; no network at build or test
 * time.** The table is data, not generated at runtime, and no generator script
 * is committed:
 *
 *   - codes: the ISO 3166 Maintenance Agency's officially assigned set, as
 *     carried by the `iso-codes` 4.9.0 data files (249 entries), cross-checked
 *     against CLDR 48 (Node 22.23.1, ICU 78.2) — every one of the 249 has a CLDR
 *     region name, and the 31 other two-letter CLDR regions are all
 *     user-assigned, exceptionally or transitionally reserved codes;
 *   - French names: CLDR 48 via `Intl.DisplayNames(["fr"], { type: "region" })`,
 *     with these overrides and no others:
 *       - `HK` « Hong Kong » (CLDR's long form is « R.A.S. chinoise de Hong
 *         Kong »; « Hong Kong » is also the label this table carried before the
 *         list was embedded),
 *       - `MO` « Macao » (CLDR's long form is « R.A.S. chinoise de Macao »).
 *     The 30 labels the table carried before (`FR` … `LU`) are byte-identical;
 *     `HK` is the only one of them CLDR spells differently.
 *
 * **Stored in French collation order** (`Intl.Collator("fr").compare` on
 * `nameFr`, asserted by this module's drift test on the Node ICU), so a list
 * that renders it never sorts it at runtime: a browser's ICU may collate
 * differently, and the order must not move with the reader's browser.
 *
 * Deliberately **framework-free** (no `zod` import), for the reason
 * `exchange-mic.ts`'s and `sector.ts`'s headers both state: `web` imports it
 * and `web-no-server-runtime-imports` permits `core/*` only, so this module
 * stays dependency-free and that permission never needs widening.
 */

/**
 * Every officially assigned ISO 3166-1 alpha-2 code with its French name, in
 * French collation order of the name. The one source: {@link COUNTRY_LABELS_FR}
 * and {@link isIsoCountryCode} are derived from it.
 */
export const ISO_3166_COUNTRIES: readonly { readonly code: string; readonly nameFr: string }[] = [
  { code: "AF", nameFr: "Afghanistan" },
  { code: "ZA", nameFr: "Afrique du Sud" },
  { code: "AL", nameFr: "Albanie" },
  { code: "DZ", nameFr: "Algérie" },
  { code: "DE", nameFr: "Allemagne" },
  { code: "AD", nameFr: "Andorre" },
  { code: "AO", nameFr: "Angola" },
  { code: "AI", nameFr: "Anguilla" },
  { code: "AQ", nameFr: "Antarctique" },
  { code: "AG", nameFr: "Antigua-et-Barbuda" },
  { code: "SA", nameFr: "Arabie saoudite" },
  { code: "AR", nameFr: "Argentine" },
  { code: "AM", nameFr: "Arménie" },
  { code: "AW", nameFr: "Aruba" },
  { code: "AU", nameFr: "Australie" },
  { code: "AT", nameFr: "Autriche" },
  { code: "AZ", nameFr: "Azerbaïdjan" },
  { code: "BS", nameFr: "Bahamas" },
  { code: "BH", nameFr: "Bahreïn" },
  { code: "BD", nameFr: "Bangladesh" },
  { code: "BB", nameFr: "Barbade" },
  { code: "BE", nameFr: "Belgique" },
  { code: "BZ", nameFr: "Belize" },
  { code: "BJ", nameFr: "Bénin" },
  { code: "BM", nameFr: "Bermudes" },
  { code: "BT", nameFr: "Bhoutan" },
  { code: "BY", nameFr: "Biélorussie" },
  { code: "BO", nameFr: "Bolivie" },
  { code: "BA", nameFr: "Bosnie-Herzégovine" },
  { code: "BW", nameFr: "Botswana" },
  { code: "BR", nameFr: "Brésil" },
  { code: "BN", nameFr: "Brunei" },
  { code: "BG", nameFr: "Bulgarie" },
  { code: "BF", nameFr: "Burkina Faso" },
  { code: "BI", nameFr: "Burundi" },
  { code: "KH", nameFr: "Cambodge" },
  { code: "CM", nameFr: "Cameroun" },
  { code: "CA", nameFr: "Canada" },
  { code: "CV", nameFr: "Cap-Vert" },
  { code: "CL", nameFr: "Chili" },
  { code: "CN", nameFr: "Chine" },
  { code: "CY", nameFr: "Chypre" },
  { code: "CO", nameFr: "Colombie" },
  { code: "KM", nameFr: "Comores" },
  { code: "CG", nameFr: "Congo-Brazzaville" },
  { code: "CD", nameFr: "Congo-Kinshasa" },
  { code: "KP", nameFr: "Corée du Nord" },
  { code: "KR", nameFr: "Corée du Sud" },
  { code: "CR", nameFr: "Costa Rica" },
  { code: "CI", nameFr: "Côte d’Ivoire" },
  { code: "HR", nameFr: "Croatie" },
  { code: "CU", nameFr: "Cuba" },
  { code: "CW", nameFr: "Curaçao" },
  { code: "DK", nameFr: "Danemark" },
  { code: "DJ", nameFr: "Djibouti" },
  { code: "DM", nameFr: "Dominique" },
  { code: "EG", nameFr: "Égypte" },
  { code: "AE", nameFr: "Émirats arabes unis" },
  { code: "EC", nameFr: "Équateur" },
  { code: "ER", nameFr: "Érythrée" },
  { code: "ES", nameFr: "Espagne" },
  { code: "EE", nameFr: "Estonie" },
  { code: "SZ", nameFr: "Eswatini" },
  { code: "VA", nameFr: "État de la Cité du Vatican" },
  { code: "US", nameFr: "États-Unis" },
  { code: "ET", nameFr: "Éthiopie" },
  { code: "FJ", nameFr: "Fidji" },
  { code: "FI", nameFr: "Finlande" },
  { code: "FR", nameFr: "France" },
  { code: "GA", nameFr: "Gabon" },
  { code: "GM", nameFr: "Gambie" },
  { code: "GE", nameFr: "Géorgie" },
  { code: "GS", nameFr: "Géorgie du Sud-et-les Îles Sandwich du Sud" },
  { code: "GH", nameFr: "Ghana" },
  { code: "GI", nameFr: "Gibraltar" },
  { code: "GR", nameFr: "Grèce" },
  { code: "GD", nameFr: "Grenade" },
  { code: "GL", nameFr: "Groenland" },
  { code: "GP", nameFr: "Guadeloupe" },
  { code: "GU", nameFr: "Guam" },
  { code: "GT", nameFr: "Guatemala" },
  { code: "GG", nameFr: "Guernesey" },
  { code: "GN", nameFr: "Guinée" },
  { code: "GQ", nameFr: "Guinée équatoriale" },
  { code: "GW", nameFr: "Guinée-Bissau" },
  { code: "GY", nameFr: "Guyana" },
  { code: "GF", nameFr: "Guyane française" },
  { code: "HT", nameFr: "Haïti" },
  { code: "HN", nameFr: "Honduras" },
  { code: "HK", nameFr: "Hong Kong" },
  { code: "HU", nameFr: "Hongrie" },
  { code: "BV", nameFr: "Île Bouvet" },
  { code: "CX", nameFr: "Île Christmas" },
  { code: "IM", nameFr: "Île de Man" },
  { code: "NF", nameFr: "Île Norfolk" },
  { code: "AX", nameFr: "Îles Åland" },
  { code: "KY", nameFr: "Îles Caïmans" },
  { code: "CC", nameFr: "Îles Cocos" },
  { code: "CK", nameFr: "Îles Cook" },
  { code: "FO", nameFr: "Îles Féroé" },
  { code: "HM", nameFr: "Îles Heard-et-MacDonald" },
  { code: "FK", nameFr: "Îles Malouines" },
  { code: "MP", nameFr: "Îles Mariannes du Nord" },
  { code: "MH", nameFr: "Îles Marshall" },
  { code: "UM", nameFr: "Îles mineures éloignées des États-Unis" },
  { code: "PN", nameFr: "Îles Pitcairn" },
  { code: "SB", nameFr: "Îles Salomon" },
  { code: "TC", nameFr: "Îles Turques-et-Caïques" },
  { code: "VG", nameFr: "Îles Vierges britanniques" },
  { code: "VI", nameFr: "Îles Vierges des États-Unis" },
  { code: "IN", nameFr: "Inde" },
  { code: "ID", nameFr: "Indonésie" },
  { code: "IQ", nameFr: "Irak" },
  { code: "IR", nameFr: "Iran" },
  { code: "IE", nameFr: "Irlande" },
  { code: "IS", nameFr: "Islande" },
  { code: "IL", nameFr: "Israël" },
  { code: "IT", nameFr: "Italie" },
  { code: "JM", nameFr: "Jamaïque" },
  { code: "JP", nameFr: "Japon" },
  { code: "JE", nameFr: "Jersey" },
  { code: "JO", nameFr: "Jordanie" },
  { code: "KZ", nameFr: "Kazakhstan" },
  { code: "KE", nameFr: "Kenya" },
  { code: "KG", nameFr: "Kirghizstan" },
  { code: "KI", nameFr: "Kiribati" },
  { code: "KW", nameFr: "Koweït" },
  { code: "RE", nameFr: "La Réunion" },
  { code: "LA", nameFr: "Laos" },
  { code: "LS", nameFr: "Lesotho" },
  { code: "LV", nameFr: "Lettonie" },
  { code: "LB", nameFr: "Liban" },
  { code: "LR", nameFr: "Liberia" },
  { code: "LY", nameFr: "Libye" },
  { code: "LI", nameFr: "Liechtenstein" },
  { code: "LT", nameFr: "Lituanie" },
  { code: "LU", nameFr: "Luxembourg" },
  { code: "MO", nameFr: "Macao" },
  { code: "MK", nameFr: "Macédoine du Nord" },
  { code: "MG", nameFr: "Madagascar" },
  { code: "MY", nameFr: "Malaisie" },
  { code: "MW", nameFr: "Malawi" },
  { code: "MV", nameFr: "Maldives" },
  { code: "ML", nameFr: "Mali" },
  { code: "MT", nameFr: "Malte" },
  { code: "MA", nameFr: "Maroc" },
  { code: "MQ", nameFr: "Martinique" },
  { code: "MU", nameFr: "Maurice" },
  { code: "MR", nameFr: "Mauritanie" },
  { code: "YT", nameFr: "Mayotte" },
  { code: "MX", nameFr: "Mexique" },
  { code: "FM", nameFr: "Micronésie" },
  { code: "MD", nameFr: "Moldavie" },
  { code: "MC", nameFr: "Monaco" },
  { code: "MN", nameFr: "Mongolie" },
  { code: "ME", nameFr: "Monténégro" },
  { code: "MS", nameFr: "Montserrat" },
  { code: "MZ", nameFr: "Mozambique" },
  { code: "MM", nameFr: "Myanmar (Birmanie)" },
  { code: "NA", nameFr: "Namibie" },
  { code: "NR", nameFr: "Nauru" },
  { code: "NP", nameFr: "Népal" },
  { code: "NI", nameFr: "Nicaragua" },
  { code: "NE", nameFr: "Niger" },
  { code: "NG", nameFr: "Nigeria" },
  { code: "NU", nameFr: "Niue" },
  { code: "NO", nameFr: "Norvège" },
  { code: "NC", nameFr: "Nouvelle-Calédonie" },
  { code: "NZ", nameFr: "Nouvelle-Zélande" },
  { code: "OM", nameFr: "Oman" },
  { code: "UG", nameFr: "Ouganda" },
  { code: "UZ", nameFr: "Ouzbékistan" },
  { code: "PK", nameFr: "Pakistan" },
  { code: "PW", nameFr: "Palaos" },
  { code: "PA", nameFr: "Panama" },
  { code: "PG", nameFr: "Papouasie-Nouvelle-Guinée" },
  { code: "PY", nameFr: "Paraguay" },
  { code: "NL", nameFr: "Pays-Bas" },
  { code: "BQ", nameFr: "Pays-Bas caribéens" },
  { code: "PE", nameFr: "Pérou" },
  { code: "PH", nameFr: "Philippines" },
  { code: "PL", nameFr: "Pologne" },
  { code: "PF", nameFr: "Polynésie française" },
  { code: "PR", nameFr: "Porto Rico" },
  { code: "PT", nameFr: "Portugal" },
  { code: "QA", nameFr: "Qatar" },
  { code: "CF", nameFr: "République centrafricaine" },
  { code: "DO", nameFr: "République dominicaine" },
  { code: "RO", nameFr: "Roumanie" },
  { code: "GB", nameFr: "Royaume-Uni" },
  { code: "RU", nameFr: "Russie" },
  { code: "RW", nameFr: "Rwanda" },
  { code: "EH", nameFr: "Sahara occidental" },
  { code: "BL", nameFr: "Saint-Barthélemy" },
  { code: "KN", nameFr: "Saint-Christophe-et-Niévès" },
  { code: "SM", nameFr: "Saint-Marin" },
  { code: "MF", nameFr: "Saint-Martin" },
  { code: "SX", nameFr: "Saint-Martin (partie néerlandaise)" },
  { code: "PM", nameFr: "Saint-Pierre-et-Miquelon" },
  { code: "VC", nameFr: "Saint-Vincent-et-les Grenadines" },
  { code: "SH", nameFr: "Sainte-Hélène" },
  { code: "LC", nameFr: "Sainte-Lucie" },
  { code: "SV", nameFr: "Salvador" },
  { code: "WS", nameFr: "Samoa" },
  { code: "AS", nameFr: "Samoa américaines" },
  { code: "ST", nameFr: "Sao Tomé-et-Principe" },
  { code: "SN", nameFr: "Sénégal" },
  { code: "RS", nameFr: "Serbie" },
  { code: "SC", nameFr: "Seychelles" },
  { code: "SL", nameFr: "Sierra Leone" },
  { code: "SG", nameFr: "Singapour" },
  { code: "SK", nameFr: "Slovaquie" },
  { code: "SI", nameFr: "Slovénie" },
  { code: "SO", nameFr: "Somalie" },
  { code: "SD", nameFr: "Soudan" },
  { code: "SS", nameFr: "Soudan du Sud" },
  { code: "LK", nameFr: "Sri Lanka" },
  { code: "SE", nameFr: "Suède" },
  { code: "CH", nameFr: "Suisse" },
  { code: "SR", nameFr: "Suriname" },
  { code: "SJ", nameFr: "Svalbard et Jan Mayen" },
  { code: "SY", nameFr: "Syrie" },
  { code: "TJ", nameFr: "Tadjikistan" },
  { code: "TW", nameFr: "Taïwan" },
  { code: "TZ", nameFr: "Tanzanie" },
  { code: "TD", nameFr: "Tchad" },
  { code: "CZ", nameFr: "Tchéquie" },
  { code: "TF", nameFr: "Terres australes françaises" },
  { code: "IO", nameFr: "Territoire britannique de l’océan Indien" },
  { code: "PS", nameFr: "Territoires palestiniens" },
  { code: "TH", nameFr: "Thaïlande" },
  { code: "TL", nameFr: "Timor oriental" },
  { code: "TG", nameFr: "Togo" },
  { code: "TK", nameFr: "Tokelau" },
  { code: "TO", nameFr: "Tonga" },
  { code: "TT", nameFr: "Trinité-et-Tobago" },
  { code: "TN", nameFr: "Tunisie" },
  { code: "TM", nameFr: "Turkménistan" },
  { code: "TR", nameFr: "Turquie" },
  { code: "TV", nameFr: "Tuvalu" },
  { code: "UA", nameFr: "Ukraine" },
  { code: "UY", nameFr: "Uruguay" },
  { code: "VU", nameFr: "Vanuatu" },
  { code: "VE", nameFr: "Venezuela" },
  { code: "VN", nameFr: "Viêt Nam" },
  { code: "WF", nameFr: "Wallis-et-Futuna" },
  { code: "YE", nameFr: "Yémen" },
  { code: "ZM", nameFr: "Zambie" },
  { code: "ZW", nameFr: "Zimbabwe" },
];

/** ISO 3166-1 alpha-2 code -> French country name, derived from {@link ISO_3166_COUNTRIES}. */
export const COUNTRY_LABELS_FR: Readonly<Record<string, string>> = Object.fromEntries(
  ISO_3166_COUNTRIES.map((country) => [country.code, country.nameFr]),
);

/**
 * Whether `code` is an officially assigned ISO 3166-1 alpha-2 code. Exact and
 * case-sensitive: `"fr"` is not a code, `"FR"` is.
 *
 * Guarded with `Object.hasOwn` for the same F-6 reason {@link countryLabel}
 * records: an inherited-property name such as `"toString"` must not pass.
 */
export function isIsoCountryCode(code: string): boolean {
  return Object.hasOwn(COUNTRY_LABELS_FR, code);
}

/**
 * Total function: `undefined` for a code with no label, never throws — the
 * caller renders the raw code in that case, which is why a missing
 * entry degrades a label rather than hiding a country.
 *
 * Guarded with `Object.hasOwn` for the same F-6 reason
 * `sectorCodeForProviderLabel` records in full: `code` reaches this function
 * from a database row or a derived MIC lookup, and an inherited-property name
 * must resolve to `undefined` rather than to a member of `Object.prototype`.
 */
export function countryLabel(code: string): string | undefined {
  return Object.hasOwn(COUNTRY_LABELS_FR, code) ? COUNTRY_LABELS_FR[code] : undefined;
}
