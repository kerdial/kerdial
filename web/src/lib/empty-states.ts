import { ApiError } from "./api-client.js";

/**
 * `empty-states.ts` — UR-36 (FR-110/FR-113/FR-122, AC105/AC114).
 *
 * **One catalogue, twelve states + two, + four.** The base table lists
 * twelve states, then adds `VALUATION_RESPONSE_TOO_LARGE` and "a 429 throttled
 * state distinct from a failure" as separate requirements — fourteen entries;
 * `dividend-screen` DS-8 adds `zero-dividends` as the
 * fifteenth, `closed-positions` adds `portfolio-no-closed-positions` as
 * the sixteenth, and `watchlist` (UR-54) adds `watchlist-empty` and
 * `watchlist-row-no-price` as the seventeenth and eighteenth — each for a
 * screen that did not exist when UR-36 was written. All
 * below. Keeping every string here (rather than inline in each
 * screen) is what makes the two ACs mechanically checkable at all:
 *
 * - "each state renders its own explanation" — `EmptyState.tsx` reads title
 *   and explanation **from this table by id**, so a state that renders is a
 *   state that has copy, by construction (a screen cannot silently render a
 *   bare container and still name a state id);
 * - "no empty/error copy implies a capability that is blocked" — `empty-state-copy-audit.test.ts` scans this one table plus the
 *   state components' own source text, instead of chasing free-floating JSX
 *   strings across nine screens.
 *
 * **Each entry answers three questions** — *what
 * happened* (`title`), *whether it is expected* (`expected`, rendered as an
 * explicit French badge by `EmptyState.tsx`, never left for the user to
 * infer), and *what the user can do* (the closing sentence of `explanation`,
 * plus `actionLabel` when a **real, reachable** action exists — never an
 * invented one).
 *
 * **Error-shaped states carry no server text.** For the four error-shaped
 * entries the *what happened* half comes from `messageForError` (UR-6) at
 * render time via `ValuationErrorState.tsx`; `explanation` here is the
 * recovery half only. The server's `detail`/`title` is never rendered
 * (FR-110, FR-128/AC120) — see `problem-messages.ts`'s own header.
 *
 * **Copy constraints that are load-bearing, not stylistic** (the blocked
 * register):
 * - no state promises a backfill retry, automatic or manual — there is no
 *   endpoint and the reconcile job skips `FAILED` by design;
 * - no state names a cash/`trésorerie` figure. **Amended by CA-19**:
 *   it used to be that no
 *   route read `cash_balance`, and that is no longer true —
 *   `GET /portfolios/:id/cash` does, and the workspace's « Espèces » tab
 *   renders it. Since portfolio-cash (FR-689) the holdings and overview
 *   reads carry the as-of cash too, and the stat strip and the Aperçu tab
 *   show it as « Liquidités ». What survives is that no **empty state**
 *   presents the figure itself: the surfaces above it already state it, and
 *   `cash-only-portfolio` points at the tab where the accounts live instead
 *   of repeating a number — it used to assert no cash figure existed, the
 *   claim CA-19 falsified;
 * - no state presents a wall-clock recalculation time;
 * - no state implies an audit trail or change log (AC115's standing rule).
 */
export type EmptyStateId =
  | "zero-portfolios"
  | "zero-instruments"
  | "zero-transactions"
  | "portfolio-no-holdings"
  | "cash-only-portfolio"
  | "manual-only-without-price"
  | "ingestion-in-progress"
  | "ingestion-failed"
  | "sold-out-instrument"
  | "valuation-price-unavailable"
  | "valuation-fx-rate-unavailable"
  | "valuation-response-too-large"
  | "read-throttled"
  | "zero-dividends"
  | "portfolio-no-closed-positions"
  | "watchlist-empty"
  | "watchlist-row-no-price";

export interface EmptyStateCopy {
  readonly id: EmptyStateId;
  /** *What happened*, in one short French noun phrase. */
  readonly title: string;
  /** *Whether it is expected*, and *what the user can do* — never a raw payload, never the server's `detail`. */
  readonly explanation: string;
  /** Rendered as an explicit badge by `EmptyState.tsx`, so "is this normal?" is answered on screen rather than inferred from tone. */
  readonly expected: boolean;
  /** Present only when a genuinely reachable action exists for this state. Absent is a statement, not an omission. */
  readonly actionLabel?: string;
}

