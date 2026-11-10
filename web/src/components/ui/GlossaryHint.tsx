import type { ReactNode } from "react";
import { fill } from "../../lib/copy/fill.js";
import { GLOSSARY_COPY, GLOSSARY_HINT_COPY, type GlossaryTermId } from "../../lib/copy/glossary.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

/**
 * The de-jargoning affordance: *"Kerdial never
 * asks the reader to already know a term it uses."*
 *
 * `Tooltip.tsx` is the mechanism; this is the **one** thing that mounts it, so
 * that every jargon explanation in the app has the same trigger, the same
 * keyboard behaviour and the same accessible name.
 *
 * ## Why the trigger is a real `<button>`, and why that is the whole point
 *
 * `Tooltip` delegates to Radix, whose `Trigger asChild` clones its child and
 * attaches `onFocus`/`onBlur`/`onPointerEnter` to it. Handed a bare `<span>`,
 * `<dt>` or `<th>` — which is what a table header or a definition list would
 * naturally have wrapped — the events attach to something that is **not in the
 * tab order**, so the tooltip opens on hover and is unreachable by keyboard
 * altogether. That is not a styling detail: it is the difference between the
 * design rule being implemented and being invisible to half its audience.
 *
 * So the affordance is a small focusable icon-button rather than the term
 * itself. The term stays plain text; the button sits beside it. `<JargonTerm>`
 * below is the two of them together, for the common case.
 *
 * **Tap target.** `.k-glossary-hint` is deliberately smaller than the 44px
 * `--tap-target` every interactive primitive in `components.css` is held to —
 * it sits inline inside 38px table-header rows and inside `<dt>`s in a
 * two-column grid, where a 44px control would either overlap its neighbour's
 * hit area (the sortable header immediately beside it) or push the row taller
 * on every screen. It carries no `:hover`/`:focus`/`cursor` rule of its own for
 * that reason, so `design-rules.test.ts`'s tap-target derivation does not
 * classify it as an interactive primitive; the focus ring comes from the global
 * `:focus-visible` rule, which is where it should come from anyway.
 *
 * ## The accessible name
 *
 * `« Définition : <the sentence> »`, from `GLOSSARY_HINT_COPY.hintLabel`. Radix
 * additionally points `aria-describedby` at the open tooltip, so the sentence
 * is announced twice while it is open — deliberate: the name is what a screen
 * reader hears in browse mode, without focusing anything, and that is the
 * fallback `<StatTile hint>`'s old `<Icon label>` provided and this must not
 * lose.
 */
export interface DefinitionHintProps {
  /** The sentence itself. Always catalogue copy — this component never composes one. */
  readonly definition: string;
  /** Set by {@link GlossaryHint}; surfaces it as `data-glossary-term` so the audit can find every occurrence of a term. */
  readonly termId?: GlossaryTermId;
  readonly testId?: string;
}

export function DefinitionHint({ definition, termId, testId }: DefinitionHintProps) {
  return (
    <Tooltip
      label={definition}
      contentTestId={testId === undefined ? undefined : `${testId}-content`}
    >
      <button
        type="button"
        className="k-glossary-hint"
        data-testid={testId}
        data-glossary-term={termId}
        aria-label={fill(GLOSSARY_HINT_COPY.hintLabel, { definition })}
      >
        <Icon name="circle-help" size="xs" />
      </button>
    </Tooltip>
  );
}

export interface GlossaryHintProps {
  readonly term: GlossaryTermId;
}

/** The catalogue-bound form: `<GlossaryHint term="pmp" />`. The only form a screen should reach for. */
export function GlossaryHint({ term }: GlossaryHintProps) {
  return (
    <DefinitionHint
      definition={GLOSSARY_COPY[term]}
      termId={term}
      testId={`glossary-hint-${term}`}
    />
  );
}

export interface JargonTermProps {
  readonly term: GlossaryTermId;
  /** The term as the screen already writes it — a column label, a `<dt>`'s text, a micro-label. */
  readonly children: ReactNode;
}

/**
 * A term and its hint, inline: `<JargonTerm term="pmp">{HOLDINGS_COPY.cardAveragePrice}</JargonTerm>`.
 *
 * The wrapper is a `<span>` so it can sit inside a `<dt>`, a `<th>`, a
 * `micro-label` or a grid header cell without changing any of their semantics —
 * this never introduces a heading, a list item or a landmark.
 */
export function JargonTerm({ term, children }: JargonTermProps) {
  return (
    <span className="k-jargon">
      {children}
      <GlossaryHint term={term} />
    </span>
  );
}
