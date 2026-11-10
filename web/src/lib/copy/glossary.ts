/**
 * `copy/glossary.ts` — one sentence per jargon term, at the point of use.
 *
 * The rule this module implements: **"Kerdial never asks the reader to already know a
 * term it uses."** Ten terms appeared on the screens when this module was
 * written — TWR, MWR, PMP, the latent and realised results, coverage, the
 * quote policy, a delayed quote, withholding tax, and an FX rate's source —
 * and before this issue most of them were rendered with no explanation
 * anywhere in the product. **Fourteen since the watchlist cycle** (UR-55),
 * which brought four more onto one new screen: the annualised volatility, the
 * maximum drawdown, the distance from the 52-week high and the moving
 * averages. Ten was MEASURED up front and re-derived at implementation
 * time; the count is asserted by value in both paired tests.
 *
 * There were eleven: **the valuation version («version <calcEpoch>») was
 * dropped on 2026-09-08** along with every surface that displayed it. A
 * definition with no surface is copy nobody can reach, so the entry went with
 * the chips — `glossary-surfaces.test.tsx` is what would have caught it
 * staying.
 *
 * **One definition per term, one place.** `TWR_HINT`/`MWR_HINT` used to sit as
 * two exported constants in `components/portfolio-detail/PerformanceBlocks.tsx`
 * and were imported by three siblings; `OVERVIEW_COPY.twrHint` and
 * `PERFORMANCE_COPY.twrHint` were two *further* wordings of the same idea on
 * two other screens. Three wordings of "what is a TWR" is three answers a
 * reader can be given for the same question, and it is exactly what
 * `glossary-copy-audit.test.ts` now forbids: no definition below may appear as
 * a literal in any surface file.
 *
 * ## The voice rules, which are constraints and not taste
 *
 * French, sentence case, **at most two short sentences**, no advice, no
 * prediction, and each one defines its term without assuming it. A definition
 * that says "the TWR is the time-weighted return" has explained nothing to the
 * only reader who needed it.
 *
 * Three entries additionally carry a constraint the rest of the codebase
 * already enforces, and are worded around it rather than against it:
 *
 * - **`quotePolicy`** and **`delayedQuote`** may not put « périmé », « TWR »,
 *   « MWR » or « stale » anywhere near a manual price — `ManualPriceDialog.
 *   test.tsx` and `positions.test.ts` both assert it, because a manual price
 *   leaves neither return figure stale and saying so would invent a defect.
 * - **`withholding`** is stated in the settling account's currency,
 *   and the net it leaves is shown (LD-1, which forbade any net, is
 *   superseded): the sentence names both, and the net is the settled amount
 *   minus the withholding — never the gross minus it, which may be in another
 *   currency.
 *
 * ## How it reaches a screen
 *
 * Never by a screen retyping it: `<GlossaryHint term="pmp">` (or
 * `<JargonTerm>`, or `<StatTile hintTerm="pmp">`) looks the definition up
 * here and renders the one shared, focusable, Esc-dismissible trigger —
 * `components/ui/GlossaryHint.tsx`, which is also where the accessible-name
 * composition below is used.
 */
export type GlossaryTermId =
  | "twr"
  | "mwr"
  | "pmp"
  | "unrealized"
  | "realized"
  | "coverage"
  | "quotePolicy"
  | "delayedQuote"
  | "withholding"
  | "fxRate"
  // The watchlist's four (UR-55).
  // English camelCase ids, French copy — the convention every id above
  // already follows (`twr`, `pmp`, `delayedQuote`), and UR-56's rule that the
  // *copy* is French either way.
  | "volatility"
  | "drawdown"
  | "distanceFromHigh"
  | "movingAverage";

export const GLOSSARY_COPY = {
  twr: "Le rendement pondéré par le temps mesure la progression du portefeuille lui-même : les versements et les retraits sont neutralisés.",
  mwr: "Le rendement pondéré par les flux tient compte du moment de vos versements et de vos retraits, pas seulement de leur montant.",
  pmp: "Le prix moyen pondéré est le prix d'achat moyen d'une ligne, chaque achat comptant à hauteur de sa quantité.",
  unrealized:
    "Une plus ou moins-value latente est l'écart entre la valeur actuelle d'une ligne et ce qu'elle a coûté, tant qu'elle n'a pas été vendue.",
  /** Sign-neutral on purpose: `RealizedGainsIndicator` labels the same figure « Plus-value réalisée », « Moins-value réalisée » or « Résultat réalisé », and one definition has to fit all three. */
  realized:
    "Un résultat réalisé est l'écart entre le prix de vente et le prix d'achat des titres effectivement vendus.",
  /** Covers the three shapes coverage takes: a start date (Contrôles), a completed-history count (Instruments), and a rate count plus first date (Devises). */
  coverage:
    "La couverture est l'étendue de l'historique de cours déjà récupéré, à partir de la première date enregistrée.",
  quotePolicy:
    "La politique de cours indique d'où vient le prix d'un instrument : récupéré automatiquement, ou saisi à la main.",
  delayedQuote:
    "Un cours différé est publié avec un décalage sur le marché, souvent de quelques minutes.",
  /** What is taken, in the account's currency, and what is left — LD-1's "no net" is superseded. */
  withholding:
    "La retenue à la source est l'impôt prélevé sur un dividende ou des intérêts avant qu'ils ne vous soient versés. Elle est exprimée dans la devise du compte espèce, et le montant net est le montant réglé moins la retenue.",
  fxRate:
    "Un taux de change convertit un montant d'une devise dans une autre. Sa source indique d'où vient ce taux et à quelle date il a été observé.",
  /** A dispersion, never a direction — the sentence says "ampleur", so nothing in it can be read as a forecast of which way the price moves. */
  volatility:
    "La volatilité annualisée mesure l'ampleur des variations de cours passées, ramenée à une échelle d'un an.",
  /** Peak *then* trough, in that order: a recovery is never required for the figure to exist, which is the server's own contract for it. */
  drawdown:
    "La baisse maximale est le plus fort recul entre un sommet et un creux qui le suit, sur la période observée.",
  distanceFromHigh:
    "L'écart au plus haut situe le dernier cours par rapport au plus haut atteint sur les cinquante-deux dernières semaines.",
  movingAverage:
    "Une moyenne mobile est la moyenne des derniers cours de clôture, recalculée chaque jour : elle lisse les variations quotidiennes.",
} as const satisfies Readonly<Record<GlossaryTermId, string>>;

/** The term ids, enumerated — what the audit iterates so a term added above cannot escape it. */
export const GLOSSARY_TERM_IDS = Object.keys(GLOSSARY_COPY) as readonly GlossaryTermId[];

export type GlossaryHintCopyKey = "hintLabel";

/**
 * The trigger's accessible name.
 *
 * `<StatTile hint>` used to render `<Icon name="circle-help" label={hint}/>`,
 * whose accessible name was the bare definition — a control announced as
 * « Le prix moyen pondéré est… » with nothing saying it is a help affordance.
 * The prefix restores that, and keeps the whole definition in the name so a
 * screen reader still hears it without opening anything: the tooltip's own
 * `aria-describedby` only exists while it is open.
 */
export const GLOSSARY_HINT_COPY = {
  hintLabel: "Définition : {definition}",
} as const satisfies Readonly<Record<GlossaryHintCopyKey, string>>;