/** The canonical order — the base twelve states, then the two additional requirements. */
export const EMPTY_STATE_IDS: readonly EmptyStateId[] = [
  "zero-portfolios",
  "zero-instruments",
  "zero-transactions",
  "portfolio-no-holdings",
  "cash-only-portfolio",
  "manual-only-without-price",
  "ingestion-in-progress",
  "ingestion-failed",
  "sold-out-instrument",
  "valuation-price-unavailable",
  "valuation-fx-rate-unavailable",
  "valuation-response-too-large",
  "read-throttled",
  // `dividend-screen` DS-8 — the Dividendes screen's own
  // first-use/narrow-scope state.
  "zero-dividends",
  // `closed-positions` (OD-2/UR-41) — the « Clôturées » tab's own honest
  // "you have not fully sold out of anything yet" case, for a screen half that
  // did not exist when UR-36 was written.
  "portfolio-no-closed-positions",
  // `watchlist` (UR-54, AC-344) — the two states of a screen that did not
  // exist when UR-36 was written: a watchlist with no rows at all, and a
  // watched instrument the wire carries no price for.
  "watchlist-empty",
  "watchlist-row-no-price",
];

export const EXPECTED_BADGE_LABEL = "Situation normale";
export const UNEXPECTED_BADGE_LABEL = "Anomalie";

