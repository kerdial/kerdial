import { fill } from "../lib/copy/fill.js";
import { SHELL_COPY } from "../lib/copy/shell.js";

/**
 * `PanelLoading.tsx` — UR-36's third acceptance
 * criterion: *"loading is per-panel, never a whole-page spinner, on every
 * screen with more than one data source."*
 *
 * Two things make that criterion checkable rather than aspirational:
 *
 * 1. **The label is required.** A panel-scoped loading line must name the
 *    panel it belongs to ("Chargement des positions…"), which a page-level
 *    spinner structurally cannot do — there is no single panel to name. The
 *    bare `<p>Chargement…</p>` this component replaces was indistinguishable
 *    between the two readings.
 * 2. **`empty-state-copy-audit.test.ts` forbids the bare form** in the
 *    multi-source screens, so a future edit cannot quietly reintroduce a
 *    page-level "Chargement…" above the whole tree.
 *
 * `role="status"` (not `aria-busy` on a container): the panel's own region is
 * *replaced* by this line while the read is in flight, so there is no busy
 * container to annotate — and a screen reader should hear which panel is
 * still loading while the rest of the screen is already usable.
 */
export interface PanelLoadingProps {
  /** The panel's own French name, in the grammatical form that follows "Chargement " — e.g. `"des positions"`, `"de l'historique des cours"`. */
  readonly panelLabel: string;
  readonly testId: string;
}

export function PanelLoading({ panelLabel, testId }: PanelLoadingProps) {
  return (
    <p role="status" data-testid={testId} className="k-panel-loading">
      {fill(SHELL_COPY.panelLoading, { panel: panelLabel })}
    </p>
  );
}
