/**
 * `copy/shell.ts` — the app chrome.
 *
 * The parts of the UI that belong to no screen because they are on every
 * screen: the navigation rail and its two mobile forms, the account menu,
 * quick search, the offline banner, the service-worker update toast, the two
 * global write buttons, and the per-panel loading line.
 *
 * The nav *destinations* are not here. `nav-items.ts` owns each item's label,
 * icon and route together — FR-95's binding requirement is the destination
 * set, and splitting a nav item's label away from its route is how a rail and
 * a tab bar start offering different words for the same screen. This module
 * holds the chrome around those items, not the items.
 */
export type ShellCopyKey =
  | "brandName"
  | "primaryNav"
  | "openNavMenu"
  | "moreNav"
  | "navigation"
  | "account"
  | "myAccount"
  | "users"
  | "logout"
  | "search"
  | "quickSearchTitle"
  | "quickSearchDescription"
  | "quickSearchPlaceholder"
  | "quickSearchPortfolios"
  | "quickSearchNoPortfolio"
  | "quickSearchPortfoliosTruncated"
  | "quickSearchInstruments"
  | "quickSearchInstrumentMinimum"
  | "quickSearchNoInstrument"
  | "offline"
  | "updateAvailable"
  | "reload"
  | "newInstrument"
  | "newTransaction"
  | "panelLoading";

export const SHELL_COPY = {
  /** The product name. Catalogued rather than exempted: a brand is still a string on screen, and `Brand.tsx` renders it twice. */
  brandName: "Kerdial",
  primaryNav: "Navigation principale",
  openNavMenu: "Ouvrir le menu de navigation",
  moreNav: "Plus",
  navigation: "Navigation",
  /** The fallback name for the account button when no email is known. */
  account: "Compte",
  /** `account-setup` UR-70/LD-2: the account menu's own two new entries — a menu item each, never a nav-rail section. */
  myAccount: "Mon compte",
  users: "Utilisateurs",
  logout: "Se déconnecter",
  search: "Rechercher",
  quickSearchTitle: "Recherche rapide",
  quickSearchDescription: "Rechercher un portefeuille ou un instrument par nom.",
  quickSearchPlaceholder: "Rechercher un portefeuille ou un instrument…",
  quickSearchPortfolios: "Portefeuilles",
  quickSearchNoPortfolio: "Aucun portefeuille ne correspond.",
  quickSearchPortfoliosTruncated:
    "D'autres portefeuilles correspondent — affinez la recherche pour les voir.",
  quickSearchInstruments: "Instruments",
  quickSearchInstrumentMinimum:
    "Tapez au moins 3 caractères alphanumériques pour rechercher un instrument.",
  quickSearchNoInstrument: "Aucun instrument ne correspond.",
  offline:
    "Hors ligne — seule l'application de base est disponible ; les données ne peuvent pas être actualisées.",
  updateAvailable: "Nouvelle version disponible",
  reload: "Recharger",
  newInstrument: "Nouvel instrument",
  newTransaction: "Nouvelle transaction",
  /**
   * `{panel}` is the panel's own French name in the grammatical form that
   * follows « Chargement » — « des positions », « de l'historique des cours ».
   * That form belongs to the caller, which is why this is a slot and not a
   * concatenation done here.
   */
  panelLoading: "Chargement {panel}…",
} as const satisfies Readonly<Record<ShellCopyKey, string>>;
