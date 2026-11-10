/**
 * `copy/currencies.ts` — the **Devises** screen.
 *
 * `CurrenciesRoute.tsx`: the FX pairs this installation fetches, their latest
 * rate, and the two writes that change the set.
 *
 * The three patterns below carry `{slot}`s the route fills with values it has
 * already rendered — a pair key, a currency code, a count. Nothing here
 * formats, pluralises or joins; that stays with the callers and the helpers
 * that already own it.
 */
export type CurrenciesCopyKey =
  | "screenTitle"
  | "screenSubtitle"
  | "refetch"
  | "pairsFetched"
  | "pairsTracked"
  | "latestRate"
  | "source"
  | "ratesExpressedIn"
  | "pairsWithoutHistory"
  | "ingestionNotConfigured"
  | "pairNotPublished"
  | "addPair"
  | "addPairHint"
  | "choosePair"
  | "add"
  | "loadingRates"
  | "noPairs"
  | "columnPair"
  | "columnLatestRate"
  | "columnDate"
  | "columnSource"
  | "columnHistory"
  | "columnOrigin"
  | "columnAction"
  | "flagHeld"
  | "flagTracked"
  | "flagUnsupported"
  | "stopTracking"
  | "installationWideNote";

export const CURRENCIES_COPY = {
  screenTitle: "Devises",
  screenSubtitle: "Les taux de change récupérés pour les devises de vos positions.",
  refetch: "Relancer la récupération",
  pairsFetched: "Paires récupérées",
  pairsTracked: "dont {count} ajoutées",
  latestRate: "Taux le plus récent",
  source: "Source",
  ratesExpressedIn: "taux exprimés en {currency}",
  pairsWithoutHistory: "Paires sans historique",
  ingestionNotConfigured:
    "Cette installation n'a pas de file de récupération configurée : les taux affichés restent ceux déjà enregistrés, et le bouton de relance est indisponible.",
  /** Appended to `messageForError(...).text`, hence the leading space. */
  pairNotPublished: " Cette paire n'est pas publiée par la source de taux.",
  addPair: "Ajouter une paire",
  addPairHint: "Seules les paires publiées par la source de taux sont proposées.",
  choosePair: "Choisir une paire…",
  add: "Ajouter",
  loadingRates: "Chargement des taux de change…",
  noPairs:
    "Aucune paire à récupérer pour le moment. Les devises de vos positions apparaissent ici automatiquement ; vous pouvez aussi ajouter une paire ci-dessus pour la suivre dès maintenant.",
  columnPair: "Paire",
  columnLatestRate: "Dernier taux",
  columnDate: "Date",
  columnSource: "Source",
  columnHistory: "Historique",
  columnOrigin: "Origine",
  columnAction: "Action",
  flagHeld: "Position",
  flagTracked: "Ajoutée",
  flagUnsupported: "Non publiée",
  stopTracking: "Ne plus suivre {pair}",
  installationWideNote:
    "Les paires ajoutées valent pour toute l'installation, pas seulement pour votre compte. Retirer une paire arrête sa récupération ; les taux déjà enregistrés sont conservés.",
} as const satisfies Readonly<Record<CurrenciesCopyKey, string>>;
