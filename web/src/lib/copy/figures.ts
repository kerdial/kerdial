/**
 * `copy/figures.ts` — what `<Figure>` announces.
 *
 * Every money and quantity value in the UI is rendered by `Figure.tsx`, and
 * three of its four strings are the *only* place a provenance badge says what
 * it means: the badges themselves are a letter and two icons, so a screen
 * reader hears these labels or it hears nothing.
 *
 * The figures themselves are absent from this table by design. `Figure.tsx`
 * formats through `figure-format.ts`, which has a sole-importer test naming it
 * the one formatter — the catalogue must never grow a second one.
 */
export type FigureCopyKey = "absent" | "manualBadge" | "delayedBadge" | "pinnedFxBadge";

export const FIGURE_COPY = {
  /** The em dash a figure renders when it cannot be formatted — announced, never silent. */
  absent: "Valeur indisponible",
  manualBadge: "Donnée saisie manuellement",
  delayedBadge: "Cours différé",
  pinnedFxBadge: "Taux de change épinglé par l'utilisateur",
} as const satisfies Readonly<Record<FigureCopyKey, string>>;