export const EMPTY_STATE_COPY: Readonly<Record<EmptyStateId, EmptyStateCopy>> = {
  "zero-portfolios": {
    id: "zero-portfolios",
    title: "Aucun portefeuille",
    explanation:
      "Aucun portefeuille n'a encore été créé — c'est l'état attendu à la première utilisation. Créez un portefeuille pour pouvoir y enregistrer des transactions.",
    expected: true,
    actionLabel: "Créer un portefeuille",
  },
  "zero-instruments": {
    id: "zero-instruments",
    title: "Aucun instrument",
    explanation:
      "Cette liste réunit les instruments détenus ou déjà transigés : elle est vide parce qu'aucune transaction n'a encore été enregistrée. C'est attendu — elle se remplira d'elle-même dès la première transaction.",
    expected: true,
    actionLabel: "Ajouter une transaction",
  },
  "zero-transactions": {
    id: "zero-transactions",
    title: "Aucune transaction",
    explanation:
      "Aucune transaction n'a encore été enregistrée — c'est l'état attendu à la première utilisation. Ajoutez une transaction pour alimenter positions, instruments et valorisations.",
    expected: true,
    actionLabel: "Ajouter une transaction",
  },
  "portfolio-no-holdings": {
    id: "portfolio-no-holdings",
    title: "Aucune position",
    explanation:
      "Aucune position valorisée n'est détenue dans cette vue. C'est attendu : les positions peuvent avoir été entièrement cédées, le portefeuille peut ne contenir que des espèces, ou aucune transaction n'a encore été enregistrée. Ajoutez une transaction pour alimenter cette vue.",
    expected: true,
    actionLabel: "Ajouter une transaction",
  },
  "cash-only-portfolio": {
    id: "cash-only-portfolio",
    title: "Aucune position valorisée",
    explanation:
      "Ce portefeuille a des transactions enregistrées mais plus aucune position ouverte : il a pu être entièrement soldé, ou ne contenir que des espèces. C'est attendu. Seules les positions en titres sont valorisées ici ; les comptes espèces de ce portefeuille se consultent dans l'onglet « Espèces ».",
    expected: true,
    actionLabel: "Voir l'activité de ce portefeuille",
  },
  "manual-only-without-price": {
    id: "manual-only-without-price",
    title: "Aucune valeur liquidative saisie",
    explanation:
      "Cet instrument est en valorisation manuelle : aucune source automatique ne lui fournit de cours. C'est attendu pour ce type de fonds — il restera non valorisé tant qu'aucune valeur liquidative n'aura été saisie.",
    expected: true,
    actionLabel: "Saisir une valeur liquidative",
  },
  "ingestion-in-progress": {
    id: "ingestion-in-progress",
    title: "Récupération de l'historique en cours",
    explanation:
      "L'historique des cours de cet instrument est en cours de récupération — cela peut prendre quelques minutes. C'est transitoire et attendu : aucune action n'est nécessaire, l'historique s'affichera une fois la récupération terminée.",
    expected: true,
  },
  "ingestion-failed": {
    id: "ingestion-failed",
    title: "Récupération de l'historique en échec",
    explanation:
      "La récupération automatique de l'historique des cours s'est arrêtée en échec. Ce n'est pas normal, et la cause n'est pas conservée : l'application n'en dispose pas et ne peut pas la restituer. Vous pouvez saisir un cours manuellement pour que cet instrument reste valorisé.",
    expected: false,
    actionLabel: "Saisir un cours manuel",
  },
  "sold-out-instrument": {
    id: "sold-out-instrument",
    title: "Instrument entièrement cédé",
    explanation:
      "Cet instrument n'est plus détenu : toutes les quantités ont été cédées. C'est un état historique normal, pas une erreur — les transactions passées restent consultables.",
    expected: true,
    actionLabel: "Voir l'activité de cet instrument",
  },
  "valuation-price-unavailable": {
    id: "valuation-price-unavailable",
    title: "Valorisation indisponible — cours manquant",
    explanation:
      "Ce panneau n'a pas pu être valorisé ; les autres panneaux de cet écran restent affichés. Ce n'est pas attendu : saisissez un cours pour l'instrument concerné, ou revenez plus tard.",
    expected: false,
  },
  "valuation-fx-rate-unavailable": {
    id: "valuation-fx-rate-unavailable",
    title: "Valorisation indisponible — taux de change manquant",
    explanation:
      "Ce panneau n'a pas pu être converti dans la devise de référence ; les autres panneaux de cet écran restent affichés. Ce n'est pas attendu : revenez plus tard, ou restreignez la période demandée.",
    expected: false,
  },
  "valuation-response-too-large": {
    id: "valuation-response-too-large",
    title: "Vue trop volumineuse",
    explanation:
      "Le serveur a refusé de produire cette vue parce qu'elle dépasse la taille maximale prise en charge. Ce n'est pas attendu à l'usage courant : demandez un portefeuille à la fois, ou une période plus courte.",
    expected: false,
  },
  "zero-dividends": {
    id: "zero-dividends",
    title: "Aucun dividende enregistré",
    explanation:
      "Aucune transaction de type dividende sur la période et le périmètre choisis. C'est attendu tant qu'aucun versement n'a été enregistré. Enregistrez un dividende depuis l'écran Activité, ou élargissez la période.",
    expected: true,
    actionLabel: "Ouvrir l'Activité",
  },
  "read-throttled": {
    id: "read-throttled",
    title: "Lectures temporairement limitées",
    explanation:
      "Trop de requêtes simultanées ont été envoyées ; cette lecture a été refusée. C'est une limite temporaire, sans perte de données — patientez un instant puis relancez la lecture.",
    expected: false,
    actionLabel: "Relancer la lecture",
  },
  /**
   * `closed-positions` — the « Clôturées » tab's own empty case, and the
   * one state in this catalogue that is genuinely new for that feature (the
   * cap refusal reuses `valuation-response-too-large` above, same panel, same
   * copy).
   *
   * **Action-free, deliberately.** The only thing that produces a closed
   * position is selling the last unit of a line, which is not something this
   * screen can offer as a button without implying it will do it — the same
   * "waiting is not an action" rule `ingestion-in-progress` follows. It names
   * where the still-held lines are instead, which is the honest answer to
   * "then where is my portfolio?".
   */
  "portfolio-no-closed-positions": {
    id: "portfolio-no-closed-positions",
    title: "Aucune position clôturée",
    explanation:
      "Aucun instrument n'a encore été entièrement cédé sur ce périmètre. C'est attendu : une ligne n'apparaît ici qu'une fois la totalité de ses quantités vendues, et les positions encore détenues restent dans l'onglet « Ouvertes ».",
    expected: true,
  },
  /**
   * `watchlist` (UR-54(a), AC-344) — the first-use state of the Suivi
   * screen, and the one state in this catalogue whose action is genuinely on
   * the same screen: « Ajouter » opens the asset-search popover in the header,
   * so the label points at a control that is already there rather than at
   * another destination.
   */
  "watchlist-empty": {
    id: "watchlist-empty",
    title: "Aucun instrument suivi",
    explanation:
      "Cette liste ne contient encore aucun instrument — c'est l'état attendu à la première utilisation. Ajoutez un instrument pour suivre son cours et ses indicateurs, qu'il soit détenu ou non.",
    expected: true,
    actionLabel: "Ajouter un instrument",
  },
  /**
   * `watchlist` (UR-54(b), AC-344) — a watched instrument the response
   * carries **no price for at all** (FR-346: `currentPrice` absent, not zero).
   *
   * **Action-free, deliberately**, and distinct from
   * `manual-only-without-price` above: that state describes a fund whose
   * valuation is manual by policy and offers the saisie that fixes it, which is
   * a claim this row cannot make — a watched instrument may simply have no
   * history yet, because the backfill the first watch requested has not
   * landed. Naming a wait is not offering an action (`ingestion-in-progress`'s
   * own rule), and the copy says which of the two facts it knows: no price of
   * any origin exists yet.
   */
  "watchlist-row-no-price": {
    id: "watchlist-row-no-price",
    title: "Aucun cours disponible",
    explanation:
      "Aucun cours n'est disponible pour cet instrument, d'aucune source : ses indicateurs restent donc vides plutôt que d'afficher zéro. C'est attendu juste après un premier suivi, le temps que l'historique soit récupéré ; vous pouvez aussi saisir un cours manuellement depuis la fiche de l'instrument.",
    expected: true,
  },
};

/**
 * Maps an error thrown by a valuation-shaped read onto its own state id, or
 * `undefined` when no dedicated state applies (the caller then falls back to
 * `messageForError`'s own generic copy — never a raw payload).
 *
 * **Code first, status second**, deliberately mirroring `problem-messages.ts`'s
 * own load-bearing resolution order: `MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED`
 * is a **429** that means "capacity cap reached", not "throttled", so a
 * status-first mapper would file it under `read-throttled` and tell the user
 * to retry something that will never succeed. It is intentionally absent from
 * the code list below and therefore falls through to the generic path.
 *
 * `DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG` is absent for that reason one step
 * further: no catalogued state describes "the stored data must
 * be corrected", and `ValuationErrorState.tsx`'s own rule is that an unmapped
 * error falls through to a labelled paragraph rather than borrowing a state
 * whose recovery advice cannot work. That paragraph now carries the
 * code's own French message instead of the generic 422 default, which is the
 * half that was actually missing.
 */
export function valuationStateIdForError(err: unknown): EmptyStateId | undefined {
  if (!(err instanceof ApiError)) return undefined;
  switch (err.code) {
    case "VALUATION_PRICE_UNAVAILABLE":
      return "valuation-price-unavailable";
    case "VALUATION_FX_RATE_UNAVAILABLE":
      return "valuation-fx-rate-unavailable";
    // `GET /dividends/summary`'s DV6 refusal shares this state, deliberately
    // **reusing** the entry rather than adding a sixteenth:
    // its copy — "le serveur a refusé de produire cette vue … demandez un
    // portefeuille à la fois, ou une période plus courte" — names exactly the
    // two controls the Dividendes screen has, and a second catalogue entry
    // saying the same thing in other words is how two surfaces start to drift.
    // `messageForError` still supplies the *what happened* half, so the panel
    // reads with the dividend cap's own number, not the holdings one.
    // `closed-positions` FR-333 reuses this entry for the identical
    // reason the dividend cap does, one step more literally: it *is* a
    // valuation read refusing an over-sized view, and its copy already names
    // the one control the Positions screen has ("demandez un portefeuille à la
    // fois"). A sixteenth state saying the same thing in other words is how
    // two surfaces start to drift. `messageForError` still supplies the *what
    // happened* half, so the panel reads with this cap's own detail.
    // `watchlist` FR-365/NFR-39 reuses this entry for the third time and for
    // the same reason: it *is* a valuation-class read refusing an over-sized
    // view, and the copy's "demandez … une période plus courte" names the one
    // control the Suivi screen has (its window selector) alongside the other
    // remedy — following fewer instruments — that `messageForError` states with
    // this cap's own number. A seventeenth state repeating that in other words
    // is how two surfaces start to drift.
    case "VALUATION_RESPONSE_TOO_LARGE":
    case "DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE":
    case "CLOSED_POSITIONS_RESPONSE_TOO_LARGE":
    case "WATCHLIST_RESPONSE_TOO_LARGE":
      return "valuation-response-too-large";
    case "ADMISSION_BOUND_EXCEEDED":
      return "read-throttled";
    case undefined:
      // An unmapped 429 is a genuine throttle (FR-122's "a 429 state distinct
      // from a failure"); a 429 that carried one of the codes above already
      // returned, and the cap-shaped 429 is handled by its own `case` below.
      return err.status === 429 ? "read-throttled" : undefined;
    // Both cap-shaped 429s are deliberately **unmapped**, for the identical
    // reason: no catalogued state describes "a capacity ceiling is full", and
    // `read-throttled`'s recovery advice — patientez puis relancez — is false
    // for a cap that waiting does not clear. `problem-messages.ts` names each
    // cap's own number instead, and `ValuationErrorState.tsx` renders it as a
    // labelled paragraph.
    case "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED":
    case "WATCHLIST_TENANT_CAP_EXCEEDED":
      return undefined;
    default:
      return err.status === 429 ? "read-throttled" : undefined;
  }
}
